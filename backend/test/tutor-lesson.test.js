process.env.STORE_BACKEND = "memory";
const test = require("node:test");
const assert = require("node:assert/strict");

const lessons = require("../src/services/tutorLessonService");
const tutorLlm = require("../src/services/tutorLlm");
const { scoreAttempt } = require("../src/services/tutorScoringService");

const llmReturning = (value) => async () => ({ text: typeof value === "string" ? value : JSON.stringify(value), model: "stub-model", usage: { prompt_tokens: 900, completion_tokens: 200 } });

const goodLesson = {
  story: { character: "Momo", intro: "Momo is a little dragon. Momo likes animals." },
  items: [
    { activityType: "listen_repeat", say: "I see a dog" },
    { activityType: "name_picture", pictureKey: "rabbit" },
    { activityType: "name_picture", pictureKey: "duck" },
    { activityType: "answer_question", prompt: "Is a cat small?", acceptedAnswers: [{ text: "Yes it is", targetWords: ["yes"] }], choices: ["yes", "no"] },
    { activityType: "answer_question", prompt: "What animal do you like?", answerCategory: "animal", answerTemplate: "I like {w}" },
  ],
};
const request = { topicId: "animals", ageBand: "B" };

test("every vetted fallback lesson passes the validator for both age bands", () => {
  const topics = require("../src/data/tutorTopics.json").topics;
  for (const topicId of lessons.topicIds) {
    const story = lessons.normaliseStory(topics[topicId].fallback.story, topicId, "B");
    assert.deepEqual(story.reasons, [], `${topicId} story`);
    for (const ageBand of ["A", "B"]) assert.equal(lessons.fallbackItems(topicId, ageBand).length, 5, `${topicId} ${ageBand}`);
  }
});

test("a valid model lesson is used as written and recorded as AI-generated", async () => {
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(goodLesson) });
  assert.equal(lesson.meta.aiItems, 5);
  assert.equal(lesson.meta.fallbackItems, 0);
  assert.equal(lesson.meta.model, "stub-model");
  assert.match(lesson.meta.promptVersion, /^tutor-lesson\.v\d+$/);
  assert.deepEqual(lesson.items.map((i) => i.activityType), ["listen_repeat", "name_picture", "name_picture", "answer_question", "answer_question"]);
  assert.ok(lesson.items.every((i) => i.source === "ai"));
  assert.equal(lesson.story.character, "Momo");
});

test("a word outside the allowlist rejects that item and the vetted fallback fills the slot", async () => {
  const bad = structuredClone(goodLesson);
  bad.items[0] = { activityType: "listen_repeat", say: "I see a dinosaur" };
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
  assert.equal(lesson.items[0].source, "fallback");
  assert.equal(lesson.items[0].say, "I see a cat");
  assert.match(lesson.meta.rejected[0].reasons[0], /dinosaur/);
  assert.equal(lesson.meta.aiItems, 4);
  assert.equal(lesson.meta.fallbackItems, 1);
});

test("questions that ask for personal information are rejected", async () => {
  const bad = structuredClone(goodLesson);
  bad.items[3] = { activityType: "answer_question", prompt: "What is your name?", acceptedAnswers: [{ text: "Yes" }], choices: ["yes", "no"] };
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
  assert.equal(lesson.meta.aiItems, 4);
  assert.equal(lesson.meta.fallbackItems, 1);
  assert.ok(lesson.meta.rejected.some((r) => r.reasons.some((x) => /name/.test(x))));
  assert.ok(lesson.items.every((i) => !/your name/i.test(i.prompt)));
});

test("a franchise character name or invalid name falls back to the vetted story", async () => {
  for (const character of ["Pikachu", "Mo Mo", "X"]) {
    const bad = { ...goodLesson, story: { character, intro: "A little friend likes animals." } };
    const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
    assert.equal(lesson.story.character, "Momo", character);
    assert.ok(lesson.meta.rejected.some((r) => r.index === "story"));
  }
});

test("pictures outside the curated set or the topic are rejected", async () => {
  const bad = structuredClone(goodLesson);
  bad.items[1] = { activityType: "name_picture", pictureKey: "dinosaur" };
  bad.items[2] = { activityType: "name_picture", pictureKey: "moon" };
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
  assert.equal(lesson.meta.aiItems, 3);
  assert.ok(lesson.items[1].source === "fallback" && lesson.items[2].source === "fallback");
});

test("the model never supplies picture-fallback choices: code builds them", async () => {
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(goodLesson) });
  const picture = lesson.items[1];
  assert.equal(picture.choices.length, 3);
  assert.ok(picture.choices.some((c) => c.id === "rabbit"));
  assert.equal(picture.correctChoiceId, "rabbit");
  const again = await lessons.generateLesson(request, { llm: llmReturning(goodLesson) });
  assert.deepEqual(again.items[1].choices, picture.choices, "deterministic");
});

