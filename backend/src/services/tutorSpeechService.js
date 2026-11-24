// Server-side speech for the tutor: the child's answer to text, and the tutor's lines to audio.
//
// Why on the server: the API keys stay private, and the transcript that is scored comes from the speech
// service, not from a value the browser could make up (the browser only reports timing and attempts).
//
// Speech to text (TUTOR_STT_PROVIDER):
//   xai   POST https://api.x.ai/v1/stt (model grok-voice-transcribe-2.0). The response has the text and word
//         timestamps but NO confidence, so the Clarity criterion is omitted for these answers (the scorer
//         already omits a criterion that cannot be measured and renormalises the weights).
//   groq  Groq's hosted Whisper. verbose_json gives each segment's average log-probability, which is only a
//         rough stand-in for confidence and is not calibrated against children's speech. It is reported as
//         confidenceProxy and is used for scoring only if TUTOR_STT_USE_LOGPROB=true.
// Text to speech (TUTOR_TTS_PROVIDER=xai): POST https://api.x.ai/v1/tts with a gentle education voice and a
//   slightly slower speed for the younger age band. Audio is cached by (voice, speed, text), because the same
//   short lines ("What is this?", "Great job!") are spoken constantly; this is where the cost assumption of
//   reusing stored tutor audio comes from.
//
// The child's audio is sent to the provider once, held in memory only for that request, and never stored.
// Whether a provider is acceptable for children's voices (its retention and training policy, and its accuracy
// on young speakers) has NOT been verified; that must be checked before any pilot (see the README).

const { trackAiRequest } = require("./aiTelemetry");

const XAI_URL = "https://api.x.ai/v1";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // one short turn is a few tens of kilobytes
const TIMEOUT_MS = 20000;
const MAX_TTS_CHARS = 300;
const CACHE_MAX_ENTRIES = 300;
const CACHE_MAX_BYTES = 30 * 1024 * 1024;
const SPOKEN_TEXT = /^[A-Za-z0-9 '.,?!-]+$/;

const EXTENSIONS = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/flac": "flac", "audio/aac": "aac", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
};

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const env = (name) => (process.env[name] || "").trim();

// --- configuration -----------------------------------------------------------------------------

function sttConfig() {
  const provider = env("TUTOR_STT_PROVIDER").toLowerCase();
  if (provider === "xai" && env("XAI_API_KEY")) return { provider, key: env("XAI_API_KEY"), model: env("TUTOR_STT_MODEL") || "grok-voice-transcribe-2.0" };
  if (provider === "groq" && env("GROQ_API_KEY")) return { provider, key: env("GROQ_API_KEY"), model: GROQ_MODEL };
  return null;
}

function ttsConfig() {
  if (env("TUTOR_TTS_PROVIDER").toLowerCase() === "xai" && env("XAI_API_KEY")) return { provider: "xai", key: env("XAI_API_KEY"), voice: env("TUTOR_TTS_VOICE") || "luna" };
  return null;
}

// What the browser needs to know: when a service is off it falls back to the browser's own speech.
function status() {
  const stt = sttConfig();
  const tts = ttsConfig();
  return {
    stt: { enabled: Boolean(stt), provider: stt?.provider ?? null, providesConfidence: stt?.provider === "groq" && env("TUTOR_STT_USE_LOGPROB") === "true", maxBytes: MAX_AUDIO_BYTES },
    tts: { enabled: Boolean(tts), provider: tts?.provider ?? null, voice: tts?.voice ?? null },
  };
}

// --- shared request helper ---------------------------------------------------------------------

