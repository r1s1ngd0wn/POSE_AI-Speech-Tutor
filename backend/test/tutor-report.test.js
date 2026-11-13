process.env.STORE_BACKEND = "memory";
delete process.env.TUTOR_LLM_PROVIDER;

const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const auth = require("../src/services/authService");
const tutor = require("../src/services/tutorSessionService");
const progress = require("../src/services/tutorProgressService");
const report = require("../src/services/tutorReportService");

const T0 = Date.parse("2026-11-02T03:00:00.000Z");
const at = (days) => new Date(T0 + days * 86400000).toISOString();
const child = { id: "child_r1", parentId: "p1", nickname: "Mimi", ageBand: "B" };

// Five lessons, getting better; clarity is the weakest criterion, participation the strongest.
let n = 0;
function lesson(day, stars, { topicId = "animals", mode = "speech", status = "completed", ms = 2500, clarity = 3 } = {}) {
  const criteria = [{ id: "clarity", band: clarity }, { id: "accuracy", band: 4 }, { id: "participation", band: 5 }].filter((c) => mode === "speech" || c.id !== "clarity");
  return {
    id: `s${++n}`, childId: child.id, topicId, status, startedAt: at(day), items: stars.map((_, i) => ({ id: `i${i}` })),
    attempts: stars.map((s) => ({ response: { mode, firstAttemptMs: ms }, result: { completed: true, stars: s, activityType: "listen_repeat", criteria } })),
  };
}
const RISING = [[1, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 3, 2, 2], [3, 2, 3, 3, 2], [3, 3, 3, 2, 3]];
const sessions = RISING.map((stars, i) => lesson(i, stars, { topicId: ["animals", "food"][i % 2] }));

function learner(extra = {}) {
  const p = progress.emptyProgress(child.id);
  const word = (form, box) => ({ form, box, seen: 4, correct: box, lastSeenAt: at(5), nextDueAt: at(5) });
  p.words = { cat: word("cat", 4), dog: word("dog", 4), bird: word("bird", 2), rabbit: word("rabbit", 1), apple: word("apple", 1) };
  p.streak = { current: 2, longest: 3, lastDay: progress.dayNumber(at(4)) };
  p.stickers = [{ id: "first_lesson" }];
  return { ...p, ...extra };
}
const facts = () => report.computeFacts({ progress: learner(), sessions, now: at(5) });

test("facts are computed by code from the stored scores", () => {
  const f = facts();
  assert.equal(f.enoughData, true);
  assert.equal(f.lessonsCompleted, 5);
  assert.equal(f.activitiesScored, 25);
  assert.equal(f.activeDays, 5);
  assert.equal(f.averageStars, 2.28);
  assert.equal(f.criteria.clarity.average, 3);
  assert.equal(f.criteria.participation.average, 5);
  assert.equal(f.criteria.completeness.samples, 0);
  assert.equal(f.strongestCriterion, "participation");
  assert.equal(f.weakestCriterion, "clarity");
  assert.deepEqual(f.starsTrend, { label: "improving", recentAvg: 2.53, earlierAvg: 1.9 });
  assert.deepEqual(f.words.masteredList.sort(), ["cat", "dog"]);
  assert.deepEqual(f.words.practiceList, ["rabbit", "apple", "bird"], "weakest words first");
  assert.equal(f.topics.animals.lessons + f.topics.food.lessons, 5);
  assert.equal(f.pictureAnswerShare, 0);
  assert.equal(f.averageSecondsToFirstAttempt, 2.5);
});

