// Tutor scoring (SRS v0.3 FR-12 / FR-13, section 6.3). Every score is a deterministic function of
// the lesson item, the child's response and the versioned rubric in data/tutorRubric.json. A language
// model never assigns or changes a band or a star. The lesson item (including its accepted answers)
// may be written by an LLM, but it is validated before use and a snapshot of it is stored with the
// attempt, so any result can be reproduced from the stored inputs.
//
// Lesson item:  { activityType, acceptedAnswers: [string | { text, targetWords? }], correctChoiceId? }
//   - target words default to the words of the answer minus the ignored articles.
// Response:     { mode: "speech" | "picture" | "abandoned", transcript?, confidence?, wordConfidences?,
//                 choiceId?, firstAttemptMs?, attemptCount?, hintUsed? }
// Options:      { ageBand: "A" | "B" }

const rubric = require("../data/tutorRubric.json");

const CRITERIA = ["clarity", "accuracy", "completeness", "participation"];
const ACTIVITIES = ["listen_repeat", "name_picture", "answer_question"];
const IGNORED = new Set(rubric.matching.ignoredWords);

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// --- Text matching ---------------------------------------------------------------------------

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

function stem(word) {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Exact, plural-insensitive, or one small spelling slip on a longer word (speech recognisers often
// return a near miss for a child's pronunciation).
function wordsMatch(target, spoken) {
  if (target === spoken || stem(target) === stem(spoken)) return true;
  const { fuzzyMinLength, fuzzyMaxEdits } = rubric.matching;
  return target.length >= fuzzyMinLength && spoken.length >= fuzzyMinLength && editDistance(target, spoken) <= fuzzyMaxEdits;
}

// Returns the spoken token that matches the target word, or null.
function findSpoken(target, spokenTokens) {
  return spokenTokens.find((s) => wordsMatch(target, s)) ?? null;
}

// --- Per-criterion band functions (each returns 1..5) -----------------------------------------

function bandFromBounds(value, bounds) {
  const index = bounds.findIndex((b) => value >= b);
  return index === -1 ? 1 : 5 - index;
}

function accuracyBand(share) {
  return bandFromBounds(share, rubric.accuracy.minShare);
}

function clarityBand(confidence, ageBand) {
  return bandFromBounds(confidence, rubric.clarity.minBand[ageBand]);
}

function completenessBand({ missingWords, missingTargets, targetCount }) {
  if (missingWords === 0) return 5;
  if (missingWords === 1 && missingTargets === 0) return 4;
  if (missingTargets === 0) return 3;
  if (missingTargets < targetCount) return 2;
  return 1;
}

function participationBand({ firstAttemptMs, attemptCount, hintUsed }) {
  if (hintUsed) return 1;
  if (attemptCount >= 2) return 2;
  const [fast, medium] = rubric.participation.firstAttemptMs;
  if (firstAttemptMs <= fast) return 5;
  if (firstAttemptMs <= medium) return 4;
  return 3;
}

// --- Evaluating a spoken response against one accepted answer ---------------------------------

function normaliseAnswer(answer) {
  const text = typeof answer === "string" ? answer : answer?.text;
  const all = tokens(text);
  if (!all.length) throw fail("An accepted answer must contain at least one word.");
  const explicit = typeof answer === "object" && Array.isArray(answer.targetWords) ? tokens(answer.targetWords.join(" ")) : null;
  const targets = explicit?.length ? explicit : all.filter((w) => !IGNORED.has(w));
  return { text, words: all.filter((w) => !IGNORED.has(w)), targets: targets.length ? targets : all };
}

function evaluateAgainst(answer, spokenTokens) {
  const matches = answer.targets.map((target) => ({ target, spoken: findSpoken(target, spokenTokens) }));
  const matchedTargets = matches.filter((m) => m.spoken).length;
  const missingWords = answer.words.filter((w) => !findSpoken(w, spokenTokens)).length;
  const missingTargets = answer.targets.length - matchedTargets;
  return {
    answer: answer.text,
    matches,
    share: matchedTargets / answer.targets.length,
    completeness: completenessBand({ missingWords, missingTargets, targetCount: answer.targets.length }),
    missingWords,
    missingTargets,
  };
}

function bestEvaluation(item, spokenTokens) {
  if (!Array.isArray(item.acceptedAnswers) || !item.acceptedAnswers.length) {
    throw fail("A spoken activity needs at least one accepted answer.");
  }
  const evaluations = item.acceptedAnswers.map(normaliseAnswer).map((a) => evaluateAgainst(a, spokenTokens));
  // Ties go to the earlier accepted answer, so the result never depends on iteration quirks.
  return evaluations.reduce((best, e) => {
    if (e.share !== best.share) return e.share > best.share ? e : best;
    return e.completeness > best.completeness ? e : best;
  });
}

function clarityInput(evaluation, response, spokenTokens) {
  const byWord = new Map();
  for (const entry of response.wordConfidences || []) {
    const word = tokens(entry?.word)[0];
    if (word && Number.isFinite(entry.confidence)) byWord.set(word, entry.confidence);
  }
  const targetScores = evaluation.matches
    .filter((m) => m.spoken && byWord.has(m.spoken))
    .map((m) => byWord.get(m.spoken));
  if (targetScores.length) return { value: mean(targetScores), basis: "target words" };
  if (Number.isFinite(response.confidence)) return { value: response.confidence, basis: "whole transcript" };
  if (byWord.size) return { value: mean([...byWord.values()]), basis: "all words" };
  return null;
}

const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const round = (n, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

// --- Public API -------------------------------------------------------------------------------

function scoreAttempt(item, response, options = {}) {
  const ageBand = options.ageBand === "A" ? "A" : "B";
  if (!item || !response) throw fail("An item and a response are required.");
  if (!ACTIVITIES.includes(item.activityType)) throw fail(`Unknown activity type: ${item.activityType}`);

  const base = { rubricVersion: rubric.version, activityType: item.activityType, ageBand, responseMode: response.mode };

  if (response.mode === "abandoned") {
    return { ...base, completed: false, scoringKey: "abandoned", criteria: [], weightedBand: null, stars: null, inputs: {} };
  }
  if (response.mode !== "speech" && response.mode !== "picture") throw fail(`Unknown response mode: ${response.mode}`);

  const scoringKey = response.mode === "picture" ? "picture_choice" : item.activityType;
  const applicable = new Set(rubric.applicability[scoringKey]);
  const bands = {};
  const inputs = {};

  if (response.mode === "picture") {
    if (item.correctChoiceId === undefined || response.choiceId === undefined) {
      throw fail("A picture choice needs both the correct choice and the child's choice.");
    }
    // An open question can have several acceptable choices, so the correct choice may be a list.
    const correct = [].concat(item.correctChoiceId).includes(response.choiceId);
    bands.accuracy = correct ? 5 : 1;
    inputs.accuracy = { correct };
    // Which word a picture choice tested, for word progress (only when the item is about one word).
    if (typeof item.correctChoiceId === "string") inputs.words = correct ? { matched: [item.correctChoiceId], missed: [] } : { matched: [], missed: [item.correctChoiceId] };
  } else {
    const spoken = tokens(response.transcript);
    const evaluation = bestEvaluation(item, spoken);
    inputs.matchedAnswer = evaluation.answer;
    bands.accuracy = accuracyBand(evaluation.share);
    inputs.accuracy = { share: round(evaluation.share), matched: evaluation.matches.filter((m) => m.spoken).length, targets: evaluation.matches.length };
    inputs.words = { matched: evaluation.matches.filter((m) => m.spoken).map((m) => m.target), missed: evaluation.matches.filter((m) => !m.spoken).map((m) => m.target) };
    if (applicable.has("completeness")) {
      bands.completeness = evaluation.completeness;
      inputs.completeness = { missingWords: evaluation.missingWords, missingTargets: evaluation.missingTargets };
    }
    if (applicable.has("clarity")) {
      const clarity = clarityInput(evaluation, response, spoken);
      // Without any confidence from the recogniser the criterion is omitted and its weight is normalised.
      if (clarity) {
        bands.clarity = clarityBand(clarity.value, ageBand);
        inputs.clarity = { confidence: round(clarity.value), basis: clarity.basis };
      }
    }
  }

  const attemptCount = Number.isInteger(response.attemptCount) && response.attemptCount > 0 ? response.attemptCount : 1;
  const hintUsed = Boolean(response.hintUsed);
  const timed = Number.isFinite(response.firstAttemptMs) && response.firstAttemptMs >= 0;
  // Participation needs a timing, a repeat attempt or a hint; otherwise it cannot be judged and is omitted.
  if (applicable.has("participation") && (timed || attemptCount >= 2 || hintUsed)) {
    bands.participation = participationBand({ firstAttemptMs: response.firstAttemptMs, attemptCount, hintUsed });
    inputs.participation = { firstAttemptMs: timed ? response.firstAttemptMs : null, attemptCount, hintUsed };
  }

  const scored = CRITERIA.filter((id) => bands[id] !== undefined);
  const weightSum = scored.reduce((sum, id) => sum + rubric.weights[id], 0);
  // Rounded so a mathematically exact 4.0 or 2.5 is not pushed under its threshold by floating-point error.
  const weightedBand = round(scored.reduce((sum, id) => sum + bands[id] * rubric.weights[id], 0) / weightSum, 6);
  const stars = weightedBand >= rubric.stars.three ? 3 : weightedBand >= rubric.stars.two ? 2 : 1;

  return {
    ...base,
    completed: true,
    scoringKey,
    criteria: CRITERIA.map((id) => ({
      id,
      applicable: applicable.has(id),
      band: bands[id] ?? null,
      weight: bands[id] === undefined ? 0 : round(rubric.weights[id] / weightSum),
    })),
    weightedBand: round(weightedBand),
    stars,
    inputs,
  };
}

module.exports = { scoreAttempt, tokens, wordsMatch, rubricVersion: rubric.version };