async function send(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw fail("The speech service could not be reached.", 502, "SPEECH_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}

// --- speech to text ----------------------------------------------------------------------------

function describe(mimeType) {
  const mime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const extension = EXTENSIONS[mime];
  if (!extension) throw fail("Unsupported audio format.", 415, "AUDIO_FORMAT");
  return { mime, name: `answer.${extension}` };
}

const meanLogprobConfidence = (segments) => {
  const usable = (segments || []).filter((s) => Number.isFinite(s?.avg_logprob));
  if (!usable.length) return null;
  const mean = usable.reduce((sum, s) => sum + Math.exp(s.avg_logprob), 0) / usable.length;
  return Math.round(Math.min(1, Math.max(0, mean)) * 1000) / 1000;
};

async function transcribeXai(cfg, audio, mime, name) {
  const form = new FormData();
  // Option fields come before the file: the provider ignores fields sent after it.
  form.append("model", cfg.model);
  form.append("language", "en");
  form.append("file", new Blob([audio], { type: mime }), name);
  const res = await send(`${XAI_URL}/stt`, { method: "POST", headers: { Authorization: `Bearer ${cfg.key}` }, body: form });
  return { res, read: (data) => ({ text: data?.text, confidence: null, confidenceProxy: null, words: data?.words, durationSeconds: data?.duration }) };
}

async function transcribeGroq(cfg, audio, mime, name) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), name);
  form.append("model", cfg.model);
  form.append("language", "en");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const res = await send(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${cfg.key}` }, body: form });
  return {
    res,
    read: (data) => {
      const proxy = meanLogprobConfidence(data?.segments);
      return { text: data?.text, confidence: env("TUTOR_STT_USE_LOGPROB") === "true" ? proxy : null, confidenceProxy: proxy, words: null, durationSeconds: data?.duration };
    },
  };
}

// transcribe(audio Buffer, mime) -> { transcript, confidence, confidenceProxy, words, durationMs, provider }
async function transcribe(audio, mimeType) {
  const cfg = sttConfig();
  if (!cfg) throw fail("Speech recognition is not configured.", 503, "STT_NOT_CONFIGURED");
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw fail("No audio was received.", 400, "NO_AUDIO");
  if (audio.length > MAX_AUDIO_BYTES) throw fail("The recording is too long.", 413, "AUDIO_TOO_LARGE");
  const { mime, name } = describe(mimeType);

  return trackAiRequest({ capability: "speech", provider: cfg.provider, model: cfg.model, operation: "transcribe" }, async (note) => {
    const { res, read } = await (cfg.provider === "xai" ? transcribeXai : transcribeGroq)(cfg, audio, mime, name);
    note({ provider_status: res.status });
    if (!res.ok) throw fail("The speech service could not understand that recording.", 502, "STT_FAILED");
    const data = await res.json().catch(() => null);
    const out = read(data);
    const transcript = typeof out.text === "string" ? out.text.trim() : "";
    // Silence is not an attempt: the child should simply try again.
    if (!transcript) throw fail("No speech was detected.", 422, "NO_SPEECH_DETECTED");
    return {
      transcript,
      confidence: out.confidence,
      confidenceProxy: out.confidenceProxy,
      words: Array.isArray(out.words) ? out.words.filter((w) => /\w/.test(w?.text ?? "")).map((w) => ({ word: w.text, start: w.start, end: w.end })) : null,
      durationMs: Number.isFinite(out.durationSeconds) ? Math.round(out.durationSeconds * 1000) : null,
      provider: cfg.provider,
    };
  });
}

// --- text to speech ----------------------------------------------------------------------------

const cache = new Map(); // key -> { audio, contentType }; insertion order doubles as recency
let cacheBytes = 0;

function remember(key, value) {
  cache.set(key, value);
  cacheBytes += value.audio.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).audio.length;
    cache.delete(oldest);
  }
}

const clearCache = () => { cache.clear(); cacheBytes = 0; };

// Text is read as written, so the colon in "Say: I see a cat." becomes a comma to sound natural.
const forSpeech = (text) => String(text ?? "").replace(/:/g, ",").replace(/\s+/g, " ").trim();

// speak(text, { ageBand }) -> { audio Buffer, contentType, cached }
async function speak(text, { ageBand = "B" } = {}) {
  const cfg = ttsConfig();
  if (!cfg) throw fail("Text to speech is not configured.", 503, "TTS_NOT_CONFIGURED");
  const spoken = forSpeech(text);
  if (!spoken || spoken.length > MAX_TTS_CHARS || !SPOKEN_TEXT.test(spoken)) throw fail("That text cannot be spoken.", 400, "TTS_TEXT_INVALID");
  const speed = ageBand === "A" ? 0.9 : 1.0;
  const key = `${cfg.provider}|${cfg.voice}|${speed}|${spoken}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used
    return { ...hit, cached: true };
  }

  return trackAiRequest({ capability: "tts", provider: cfg.provider, model: "tts", operation: "speak" }, async (note) => {
    const res = await send(`${XAI_URL}/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken, voice_id: cfg.voice, language: "en", speed }),
    });
    note({ provider_status: res.status });
    if (!res.ok) throw fail("The voice service could not speak that.", 502, "TTS_FAILED");
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw fail("The voice service returned no audio.", 502, "TTS_FAILED");
    const value = { audio, contentType: res.headers?.get?.("content-type") || "audio/mpeg" };
    remember(key, value);
    return { ...value, cached: false };
  });
}

module.exports = { status, transcribe, speak, forSpeech, clearCache, MAX_AUDIO_BYTES };
