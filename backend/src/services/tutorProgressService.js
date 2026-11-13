// Learner model for the tutor (SRS v0.3 FR-16; supervisor points 2 and 3). It records what each
// child practised and adapts later lessons. Every rule here is plain code over stored scores:
//
//   - Word mastery: a Leitner-style box (1 = new or struggling ... 5 = well known) per tracked
//     word. Saying a word correctly moves it up a box, missing it moves it down one. Tapping the
//     right picture counts for less than saying the word (it cannot lift a word past box 2).
//     A word is "mastered" from box 4. Each box has a review interval, so weak words come back sooner.
//   - Difficulty level 1-3: raised after several strong lessons in a row at the current level,
//     lowered after weak ones. Level changes the length limits used when a lesson is written.
//   - Streak, stickers and per-topic counts.
//   - Practice words: the weakest or due words, offered to the lesson generator for the next lesson.
//
// The language model does not decide any of this and receives only the list of practice words and
// the level. Functions that change a progress document are pure (they return a new document) so
// they are easy to test; the store functions at the bottom load and save it.

const store = require("../store");
const rules = require("../data/tutorProgressRules.json");
const wordsData = require("../data/tutorWords.json");
const topicsData = require("../data/tutorTopics.json");
const { tokens } = require("./tutorScoringService");

const DAY_MS = 24 * 60 * 60 * 1000;
const BOXES = rules.boxIntervalsDays.length;

// Only topic vocabulary is tracked as "words learned". Function words (I, see, the, yes) are not.
const BASE = new Set(tokens(wordsData.baseWords));
const TRACKED = new Set(Object.values(topicsData.topics).flatMap((t) => tokens(t.vocab)).filter((w) => !BASE.has(w)));

const wordKey = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const isTracked = (w) => TRACKED.has(w) || TRACKED.has(wordKey(w));

function emptyProgress(childId) {
  return {
    childId,
    level: 2,
    words: {},
    sessionsCompleted: 0,
    starsTotal: 0,
    streak: { current: 0, longest: 0, lastDay: null },
    stickers: [],
    topicCounts: {},
    recentSessions: [],
    updatedAt: null,
  };
}

// The calendar day in the pilot's time zone, as a whole number of days.
const dayNumber = (at) => Math.floor((new Date(at).getTime() + rules.utcOffsetMinutes * 60000) / DAY_MS);

// --- word mastery ------------------------------------------------------------------------------

function applyWord(words, { word, success, mode }, at) {
  const key = wordKey(word);
  const entry = words[key] ?? { form: word, box: 1, seen: 0, correct: 0, lastSeenAt: null, nextDueAt: null };
  entry.seen += 1;
  if (success) {
    entry.correct += 1;
    entry.box = mode === "picture" ? Math.max(entry.box, Math.min(entry.box + 1, rules.pictureSuccessMaxBox)) : Math.min(BOXES, entry.box + 1);
  } else {
    entry.box = Math.max(1, entry.box - 1);
  }
  entry.lastSeenAt = at;
  entry.nextDueAt = new Date(new Date(at).getTime() + rules.boxIntervalsDays[entry.box - 1] * DAY_MS).toISOString();
  words[key] = entry;
}

// Which words an attempt tested, and whether each was said (or tapped) correctly.
function wordOutcomes(item, result) {
  if (!result.completed || !result.inputs?.words) return [];
  const { matched, missed } = result.inputs.words;
  // An open question ("What animal do you like?") accepts any animal, so not naming one particular
  // animal is not a miss for that word.
  const misses = item.answerCategory ? [] : missed;
  return [...matched.map((word) => ({ word, success: true })), ...misses.map((word) => ({ word, success: false }))].filter((o) => isTracked(o.word));
}

function applyAttempt(progress, { item, result, mode, at }) {
  const next = structuredClone(progress);
  for (const outcome of wordOutcomes(item, result)) applyWord(next.words, { ...outcome, mode }, at);
  next.updatedAt = at;
  return next;
}

// --- difficulty level --------------------------------------------------------------------------

function adjustLevel(progress) {
  const cfg = rules.level;
  const atLevel = [];
  for (const s of [...progress.recentSessions].reverse()) {
    if (s.level !== progress.level) break;
    atLevel.push(s);
  }
  const mean = (list) => list.reduce((sum, s) => sum + s.avgStars, 0) / list.length;
  const up = atLevel.slice(0, cfg.upSessions);
  if (progress.level < cfg.max && up.length === cfg.upSessions && mean(up) >= cfg.upAvgStars) return progress.level + 1;
  const down = atLevel.slice(0, cfg.downSessions);
  if (progress.level > cfg.min && down.length === cfg.downSessions && mean(down) < cfg.downAvgStars) return progress.level - 1;
  return progress.level;
}

