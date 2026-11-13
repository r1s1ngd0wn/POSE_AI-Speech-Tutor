// Lesson generation for the tutor (supervisor points 1 and 2).
//
// The language model writes the story setup and the lesson items. Nothing it writes reaches a child
// until code has validated it, and code, not the model, builds everything that affects scoring:
//   - words must come from an allowlist (base words + the topic's words + practice words + the
//     character's name), which also keeps unsafe vocabulary out;
//   - pictures come from a curated set, and the picture-choice fallback choices are built by code;
//   - open questions name a category and a template and code expands the accepted answers;
//   - questions may not ask for personal information.
// An item that fails validation is replaced from the topic's vetted fallback lesson, so a bad or
// missing model answer degrades the lesson but never breaks it. The result records which items came
// from the model and why others were rejected, so a lesson can be audited and reproduced.

const topicsData = require("../data/tutorTopics.json");
const wordsData = require("../data/tutorWords.json");
const { pictures } = require("../data/tutorPictures.json");
const prompts = require("../prompts");
const { tokens } = require("./tutorScoringService");
const tutorLlm = require("./tutorLlm");

const ACTIVITY_TYPES = ["listen_repeat", "name_picture", "answer_question"];
const BASE_MIX = ["listen_repeat", "name_picture", "name_picture", "answer_question", "answer_question"];
const LIMITS = {
  A: { say: 5, question: 7, answer: 4, rules: "a child aged 6 to 7 who knows only a few English words. Use the very simplest words and the shortest sentences." },
  B: { say: 8, question: 12, answer: 7, rules: "a child aged 8 to 10 who knows some basic English. Use simple words and short sentences." },
};
// Difficulty level 1-3 within an age band: level 1 asks for slightly shorter sentences, level 3 slightly longer.
const LEVEL_DELTA = { 1: -1, 2: 0, 3: 1 };
const LEVEL_TEXT = {
  1: "Difficulty: easier than usual. Use the shortest, most familiar words.",
  2: "Difficulty: standard.",
  3: "Difficulty: a little harder than usual. Sentences may be slightly longer, but keep every word on the allowed lists.",
};
function limitsFor(ageBand, level = 2) {
  const base = LIMITS[ageBand];
  const delta = LEVEL_DELTA[level] ?? 0;
  const adjust = (n) => Math.max(2, n + delta);
  return { say: adjust(base.say), question: adjust(base.question), answer: adjust(base.answer), rules: `${base.rules} ${LEVEL_TEXT[level] ?? LEVEL_TEXT[2]}` };
}
const STORY_MAX_WORDS = 20;
const TEXT_OK = /^[A-Za-z' ?.!,:]+$/;
const PERSONAL = /\b(your name|my name|name is|address|phone|email|school|live|lives|home|how old|years old|birthday|password|mom|mum|mother|dad|father|where are you from|surname)\b/i;
const NAME_OK = /^[A-Z][a-z]{1,9}$/;
const BASE_WORDS = new Set(tokens(wordsData.baseWords));
const STORY_WORDS = new Set(tokens(wordsData.storyWords));

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h;
}
// Deterministic "shuffle": the same inputs always give the same order.
const orderBy = (list, salt) => [...list].sort((a, b) => hash(`${salt}:${a}`) - hash(`${salt}:${b}`) || (a < b ? -1 : 1));

const topicVocab = (topicId) => new Set(tokens(topicsData.topics[topicId].vocab));

// Every word the app knows about; learner-model practice words outside this set are ignored.
const KNOWN_WORDS = new Set([...BASE_WORDS, ...Object.keys(topicsData.topics).flatMap((id) => [...topicVocab(id)])]);

function allowedWords({ topicId, practiceWords, character }) {
  // The category names are needed to ask open questions in any topic ("What color do you like?").
  const allowed = new Set([...BASE_WORDS, ...topicVocab(topicId), ...Object.keys(topicsData.categories)]);
  for (const w of practiceWords) if (KNOWN_WORDS.has(w)) allowed.add(w);
  if (character) allowed.add(character.toLowerCase());
  return allowed;
}

// --- text checks -------------------------------------------------------------------------------

function checkText(text, { allowed, maxWords, label }) {
  const reasons = [];
  if (typeof text !== "string" || !text.trim()) return [`${label}: missing`];
  const clean = text.replace(/[‘’]/g, "'");
  if (!TEXT_OK.test(clean)) reasons.push(`${label}: unsupported characters`);
  if (PERSONAL.test(clean)) reasons.push(`${label}: asks for or mentions personal information`);
  const words = tokens(clean);
  if (!words.length) reasons.push(`${label}: no words`);
  if (words.length > maxWords) reasons.push(`${label}: too long (${words.length} words, max ${maxWords})`);
  const unknown = [...new Set(words.filter((w) => !allowed.has(w)))];
  if (unknown.length) reasons.push(`${label}: words not allowed: ${unknown.join(", ")}`);
  return reasons;
}