test("an open question expands into accepted answers that the scoring code can use", async () => {
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(goodLesson) });
  const open = lesson.items[4];
  assert.ok(open.acceptedAnswers.some((a) => a.text === "I like cat"));
  const spoken = scoreAttempt(open, { mode: "speech", transcript: "I like tigers", confidence: 0.9, firstAttemptMs: 3000 });
  assert.equal(spoken.stars, 3);
  const picture = scoreAttempt(open, { mode: "picture", choiceId: open.choices[0].id, firstAttemptMs: 3000 });
  assert.equal(picture.stars, 3, "any shown choice answers an open question");
});

test("a closed question needs picture-fallback choices unless it is yes/no", async () => {
  const bad = structuredClone(goodLesson);
  bad.items[3] = { activityType: "answer_question", prompt: "What do cows give?", acceptedAnswers: [{ text: "Milk", targetWords: ["milk"] }] };
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
  assert.equal(lesson.meta.aiItems, 4);
  assert.equal(lesson.meta.fallbackItems, 1);
  assert.ok(lesson.meta.rejected.some((r) => r.reasons.some((x) => /choices/.test(x))));
});

test("Band A has tighter length limits than Band B", async () => {
  const long = structuredClone(goodLesson);
  long.items[0] = { activityType: "listen_repeat", say: "I see a big cat here" };
  const b = await lessons.generateLesson({ ...request, ageBand: "B" }, { llm: llmReturning(long) });
  const a = await lessons.generateLesson({ ...request, ageBand: "A" }, { llm: llmReturning(long) });
  assert.equal(b.items[0].source, "ai");
  assert.equal(a.items[0].source, "fallback");
});

test("practice words from another topic are allowed; unknown ones are ignored", async () => {
  const lesson = { ...goodLesson, items: [{ activityType: "listen_repeat", say: "I see a dog" }, ...goodLesson.items.slice(1)] };
  const nature = { topicId: "nature", ageBand: "B", practiceWords: ["dog", "zebra"] };
  const fromNature = { ...lesson, items: [{ activityType: "listen_repeat", say: "I see a dog" }, { activityType: "name_picture", pictureKey: "tree" }, { activityType: "name_picture", pictureKey: "sun" }] };
  const withWord = await lessons.generateLesson(nature, { llm: llmReturning(fromNature) });
  assert.equal(withWord.items[0].source, "ai");
  const without = await lessons.generateLesson({ ...nature, practiceWords: [] }, { llm: llmReturning(fromNature) });
  assert.equal(without.items[0].source, "fallback");
  const zebra = { ...fromNature, items: [{ activityType: "listen_repeat", say: "I see a zebra" }, ...fromNature.items.slice(1)] };
  assert.equal((await lessons.generateLesson(nature, { llm: llmReturning(zebra) })).items[0].source, "fallback");
});

test("invalid JSON, a failing model, or no model all give a complete fallback lesson", async () => {
  const cases = [
    [llmReturning("not json at all"), "invalid_json"],
    [async () => { throw Object.assign(new Error("x"), { code: "timeout" }); }, "timeout"],
    [null, "not_configured"],
  ];
  for (const [llm, expected] of cases) {
    const lesson = await lessons.generateLesson(request, { llm });
    assert.equal(lesson.items.length, 5);
    assert.ok(lesson.items.every((i) => i.source === "fallback"));
    assert.equal(lesson.meta.llmError, expected);
  }
});

test("JSON inside a code fence is accepted", async () => {
  const lesson = await lessons.generateLesson(request, { llm: llmReturning("```json\n" + JSON.stringify(goodLesson) + "\n```") });
  assert.equal(lesson.meta.aiItems, 5);
});

test("the prompt carries the allowed words and the topic but nothing about the child", async () => {
  let seen;
  await lessons.generateLesson({ ...request, practiceWords: ["rabbit"] }, { llm: async (args) => { seen = args; return { text: JSON.stringify(goodLesson) }; } });
  assert.match(seen.system, /Animals/);
  assert.match(seen.system, /rabbit/);
  assert.match(seen.system, /listen_repeat, name_picture, name_picture, answer_question, answer_question/);
  assert.ok(!/\{\{/.test(seen.system), "all placeholders filled");
});

test("unknown topic is rejected", async () => {
  await assert.rejects(() => lessons.generateLesson({ topicId: "dinosaurs" }, { llm: null }), /Unknown topic/);
});

test("OpenRouter client: not configured without a key and model; sends the key only in a header", async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.TUTOR_LLM_PROVIDER;
  assert.equal(tutorLlm.status().enabled, false);
  await assert.rejects(() => tutorLlm.complete({ system: "s", user: "u" }), (e) => e.code === "not_configured");

  process.env.TUTOR_LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "sk-or-not-a-real-key";
  process.env.OPENROUTER_MODEL = "vendor/model-id";
  process.env.OPENROUTER_ZDR = "true";
  assert.ok(!JSON.stringify(tutorLlm.status()).includes("sk-or"));
  let request;
  t.mock.method(global, "fetch", async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ model: "vendor/model-id", choices: [{ message: { content: " {\"ok\":true} " } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  });
  const out = await tutorLlm.complete({ system: "s", user: "u" });
  assert.equal(out.text, '{"ok":true}');
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer sk-or-not-a-real-key");
  assert.ok(!request.init.body.includes("sk-or"));
  assert.equal(request.body.model, "vendor/model-id");
  assert.deepEqual(request.body.provider, { data_collection: "deny", zdr: true });
  assert.deepEqual(request.body.response_format, { type: "json_object" });
});

test("OpenRouter client: HTTP errors surface as coded errors without the response body", async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.TUTOR_LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "sk-or-not-a-real-key";
  process.env.OPENROUTER_MODEL = "vendor/model-id";
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "secret detail" } }) }));
  await assert.rejects(() => tutorLlm.complete({ system: "s", user: "u" }), (e) => e.code === "rate_limited" && !/secret detail/.test(e.message));
});

