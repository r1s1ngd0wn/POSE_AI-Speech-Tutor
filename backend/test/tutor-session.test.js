process.env.STORE_BACKEND = "memory";
delete process.env.TUTOR_LLM_PROVIDER; // lessons come from the vetted fallback set unless a test passes a model

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const tutor = require("../src/services/tutorSessionService");
const { app } = require("../src/server");

let counter = 0;
const newParent = async () => (await auth.register({ email: `tutor${++counter}@test.dev`, password: "secret1", name: `Parent ${counter}` })).user;
const spoken = (transcript, extra) => ({ mode: "speech", transcript, confidence: 0.9, firstAttemptMs: 3000, ...extra });

async function startAnimals(parentId, ageBand = "B") {
  const child = await tutor.createChild(parentId, { nickname: "Mimi", ageBand });
  const session = await tutor.startSession(parentId, { childId: child.id, topicId: "animals" }, { llm: null });
  return { child, session };
}

test("child profiles: nickname and age band are validated and capped per parent", async () => {
  const parent = await newParent();
  await assert.rejects(tutor.createChild(parent.id, { nickname: "", ageBand: "A" }), (e) => e.status === 400);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "kid@home.com", ageBand: "A" }), (e) => e.status === 400);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Mimi", ageBand: "C" }), (e) => e.status === 400);
  for (let i = 0; i < tutor.MAX_CHILDREN; i += 1) await tutor.createChild(parent.id, { nickname: `Kid${"abcde"[i]}`, ageBand: "B" });
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Extra", ageBand: "B" }), (e) => e.status === 409);
  assert.equal((await tutor.listChildren(parent.id)).length, tutor.MAX_CHILDREN);
});

test("the browser view of a session never contains the answer key", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  const json = JSON.stringify(session);
  assert.ok(!/acceptedAnswers|correctChoiceId|targetWords/.test(json));
  assert.equal(session.status, "active");
  assert.equal(session.totalItems, 5);
  assert.equal(session.current.id, "i1");
  assert.equal(session.current.activityType, "listen_repeat");
  assert.equal(session.story.character, "Momo");
});

test("a full lesson is scored in code, in order, and ends completed", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);

  let step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: spoken("I see a cat") });
  assert.equal(step.result.stars, 3);
  assert.equal(step.feedback, "Great job!");
  assert.equal(step.reveal, "I see a cat");
  assert.equal(step.session.current.id, "i2");

  step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i2", response: spoken("a cat", { confidence: 0.2 }) });
  assert.equal(step.result.completed, true);
  assert.ok(step.result.stars >= 1);

  const options = step.session.current.choices;
  assert.equal(options.length, 3);
  step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i3", response: { mode: "picture", choiceId: "dog", firstAttemptMs: 2000 } });
  assert.equal(step.result.stars, 3);
  assert.ok(!step.result.criteria.some((c) => c.id === "clarity"), "picture choice has no clarity score");

  step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i4", response: spoken("yes") });
  assert.equal(step.result.stars, 3);
  step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i5", response: spoken("I like tigers") });
  assert.equal(step.done, true);
  assert.equal(step.session.status, "completed");
  assert.equal(step.session.summary.activitiesDone, 5);
  assert.ok(step.session.summary.starsEarned >= 12);
  assert.equal(step.session.summary.starsPossible, 15);
  await assert.rejects(tutor.submitAttempt(parent.id, session.id, { itemId: "i5", response: spoken("x") }), (e) => e.status === 409);
});

test("activities must be answered in order", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  await assert.rejects(tutor.submitAttempt(parent.id, session.id, { itemId: "i3", response: spoken("dog") }), (e) => e.status === 409);
});

test("picture fallback: allowed options only, and a Listen and Repeat sentence can fall back to a picture", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  assert.ok(session.current.choices, "Say: I see a cat has a picture fallback");
  await assert.rejects(tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: { mode: "picture", choiceId: "elephant" } }), (e) => e.status === 400);
  const step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: { mode: "picture", choiceId: "cat", firstAttemptMs: 2000 } });
  assert.equal(step.result.stars, 3);
});

test("an abandoned activity gets no stars and the lesson goes on; ending early abandons the session", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  const step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: { mode: "abandoned" } });
  assert.equal(step.result.stars, null);
  assert.equal(step.result.completed, false);
  assert.equal(step.session.status, "active");
  assert.equal(step.session.summary.starsEarned, 0);

  const ended = await tutor.finishSession(parent.id, session.id);
  assert.equal(ended.status, "abandoned");
  assert.equal(ended.current, null);
  assert.equal((await tutor.finishSession(parent.id, session.id)).status, "abandoned", "ending twice is harmless");
});

