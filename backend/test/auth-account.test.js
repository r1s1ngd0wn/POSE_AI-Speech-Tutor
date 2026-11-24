process.env.STORE_BACKEND = "memory";

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const accounts = require("../src/services/accountService");
const tutor = require("../src/services/tutorSessionService");
const privacy = require("../src/services/tutorPrivacyService");
const { seedTestAccount, PARENT, TEACHER } = require("../src/db/seed");

let counter = 0;
async function newUser() {
  counter += 1;
  return auth.register({ email: `user${counter}@test.dev`, password: "secret1", name: `User ${counter}` });
}

test("login without a password is a 400, not a crash", async () => {
  await newUser();
  await assert.rejects(auth.login({ email: "user1@test.dev" }), (err) => err.status === 400);
  await assert.rejects(auth.login({ email: "user1@test.dev", password: 123456 }), (err) => err.status === 400);
});

test("wrong password is a 401 and correct password works", async () => {
  await assert.rejects(auth.login({ email: "user1@test.dev", password: "wrong-one" }), (err) => err.status === 401);
  assert.ok((await auth.login({ email: "user1@test.dev", password: "secret1" })).token);
});

test("register validates email, name and password", async () => {
  await assert.rejects(auth.register({ email: "nope", password: "secret1", name: "A" }), (e) => e.status === 400);
  await assert.rejects(auth.register({ email: "a@b.dev", password: "123", name: "A" }), (e) => e.status === 400);
  await assert.rejects(auth.register({ email: "a@b.dev", password: "secret1", name: "  " }), (e) => e.status === 400);
});

test("concurrent registration cannot replace another account's email mapping", async () => {
  const email = `race${++counter}@test.dev`;
  const results = await Promise.allSettled([
    auth.register({ email, password: "secret1", name: "First" }),
    auth.register({ email, password: "secret1", name: "Second" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  const winner = results.find((result) => result.status === "fulfilled").value.user;
  assert.equal(await store.usersByEmail.get(email), winner.id);
});

test("expired tokens are rejected and removed; revoked tokens stop working", async () => {
  const { token } = await newUser();
  assert.ok(await auth.getUserFromToken(token));
  const record = await store.tokens.get(token);
  await store.tokens.set(token, { ...record, expiresAt: Date.now() - 1 });
  assert.equal(await auth.getUserFromToken(token), null);
  assert.equal(await store.tokens.has(token), false);

  const second = await newUser();
  await auth.revokeToken(second.token);
  assert.equal(await auth.getUserFromToken(second.token), null);
});

test("the memory-preview test logins are a parent and a teacher, and seeding twice is harmless", async () => {
  await seedTestAccount();
  await seedTestAccount();
  const parent = await auth.login({ email: PARENT.email, password: PARENT.password });
  const teacher = await auth.login({ email: TEACHER.email, password: TEACHER.password });
  assert.notEqual(parent.user.role, "teacher");
  assert.equal((await store.users.get(teacher.user.id)).role, "teacher");
});

test("account export includes the tutor data of the parent's children and never the password", async () => {
  const { user } = await newUser();
  await privacy.recordConsent(user.id, privacy.CONSENT_VERSION);
  const child = await tutor.createChild(user.id, { nickname: "Mimi", age: 7 });
  const session = await tutor.startSession(user.id, { childId: child.id, topicId: "animals" }, { llm: null });
  await tutor.submitAttempt(user.id, session.id, { itemId: "i1", response: { mode: "speech", transcript: "I see a cat", firstAttemptMs: 1000 } });

  const exported = await accounts.exportData(user.id);
  assert.equal(exported.user.passwordHash, undefined);
  assert.equal(exported.children.length, 1);
  assert.equal(exported.children[0].child.nickname, "Mimi");
  assert.equal(exported.children[0].sessions[0].attempts.length, 1);
  assert.equal(exported.privacy.consent.upToDate, true);
  assert.deepEqual(exported.aiRequests, []);
});

test("account deletion removes the user, all tutor data and tokens", async () => {
  const { user, token } = await newUser();
  await privacy.recordConsent(user.id, privacy.CONSENT_VERSION);
  const child = await tutor.createChild(user.id, { nickname: "Mimi", age: 7 });
  const session = await tutor.startSession(user.id, { childId: child.id, topicId: "animals" }, { llm: null });

  await accounts.deleteAccount(user.id);
  assert.equal(await store.users.has(user.id), false);
  assert.equal(await store.usersByEmail.has(user.email), false);
  assert.equal(await store.tokens.has(token), false);
  assert.equal(await store.tutorChildren.get(child.id), undefined);
  assert.equal(await store.tutorSessions.get(session.id), undefined);
  assert.equal(await store.tutorParents.get(user.id), undefined);
});
