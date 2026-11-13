const test = require("node:test");
const assert = require("node:assert/strict");

const { scoreAttempt, wordsMatch } = require("../src/services/tutorScoringService");

const band = (result, id) => result.criteria.find((c) => c.id === id).band;
const likeCats = { activityType: "listen_repeat", acceptedAnswers: ["I like cats"] };
const speech = (extra) => ({ mode: "speech", firstAttemptMs: 3000, confidence: 0.9, ...extra });

test("a clear, complete, quick repeat earns three stars", () => {
  const r = scoreAttempt(likeCats, speech({ transcript: "I like cats" }));
  assert.equal(r.stars, 3);
  assert.equal(band(r, "clarity"), 5);
  assert.equal(band(r, "accuracy"), 5);
  assert.equal(band(r, "participation"), 5);
  assert.equal(r.criteria.find((c) => c.id === "completeness").applicable, false);
});

test("scoring is deterministic and records the rubric version and inputs", () => {
  const args = [likeCats, speech({ transcript: "i like cat" })];
  assert.deepEqual(scoreAttempt(...args), scoreAttempt(...args));
  const r = scoreAttempt(...args);
  assert.match(r.rubricVersion, /^tutor-/);
  assert.equal(r.inputs.accuracy.targets, 3);
});

test("matching ignores case, punctuation, plurals and one slip on a long word", () => {
  assert.ok(wordsMatch("cat", "cats"));
  assert.ok(wordsMatch("elephant", "elephent"));
  assert.ok(!wordsMatch("cat", "bat"), "short words must match exactly");
  const r = scoreAttempt({ activityType: "name_picture", acceptedAnswers: ["an elephant"] }, speech({ transcript: "Elephent!" }));
  assert.equal(band(r, "accuracy"), 5);
});

test("articles are not counted as target words", () => {
  const r = scoreAttempt({ activityType: "name_picture", acceptedAnswers: ["a cat"] }, speech({ transcript: "cat" }));
  assert.equal(band(r, "accuracy"), 5);
});

test("accuracy bands follow the share of target words", () => {
  const item = { activityType: "listen_repeat", acceptedAnswers: ["red big dog runs"] };
  const accuracy = (transcript) => band(scoreAttempt(item, speech({ transcript })), "accuracy");
  assert.equal(accuracy("red big dog runs"), 5);
  assert.equal(accuracy("red big dog"), 4);
  assert.equal(accuracy("red big"), 3);
  assert.equal(accuracy("red"), 2);
  assert.equal(accuracy("blue"), 1);
});

test("Band A uses lower clarity thresholds than Band B", () => {
  const response = speech({ transcript: "I like cats", confidence: 0.78 });
  assert.equal(band(scoreAttempt(likeCats, response, { ageBand: "B" }), "clarity"), 4);
  assert.equal(band(scoreAttempt(likeCats, response, { ageBand: "A" }), "clarity"), 5);
});

test("clarity prefers per-word confidence of the matched target words", () => {
  const r = scoreAttempt(likeCats, speech({
    transcript: "I like cats",
    confidence: 0.99,
    wordConfidences: [{ word: "i", confidence: 0.99 }, { word: "like", confidence: 0.6 }, { word: "cats", confidence: 0.5 }],
  }));
  assert.equal(r.inputs.clarity.basis, "target words");
  assert.equal(band(r, "clarity"), 3, "mean of 0.99, 0.6, 0.5 = 0.70");
});

test("without any confidence, clarity is omitted and the other weights are normalised", () => {
  const r = scoreAttempt(likeCats, { mode: "speech", transcript: "I like cats", firstAttemptMs: 2000 });
  assert.equal(band(r, "clarity"), null);
  const weights = Object.fromEntries(r.criteria.map((c) => [c.id, c.weight]));
  assert.equal(weights.accuracy, 0.6);
  assert.equal(weights.participation, 0.4);
  assert.equal(r.stars, 3);
});

test("Answer the Question scores completeness against the expected phrase", () => {
  const item = { activityType: "answer_question", acceptedAnswers: [{ text: "I like red", targetWords: ["red"] }] };
  const completeness = (transcript) => band(scoreAttempt(item, speech({ transcript })), "completeness");
  assert.equal(completeness("I like red"), 5);
  assert.equal(completeness("like red"), 4, "one minor word missing");
  assert.equal(completeness("red"), 3, "key words present");
  assert.equal(completeness("blue"), 1);
});

test("the best of several accepted answers is used", () => {
  const item = { activityType: "answer_question", acceptedAnswers: ["I like red", "I like blue"] };
  const r = scoreAttempt(item, speech({ transcript: "I like blue" }));
  assert.equal(r.inputs.matchedAnswer, "I like blue");
  assert.equal(band(r, "completeness"), 5);
});

test("participation: speed, second attempt, hint", () => {
  const part = (extra) => band(scoreAttempt(likeCats, speech({ transcript: "I like cats", ...extra })), "participation");
  assert.equal(part({ firstAttemptMs: 4000 }), 5);
  assert.equal(part({ firstAttemptMs: 8000 }), 4);
  assert.equal(part({ firstAttemptMs: 12000 }), 3);
  assert.equal(part({ attemptCount: 2 }), 2);
  assert.equal(part({ hintUsed: true, attemptCount: 2 }), 1);
});

test("picture-choice fallback scores accuracy and participation only", () => {
  const item = { activityType: "name_picture", acceptedAnswers: ["cat"], correctChoiceId: "cat" };
  const good = scoreAttempt(item, { mode: "picture", choiceId: "cat", firstAttemptMs: 2000 });
  assert.equal(good.stars, 3);
  assert.equal(band(good, "clarity"), null);
  const bad = scoreAttempt(item, { mode: "picture", choiceId: "dog", firstAttemptMs: 2000, attemptCount: 2 });
  assert.equal(band(bad, "accuracy"), 1);
  assert.equal(bad.stars, 1);
});

test("an abandoned activity has no stars and no bands", () => {
  const r = scoreAttempt(likeCats, { mode: "abandoned" });
  assert.equal(r.completed, false);
  assert.equal(r.stars, null);
  assert.deepEqual(r.criteria, []);
});

test("an attempted but unrecognised response still completes with one star", () => {
  const r = scoreAttempt(likeCats, speech({ transcript: "", confidence: 0.2 }));
  assert.equal(r.completed, true);
  assert.equal(r.stars, 1);
});

test("star thresholds are exact: a weighted band of 4.0 is three stars, 2.5 is two", () => {
  const item = { activityType: "listen_repeat", acceptedAnswers: ["red big dog runs"] };
  const three = scoreAttempt(item, speech({ transcript: "red big dog", confidence: 0.75, firstAttemptMs: 8000 }));
  assert.equal(three.weightedBand, 4);
  assert.equal(three.stars, 3);
  const two = scoreAttempt({ activityType: "answer_question", acceptedAnswers: [{ text: "I like red", targetWords: ["red"] }] },
    speech({ transcript: "red", confidence: 0.5, firstAttemptMs: 12000 }));
  assert.equal(two.stars, 2, `weighted band was ${two.weightedBand}`);
});

test("invalid input is rejected", () => {
  assert.throws(() => scoreAttempt({ activityType: "free_chat", acceptedAnswers: ["x"] }, speech({ transcript: "x" })), /Unknown activity/);
  assert.throws(() => scoreAttempt({ activityType: "listen_repeat" }, speech({ transcript: "x" })), /accepted answer/);
  assert.throws(() => scoreAttempt(likeCats, { mode: "typed" }), /Unknown response mode/);
});
