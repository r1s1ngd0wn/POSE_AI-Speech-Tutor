process.env.STORE_BACKEND = "memory";
process.env.TUTOR_PIN_SECRET = "test-secret-not-for-production";
delete process.env.TUTOR_LLM_PROVIDER;

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const tutor = require("../src/services/tutorSessionService");
const privacy = require("../src/services/tutorPrivacyService");
const speech = require("../src/services/tutorSpeechService");
const { app } = require("../src/server");

function withEnv(t, values) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { process.env = saved; speech.clearCache(); });
}
const XAI = { TUTOR_STT_PROVIDER: "xai", TUTOR_TTS_PROVIDER: "xai", XAI_API_KEY: "xai-not-a-real-key", GROQ_API_KEY: undefined, TUTOR_STT_USE_LOGPROB: undefined, TUTOR_TTS_VOICE: undefined };
const audio = Buffer.from("fake webm audio");

// Replaces fetch for the providers only; calls to the local test server go through.
function mockProviders(t, handler) {
  const real = global.fetch;
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1")) return real(url, init);
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mp3 = () => new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
const heard = (text) => json({ text, language: "en", duration: 1.5, words: [{ text: "I", start: 0.1, end: 0.2 }, { text: "see", start: 0.2, end: 0.4 }, { text: ".", start: 0.4, end: 0.5 }] });

// --- status and configuration -------------------------------------------------------------------

test("speech is off unless a provider is chosen and has a key, and the status never reveals a key", (t) => {
  withEnv(t, { ...XAI, TUTOR_STT_PROVIDER: undefined, TUTOR_TTS_PROVIDER: undefined });
  assert.deepEqual(speech.status().stt.enabled, false);
  assert.deepEqual(speech.status().tts.enabled, false);
  process.env.TUTOR_STT_PROVIDER = "xai";
  process.env.TUTOR_TTS_PROVIDER = "xai";
  const status = speech.status();
  assert.deepEqual([status.stt.enabled, status.stt.provider, status.tts.enabled, status.tts.voice], [true, "xai", true, "luna"]);
  assert.ok(!JSON.stringify(status).includes("xai-not-a-real-key"));
  delete process.env.XAI_API_KEY;
  assert.equal(speech.status().stt.enabled, false, "a provider without a key is off");
});

// --- speech to text -----------------------------------------------------------------------------

test("xAI speech to text: request shape and response mapping, with no confidence", async (t) => {
  withEnv(t, XAI);
  const calls = mockProviders(t, () => heard("  I see  "));
  const out = await speech.transcribe(audio, "audio/webm;codecs=opus");
  assert.equal(calls[0].url, "https://api.x.ai/v1/stt");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xai-not-a-real-key");
  const form = calls[0].init.body;
  assert.deepEqual([...form.keys()], ["model", "language", "file"], "options come before the file");
  assert.equal(form.get("model"), "grok-voice-transcribe-2.0");
  assert.equal(form.get("language"), "en");
  assert.equal(form.get("file").name, "answer.webm");
  assert.equal(out.transcript, "I see");
  assert.equal(out.confidence, null, "this service returns no confidence");
  assert.deepEqual(out.words.map((w) => w.word), ["I", "see"], "punctuation-only tokens are dropped");
  assert.equal(out.durationMs, 1500);
  assert.equal(out.provider, "xai");
});

test("Groq speech to text: log-probability is only a proxy and is used for scoring only when switched on", async (t) => {
  withEnv(t, { TUTOR_STT_PROVIDER: "groq", GROQ_API_KEY: "gsk-not-a-real-key", XAI_API_KEY: undefined, TUTOR_STT_USE_LOGPROB: undefined });
  mockProviders(t, () => json({ text: "I see a cat", duration: 2, segments: [{ avg_logprob: -0.2 }, { avg_logprob: -0.4 }] }));
  const off = await speech.transcribe(audio, "audio/wav");
  assert.equal(off.confidence, null);
  assert.ok(off.confidenceProxy > 0.7 && off.confidenceProxy < 0.8, String(off.confidenceProxy));
  process.env.TUTOR_STT_USE_LOGPROB = "true";
  assert.equal((await speech.transcribe(audio, "audio/wav")).confidence, off.confidenceProxy);
});

test("speech to text failures are coded and never reveal the provider's reply", async (t) => {
  withEnv(t, XAI);
  mockProviders(t, () => json({ error: "secret detail" }, 500));
  await assert.rejects(speech.transcribe(audio, "audio/webm"), (e) => e.code === "STT_FAILED" && e.status === 502 && !/secret detail/.test(e.message));
  t.mock.restoreAll();
  mockProviders(t, () => { throw new TypeError("fetch failed"); });
  await assert.rejects(speech.transcribe(audio, "audio/webm"), (e) => e.code === "SPEECH_UNAVAILABLE" && e.status === 502);
  t.mock.restoreAll();
  mockProviders(t, () => heard("   "));
  await assert.rejects(speech.transcribe(audio, "audio/webm"), (e) => e.code === "NO_SPEECH_DETECTED" && e.status === 422);
  await assert.rejects(speech.transcribe(Buffer.alloc(0), "audio/webm"), (e) => e.code === "NO_AUDIO");
  await assert.rejects(speech.transcribe(Buffer.alloc(speech.MAX_AUDIO_BYTES + 1), "audio/webm"), (e) => e.status === 413);
  await assert.rejects(speech.transcribe(audio, "text/plain"), (e) => e.status === 415);
  withEnv(t, { TUTOR_STT_PROVIDER: undefined });
  await assert.rejects(speech.transcribe(audio, "audio/webm"), (e) => e.code === "STT_NOT_CONFIGURED" && e.status === 503);
});

// --- text to speech -----------------------------------------------------------------------------

test("xAI text to speech: voice, language, speed by age band, and caching of repeated lines", async (t) => {
  withEnv(t, XAI);
  const calls = mockProviders(t, mp3);
  const first = await speech.speak("What is this?", { ageBand: "A" });
  assert.equal(calls[0].url, "https://api.x.ai/v1/tts");
  assert.equal(calls[0].init.headers.Authorization, "Bearer xai-not-a-real-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "What is this?", voice_id: "luna", language: "en", speed: 0.9 });
  assert.deepEqual([first.cached, first.contentType, first.audio.length], [false, "audio/mpeg", 4]);

  const again = await speech.speak("What is this?", { ageBand: "A" });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1, "a repeated line is not fetched again");
  await speech.speak("What is this?", { ageBand: "B" });
  assert.equal(JSON.parse(calls[1].init.body).speed, 1.0);
  process.env.TUTOR_TTS_VOICE = "cosmo";
  await speech.speak("What is this?", { ageBand: "B" });
  assert.equal(JSON.parse(calls[2].init.body).voice_id, "cosmo", "a different voice is a different cache entry");
});

test("text to speech turns the colon into a comma and refuses text it should not speak", async (t) => {
  withEnv(t, XAI);
  const calls = mockProviders(t, mp3);
  await speech.speak("Say: I see a cat.");
  assert.equal(JSON.parse(calls[0].init.body).text, "Say, I see a cat.");
  for (const bad of ["", "   ", "[laugh] hello", "<whisper>hi</whisper>", "hello\u0000", "x".repeat(301), "visit http://a.b"]) {
    await assert.rejects(speech.speak(bad), (e) => e.code === "TTS_TEXT_INVALID", JSON.stringify(bad).slice(0, 30));
  }
  assert.equal(calls.length, 1);
});

test("text to speech failures are coded", async (t) => {
  withEnv(t, XAI);
  mockProviders(t, () => json({ error: "nope" }, 429));
  await assert.rejects(speech.speak("Hello"), (e) => e.code === "TTS_FAILED" && e.status === 502);
  withEnv(t, { TUTOR_TTS_PROVIDER: undefined });
  await assert.rejects(speech.speak("Hello"), (e) => e.code === "TTS_NOT_CONFIGURED" && e.status === 503);
});

// --- in a session -------------------------------------------------------------------------------

let counter = 0;
const newParent = async () => (await auth.register({ email: `speech${++counter}@test.dev`, password: "secret1", name: `P ${counter}` })).user;
async function startAnimals(parentId) {
  const child = await tutor.createChild(parentId, { nickname: "Mimi", age: 8 });
  return tutor.startSession(parentId, { childId: child.id, topicId: "animals" }, { llm: null });
}

test("the tutor's lines are chosen by the server from the session", async () => {
  const parent = await newParent();
  const session = await startAnimals(parent.id);
  assert.deepEqual(await tutor.speechLine(parent.id, session.id, { line: "story" }), { text: "Momo is a little dragon. Momo likes animals.", ageBand: "B" });
  assert.equal((await tutor.speechLine(parent.id, session.id, { line: "prompt", itemId: "i1" })).text, "Say: I see a cat.");
  assert.equal((await tutor.speechLine(parent.id, session.id, { line: "feedback", stars: "3" })).text, "Great job!");
  assert.equal((await tutor.speechLine(parent.id, session.id, { line: "feedback", stars: "abandoned" })).text, "That's okay! Let's try the next one.");
  await assert.rejects(tutor.speechLine(parent.id, session.id, { line: "prompt", itemId: "i3" }), (e) => e.status === 409, "not started");
  await assert.rejects(tutor.speechLine(parent.id, session.id, { line: "reveal", itemId: "i1" }), (e) => e.status === 409, "not answered");
  await assert.rejects(tutor.speechLine(parent.id, session.id, { line: "prompt", itemId: "zzz" }), (e) => e.status === 404);
  await assert.rejects(tutor.speechLine(parent.id, session.id, { line: "feedback", stars: "9" }), (e) => e.status === 400);
  await assert.rejects(tutor.speechLine(parent.id, session.id, { line: "anything you like" }), (e) => e.status === 400);
  await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: { mode: "speech", transcript: "I see a cat", firstAttemptMs: 1000 } });
  assert.equal((await tutor.speechLine(parent.id, session.id, { line: "reveal", itemId: "i1" })).text, "I see a cat");
  const other = await newParent();
  await assert.rejects(tutor.speechLine(other.id, session.id, { line: "story" }), (e) => e.status === 404);
});