const stripEnd = (text) => String(text).trim().replace(/[.!?,:\s]+$/, "");

// --- item normalisation ------------------------------------------------------------------------

function choiceFor(id, label) {
  const picture = pictures[id] || pictures[label];
  return { id, label, ...(picture ? { emoji: picture.emoji } : {}) };
}

function pictureChoices(topic, key) {
  const others = orderBy(topic.pictures.filter((k) => k !== key), key).slice(0, 2);
  const ids = orderBy([key, ...others], `${key}:order`);
  return ids.map((id) => choiceFor(id, id));
}

function wordChoices(words) {
  return words.map((w) => choiceFor(w, w));
}

// Returns { item } for a usable item or { reasons } for a rejected one.
function normaliseItem(raw, ctx) {
  const { ageBand, level, topic, allowed } = ctx;
  const limits = limitsFor(ageBand, level);
  if (!raw || typeof raw !== "object") return { reasons: ["item is not an object"] };
  const type = raw.activityType;
  if (!ACTIVITY_TYPES.includes(type)) return { reasons: [`unknown activity type: ${type}`] };

  if (type === "listen_repeat") {
    const reasons = checkText(raw.say, { allowed, maxWords: limits.say, label: "say" });
    if (reasons.length) return { reasons };
    const say = stripEnd(raw.say);
    // If the sentence names something we have a picture for, a child who cannot use the microphone
    // can tap that picture instead; otherwise this activity has no picture fallback.
    const spoken = tokens(say);
    const key = topic.pictures.find((k) => spoken.includes(k) || spoken.includes(`${k}s`));
    return {
      item: {
        activityType: type, prompt: `Say: ${say}.`, say, acceptedAnswers: [{ text: say }],
        choices: key ? pictureChoices(topic, key) : null, correctChoiceId: key ?? null,
      },
    };
  }

  if (type === "name_picture") {
    const key = raw.pictureKey;
    if (!pictures[key] || !topic.pictures.includes(key)) return { reasons: [`picture not allowed for this topic: ${key}`] };
    return {
      item: {
        activityType: type,
        prompt: pictures[key].topic === "colors" ? "What color is this?" : "What is this?",
        pictureKey: key,
        picture: { emoji: pictures[key].emoji },
        acceptedAnswers: [{ text: key, targetWords: [key] }],
        choices: pictureChoices(topic, key),
        correctChoiceId: key,
      },
    };
  }

  // answer_question
  const reasons = checkText(raw.prompt, { allowed, maxWords: limits.question, label: "prompt" });
  if (typeof raw.prompt === "string" && !raw.prompt.trim().endsWith("?")) reasons.push("prompt: must end with a question mark");
  if (reasons.length) return { reasons };
  const prompt = raw.prompt.trim();

  if (raw.answerCategory !== undefined) {
    const words = topicsData.categories[raw.answerCategory];
    if (!words) return { reasons: [`unknown answer category: ${raw.answerCategory}`] };
    const template = String(raw.answerTemplate || "");
    if (template.split("{w}").length !== 2) return { reasons: ["answerTemplate: must contain {w} exactly once"] };
    // The question and the answer sentence must fit each other ("What animal is this?" cannot take
    // "I like {w}"): the question names the category and uses the template's verb.
    const promptWords = new Set(tokens(prompt));
    const verb = tokens(template.replace("{w}", " ")).find((w) => !["i", "it", "the", "a", "an", "my"].includes(w));
    const categoryName = raw.answerCategory;
    if (!promptWords.has(categoryName) && !promptWords.has(`${categoryName}s`)) return { reasons: [`prompt: a ${categoryName} question must mention "${categoryName}"`] };
    if (verb && !promptWords.has(verb) && !promptWords.has(`${verb}s`)) return { reasons: [`prompt does not match answerTemplate: the question should use "${verb}"`] };
    if (promptWords.has("this") || promptWords.has("that")) return { reasons: ["prompt: refers to a picture the child cannot see"] };
    const rest = template.replace("{w}", " ").trim();
    const templateReasons = rest ? checkText(rest, { allowed, maxWords: limits.answer - 1, label: "answerTemplate" }) : [];
    if (templateReasons.length) return { reasons: templateReasons };
    const shown = orderBy(words, prompt).slice(0, 3);
    return {
      item: {
        activityType: type, prompt, answerCategory: raw.answerCategory,
        acceptedAnswers: words.map((w) => ({ text: template.replace("{w}", w).replace(/\s+/g, " ").trim(), targetWords: [w] })),
        choices: wordChoices(shown), correctChoiceId: shown,
      },
    };
  }

  // closed question
  const answers = Array.isArray(raw.acceptedAnswers) ? raw.acceptedAnswers.slice(0, 4) : [];
  if (!answers.length) return { reasons: ["acceptedAnswers: missing"] };
  const accepted = [];
  const answerReasons = [];
  for (const [i, entry] of answers.entries()) {
    const text = typeof entry === "string" ? entry : entry?.text;
    const r = checkText(text, { allowed, maxWords: limits.answer, label: `acceptedAnswers[${i}]` });
    const targets = typeof entry === "object" && Array.isArray(entry.targetWords) ? entry.targetWords.map((w) => tokens(w)[0]).filter(Boolean) : null;
    if (targets) {
      const inText = new Set(tokens(text));
      if (targets.some((w) => !inText.has(w))) r.push(`acceptedAnswers[${i}]: target words must appear in the answer`);
    }
    answerReasons.push(...r);
    if (!r.length) accepted.push({ text: stripEnd(text), ...(targets?.length ? { targetWords: targets } : {}) });
  }
  if (answerReasons.length) return { reasons: answerReasons };

  const targetWords = new Set(accepted.flatMap((a) => a.targetWords || tokens(a.text)));
  let choiceWords = Array.isArray(raw.choices) ? [...new Set(raw.choices.flatMap((c) => tokens(String(c)).slice(0, 1)))].slice(0, 3) : null;
  if (!choiceWords) {
    const yesNo = [...targetWords].every((w) => w === "yes" || w === "no");
    if (!yesNo) return { reasons: ["choices: a closed question needs 2 or 3 choices for the picture fallback"] };
    choiceWords = ["yes", "no"];
  }
  const choiceReasons = choiceWords.flatMap((w) => (allowed.has(w) ? [] : [`choices: word not allowed: ${w}`]));
  if (choiceWords.length < 2) choiceReasons.push("choices: need at least 2");
  const correct = choiceWords.filter((w) => targetWords.has(w));
  if (!correct.length) choiceReasons.push("choices: none matches an accepted answer");
  if (choiceReasons.length) return { reasons: choiceReasons };
  return { item: { activityType: type, prompt, acceptedAnswers: accepted, choices: wordChoices(orderBy(choiceWords, prompt)), correctChoiceId: correct } };
}

