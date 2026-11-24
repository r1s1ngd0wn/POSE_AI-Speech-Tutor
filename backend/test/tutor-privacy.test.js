process.env.STORE_BACKEND = "memory";
process.env.TUTOR_PIN_SECRET = "test-secret-not-for-production";
delete process.env.TUTOR_LLM_PROVIDER;

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const tutor = require("../src/services/tutorSessionService");
const privacy = require("../src/services/tutorPrivacyService");
const review = require("../src/services/tutorReviewService");
const { scrubContactDetails } = require("../src/utils/scrub");
const { app } = require("../src/server");

let counter = 0;
const newUser = async () => (await auth.register({ email: `privacy${++counter}@test.dev`, password: "secret1", name: `User ${counter}` })).user;
const say = (transcript, extra) => ({ mode: "speech", transcript, confidence: 0.9, firstAttemptMs: 2000, ...extra });

// The test store is shared, so a test that counts the review queue first switches review off for every other
// parent. (A real teacher sees all permitted attempts; only the test needs the isolation.)
async function onlyReviewFor(parentIds = []) {
  for (const p of await store.tutorParents.values()) {
    if (!parentIds.includes(p.parentId) && p.permissions.teacherReview) await store.tutorParents.set(p.parentId, { ...p, permissions: { ...p.permissions, teacherReview: false } });
  }
}

// A parent with consent, a PIN, a child, and one finished animals lesson.
async function family({ allowReview = false } = {}) {
  const parent = await newUser();
  await privacy.recordConsent(parent.id, privacy.CONSENT_VERSION);
  await privacy.setPin(parent.id, { pin: "4821" });
  if (allowReview) await privacy.setPermissions(parent.id, { teacherReview: true });
  const child = await tutor.createChild(parent.id, { nickname: "Mimi", age: 8 });
  const session = await tutor.startSession(parent.id, { childId: child.id, topicId: "animals" }, { llm: null });
  for (const [i, text] of ["I see a cat", "cat", "dog", "yes", "I like tigers"].entries()) {
    await tutor.submitAttempt(parent.id, session.id, { itemId: `i${i + 1}`, response: say(text) });
  }
  return { parent, child, session };
}

// --- scrubbing (FR-11) --------------------------------------------------------------------------

test("contact details are removed from free text", () => {
  const out = (t) => scrubContactDetails(t);
  assert.equal(out("email me at kid@example.com please"), "email me at [removed] please");
  assert.equal(out("see https://example.com/x or www.site.vn"), "see [removed] or [removed]");
  assert.equal(out("follow @cooldragon now"), "follow [removed] now");
  assert.equal(out("call 0912 345 678 today"), "call [removed] today");
  assert.equal(out("my number is zero nine one two three four five six seven"), "my number is [removed]");
  assert.equal(out("I see a cat and two dogs"), "I see a cat and two dogs", "ordinary speech is untouched");
  assert.equal(out("I am 8 years old"), "I am 8 years old", "a short number is not a phone number");
});

test("a transcript is scrubbed before it is scored and stored", async () => {
  const parent = await newUser();
  const child = await tutor.createChild(parent.id, { nickname: "Mimi", age: 7 });
  const session = await tutor.startSession(parent.id, { childId: child.id, topicId: "animals" }, { llm: null });
  await tutor.submitAttempt(parent.id, session.id, { itemId: "i1", response: say("I see a cat my email is kid@home.com") });
  const stored = (await store.tutorSessions.get(session.id)).attempts[0].response.transcript;
  assert.ok(!stored.includes("kid@home.com"));
  assert.match(stored, /\[removed\]/);
});

// --- profiles (FR-03) ---------------------------------------------------------------------------

test("a profile takes an age from 6 to 10 and an avatar; the age band is derived", async () => {
  const parent = await newUser();
  const young = await tutor.createChild(parent.id, { nickname: "Ann", age: 7, avatar: "panda" });
  const older = await tutor.createChild(parent.id, { nickname: "Ben", age: 8 });
  assert.deepEqual([young.ageBand, older.ageBand, older.avatar], ["A", "B", "fox"]);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Cy", age: 5 }), (e) => e.status === 400);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Cy", age: 11 }), (e) => e.status === 400);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Cy", age: 7.5 }), (e) => e.status === 400);
  await assert.rejects(tutor.createChild(parent.id, { nickname: "Cy", age: 7, avatar: "dragon" }), (e) => e.status === 400);
});