test("the stars trend is steady, improving or declining only when there is enough to compare", () => {
  const trend = (series) => report.computeFacts({ progress: learner(), sessions: series.map((s, i) => lesson(i, s)), now: at(9) }).starsTrend.label;
  assert.equal(trend([[2, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 2, 2, 2]]), "not enough data");
  assert.equal(trend([[2, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 2, 2, 2]]), "steady");
  assert.equal(trend([[1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [3, 3, 3, 3, 3], [3, 3, 3, 3, 3], [3, 3, 3, 3, 3]]), "improving");
  assert.equal(trend([[3, 3, 3, 3, 3], [3, 3, 3, 3, 3], [3, 3, 3, 3, 3], [2, 2, 2, 2, 2], [2, 2, 2, 2, 2], [2, 2, 2, 2, 2]]), "declining");
});

test("too little practice gives an honest 'not enough yet' report and never calls the model", async () => {
  let called = false;
  const few = sessions.slice(0, 2);
  const r = await report.buildReport({ child, progress: learner(), sessions: few, now: at(5) }, { llm: async () => { called = true; return { text: "{}" }; } });
  assert.equal(called, false);
  assert.equal(r.enoughData, false);
  assert.match(r.narrative.summary, /not enough practice yet/);
  assert.match(r.narrative.summary, /Mimi/);
  assert.deepEqual(r.narrative.strengths, []);
});

test("the template narrative is built from the facts and passes the same checks as a model narrative", () => {
  const f = facts();
  const template = report.templateNarrative(f);
  assert.deepEqual(report.checkNarrative(template, f), []);
  assert.match(template.summary, /5 lessons/);
  assert.match(template.summary, /2\.28 stars/);
  assert.ok(template.focus.some((s) => /speaking clearly/.test(s)));
});

const good = (f) => ({
  summary: `{child} has completed ${f.lessonsCompleted} lessons and earned ${f.averageStars} stars per activity on average. Results are improving.`,
  strengths: ["{child} joins in quickly (5 out of 5)."],
  focus: ['Practise the word "rabbit".'],
  suggestions: ["Find a picture of a rabbit and say its name together."],
});

test("a narrative supported by the facts is accepted", () => {
  assert.deepEqual(report.checkNarrative(good(facts()), facts()), []);
});

test("a model narrative is rejected when it invents numbers, words, diagnoses or comparisons", () => {
  const f = facts();
  const reject = (patch, pattern) => {
    const problems = report.checkNarrative({ ...good(f), ...patch }, f);
    assert.ok(problems.some((p) => pattern.test(p)), `${JSON.stringify(patch)} -> ${problems}`);
  };
  reject({ summary: "{child} has completed 9 lessons." }, /number not in the facts: 9/);
  reject({ summary: "{child} has completed seven lessons." }, /number not in the facts: 7/);
  reject({ summary: "{child} earned 2.9 stars on average." }, /number not in the facts: 2.9/);
  reject({ summary: "She has completed 5 lessons." }, /gendered/);
  reject({ summary: "{child} may have a learning delay." }, /not allowed/);
  reject({ summary: "{child} is ahead of other children." }, /not allowed/);
  reject({ summary: "{child} is working at CEFR A1." }, /not allowed/);
  reject({ summary: "Buy the premium app, {child}." }, /not allowed/);
  reject({ focus: ['Practise the word "dragon".'] }, /quoted word/);
  reject({ summary: "word ".repeat(100) }, /more than 90 words/);
  reject({ strengths: ["a", "b", "c", "d"] }, /at most 3/);
  reject({ suggestions: ["{child} did great 🎉"] }, /emoji/);
  reject({ summary: "{name} did well." }, /stray braces/);
  reject({ summary: "" }, /summary/);
  reject({ suggestions: ["Ask {child} about the topics from class."] }, /not allowed/);
  reject({ summary: "{child} has completed 3 lessons." }, /3 lessons does not match/);
  reject({ summary: "{child} scored 10 activities." }, /10 activities does not match/);
  reject({ strengths: ["Participation averages 5 stars."] }, /5 stars does not match/);
  reject({ summary: "{child} practised on 4 days." }, /4 days does not match/);
  reject({ focus: ["There are 7 words to practise."] }, /7 words does not match/);
  assert.deepEqual(report.checkNarrative({ ...good(f), strengths: ["{child} has 2 well-known words and averages 2.28 stars over 5 lessons."] }, f), []);
  reject({ focus: ["Practise answering in full phrases."] }, /mentions completeness, which was not measured/);
  assert.deepEqual(report.checkNarrative({ ...good(f), summary: "{child} did better compared to earlier lessons. 5 lessons are done." }, f), [], "comparing with their own earlier lessons is fine");
  reject({ summary: "{child} did better compared to other children." }, /not allowed/);
});

test("percentages of a share in the facts are allowed, other percentages are not", () => {
  const f = { ...facts(), pictureAnswerShare: 0.4 };
  const base = good(f);
  assert.deepEqual(report.checkNarrative({ ...base, focus: ["40% of answers were picture taps."] }, f), []);
  assert.ok(report.checkNarrative({ ...base, focus: ["45% of answers were picture taps."] }, f).length > 0);
});

test("a valid model narrative is used, the nickname is added by code, and the model never sees it", async () => {
  let seen;
  const f = facts();
  const r = await report.buildReport({ child, progress: learner(), sessions, now: at(5) }, {
    llm: async (args) => { seen = args; return { text: JSON.stringify(good(f)), model: "stub", usage: { prompt_tokens: 700, completion_tokens: 150 } }; },
  });
  assert.equal(r.narrative.source, "ai");
  assert.match(r.narrative.summary, /^Mimi has completed 5 lessons/);
  assert.ok(!/"needs"|minCompleted/.test(seen.system), "the report thresholds are not shown to the model");
  assert.ok(!seen.system.includes("Mimi") && !seen.system.includes(child.id), "no identity goes to the model");
  assert.match(seen.system, /"averageStars": 2.28/);
  assert.match(seen.system, /write exactly "\{child\}"/);
  assert.equal(r.meta.model, "stub");
  assert.match(r.meta.promptVersion, /^tutor-report\.v\d+$/);
});

test("an unsupported, unparsable or failing model falls back to the template, with the reason recorded", async () => {
  const f = facts();
  const cases = [
    [async () => ({ text: JSON.stringify({ ...good(f), summary: "{child} finished 12 lessons." }) }), (m) => assert.ok(m.rejected.length)],
    [async () => ({ text: "not json" }), (m) => assert.equal(m.llmError, "invalid_json")],
    [async () => ({ text: '{"summary":"x', finishReason: "length" }), (m) => assert.equal(m.llmError, "truncated")],
    [async () => { throw Object.assign(new Error("x"), { code: "timeout" }); }, (m) => assert.equal(m.llmError, "timeout")],
    [null, (m) => assert.equal(m.llmError, "not_configured")],
  ];
  for (const [llm, check] of cases) {
    const r = await report.buildReport({ child, progress: learner(), sessions, now: at(5) }, { llm });
    assert.equal(r.narrative.source, "template");
    assert.match(r.narrative.summary, /Mimi has completed 5 lessons/);
    check(r.meta);
  }
});

test("data notes warn when clarity or speech coverage is thin", () => {
  const picture = [0, 1, 2].map((d) => lesson(d, [2, 2, 2, 2, 2], { mode: "picture" }));
  const f = report.computeFacts({ progress: learner(), sessions: picture, now: at(5) });
  assert.equal(f.pictureAnswerShare, 1);
  assert.equal(f.criteria.clarity.samples, 0);
  assert.equal(f.dataNotes.length, 2);
  assert.equal(f.strongestCriterion, "participation", "ranking uses only criteria with enough samples");
});

let counter = 0;
const newParent = async () => (await auth.register({ email: `report${++counter}@test.dev`, password: "secret1", name: `Parent ${counter}` })).user;

async function childWithHistory(parentId) {
  const c = await tutor.createChild(parentId, { nickname: "Lily", ageBand: "B" });
  for (const [i, s] of RISING.entries()) await store.tutorSessions.set(`rs${c.id}${i}`, { ...lesson(i, s), id: `rs${c.id}${i}`, childId: c.id, parentId });
  return c;
}

test("a report is generated, stored for the parent, hidden from others and deleted with the child", async () => {
  const [a, b] = [await newParent(), await newParent()];
  const c = await childWithHistory(a.id);
  await assert.rejects(report.getReport(a.id, c.id), (e) => e.status === 404, "none yet");
  const made = await report.generateReport(a.id, c.id, { llm: null });
  assert.equal(made.enoughData, true);
  assert.match(made.disclaimer, /not a test/);
  assert.ok(!("meta" in made), "model details stay on the server");
  assert.deepEqual(await report.getReport(a.id, c.id), made);
  await assert.rejects(report.getReport(b.id, c.id), (e) => e.status === 404);
  await assert.rejects(report.generateReport(b.id, c.id, { llm: null }), (e) => e.status === 404);
  await tutor.deleteChild(a.id, c.id);
  assert.equal(await store.tutorReports.get(c.id), undefined);
});