function normaliseStory(raw, topicId, ageBand) {
  const fallback = topicsData.topics[topicId].fallback.story;
  const character = raw?.character;
  if (typeof character !== "string" || !NAME_OK.test(character) || topicsData.blockedCharacterNames.includes(character.toLowerCase())) {
    return { story: fallback, reasons: ["story: invalid or blocked character name"] };
  }
  // The intro is narration, not something the child must say, so it may also use the story words.
  // Narration may also use the topic's own name and -s forms ("loves", "sees") of allowed words.
  const base = [...allowedWords({ topicId, practiceWords: [], character }), ...STORY_WORDS, ...tokens(topicsData.topics[topicId].label)];
  const allowed = new Set([...base, ...base.map((w) => `${w}s`)]);
  const reasons = checkText(raw.intro, { allowed, maxWords: STORY_MAX_WORDS, label: "story.intro" });
  return reasons.length ? { story: fallback, reasons } : { story: { character, intro: raw.intro.trim() }, reasons: [] };
}

// --- lesson assembly ---------------------------------------------------------------------------

function mixFor(count) {
  const mix = [...BASE_MIX];
  while (mix.length < count) mix.push(mix.length % 2 ? "name_picture" : "answer_question");
  return mix.slice(0, count);
}

function itemKey(item) {
  return item.pictureKey ? `p:${item.pictureKey}` : `t:${(item.say || item.prompt).toLowerCase()}`;
}

function parseModelJson(text) {
  const body = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(body);
  } catch {
    // Small local models often wrap the JSON in a sentence; take the outermost braces.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function fallbackItems(topicId, ageBand) {
  const topic = topicsData.topics[topicId];
  const ctx = { ageBand, level: 3, topic, allowed: allowedWords({ topicId, practiceWords: [], character: topic.fallback.story.character }) };
  return topic.fallback.items.map((raw) => {
    const result = normaliseItem(raw, ctx);
    if (!result.item) throw new Error(`fallback item for ${topicId} is invalid: ${result.reasons.join("; ")}`);
    return result.item;
  });
}