test("editing a profile re-derives the age band, and only the owner can edit", async () => {
  const [a, b] = [await newUser(), await newUser()];
  const child = await tutor.createChild(a.id, { nickname: "Ann", age: 7 });
  const updated = await tutor.updateChild(a.id, child.id, { age: 9, nickname: "Annie", avatar: "bear" });
  assert.deepEqual([updated.age, updated.ageBand, updated.nickname, updated.avatar], [9, "B", "Annie", "bear"]);
  await assert.rejects(tutor.updateChild(b.id, child.id, { nickname: "Hack" }), (e) => e.status === 404);
  await assert.rejects(tutor.updateChild(a.id, child.id, { age: 12 }), (e) => e.status === 400);
});

// --- consent and permissions (FR-02, FR-17) -----------------------------------------------------

test("consent records the version and time; permissions start off", async () => {
  const parent = await newUser();
  const before = await privacy.getPrivacy(parent.id);
  assert.equal(before.consent.upToDate, false);
  assert.deepEqual(before.permissions, { teacherReview: false, audioRetention: false, teacherAudioReview: false, updatedAt: null });
  assert.equal(before.rawAudioStored, false);
  await assert.rejects(privacy.recordConsent(parent.id, "old-version"), (e) => e.code === "CONSENT_VERSION_MISMATCH");
  const after = await privacy.recordConsent(parent.id, privacy.CONSENT_VERSION, "2026-11-24T03:00:00.000Z");
  assert.deepEqual([after.consent.upToDate, after.consent.acceptedAt], [true, "2026-11-24T03:00:00.000Z"]);
  assert.ok(privacy.consentText().points.every((p) => p.en && p.vi), "the consent text is bilingual");
});

test("permissions are separate, boolean and consistent", async () => {
  const parent = await newUser();
  let p = await privacy.setPermissions(parent.id, { teacherReview: true });
  assert.deepEqual([p.permissions.teacherReview, p.permissions.audioRetention], [true, false]);
  await assert.rejects(privacy.setPermissions(parent.id, { teacherAudioReview: true }), (e) => e.status === 400, "listening needs retention");
  p = await privacy.setPermissions(parent.id, { audioRetention: true, teacherAudioReview: true });
  assert.equal(p.permissions.teacherAudioReview, true);
  p = await privacy.setPermissions(parent.id, { audioRetention: false });
  assert.equal(p.permissions.teacherAudioReview, false, "stopping retention stops teacher listening");
  await assert.rejects(privacy.setPermissions(parent.id, { teacherReview: "yes" }), (e) => e.status === 400);
  await assert.rejects(privacy.setPermissions(parent.id, { admin: true }), (e) => e.status === 400);
});

// --- PIN (FR-04) --------------------------------------------------------------------------------

test("the PIN is 4 to 6 digits, stored hashed, and checked before it can be changed", async () => {
  const parent = await newUser();
  for (const bad of ["123", "1234567", "12a4", "", undefined]) await assert.rejects(privacy.setPin(parent.id, { pin: bad }), (e) => e.code === "PIN_INVALID");
  await privacy.setPin(parent.id, { pin: "4821" });
  const stored = await store.tutorParents.get(parent.id);
  assert.ok(!JSON.stringify(stored).includes("4821"), "the PIN itself is never stored");
  await assert.rejects(privacy.setPin(parent.id, { pin: "9999" }), (e) => e.code === "PIN_INCORRECT", "changing needs the current PIN");
  await privacy.setPin(parent.id, { pin: "9999", currentPin: "4821" });
  await assert.rejects(privacy.verifyPin(parent.id, "4821"), (e) => e.code === "PIN_INCORRECT");
  assert.ok((await privacy.verifyPin(parent.id, "9999")).token);
});

