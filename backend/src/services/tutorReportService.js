// Comprehensive learner report (supervisor point 3). It turns everything stored about a child's practice
// into an overview a parent can read.
//
//   1. Code computes the facts: averages, trends, strongest and weakest criteria, topics, words,
//      engagement. Nothing in a report is estimated by a model.
//   2. A language model may phrase those facts as a short narrative. It sees the facts only, never the
//      child's nickname or any identity (it writes the token {child}, which code replaces).
//   3. Code checks the narrative before it is kept: every number must be supported by the facts, the
//      words it quotes must be words the child actually practised, and it must not diagnose, compare the
//      child with others, name an exam level or use "he/she". Anything that fails is replaced by a
//      deterministic template narrative built from the same facts.
//
// A report with too little data says so instead of drawing conclusions. It is a practice summary, not
// an assessment, and carries that disclaimer.

const store = require("../store");
const rules = require("../data/tutorReportRules.json");
const topicsData = require("../data/tutorTopics.json");
const prompts = require("../prompts");
const { httpError } = require("../utils/httpError");
const progressService = require("./tutorProgressService");
const tutorLlm = require("./tutorLlm");

const CRITERIA = ["clarity", "accuracy", "completeness", "participation"];
const PLAIN = {
  clarity: "speaking clearly",
  accuracy: "saying the right words",
  completeness: "answering in full phrases",
  participation: "joining in quickly and on their own",
};
const TIPS = {
  clarity: "Say three favourite words slowly together, then let {child} say them back to you.",
  accuracy: "Point to things at home and ask {child} to say their English names.",
  completeness: "Ask {child} a simple question and help them answer with a whole short sentence.",
  participation: "Give {child} a few seconds to start on their own before you help.",
};
const TOPIC_LABEL = Object.fromEntries(Object.entries(topicsData.topics).map(([id, t]) => [id, t.label.toLowerCase()]));
const BANNED = rules.bannedPatterns.map((p) => new RegExp(p, "i"));
// Wording that would talk about a criterion the app could not measure for this child.
const CRITERION_WORDS = {
  clarity: /clear(ly|er)?|clarity/i,
  accuracy: /right words?|accura/i,
  completeness: /full (phrases?|sentences?)|whole sentences?|complete (phrases?|sentences?)|completeness/i,
  participation: /join(ing)? in|particip/i,
};

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const meanRounded = (list) => (list.length ? round(mean(list)) : null);

// --- 1. facts ----------------------------------------------------------------------------------

function trendOf(values, key) {
  if (values.length < rules.trendMinSessions) return { label: "not enough data", recentAvg: null, earlierAvg: null };
  const recent = values.slice(-rules.trendWindow);
  const earlier = values.slice(-rules.trendWindow * 2, -rules.trendWindow);
  const recentAvg = round(mean(recent));
  const earlierAvg = round(mean(earlier));
  const diff = recentAvg - earlierAvg;
  const label = diff >= rules.trendDelta ? "improving" : diff <= -rules.trendDelta ? "declining" : "steady";
  return { label, recentAvg, earlierAvg };
}