test("a spoken answer is transcribed by the service and scored without Clarity when there is no confidence", async () => {
  const parent = await newParent();
  const session = await startAnimals(parent.id);
  const result = await tutor.submitSpeechAttempt(parent.id, session.id,
    { itemId: "i1", audio, mime: "audio/webm", firstAttemptMs: 2000, attemptCount: 1 },
    { transcribe: async () => ({ transcript: "I see a cat", confidence: null }) });
  assert.equal(result.heard, "I see a cat");
  assert.equal(result.result.stars, 3);
  assert.ok(!result.result.criteria.some((c) => c.id === "clarity"), "no confidence means no Clarity band");
  const stored = await store.tutorSessions.get(session.id);
  assert.ok(!JSON.stringify(stored).includes("fake webm audio"), "audio is never stored");
});

test("the activity is checked before any audio is sent to the speech service", async () => {
  const parent = await newParent();
  const session = await startAnimals(parent.id);
  let sent = 0;
  const deps = { transcribe: async () => { sent += 1; return { transcript: "x" }; } };
  await assert.rejects(tutor.submitSpeechAttempt(parent.id, session.id, { itemId: "i3", audio, mime: "audio/webm" }, deps), (e) => e.status === 409);
  const other = await newParent();
  await assert.rejects(tutor.submitSpeechAttempt(other.id, session.id, { itemId: "i1", audio, mime: "audio/webm" }, deps), (e) => e.status === 404);
  await tutor.finishSession(parent.id, session.id);
  await assert.rejects(tutor.submitSpeechAttempt(parent.id, session.id, { itemId: "i1", audio, mime: "audio/webm" }, deps), (e) => e.status === 409);
  assert.equal(sent, 0);
});