test("five wrong PINs lock it for five minutes, and a right PIN afterwards works", async () => {
  const parent = await newUser();
  await privacy.setPin(parent.id, { pin: "4821" });
  const t0 = Date.parse("2026-11-24T03:00:00.000Z");
  for (let i = 0; i < privacy.MAX_FAILED_PINS; i += 1) await assert.rejects(privacy.verifyPin(parent.id, "0000", t0 + i), (e) => e.code === "PIN_INCORRECT");
  await assert.rejects(privacy.verifyPin(parent.id, "4821", t0 + 1000), (e) => e.code === "PIN_LOCKED" && e.retryAfterSeconds > 0, "even the right PIN is refused while locked");
  assert.ok((await privacy.verifyPin(parent.id, "4821", t0 + 6 * 60 * 1000)).token);
});

test("a PIN token expires, cannot be forged, and only works for its own parent", async () => {
  const [a, b] = [await newUser(), await newUser()];
  await privacy.setPin(a.id, { pin: "1111" });
  await privacy.setPin(b.id, { pin: "2222" });
  const now = Date.parse("2026-11-24T03:00:00.000Z");
  const { token } = await privacy.verifyPin(a.id, "1111", now);
  await privacy.assertPinToken(a.id, token, now + 1000);
  await assert.rejects(privacy.assertPinToken(a.id, token, now + privacy.TOKEN_TTL_MS + 1), (e) => e.code === "PIN_REQUIRED", "expired");
  await assert.rejects(privacy.assertPinToken(b.id, token, now + 1000), (e) => e.code === "PIN_REQUIRED", "another parent's token");
  const [exp, sig] = token.split(".");
  await assert.rejects(privacy.assertPinToken(a.id, `${Number(exp) + 999999}.${sig}`, now + 1000), (e) => e.code === "PIN_REQUIRED", "tampered expiry");
  await assert.rejects(privacy.assertPinToken(a.id, undefined, now), (e) => e.code === "PIN_REQUIRED");
  const noPin = await newUser();
  await assert.rejects(privacy.assertPinToken(noPin.id, token, now), (e) => e.code === "PIN_NOT_SET");
});

// --- daily limit (FR-04) ------------------------------------------------------------------------

test("a daily practice limit stops new lessons once the time is used", async () => {
  const parent = await newUser();
  const child = await tutor.createChild(parent.id, { nickname: "Mimi", age: 8 });
  await assert.rejects(privacy.setDailyLimit(parent.id, 3), (e) => e.status === 400);
  await assert.rejects(privacy.setDailyLimit(parent.id, 500), (e) => e.status === 400);
  await privacy.setDailyLimit(parent.id, 10);
  const first = await tutor.startSession(parent.id, { childId: child.id, topicId: "animals" }, { llm: null });
  // Pretend the first lesson ran for 11 minutes.
  const stored = await store.tutorSessions.get(first.id);
  stored.endedAt = new Date(new Date(stored.startedAt).getTime() + 11 * 60000).toISOString();
  stored.status = "abandoned";
  await store.tutorSessions.set(stored.id, stored);
  await assert.rejects(tutor.startSession(parent.id, { childId: child.id, topicId: "food" }, { llm: null }), (e) => e.code === "DAILY_LIMIT_REACHED");
  await privacy.setDailyLimit(parent.id, null);
  await tutor.startSession(parent.id, { childId: child.id, topicId: "food" }, { llm: null });
});

// --- export and deletion (FR-17) ----------------------------------------------------------------

test("a parent can export a child's data, without the answer key, and only their own", async () => {
  const { parent, child } = await family();
  const other = await newUser();
  const data = await tutor.exportChildData(parent.id, child.id);
  assert.equal(data.child.nickname, "Mimi");
  assert.equal(data.sessions[0].attempts.length, 5);
  assert.ok(!/acceptedAnswers|correctChoiceId|targetWords/.test(JSON.stringify(data)));
  assert.ok(data.progress.words.length > 0);
  await assert.rejects(tutor.exportChildData(other.id, child.id), (e) => e.status === 404);
});