// --- finishing a lesson ------------------------------------------------------------------------

const masteredCount = (progress) => Object.values(progress.words).filter((w) => w.box >= rules.masteredBox).length;

function updateStreak(streak, at) {
  const today = dayNumber(at);
  if (streak.lastDay === today) return streak;
  const current = streak.lastDay === today - 1 ? streak.current + 1 : 1;
  return { current, longest: Math.max(streak.longest, current), lastDay: today };
}

// Call once, when a lesson has been completed (every activity attempted).
function completeSession(progress, session, at) {
  const next = structuredClone(progress);
  const scored = session.attempts.filter((a) => a.result.completed);
  next.sessionsCompleted += 1;
  next.starsTotal += scored.reduce((sum, a) => sum + a.result.stars, 0);
  next.topicCounts[session.topicId] = (next.topicCounts[session.topicId] ?? 0) + 1;
  next.streak = updateStreak(next.streak, at);

  if (scored.length >= rules.level.minScoredActivities) {
    const avgStars = scored.reduce((sum, a) => sum + a.result.stars, 0) / scored.length;
    next.recentSessions.push({ sessionId: session.id, topicId: session.topicId, level: session.level ?? next.level, avgStars: Math.round(avgStars * 100) / 100, scored: scored.length, at });
    next.recentSessions = next.recentSessions.slice(-rules.recentSessionsKept);
    next.level = adjustLevel(next);
  }

  const earned = new Set(next.stickers.map((s) => s.id));
  const award = (id) => {
    if (rules.stickers[id] && !earned.has(id)) {
      earned.add(id);
      next.stickers.push({ id, label: rules.stickers[id], at });
      newStickers.push(id);
    }
  };
  const newStickers = [];
  if (next.sessionsCompleted === 1) award("first_lesson");
  if (scored.length >= 4 && scored.length === session.items.length && scored.every((a) => a.result.stars === 3)) award("perfect_lesson");
  const mastered = masteredCount(next);
  if (mastered >= 5) award("words_5");
  if (mastered >= 10) award("words_10");
  if (next.streak.current >= 3) award("streak_3");
  if (next.streak.current >= 7) award("streak_7");
  if (next.topicCounts[session.topicId] === 1) award(`explorer_${session.topicId}`);
  next.updatedAt = at;
  return { progress: next, newStickers };
}

// --- reading the model -------------------------------------------------------------------------

// Words to practise in the next lesson: the weakest first, and anything whose review is due.
function practiceWordsFor(progress, now = new Date().toISOString(), limit = rules.practiceWordsPerLesson) {
  const t = new Date(now).getTime();
  return Object.values(progress.words)
    .filter((w) => w.box < rules.masteredBox && (w.box === 1 || new Date(w.nextDueAt).getTime() <= t))
    .sort((a, b) => a.box - b.box || String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)))
    .slice(0, limit)
    .map((w) => w.form);
}

function viewOf(progress, now = new Date().toISOString()) {
  const entries = Object.values(progress.words);
  const status = (w) => (w.box >= rules.masteredBox ? "mastered" : w.box >= 2 ? "learning" : "needs practice");
  const topic = Object.entries(progress.topicCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    level: progress.level,
    sessionsCompleted: progress.sessionsCompleted,
    starsTotal: progress.starsTotal,
    streak: progress.streak.lastDay !== null && dayNumber(now) - progress.streak.lastDay > 1 ? { ...progress.streak, current: 0 } : progress.streak,
    stickers: progress.stickers,
    words: entries.sort((a, b) => b.box - a.box || a.form.localeCompare(b.form)).map((w) => ({ word: w.form, status: status(w), box: w.box, seen: w.seen, correct: w.correct, lastSeenAt: w.lastSeenAt })),
    counts: { mastered: entries.filter((w) => w.box >= rules.masteredBox).length, learning: entries.filter((w) => w.box >= 2 && w.box < rules.masteredBox).length, needsPractice: entries.filter((w) => w.box === 1).length },
    wordsToPractice: practiceWordsFor(progress, now),
    favouriteTopic: topic ? topic[0] : null,
    recentSessions: progress.recentSessions,
    rulesVersion: rules.version,
  };
}

// --- storage -----------------------------------------------------------------------------------

async function getProgress(childId) {
  return (await store.tutorProgress.get(childId)) ?? emptyProgress(childId);
}

async function saveProgress(progress) {
  await store.tutorProgress.set(progress.childId, progress);
}

async function deleteProgress(childId) {
  await store.tutorProgress.delete(childId);
}

module.exports = {
  emptyProgress, applyAttempt, completeSession, practiceWordsFor, viewOf, wordOutcomes, adjustLevel,
  getProgress, saveProgress, deleteProgress, rules, dayNumber, wordKey,
};