test("a heard transcript is scrubbed of contact details before it is shown or stored", async () => {
  const parent = await newParent();
  const session = await startAnimals(parent.id);
  const result = await tutor.submitSpeechAttempt(parent.id, session.id, { itemId: "i1", audio, mime: "audio/webm" },
    { transcribe: async () => ({ transcript: "I see a cat email kid@home.com", confidence: null }) });
  assert.ok(!result.heard.includes("kid@home.com"));
  assert.ok(!JSON.stringify(await store.tutorSessions.get(session.id)).includes("kid@home.com"));
});

// --- HTTP ---------------------------------------------------------------------------------------

test("HTTP: a spoken answer and the tutor's voice, with consent required and silence not counted", async (t) => {
  withEnv(t, XAI);
  let transcript = "I see a cat";
  mockProviders(t, (url) => (url.endsWith("/stt") ? heard(transcript) : mp3()));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { method = "GET", body, token, headers = {}, raw = false } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, type, data: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  };

  const registered = (await call("/auth/register", { method: "POST", body: { name: "S", email: "speech-http@test.dev", password: "secret1" } })).data;
  const token = registered.token;
  const status = await call("/tutor/speech/status", { token });
  assert.equal(status.data.stt.enabled, true);

  // set up consent, PIN and a child, then a lesson
  await call("/tutor/consent", { method: "POST", token, body: { version: privacy.CONSENT_VERSION } });
  await call("/tutor/pin", { method: "POST", token, body: { pin: "4821" } });
  const pin = { "X-Parent-Pin-Token": (await call("/tutor/pin/verify", { method: "POST", token, body: { pin: "4821" } })).data.token };
  const child = (await call("/tutor/children", { method: "POST", token, headers: pin, body: { nickname: "Mimi", age: 6 } })).data.child;
  const sessionId = (await call("/tutor/sessions", { method: "POST", token, body: { childId: child.id, topicId: "animals" } })).data.session.id;

  // the tutor's voice
  const voice = await call(`/tutor/sessions/${sessionId}/speech?line=prompt&itemId=i1`, { token });
  assert.equal(voice.status, 200);
  assert.equal(voice.type, "audio/mpeg");
  assert.deepEqual([...voice.data], [1, 2, 3, 4]);
  assert.equal((await call(`/tutor/sessions/${sessionId}/speech?line=prompt&itemId=i3`, { token })).status, 409);
  assert.equal((await call(`/tutor/sessions/${sessionId}/speech?line=dance`, { token })).status, 400);

  // silence does not use up the activity
  transcript = "   ";
  const query = "?itemId=i1&firstAttemptMs=2400&attemptCount=1&hintUsed=false";
  const silent = await call(`/tutor/sessions/${sessionId}/attempts/audio${query}`, { method: "POST", token, body: audio, raw: true, headers: { "Content-Type": "audio/webm" } });
  assert.equal(silent.status, 422);
  assert.equal(silent.data.code, "NO_SPEECH_DETECTED");
  assert.equal((await call(`/tutor/sessions/${sessionId}`, { token })).data.session.currentIndex, 0);

  // a real answer
  transcript = "I see a cat";
  const ok = await call(`/tutor/sessions/${sessionId}/attempts/audio${query}`, { method: "POST", token, body: audio, raw: true, headers: { "Content-Type": "audio/webm" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.heard, "I see a cat");
  assert.equal(ok.data.result.stars, 3);
  assert.equal(ok.data.session.currentIndex, 1);

  // wrong content type, and a parent who has not given consent
  assert.equal((await call(`/tutor/sessions/${sessionId}/attempts/audio?itemId=i2`, { method: "POST", token, body: "{}", raw: true, headers: { "Content-Type": "application/json" } })).status, 415);
  const stranger = (await call("/auth/register", { method: "POST", body: { name: "N", email: "speech-nonconsent@test.dev", password: "secret1" } })).data;
  const refused = await call(`/tutor/sessions/${sessionId}/attempts/audio${query}`, { method: "POST", token: stranger.token, body: audio, raw: true, headers: { "Content-Type": "audio/webm" } });
  assert.equal(refused.data.code, "CONSENT_REQUIRED");
});