function computeFacts({ progress, sessions, now = new Date().toISOString() }) {
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const completed = ordered.filter((s) => s.status === "completed");
  const scored = ordered.flatMap((s) => s.attempts.filter((a) => a.result.completed).map((a) => ({ ...a, topicId: s.topicId })));

  const perSessionStars = completed.map((s) => mean(s.attempts.filter((a) => a.result.completed).map((a) => a.result.stars))).filter((v) => v !== null);
  const criteria = {};
  for (const id of CRITERIA) {
    const bands = scored.flatMap((a) => {
      const c = a.result.criteria.find((x) => x.id === id);
      return c && c.band !== null ? [c.band] : [];
    });
    const recent = bands.slice(-rules.recentActivities);
    const earlier = bands.slice(0, -rules.recentActivities);
    criteria[id] = {
      samples: bands.length,
      average: meanRounded(bands),
      recentAverage: meanRounded(recent),
      earlierAverage: earlier.length >= rules.minSamplesPerCriterion ? meanRounded(earlier) : null,
    };
  }
  const rankable = CRITERIA.filter((id) => criteria[id].samples >= rules.minSamplesPerCriterion);
  const ranked = [...rankable].sort((a, b) => criteria[b].average - criteria[a].average || CRITERIA.indexOf(a) - CRITERIA.indexOf(b));

  const byType = {};
  for (const a of scored) (byType[a.result.activityType] ??= []).push(a.result.stars);
  const byTopic = {};
  for (const a of scored) (byTopic[a.topicId] ??= { stars: [], sessions: new Set() }).stars.push(a.result.stars);
  for (const s of completed) byTopic[s.topicId]?.sessions.add(s.id);

  const days = new Set(ordered.map((s) => progressService.dayNumber(s.startedAt)));
  const times = scored.map((a) => a.response?.firstAttemptMs).filter(Number.isFinite);
  const view = progressService.viewOf(progress, now);

  return {
    enoughData: completed.length >= rules.minCompletedSessions && scored.length >= rules.minScoredActivities,
    needs: { completedLessons: rules.minCompletedSessions, scoredActivities: rules.minScoredActivities },
    lessonsStarted: ordered.length,
    lessonsCompleted: completed.length,
    lessonsStoppedEarly: ordered.filter((s) => s.status === "abandoned").length,
    activitiesScored: scored.length,
    activeDays: days.size,
    daysCovered: ordered.length ? Math.max(...days) - Math.min(...days) + 1 : 0,
    longestStreakDays: progress.streak.longest,
    currentStreakDays: view.streak.current,
    currentLevel: progress.level,
    averageStars: meanRounded(scored.map((a) => a.result.stars)),
    starsTrend: trendOf(perSessionStars),
    criteria,
    strongestCriterion: ranked.length >= 2 ? ranked[0] : null,
    weakestCriterion: ranked.length >= 2 && criteria[ranked[ranked.length - 1]].average < 5 ? ranked[ranked.length - 1] : null,
    activityTypes: Object.fromEntries(Object.entries(byType).map(([type, stars]) => [type, { activities: stars.length, averageStars: meanRounded(stars) }])),
    topics: Object.fromEntries(Object.entries(byTopic).map(([id, t]) => [id, { lessons: t.sessions.size, averageStars: meanRounded(t.stars) }])),
    pictureAnswerShare: scored.length ? round(scored.filter((a) => a.response?.mode === "picture").length / scored.length) : null,
    averageSecondsToFirstAttempt: times.length ? round(mean(times) / 1000, 1) : null,
    words: {
      mastered: view.counts.mastered,
      learning: view.counts.learning,
      needsPractice: view.counts.needsPractice,
      masteredList: view.words.filter((w) => w.status === "mastered").slice(0, rules.wordsListed).map((w) => w.word),
      practiceList: progressService.practiceWordsFor(progress, now, rules.wordsListed),
    },
    stickersEarned: progress.stickers.length,
    dataNotes: [
      ...(criteria.clarity.samples < scored.length / 2 ? ["Clarity could be measured for fewer than half of the activities, so it is a rough guide."] : []),
      ...(scored.length && scored.filter((a) => a.response?.mode === "picture").length / scored.length > 0.3 ? ["More than a third of the answers were picture taps instead of speech."] : []),
    ],
  };
}

// --- 3a. deterministic narrative ---------------------------------------------------------------

function templateNarrative(facts) {
  if (!facts.enoughData) {
    return {
      source: "template",
      summary: `There is not enough practice yet for a full overview. {child} has completed ${facts.lessonsCompleted} lessons with ${facts.activitiesScored} scored activities; a report needs at least ${facts.needs.completedLessons} completed lessons and ${facts.needs.scoredActivities} scored activities.`,
      strengths: [],
      focus: [],
      suggestions: ["Keep practising a little often. The overview will appear once there is enough to look at."],
    };
  }
  const trend = facts.starsTrend;
  const trendText = {
    improving: `Recent lessons are going better than earlier ones (${trend.recentAvg} stars on average, up from ${trend.earlierAvg}).`,
    steady: `Results have stayed steady (${trend.recentAvg} stars on average recently, ${trend.earlierAvg} before).`,
    declining: `Recent lessons were a little harder (${trend.recentAvg} stars on average, down from ${trend.earlierAvg}), which is normal when new words appear.`,
    "not enough data": "There are not enough lessons yet to say whether results are changing.",
  }[trend.label];
  const summary = `{child} has completed ${facts.lessonsCompleted} lessons on ${facts.activeDays} different days and earned ${facts.averageStars} stars per activity on average, out of 3. ${trendText} ${facts.words.mastered} words are now well known and ${facts.words.learning} are still being learned.`;

  const strengths = [];
  if (facts.strongestCriterion) strengths.push(`{child} is strongest at ${PLAIN[facts.strongestCriterion]} (${facts.criteria[facts.strongestCriterion].average} out of 5).`);
  if (facts.words.mastered > 0 && facts.words.masteredList.length) strengths.push(`Well-known words include ${facts.words.masteredList.slice(0, 4).map((w) => `"${w}"`).join(", ")}.`);
  if (facts.longestStreakDays >= 2) strengths.push(`{child} has practised on ${facts.longestStreakDays} days in a row at best.`);

  const focus = [];
  if (facts.weakestCriterion && facts.weakestCriterion !== facts.strongestCriterion) focus.push(`The area to grow most is ${PLAIN[facts.weakestCriterion]} (${facts.criteria[facts.weakestCriterion].average} out of 5).`);
  if (facts.words.practiceList.length) focus.push(`Words to practise next: ${facts.words.practiceList.slice(0, 5).map((w) => `"${w}"`).join(", ")}.`);
  for (const note of facts.dataNotes) focus.push(note);

  const suggestions = [];
  if (facts.weakestCriterion) suggestions.push(TIPS[facts.weakestCriterion]);
  if (facts.words.practiceList.length) suggestions.push(`Look for "${facts.words.practiceList[0]}" at home or in a picture book and say its name together.`);
  suggestions.push("A few short sessions a week work better than one long one.");

  const cap = (list) => list.slice(0, rules.limits.maxItems);
  return { source: "template", summary, strengths: cap(strengths), focus: cap(focus), suggestions: cap(suggestions) };
}

