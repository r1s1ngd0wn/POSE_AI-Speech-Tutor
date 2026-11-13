process.env.STORE_BACKEND = "memory";
delete process.env.TUTOR_LLM_PROVIDER;

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const tutor = require("../src/services/tutorSessionService");
const progress = require("../src/services/tutorProgressService");
const { scoreAttempt } = require("../src/services/tutorScoringService");

const T0 = "2026-11-10T03:00:00.000Z"; // 10:00 in the pilot's UTC+7
const day = (n, hour = 3) => new Date(Date.parse(T0) + n * 86400000 + (hour - 3) * 3600000).toISOString();

const repeatCat = { activityType: "listen_repeat", say: "I see a cat", acceptedAnswers: [{ text: "I see a cat" }], choices: [{ id: "cat" }, { id: "dog" }, { id: "cow" }], correctChoiceId: "cat" };
const speech = (transcript) => ({ mode: "speech", transcript, confidence: 0.9, firstAttemptMs: 2000 });
const attempt = (p, item, response, at = T0) => progress.applyAttempt(p, { item, result: scoreAttempt(item, response), mode: response.mode, at });

test("only topic vocabulary is tracked: function words like 'I' and 'see' are not", () => {
  const p = attempt(progress.emptyProgress("c1"), repeatCat, speech("I see a cat"));
  assert.deepEqual(Object.keys(p.words), ["cat"]);
  assert.equal(p.words.cat.box, 2);
  assert.equal(p.words.cat.correct, 1);
});

test("saying a word right moves it up a box, missing it moves it down, and never below box 1", () => {
  let p = progress.emptyProgress("c1");
  for (let i = 0; i < 3; i += 1) p = attempt(p, repeatCat, speech("I see a cat"));
  assert.equal(p.words.cat.box, 4);
  p = attempt(p, repeatCat, speech("I see a dog"));
  assert.equal(p.words.cat.box, 3);
  for (let i = 0; i < 5; i += 1) p = attempt(p, repeatCat, speech("hello"));
  assert.equal(p.words.cat.box, 1);
  assert.equal(p.words.cat.seen, 9);
});

test("tapping the right picture counts for less than saying the word", () => {
  let p = attempt(progress.emptyProgress("c1"), repeatCat, { mode: "picture", choiceId: "cat", firstAttemptMs: 2000 });
  assert.equal(p.words.cat.box, 2);
  p = attempt(p, repeatCat, { mode: "picture", choiceId: "cat", firstAttemptMs: 2000 });
  assert.equal(p.words.cat.box, 2, "pictures alone cannot lift a word past box 2");
  p = attempt(p, repeatCat, speech("I see a cat"));
  assert.equal(p.words.cat.box, 3);
});

test("a wrong picture counts as a miss, and an abandoned activity changes nothing", () => {
  let p = attempt(progress.emptyProgress("c1"), repeatCat, speech("I see a cat"));
  p = attempt(p, repeatCat, { mode: "picture", choiceId: "dog", firstAttemptMs: 2000 });
  assert.equal(p.words.cat.box, 1);
  const before = JSON.stringify(p.words);
  p = attempt(p, repeatCat, { mode: "abandoned" });
  assert.equal(JSON.stringify(p.words), before);
});

test("on an open question, naming a different animal is not a miss for the others", () => {
  const open = {
    activityType: "answer_question", answerCategory: "animal",
    acceptedAnswers: ["cat", "dog", "bird"].map((w) => ({ text: `I like ${w}`, targetWords: [w] })),
    choices: [{ id: "cat" }], correctChoiceId: ["cat"],
  };
  let p = attempt(progress.emptyProgress("c1"), open, speech("I like dog"));
  assert.deepEqual(Object.keys(p.words), ["dog"]);
  p = attempt(p, open, speech("blue"));
  assert.deepEqual(Object.keys(p.words), ["dog"], "no word is blamed when nothing matched");
});

test("plural forms share one entry and keep the first form seen", () => {
  const apples = { activityType: "listen_repeat", say: "I like apples", acceptedAnswers: [{ text: "I like apples" }] };
  let p = attempt(progress.emptyProgress("c1"), apples, speech("I like apples"));
  p = attempt(p, { ...apples, say: "I like apple", acceptedAnswers: [{ text: "I like apple" }] }, speech("I like apple"));
  assert.equal(Object.keys(p.words).length, 1);
  assert.equal(p.words.apple.form, "apples");
  assert.equal(p.words.apple.seen, 2);
});