test("inputs are bounded before scoring", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  await assert.rejects(tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: { mode: "typed" } }), (e) => e.status === 400);
  await assert.rejects(tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: spoken("x", { firstAttemptMs: "soon" }) }), (e) => e.status === 400);
  const step = await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: spoken("I see a cat".repeat(100), { confidence: 9, firstAttemptMs: 99999999 }) });
  const stored = (await store.tutorSessions.get(session.id)).attempts[0].response;
  assert.ok(stored.transcript.length <= 300);
  assert.equal(stored.confidence, 1);
  assert.equal(stored.firstAttemptMs, 300000);
  assert.ok(step.result.completed);
});

test("the stored session is a reproducible snapshot with the answer key and rubric version, and no audio", async () => {
  const parent = await newParent();
  const { session } = await startAnimals(parent.id);
  await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: spoken("I see a cat", { audio: "AAAA", audioBase64: "AAAA" }) });
  const stored = await store.tutorSessions.get(session.id);
  assert.match(stored.rubricVersion, /^tutor-/);
  assert.ok(stored.items[0].acceptedAnswers.length > 0);
  assert.equal(stored.lessonMeta.fallbackItems, 5);
  assert.ok(!JSON.stringify(stored).includes("AAAA"), "audio is never stored");
  assert.equal(stored.attempts[0].result.rubricVersion, stored.rubricVersion);
});

test("one parent cannot see or change another parent's children or sessions", async () => {
  const [a, b] = [await newParent(), await newParent()];
  const { child, session } = await startAnimals(a.id);
  await assert.rejects(tutor.getSession(b.id, session.id), (e) => e.status === 404);
  await assert.rejects(tutor.submitAttempt(b.id, session.id, { itemId: "i1", response: spoken("x") }), (e) => e.status === 404);
  await assert.rejects(tutor.startSession(b.id, { childId: child.id, topicId: "animals" }, { llm: null }), (e) => e.status === 404);
  await assert.rejects(tutor.deleteChild(b.id, child.id), (e) => e.status === 404);
  assert.equal((await tutor.listChildren(b.id)).length, 0);
});

test("deleting a child profile deletes their sessions", async () => {
  const parent = await newParent();
  const { child, session } = await startAnimals(parent.id);
  assert.deepEqual(await tutor.deleteChild(parent.id, child.id), { deleted: true, sessionsDeleted: 1 });
  assert.equal(await store.tutorSessions.get(session.id), undefined);
  assert.equal((await tutor.listChildren(parent.id)).length, 0);
});

test("a model lesson is stored with its provenance; the child's age band sets the limits", async () => {
  const parent = await newParent();
  const child = await tutor.createChild(parent.id, { nickname: "Tiny", ageBand: "A" });
  const lesson = {
    story: { character: "Momo", intro: "Momo is a little dragon." },
    items: [{ activityType: "listen_repeat", say: "I see a big cat here" }, { activityType: "name_picture", pictureKey: "duck" }],
  };
  const session = await tutor.startSession(parent.id, { childId: child.id, topicId: "animals" }, { llm: async () => ({ text: JSON.stringify(lesson), model: "stub" }) });
  const stored = await store.tutorSessions.get(session.id);
  assert.equal(stored.lessonMeta.model, "stub");
  assert.equal(stored.items[0].source, "fallback", "6 words is too long for Band A");
  assert.equal(stored.items[1].source, "ai");
});

test("HTTP: parent creates a child, plays a lesson and ends it; unauthenticated calls are refused", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, method = "GET", body, token) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };

  assert.equal((await call("/tutor/topics")).status, 401);
  const registered = await call("/auth/register", "POST", { name: "Tutor Parent", email: "tutor-http@test.dev", password: "secret1" });
  const token = registered.data.token;

  const topics = await call("/tutor/topics", "GET", undefined, token);
  assert.deepEqual(topics.data.topics.map((x) => x.id).sort(), ["animals", "colors", "food", "nature", "space"]);

  const child = (await call("/tutor/children", "POST", { nickname: "Lily", ageBand: "A" }, token)).data.child;
  assert.equal((await call("/tutor/children", "POST", { nickname: "", ageBand: "A" }, token)).status, 400);

  const started = await call("/tutor/sessions", "POST", { childId: child.id, topicId: "colors" }, token);
  assert.equal(started.status, 201);
  const sessionId = started.data.session.id;
  assert.ok(!/acceptedAnswers|correctChoiceId/.test(JSON.stringify(started.data)));

  const attempt = await call(`/tutor/sessions/${sessionId}/attempts`, "POST", { itemId: "i1", response: { mode: "speech", transcript: "the sun is yellow", confidence: 0.9, firstAttemptMs: 2000 } }, token);
  assert.equal(attempt.status, 200);
  assert.equal(attempt.data.result.stars, 3);

  assert.equal((await call(`/tutor/sessions/${sessionId}/attempts`, "POST", { itemId: "i1", response: { mode: "abandoned" } }, token)).status, 409);
  assert.equal((await call(`/tutor/sessions/${sessionId}/finish`, "POST", {}, token)).data.session.status, "abandoned");
  assert.equal((await call(`/tutor/children/${child.id}`, "DELETE", undefined, token)).data.sessionsDeleted, 1);
});