test("deleting all tutor data removes profiles, sessions, progress and settings", async () => {
  const { parent, child, session } = await family({ allowReview: true });
  const result = await tutor.deleteAllData(parent.id);
  assert.deepEqual(result, { deleted: true, children: 1, sessionsDeleted: 1 });
  assert.equal(await store.tutorSessions.get(session.id), undefined);
  assert.equal(await store.tutorProgress.get(child.id), undefined);
  assert.equal(await store.tutorParents.get(parent.id), undefined);
  assert.equal((await tutor.listChildren(parent.id)).length, 0);
});

// --- teacher review (FR-19, FR-20) --------------------------------------------------------------

test("a teacher sees nothing until a parent allows review, and loses access the moment it is turned off", async () => {
  const teacher = await newUser();
  const { parent } = await family();
  await onlyReviewFor([]);
  assert.equal((await review.queue(teacher.id)).items.length, 0, "review is off by default");
  await privacy.setPermissions(parent.id, { teacherReview: true });
  const { items } = await review.queue(teacher.id);
  assert.equal(items.length, 5);
  const id = items[0].reviewId;
  assert.ok(await review.get(teacher.id, id));
  await privacy.setPermissions(parent.id, { teacherReview: false });
  assert.equal((await review.queue(teacher.id)).items.length, 0);
  await assert.rejects(review.get(teacher.id, id), (e) => e.status === 404);
  await assert.rejects(review.judge(teacher.id, id, { verdict: "agree" }), (e) => e.status === 404);
});

test("what a teacher sees is de-identified", async () => {
  const teacher = await newUser();
  const { parent, child } = await family({ allowReview: true });
  const { items } = await review.queue(teacher.id);
  const json = JSON.stringify(items);
  for (const secret of [parent.id, child.id, "Mimi", parent.email, "acceptedAnswers", "correctChoiceId", "startedAt", "audio"]) {
    assert.ok(!json.includes(secret), `leaked: ${secret}`);
  }
  const first = items.find((i) => i.activityType === "listen_repeat");
  assert.equal(first.target, "I see a cat");
  assert.equal(first.system.stars, 3);
  assert.ok(first.system.bands.length >= 2);
  assert.equal(first.ageBand, "B");
});

test("a teacher's view of a transcript is scrubbed even if it was stored earlier", async () => {
  const teacher = await newUser();
  const { parent, session } = await family({ allowReview: true });
  const stored = await store.tutorSessions.get(session.id);
  stored.attempts[0].response.transcript = "cat 0912345678 kid@home.com";
  await store.tutorSessions.set(stored.id, stored);
  const item = (await review.queue(teacher.id)).items.find((i) => i.reviewId === `${session.id}.i1`);
  assert.ok(!/0912345678|kid@home/.test(item.transcript));
  assert.ok(parent.id);
});

test("judgments record agreement and notes, feed the agreement rate, and go when the child is deleted", async () => {
  const teacher = await newUser();
  const { parent, child } = await family({ allowReview: true });
  await onlyReviewFor([parent.id]);
  const { items } = await review.queue(teacher.id);
  await review.judge(teacher.id, items[0].reviewId, { verdict: "agree" });
  await review.judge(teacher.id, items[1].reviewId, { verdict: "too_high", note: "she said it wrong, call 0912345678", contentIssue: true });
  await review.judge(teacher.id, items[2].reviewId, { verdict: "agree" });
  const left = await review.queue(teacher.id);
  assert.equal(left.items.length, 2, "judged items leave the default queue");
  assert.equal((await review.queue(teacher.id, { status: "all" })).items.length, 5);
  const noted = (await review.get(teacher.id, items[1].reviewId)).myJudgment;
  assert.equal(noted.contentIssue, true);
  assert.ok(!noted.note.includes("0912345678"), "notes are scrubbed too");
  assert.deepEqual(await review.summary(teacher.id), { reviewable: 5, judged: 3, agree: 2, tooHigh: 1, tooLow: 0, contentIssues: 1, agreementRate: 0.67 });
  await assert.rejects(review.judge(teacher.id, items[3].reviewId, { verdict: "great" }), (e) => e.status === 400);

  await tutor.deleteChild(parent.id, child.id);
  assert.equal((await store.tutorJudgments.values()).filter((j) => j.teacherId === teacher.id).length, 0);
  assert.equal((await review.summary(teacher.id)).reviewable, 0);
});