test("review intervals grow with the box, and practice words are the weakest or due ones", () => {
  let p = progress.emptyProgress("c1");
  p = attempt(p, repeatCat, speech("I see a dog"), T0); // cat missed: box 1, due now
  const dog = { ...repeatCat, say: "I see a dog", acceptedAnswers: [{ text: "I see a dog" }], correctChoiceId: "dog" };
  p = attempt(p, dog, speech("I see a dog"), T0); // dog right: box 2, due tomorrow
  assert.deepEqual(progress.practiceWordsFor(p, T0), ["cat"]);
  assert.deepEqual(progress.practiceWordsFor(p, day(1)), ["cat", "dog"], "dog is due after a day");
  assert.equal(p.words.dog.nextDueAt, day(1));
  p = attempt(p, dog, speech("I see a dog"), day(1)); // box 3: due in 3 days
  assert.equal(p.words.dog.nextDueAt, day(4));
  assert.deepEqual(progress.practiceWordsFor(p, day(2)), ["cat"]);
  assert.deepEqual(progress.practiceWordsFor(p, day(2), 0), []);
});

const fakeSession = (stars, extra = {}) => ({
  id: `s${Math.random()}`, topicId: "animals", level: 2, items: stars.map((_, i) => ({ id: `i${i}` })),
  attempts: stars.map((s, i) => ({ itemId: `i${i}`, result: s === null ? { completed: false, stars: null } : { completed: true, stars: s } })), ...extra,
});

test("streak: consecutive days add up, a gap resets it, the same day counts once", () => {
  let p = progress.emptyProgress("c1");
  const done = (at) => { p = progress.completeSession(p, fakeSession([2, 2, 2, 2, 2]), at).progress; };
  done(day(0));
  done(day(0, 9));
  assert.equal(p.streak.current, 1);
  done(day(1));
  done(day(2));
  assert.equal(p.streak.current, 3);
  done(day(5));
  assert.equal(p.streak.current, 1);
  assert.equal(p.streak.longest, 3);
  assert.equal(progress.viewOf(p, day(5)).streak.current, 1);
  assert.equal(progress.viewOf(p, day(9)).streak.current, 0, "a missed stretch shows as no current streak");
});

test("difficulty rises after strong lessons in a row and falls after weak ones", () => {
  let p = progress.emptyProgress("c1");
  const done = (stars, at) => { p = progress.completeSession(p, fakeSession(stars, { level: p.level }), at).progress; };
  done([3, 3, 3, 3, 3], day(0));
  done([3, 3, 3, 2, 3], day(1));
  assert.equal(p.level, 2, "two strong lessons are not enough");
  done([3, 3, 2, 3, 3], day(2));
  assert.equal(p.level, 3);
  done([3, 3, 3, 3, 3], day(3));
  done([3, 3, 3, 3, 3], day(4));
  done([3, 3, 3, 3, 3], day(5));
  assert.equal(p.level, 3, "capped at 3");
  done([1, 1, 2, 1, 1], day(6));
  assert.equal(p.level, 3, "one weak lesson is not enough");
  done([1, 1, 1, 2, 1], day(7));
  assert.equal(p.level, 2);
  done([1, 1, 1, 1, 1], day(8));
  assert.equal(p.level, 2, "sessions at the old level no longer count");
});

test("a lesson with too few scored activities does not move the level", () => {
  let p = progress.emptyProgress("c1");
  for (let i = 0; i < 4; i += 1) p = progress.completeSession(p, fakeSession([3, null, null, null, null]), day(i)).progress;
  assert.equal(p.level, 2);
  assert.equal(p.recentSessions.length, 0);
});

test("stickers are awarded by rule, once each", () => {
  let p = progress.emptyProgress("c1");
  let r = progress.completeSession(p, fakeSession([3, 3, 3, 3, 3]), day(0));
  assert.deepEqual(r.newStickers.sort(), ["explorer_animals", "first_lesson", "perfect_lesson"]);
  r = progress.completeSession(r.progress, fakeSession([3, 3, 3, 3, 3]), day(1));
  assert.deepEqual(r.newStickers, [], "nothing is awarded twice");
  r = progress.completeSession(r.progress, fakeSession([2, 2, 2, 2, 2]), day(2));
  assert.deepEqual(r.newStickers, ["streak_3"]);
  assert.equal(new Set(r.progress.stickers.map((s) => s.id)).size, r.progress.stickers.length);
});