// --- 3b. checking a model narrative ------------------------------------------------------------

const SPELLED = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function numbersIn(value, found = []) {
  if (typeof value === "number" && Number.isFinite(value)) found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, found));
  return found;
}

function allowedNumbers(facts) {
  const base = numbersIn({ ...facts, needs: undefined }); // the minimums for a report are not facts about the child
  // Scales a parent may see: stars 1-3 and criteria 1-5; shares may be written as percentages.
  return [...base, ...base.filter((n) => n > 0 && n <= 1).map((n) => Math.round(n * 100)), 1, 2, 3, 5];
}

function allowedWordsIn(facts) {
  return new Set([...facts.words.masteredList, ...facts.words.practiceList].map((w) => w.toLowerCase()));
}

// Returns a list of problems; an empty list means the narrative is supported by the facts.
function checkNarrative(narrative, facts) {
  const problems = [];
  const { summaryWords, itemWords, maxItems } = rules.limits;
  const strings = (list, label) => {
    if (!Array.isArray(list) || list.length > maxItems || list.some((s) => typeof s !== "string" || !s.trim())) problems.push(`${label}: must be at most ${maxItems} non-empty strings`);
    return Array.isArray(list) ? list.filter((s) => typeof s === "string") : [];
  };
  if (typeof narrative?.summary !== "string" || !narrative.summary.trim()) return ["summary: missing"];
  const sections = { strengths: strings(narrative.strengths, "strengths"), focus: strings(narrative.focus, "focus"), suggestions: strings(narrative.suggestions, "suggestions") };
  const wordCount = (s) => s.trim().split(/\s+/).length;
  if (wordCount(narrative.summary) > summaryWords) problems.push(`summary: more than ${summaryWords} words`);
  for (const [name, list] of Object.entries(sections)) for (const s of list) if (wordCount(s) > itemWords) problems.push(`${name}: a sentence has more than ${itemWords} words`);

  const text = [narrative.summary, ...Object.values(sections).flat()].join("\n");
  for (const pattern of BANNED) if (pattern.test(text)) problems.push(`not allowed: ${pattern.source}`);
  if (/\b(he|she|his|him|hers?)\b/i.test(text)) problems.push("uses gendered pronouns");
  if (/\{(?!child\})/.test(text) || /[\u{1F000}-\u{1FFFF}]/u.test(text)) problems.push("contains stray braces or emoji");

  const allowed = allowedNumbers(facts);
  const stripped = text.replace(/\{child\}/g, "");
  const mentioned = [...(stripped.match(/\d+(?:\.\d+)?/g) ?? []).map(Number), ...(stripped.toLowerCase().match(/\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g) ?? []).map((w) => SPELLED[w])];
  for (const n of mentioned) if (!allowed.some((a) => Math.abs(a - n) <= 0.051)) problems.push(`number not in the facts: ${n}`);

  problems.push(...checkClaims(text.replace(/\{child\}/g, ""), facts));

  for (const id of CRITERIA) {
    if (facts.criteria[id].samples === 0 && CRITERION_WORDS[id].test(text)) problems.push(`mentions ${id}, which was not measured`);
  }

  const known = allowedWordsIn(facts);
  for (const [, quoted] of text.matchAll(/["“']([A-Za-z][A-Za-z -]{0,20})["”']/g)) {
    if (!known.has(quoted.toLowerCase().trim())) problems.push(`quoted word not in the child's practice: ${quoted}`);
  }
  return problems;
}

// A number must also fit what it is attached to: "N lessons" is the lesson count, "N stars" a star average.
function checkClaims(text, facts) {
  const problems = [];
  const w = facts.words;
  const stars = [1, 2, 3, facts.averageStars, facts.starsTrend.recentAvg, facts.starsTrend.earlierAvg,
    ...Object.values(facts.activityTypes).map((t) => t.averageStars), ...Object.values(facts.topics).map((t) => t.averageStars)].filter((n) => n !== null);
  const claims = [
    [/\b(\d+)\s+(?:completed\s+|full\s+|different\s+)?lessons?\b/gi, [facts.lessonsCompleted, facts.lessonsStarted, 1], "lessons"],
    [/\b(\d+)\s+(?:scored\s+)?activities\b/gi, [facts.activitiesScored], "activities"],
    [/\b(\d+)\s+(?:different\s+)?days?\b/gi, [facts.activeDays, facts.longestStreakDays, facts.currentStreakDays, facts.daysCovered, 1, 2, 3, 7], "days"],
    [/\b(\d+)\s+(?:well[- ]known\s+|new\s+|mastered\s+|practice\s+)?words?\b/gi, [w.mastered, w.learning, w.needsPractice, w.mastered + w.learning, w.mastered + w.learning + w.needsPractice, w.masteredList.length, w.practiceList.length, 1], "words"],
    [/\b(\d+(?:\.\d+)?)\s+stars?\b/gi, stars, "stars"],
  ];
  for (const [pattern, allowed, label] of claims) {
    for (const [, value] of text.matchAll(pattern)) {
      if (!allowed.some((a) => Math.abs(a - Number(value)) <= 0.051)) problems.push(`${value} ${label} does not match the facts`);
    }
  }
  return problems;
}

function parseJson(text) {
  const body = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [body, body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object") return value;
    } catch { /* try the next form */ }
  }
  return null;
}

const fillChild = (narrative, nickname) => {
  const fill = (s) => s.replace(/\{child\}/g, nickname);
  return { ...narrative, summary: fill(narrative.summary), strengths: narrative.strengths.map(fill), focus: narrative.focus.map(fill), suggestions: narrative.suggestions.map(fill) };
};

// --- generating and storing ---------------------------------------------------------------------

// deps.llm({ system, user, ... }) -> { text, model, usage }; null forces the template narrative.
async function buildReport({ child, progress, sessions, now = new Date().toISOString() }, deps = {}) {
  const facts = computeFacts({ progress, sessions, now });
  const meta = { promptVersion: null, model: null, usage: null, llmError: null, rejected: [] };
  let narrative = null;

  const llm = deps.llm === undefined ? (tutorLlm.status().enabled ? tutorLlm.complete : null) : deps.llm;
  if (facts.enoughData && llm) {
    const prompt = prompts.render("tutor-report", {
      facts_json: JSON.stringify({ ...facts, needs: undefined }, null, 1),
      summary_words: rules.limits.summaryWords,
      item_words: rules.limits.itemWords,
      max_items: rules.limits.maxItems,
    });
    meta.promptVersion = `${prompt.name}.v${prompt.version}`;
    try {
      const out = await llm({ system: prompt.text, user: "Write the summary now.", promptName: prompt.name, promptVersion: `v${prompt.version}`, temperature: 0.3 });
      meta.model = out.model ?? null;
      meta.usage = out.usage ?? null;
      const parsed = parseJson(out.text);
      if (!parsed) meta.llmError = out.finishReason === "length" ? "truncated" : "invalid_json";
      else {
        meta.rejected = checkNarrative(parsed, facts);
        if (!meta.rejected.length) narrative = { source: "ai", summary: parsed.summary.trim(), strengths: parsed.strengths, focus: parsed.focus, suggestions: parsed.suggestions };
      }
    } catch (error) {
      meta.llmError = error.code || "error";
    }
  } else if (facts.enoughData) {
    meta.llmError = "not_configured";
  }

  narrative ??= templateNarrative(facts);
  return {
    childId: child.id,
    generatedAt: now,
    rulesVersion: rules.version,
    progressRulesVersion: progressService.rules.version,
    enoughData: facts.enoughData,
    facts,
    narrative: fillChild(narrative, child.nickname),
    disclaimer: rules.disclaimer,
    meta,
  };
}

async function generateReport(parentId, childId, deps = {}) {
  const child = await store.tutorChildren.get(childId);
  if (!child || child.parentId !== parentId) throw httpError(404, "child profile not found");
  const [progress, sessions] = await Promise.all([progressService.getProgress(child.id), store.tutorSessions.valuesWhere("childId", child.id)]);
  const report = await buildReport({ child, progress, sessions }, deps);
  await store.tutorReports.set(child.id, report);
  return publicReport(report);
}

async function getReport(parentId, childId) {
  const child = await store.tutorChildren.get(childId);
  if (!child || child.parentId !== parentId) throw httpError(404, "child profile not found");
  const report = await store.tutorReports.get(child.id);
  if (!report) throw httpError(404, "no report has been generated yet");
  return publicReport(report);
}

// What the parent's browser receives: no model metadata.
function publicReport(report) {
  const { meta, ...rest } = report;
  return { ...rest, narrative: { ...report.narrative } };
}

async function deleteReport(childId) {
  await store.tutorReports.delete(childId);
}

module.exports = { computeFacts, templateNarrative, checkNarrative, buildReport, generateReport, getReport, deleteReport, rules };