test("the review queue pages by review id", async () => {
  const teacher = await newUser();
  const { parent } = await family({ allowReview: true });
  await onlyReviewFor([parent.id]);
  const first = await review.queue(teacher.id, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.next);
  const second = await review.queue(teacher.id, { limit: 2, after: first.next });
  assert.ok(second.items.every((i) => i.reviewId > first.next));
  assert.equal(second.items.length, 2);
});

// --- HTTP: roles and the PIN flow ---------------------------------------------------------------

test("HTTP: review routes are for teachers only; privacy changes need the PIN", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, method = "GET", body, token, extra = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const signUp = async (email) => (await call("/auth/register", "POST", { name: "T", email, password: "secret1" })).data;

  // parent: consent, PIN, then allow review
  const parentAuth = await signUp("priv-parent@test.dev");
  await call("/tutor/consent", "POST", { version: privacy.CONSENT_VERSION }, parentAuth.token);
  await call("/tutor/pin", "POST", { pin: "4821" }, parentAuth.token);
  assert.equal((await call("/tutor/privacy/permissions", "PUT", { teacherReview: true }, parentAuth.token)).data.code, "PIN_REQUIRED");
  const wrong = await call("/tutor/pin/verify", "POST", { pin: "0000" }, parentAuth.token);
  assert.equal(wrong.data.code, "PIN_INCORRECT");
  const pin = { "X-Parent-Pin-Token": (await call("/tutor/pin/verify", "POST", { pin: "4821" }, parentAuth.token)).data.token };
  const set = await call("/tutor/privacy/permissions", "PUT", { teacherReview: true }, parentAuth.token, pin);
  assert.equal(set.data.privacy.permissions.teacherReview, true);
  assert.equal((await call("/tutor/privacy/limit", "PUT", { minutes: 20 }, parentAuth.token, pin)).data.privacy.dailyLimitMinutes, 20);
  const child = (await call("/tutor/children", "POST", { nickname: "Mimi", age: 9 }, parentAuth.token, pin)).data.child;
  const session = (await call("/tutor/sessions", "POST", { childId: child.id, topicId: "animals" }, parentAuth.token)).data.session;
  await call(`/tutor/sessions/${session.id}/attempts`, "POST", { itemId: "i1", response: say("I see a cat") }, parentAuth.token);

  // a parent is not a teacher
  assert.equal((await call("/tutor/review/queue", "GET", undefined, parentAuth.token)).status, 403);

  // a teacher is
  await onlyReviewFor([parentAuth.user.id]);
  const teacherAuth = await signUp("priv-teacher@test.dev");
  await store.users.set(teacherAuth.user.id, { ...(await store.users.get(teacherAuth.user.id)), role: "teacher" });
  const queue = await call("/tutor/review/queue", "GET", undefined, teacherAuth.token);
  assert.equal(queue.status, 200);
  assert.equal(queue.data.items.length, 1);
  const reviewId = queue.data.items[0].reviewId;
  const judged = await call(`/tutor/review/${encodeURIComponent(reviewId)}/judgment`, "POST", { verdict: "agree", note: "looks right" }, teacherAuth.token);
  assert.equal(judged.status, 201);
  assert.equal((await call("/tutor/review/summary", "GET", undefined, teacherAuth.token)).data.summary.agreementRate, 1);

  // export and full deletion over HTTP
  const exported = await call(`/tutor/children/${child.id}/export`, "GET", undefined, parentAuth.token, pin);
  assert.equal(exported.data.sessions[0].attempts.length, 1);
  assert.equal((await call("/tutor/data", "DELETE", undefined, parentAuth.token)).data.code, "PIN_REQUIRED");
  assert.equal((await call("/tutor/data", "DELETE", undefined, parentAuth.token, pin)).data.deleted, true);
  assert.equal((await call("/tutor/review/queue", "GET", undefined, teacherAuth.token)).data.items.length, 0);
});