test("mastery stickers come from the number of mastered words", () => {
  let p = progress.emptyProgress("c1");
  for (const w of ["cat", "dog", "bird", "fish", "cow"]) p.words[w] = { form: w, box: 4, seen: 3, correct: 3, lastSeenAt: T0, nextDueAt: day(7) };
  const r = progress.completeSession(p, fakeSession([2, 2, 2, 2, 2], { topicId: "food" }), T0);
  assert.ok(r.newStickers.includes("words_5"));
  assert.ok(!r.newStickers.includes("words_10"));
});

// --- through the session API --------------------------------------------------------------------

let counter = 0;
const newParent = async () => (await auth.register({ email: `progress${++counter}@test.dev`, password: "secret1", name: `Parent ${counter}` })).user;
const say = (transcript) => ({ mode: "speech", transcript, confidence: 0.9, firstAttemptMs: 2000 });

async function playAnimals(parentId, childId, answers) {
  const session = await tutor.startSession(parentId, { childId, topicId: "animals" }, { llm: null });
  let last;
  for (const [i, response] of answers.entries()) last = await tutor.submitAttempt(parentId, session.id, { itemId: `i${i + 1}`, response });
  return { session, last };
}

test("playing lessons builds word progress, rewards and practice words for the next lesson", async () => {
  const parent = await newParent();
  const child = await tutor.createChild(parent.id, { nickname: "Mimi", ageBand: "B" });
  assert.deepEqual((await tutor.getChildProgress(parent.id, child.id)).progress.words, []);

  // fallback animals lesson: i1 Say "I see a cat", i2 picture cat, i3 picture dog, i4 yes/no, i5 favourite animal
  const first = await playAnimals(parent.id, child.id, [say("I see a cat"), say("dog"), say("dog"), say("yes"), say("I like tigers")]);
  assert.equal(first.last.done, true);
  assert.deepEqual(first.last.rewards.newStickers.map((s) => s.id).sort(), ["explorer_animals", "first_lesson"]);
  assert.equal(first.last.rewards.streak, 1);

  const view = (await tutor.getChildProgress(parent.id, child.id)).progress;
  const byWord = Object.fromEntries(view.words.map((w) => [w.word, w]));
  assert.equal(byWord.cat.correct, 1 + 0, "'cat' was said in the repeat but missed when naming the first picture");
  assert.equal(byWord.cat.status, "needs practice");
  assert.equal(byWord.dog.status, "learning");
  assert.ok(byWord.tiger, "an open answer is remembered");
  assert.deepEqual(view.wordsToPractice, ["cat"]);
  assert.equal(view.sessionsCompleted, 1);
  assert.equal(view.favouriteTopic, "animals");

  const second = await tutor.startSession(parent.id, { childId: child.id, topicId: "animals" }, { llm: null });
  const stored = await store.tutorSessions.get(second.id);
  assert.deepEqual(stored.lessonMeta.practiceWords, ["cat"]);
  assert.equal(stored.level, 2);
});

test("the level used for a lesson is stored with it, and practice words reach the model prompt", async () => {
  const parent = await newParent();
  const child = await tutor.createChild(parent.id, { nickname: "Tom", ageBand: "B" });
  await store.tutorProgress.set(child.id, { ...progress.emptyProgress(child.id), level: 3, words: { rabbit: { form: "rabbit", box: 1, seen: 2, correct: 0, lastSeenAt: T0, nextDueAt: T0 } } });
  let seen;
  await tutor.startSession(parent.id, { childId: child.id, topicId: "nature" }, { llm: async (args) => { seen = args.system; return { text: "{}" }; } });
  assert.match(seen, /rabbit/);
  assert.match(seen, /a little harder than usual/);
});

test("progress is private to the parent and is deleted with the child profile", async () => {
  const [a, b] = [await newParent(), await newParent()];
  const child = await tutor.createChild(a.id, { nickname: "Mimi", ageBand: "A" });
  await playAnimals(a.id, child.id, [say("I see a cat")]);
  assert.ok(await store.tutorProgress.get(child.id));
  await assert.rejects(tutor.getChildProgress(b.id, child.id), (e) => e.status === 404);
  await tutor.deleteChild(a.id, child.id);
  assert.equal(await store.tutorProgress.get(child.id), undefined);
});

test("an abandoned lesson keeps the word progress but earns no stickers or streak", async () => {
  const parent = await newParent();
  const child = await tutor.createChild(parent.id, { nickname: "Mimi", ageBand: "B" });
  const { session } = await playAnimals(parent.id, child.id, [say("I see a cat")]);
  await tutor.finishSession(parent.id, session.id);
  const view = (await tutor.getChildProgress(parent.id, child.id)).progress;
  assert.equal(view.words.length, 1);
  assert.equal(view.sessionsCompleted, 0);
  assert.deepEqual(view.stickers, []);
});