function promptFor({ topicId, ageBand, level, practiceWords, mix }) {
  const topic = topicsData.topics[topicId];
  const limits = limitsFor(ageBand, level);
  return prompts.render("tutor-lesson", {
    age_rules: limits.rules,
    topic_label: topic.label,
    count: mix.length,
    mix: mix.join(", "),
    category_names: Object.keys(topicsData.categories).join(", "),
    max_question_words: limits.question,
    max_answer_words: limits.answer,
    max_say_words: limits.say,
    base_words: [...BASE_WORDS].join(" "),
    topic_vocab: [...topicVocab(topicId)].join(" "),
    practice_words: practiceWords.length ? practiceWords.join(" ") : "none",
    picture_keys: topic.pictures.join(" "),
  });
}

function cleanRequest(request = {}) {
  const topicId = request.topicId;
  if (!topicsData.topics[topicId]) throw fail(`Unknown topic: ${topicId}`);
  const ageBand = request.ageBand === "A" ? "A" : "B";
  const count = Math.min(8, Math.max(3, Number.isInteger(request.count) ? request.count : 5));
  const practiceWords = [...new Set((Array.isArray(request.practiceWords) ? request.practiceWords : []).flatMap((w) => tokens(String(w)).slice(0, 1)))].slice(0, 8);
  const level = [1, 2, 3].includes(request.level) ? request.level : 2;
  return { topicId, ageBand, level, count, practiceWords };
}

// deps.llm({ system, user, promptName, promptVersion }) -> { text, model, usage }
async function generateLesson(request, deps = {}) {
  const { topicId, ageBand, level, count, practiceWords } = cleanRequest(request);
  const llm = deps.llm ?? (tutorLlm.status().enabled ? tutorLlm.complete : null);
  const topic = topicsData.topics[topicId];
  const mix = mixFor(count);
  const meta = { level, practiceWords, promptVersion: null, model: null, usage: null, aiItems: 0, fallbackItems: 0, rejected: [], llmError: null };

  let raw = null;
  if (llm) {
    const prompt = promptFor({ topicId, ageBand, level, practiceWords, mix });
    meta.promptVersion = `${prompt.name}.v${prompt.version}`;
    try {
      const out = await llm({ system: prompt.text, user: "Write the lesson now.", promptName: prompt.name, promptVersion: `v${prompt.version}` });
      meta.model = out.model ?? null;
      meta.usage = out.usage ?? null;
      raw = parseModelJson(out.text);
      if (!raw || typeof raw !== "object") meta.llmError = out.finishReason === "length" ? "truncated" : "invalid_json";
    } catch (error) {
      meta.llmError = error.code || "error";
    }
  } else {
    meta.llmError = "not_configured";
  }

  const storyResult = normaliseStory(raw?.story, topicId, ageBand);
  if (raw?.story && storyResult.reasons.length) meta.rejected.push({ index: "story", reasons: storyResult.reasons });
  const story = storyResult.story;

  const allowed = allowedWords({ topicId, practiceWords, character: story.character });
  const ctx = { ageBand, level, topic, allowed };
  const modelItems = [];
  const seen = new Set();
  (Array.isArray(raw?.items) ? raw.items : []).slice(0, count * 2).forEach((rawItem, index) => {
    const result = normaliseItem(rawItem, ctx);
    if (!result.item) return meta.rejected.push({ index, reasons: result.reasons });
    const key = itemKey(result.item);
    if (seen.has(key)) return meta.rejected.push({ index, reasons: ["duplicate item"] });
    seen.add(key);
    modelItems.push(result.item);
  });

  const spare = fallbackItems(topicId, ageBand);
  const items = mix.map((type) => {
    const fromModel = modelItems.findIndex((it) => it.activityType === type);
    if (fromModel !== -1) {
      meta.aiItems += 1;
      return { ...modelItems.splice(fromModel, 1)[0], source: "ai" };
    }
    let fb = spare.findIndex((it) => it.activityType === type && !seen.has(itemKey(it)));
    if (fb === -1) fb = spare.findIndex((it) => !seen.has(itemKey(it)));
    if (fb === -1) fb = spare.findIndex((it) => it.activityType === type);
    if (fb === -1) fb = 0;
    const chosen = spare[fb];
    seen.add(itemKey(chosen));
    meta.fallbackItems += 1;
    return { ...chosen, source: "fallback" };
  });

  return {
    topicId,
    topicLabel: topic.label,
    ageBand,
    story,
    items: items.map((it, i) => ({ id: `i${i + 1}`, ...it })),
    meta,
  };
}

module.exports = { generateLesson, normaliseItem, normaliseStory, STORY_WORDS, limitsFor, allowedWords, mixFor, fallbackItems, LIMITS, topicIds: Object.keys(topicsData.topics) };