test("InterviewAI's local-model settings do not switch the tutor LLM on by themselves", (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  delete process.env.TUTOR_LLM_PROVIDER;
  process.env.LOCAL_LLM_URL = "http://127.0.0.1:1234/v1";
  process.env.LOCAL_LLM_MODEL = "gemma-4";
  assert.equal(tutorLlm.status().enabled, false);
});

test("local provider: needs no key, sends no OpenRouter fields, finds the loaded model when none is named", async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.TUTOR_LLM_PROVIDER = "local";
  process.env.LOCAL_LLM_URL = "http://127.0.0.1:1234/v1/";
  delete process.env.LOCAL_LLM_MODEL;
  delete process.env.LOCAL_LLM_API_KEY;
  assert.deepEqual(tutorLlm.status(), { enabled: true, provider: "local", model: null });
  const calls = [];
  t.mock.method(global, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/models")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "text-embedding-x" }, { id: "gemma-4" }] }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) };
  });
  const out = await tutorLlm.complete({ system: "s", user: "u" });
  assert.equal(out.model, "gemma-4");
  const chat = calls.find((c) => c.url.endsWith("/chat/completions"));
  assert.equal(chat.url, "http://127.0.0.1:1234/v1/chat/completions");
  const body = JSON.parse(chat.init.body);
  assert.equal(body.model, "gemma-4");
  assert.ok(!("provider" in body) && !("response_format" in body));
  assert.ok(!chat.init.headers.Authorization);
});

test("local provider: an unreachable server is a coded error, and prose around the JSON is tolerated", async (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.TUTOR_LLM_PROVIDER = "local";
  process.env.LOCAL_LLM_MODEL = "gemma-4";
  t.mock.method(global, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => tutorLlm.complete({ system: "s", user: "u" }), (e) => e.code === "unreachable");
  const wrapped = `Sure! Here is the lesson:
${JSON.stringify(goodLesson)}
Hope that helps.`;
  const lesson = await lessons.generateLesson(request, { llm: llmReturning(wrapped) });
  assert.equal(lesson.meta.aiItems, 5);
});

test("a category question must match its answer template", async () => {
  const mismatched = [
    { activityType: "answer_question", prompt: "What animal is this?", answerCategory: "animal", answerTemplate: "I like {w}" },
    { activityType: "answer_question", prompt: "Do you see the sun?", answerCategory: "animal", answerTemplate: "I like {w}" },
    { activityType: "answer_question", prompt: "What do you like?", answerCategory: "animal", answerTemplate: "I like {w}" },
  ];
  for (const item of mismatched) {
    const bad = { ...goodLesson, items: [...goodLesson.items.slice(0, 4), item] };
    const lesson = await lessons.generateLesson(request, { llm: llmReturning(bad) });
    assert.equal(lesson.meta.aiItems, 4, item.prompt);
    assert.equal(lesson.items[4].source, "fallback", item.prompt);
  }
});

test("a reply cut off by the token limit is reported as truncated", async () => {
  const lesson = await lessons.generateLesson(request, { llm: async () => ({ text: '{"story":{"character":"Momo","intro":"Momo is', finishReason: "length" }) });
  assert.equal(lesson.meta.llmError, "truncated");
  assert.equal(lesson.items.length, 5);
});

test("story narration may use the topic name and -s forms, but still not unknown words", () => {
  const ok = lessons.normaliseStory({ character: "Zuzu", intro: "Zuzu is tiny. Zuzu loves nature and sees the sun." }, "nature", "B");
  assert.deepEqual(ok.reasons, []);
  const bad = lessons.normaliseStory({ character: "Zuzu", intro: "Zuzu is a soldier. Zuzu loves nature." }, "nature", "B");
  assert.match(bad.reasons[0], /soldier/);
});

test("open questions can name their category in any topic", async () => {
  const lesson = { story: goodLesson.story, items: [{ activityType: "answer_question", prompt: "What color do you like?", answerCategory: "color", answerTemplate: "I like {w}" }] };
  const result = await lessons.generateLesson({ topicId: "nature", ageBand: "B" }, { llm: llmReturning(lesson) });
  assert.equal(result.meta.aiItems, 1);
  assert.equal(result.items.find((i) => i.source === "ai").prompt, "What color do you like?");
});
