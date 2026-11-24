// Child profiles and lesson sessions for the tutor (SRS v0.3 UC child lesson, FR-07, FR-12, FR-13).
//
// A parent account owns child profiles (a nickname and an age band, no real name, no password).
// Starting a session generates a lesson, then stores a snapshot of it including the accepted answers,
// so every score can be reproduced from what was stored. The browser never receives the answer key:
// it gets prompts, pictures and picture-choice options only. Each attempt is scored in code by
// tutorScoringService; the model is not involved after the lesson is written. Only the transcript
// of an attempt is stored here, never audio.

const store = require("../store");
const { newId } = require("../utils/id");
const { httpError } = require("../utils/httpError");
const lessons = require("./tutorLessonService");
const progressService = require("./tutorProgressService");
const reportService = require("./tutorReportService");
const privacyService = require("./tutorPrivacyService");
const reviewService = require("./tutorReviewService");
const { scrubContactDetails } = require("../utils/scrub");
const { scoreAttempt, rubricVersion } = require("./tutorScoringService");

const MAX_CHILDREN = 5;
const AVATARS = ["fox", "panda", "lion", "bunny", "owl", "frog", "bear", "cat"];
const DEFAULT_AVATAR = "fox";
const NICKNAME = /^[\p{L}][\p{L} '-]{0,19}$/u;
const MESSAGES = {
  3: "Great job!",
  2: "Good try!",
  1: "Nice effort! Let's try this again soon.",
  abandoned: "That's okay! Let's try the next one.",
};

// --- child profiles ----------------------------------------------------------------------------

const bandForAge = (age) => (age <= 7 ? "A" : "B");

function cleanNickname(value) {
  const name = String(value ?? "").trim();
  if (!NICKNAME.test(name)) throw httpError(400, "Nickname must be 1 to 20 letters (use a nickname, not a full name).");
  return name;
}

// The age (6 to 10) is what a parent enters; the age band is derived from it (FR-03). A bare ageBand is
// still accepted for callers that have no age.
function cleanAge({ age, ageBand }) {
  if (age !== undefined && age !== null && age !== "") {
    const n = Number(age);
    if (!Number.isInteger(n) || n < 6 || n > 10) throw httpError(400, "Age must be a whole number from 6 to 10.");
    return { age: n, ageBand: bandForAge(n) };
  }
  if (ageBand === "A" || ageBand === "B") return { age: null, ageBand };
  throw httpError(400, "Age (6 to 10) is required.");
}

function cleanAvatar(value) {
  if (value === undefined || value === null) return DEFAULT_AVATAR;
  if (!AVATARS.includes(value)) throw httpError(400, `Avatar must be one of: ${AVATARS.join(", ")}`);
  return value;
}

async function createChild(parentId, { nickname, age, ageBand, avatar } = {}) {
  const name = cleanNickname(nickname);
  const years = cleanAge({ age, ageBand });
  const picture = cleanAvatar(avatar);
  const existing = await store.tutorChildren.valuesWhere("parentId", parentId);
  if (existing.length >= MAX_CHILDREN) throw httpError(409, `A parent account can have at most ${MAX_CHILDREN} child profiles.`);
  const child = { id: newId("child"), parentId, nickname: name, ...years, avatar: picture, createdAt: new Date().toISOString() };
  await store.tutorChildren.set(child.id, child);
  return child;
}

// Edits a profile. Changing the age re-derives the age band; lessons already started keep their band.
async function updateChild(parentId, childId, patch = {}) {
  const child = await getOwnedChild(parentId, childId);
  const next = { ...child };
  if (patch.nickname !== undefined) next.nickname = cleanNickname(patch.nickname);
  if (patch.age !== undefined) Object.assign(next, cleanAge({ age: patch.age }));
  if (patch.avatar !== undefined) next.avatar = cleanAvatar(patch.avatar);
  await store.tutorChildren.set(child.id, next);
  return next;
}

async function listChildren(parentId) {
  return (await store.tutorChildren.valuesWhere("parentId", parentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function getOwnedChild(parentId, childId) {
  const child = await store.tutorChildren.get(childId);
  // Same answer for "missing" and "someone else's", so ids cannot be probed.
  if (!child || child.parentId !== parentId) throw httpError(404, "child profile not found");
  return child;
}

// Deleting a profile deletes everything stored about that child's practice.
async function deleteChild(parentId, childId) {
  await getOwnedChild(parentId, childId);
  const sessions = await store.tutorSessions.valuesWhere("childId", childId);
  for (const session of sessions) {
    await reviewService.deleteForSession(session.id);
    await store.tutorSessions.delete(session.id);
  }
  await store.tutorChildren.delete(childId);
  await progressService.deleteProgress(childId);
  await reportService.deleteReport(childId);
  return { deleted: true, sessionsDeleted: sessions.length };
}

// --- public views (never include the answer key) -----------------------------------------------

function hintFor(item) {
  return item.activityType === "name_picture" && item.pictureKey ? `It starts with "${item.pictureKey[0]}".` : null;
}

function publicItem(item) {
  return {
    id: item.id,
    activityType: item.activityType,
    prompt: item.prompt,
    ...(item.say ? { say: item.say } : {}),
    ...(item.picture ? { picture: item.picture } : {}),
    choices: item.choices ? item.choices.map(({ id, label, emoji }) => ({ id, label, ...(emoji ? { emoji } : {}) })) : null,
    hint: hintFor(item),
  };
}

function summarise(session) {
  const scored = session.attempts.filter((a) => a.result.completed);
  return {
    starsEarned: scored.reduce((sum, a) => sum + a.result.stars, 0),
    starsPossible: session.items.length * 3,
    activitiesDone: session.attempts.length,
    activitiesTotal: session.items.length,
    perActivity: session.attempts.map((a) => ({ itemId: a.itemId, stars: a.result.stars })),
  };
}

function publicSession(session) {
  const current = session.items[session.currentIndex];
  return {
    id: session.id,
    childId: session.childId,
    topicId: session.topicId,
    topicLabel: session.topicLabel,
    status: session.status,
    story: session.story,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    currentIndex: session.currentIndex,
    totalItems: session.items.length,
    current: session.status === "active" && current ? publicItem(current) : null,
    summary: summarise(session),
  };
}

// --- sessions ----------------------------------------------------------------------------------

// Minutes the child has practised today (in the pilot's time zone). An unfinished session counts up to its
// last answer, so leaving a session open does not use up the allowance.
async function minutesPractisedToday(childId, now = new Date().toISOString()) {
  const today = progressService.dayNumber(now);
  const sessions = (await store.tutorSessions.valuesWhere("childId", childId)).filter((x) => progressService.dayNumber(x.startedAt) === today);
  const ms = sessions.reduce((sum, x) => {
    const end = x.endedAt ?? x.attempts[x.attempts.length - 1]?.at ?? x.startedAt;
    return sum + Math.max(0, new Date(end).getTime() - new Date(x.startedAt).getTime());
  }, 0);
  return ms / 60000;
}

// The parent's optional daily limit (FR-04): no new lesson once the limit is used up.
async function assertUnderDailyLimit(parentId, childId) {
  const { dailyLimitMinutes } = await privacyService.getParent(parentId);
  if (!dailyLimitMinutes) return;
  if ((await minutesPractisedToday(childId)) >= dailyLimitMinutes) {
    throw httpError(403, "Today's practice time is used up. Come back tomorrow!", "DAILY_LIMIT_REACHED");
  }
}

async function getOwnedSession(parentId, sessionId) {
  const session = await store.tutorSessions.get(sessionId);
  if (!session || session.parentId !== parentId) throw httpError(404, "session not found");
  return session;
}

async function startSession(parentId, { childId, topicId } = {}, deps = {}) {
  const child = await getOwnedChild(parentId, childId);
  await assertUnderDailyLimit(parentId, child.id);
  if (!lessons.topicIds.includes(topicId)) throw httpError(400, `Unknown topic: ${topicId}`);
  // The learner model chooses the difficulty level and the words to practise; the model only writes the lesson.
  const progress = await progressService.getProgress(child.id);
  const lesson = await lessons.generateLesson({ topicId, ageBand: child.ageBand, level: progress.level, practiceWords: progressService.practiceWordsFor(progress) }, deps);
  const session = {
    id: newId("tsess"),
    parentId,
    childId: child.id,
    topicId,
    topicLabel: lesson.topicLabel,
    ageBand: child.ageBand,
    level: progress.level,
    status: "active",
    story: lesson.story,
    // The full lesson including accepted answers stays on the server; see the file comment.
    items: lesson.items,
    lessonMeta: lesson.meta,
    rubricVersion,
    currentIndex: 0,
    attempts: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  await store.tutorSessions.set(session.id, session);
  return publicSession(session);
}

async function getSession(parentId, sessionId) {
  return publicSession(await getOwnedSession(parentId, sessionId));
}

const number = (value, { min, max, integer = false }) => {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, "A numeric field was not a number.");
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
};

// Only the fields the scorer uses are kept; everything is bounded.
function cleanResponse(raw, item) {
  if (!raw || typeof raw !== "object") throw httpError(400, "response is required");
  const mode = raw.mode;
  if (!["speech", "picture", "abandoned"].includes(mode)) throw httpError(400, "response.mode must be speech, picture or abandoned");
  const clean = { mode };
  if (mode === "abandoned") return clean;

  clean.firstAttemptMs = number(raw.firstAttemptMs, { min: 0, max: 300000, integer: true });
  clean.attemptCount = number(raw.attemptCount, { min: 1, max: 5, integer: true });
  clean.hintUsed = Boolean(raw.hintUsed);

  if (mode === "picture") {
    if (!item.choices) throw httpError(400, "This activity has no picture-choice fallback.");
    if (!item.choices.some((c) => c.id === raw.choiceId)) throw httpError(400, "choiceId is not one of the options.");
    clean.choiceId = raw.choiceId;
    return clean;
  }

  // Contact details are removed before the text is scored or stored (FR-11).
  clean.transcript = scrubContactDetails(String(raw.transcript ?? "").slice(0, 300));
  clean.confidence = number(raw.confidence, { min: 0, max: 1 });
  if (Array.isArray(raw.wordConfidences)) {
    clean.wordConfidences = raw.wordConfidences.slice(0, 20).flatMap((w) => {
      const confidence = number(w?.confidence, { min: 0, max: 1 });
      return typeof w?.word === "string" && confidence !== undefined ? [{ word: w.word.slice(0, 30), confidence }] : [];
    });
  }
  return clean;
}

function revealFor(item) {
  if (item.activityType === "listen_repeat") return item.say;
  if (item.activityType === "name_picture") return item.pictureKey;
  return item.answerCategory ? null : item.acceptedAnswers[0]?.text ?? null;
}

async function submitAttempt(parentId, sessionId, { itemId, response } = {}) {
  const session = await getOwnedSession(parentId, sessionId);
  if (session.status !== "active") throw httpError(409, "This session is finished.");
  const item = session.items[session.currentIndex];
  if (!item || item.id !== itemId) throw httpError(409, "That is not the current activity.");

  const clean = cleanResponse(response, item);
  const result = scoreAttempt(item, clean, { ageBand: session.ageBand });
  session.attempts.push({ itemId: item.id, at: new Date().toISOString(), source: item.source, response: clean, result });
  session.currentIndex += 1;
  if (session.currentIndex >= session.items.length) {
    session.status = "completed";
    session.endedAt = new Date().toISOString();
  }
  await store.tutorSessions.set(session.id, session);

  // Word progress updates after every scored attempt; rewards and the level are settled when the lesson is completed.
  const at = session.attempts[session.attempts.length - 1].at;
  let progress = progressService.applyAttempt(await progressService.getProgress(session.childId), { item, result, mode: clean.mode, at });
  let rewards = null;
  if (session.status === "completed") {
    const done = progressService.completeSession(progress, session, at);
    progress = done.progress;
    rewards = {
      newStickers: done.newStickers.map((id) => ({ id, label: progressService.rules.stickers[id] })),
      streak: progress.streak.current,
      level: progress.level,
    };
  }
  await progressService.saveProgress(progress);

  const stars = result.completed ? result.stars : null;
  return {
    result: {
      stars,
      completed: result.completed,
      criteria: result.criteria.filter((c) => c.band !== null).map(({ id, band }) => ({ id, band })),
    },
    feedback: MESSAGES[stars ?? "abandoned"],
    reveal: revealFor(item),
    done: session.status === "completed",
    rewards,
    session: publicSession(session),
  };
}

async function getChildProgress(parentId, childId) {
  const child = await getOwnedChild(parentId, childId);
  return { child: { id: child.id, nickname: child.nickname, ageBand: child.ageBand }, progress: progressService.viewOf(await progressService.getProgress(child.id)) };
}

// Ends a session early (the child stopped). Activities not reached get no stars.
async function finishSession(parentId, sessionId) {
  const session = await getOwnedSession(parentId, sessionId);
  if (session.status === "active") {
    session.status = "abandoned";
    session.endedAt = new Date().toISOString();
    await store.tutorSessions.set(session.id, session);
  }
  return publicSession(session);
}

// A parent's copy of everything stored about one child (FR-17). The answer key is left out: it is not
// the child's data, and the export is for the parent to read.
async function exportChildData(parentId, childId) {
  const child = await getOwnedChild(parentId, childId);
  const sessions = (await store.tutorSessions.valuesWhere("childId", child.id)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const progress = progressService.viewOf(await progressService.getProgress(child.id));
  const report = await store.tutorReports.get(child.id);
  return {
    exportedAt: new Date().toISOString(),
    child: { nickname: child.nickname, age: child.age, avatar: child.avatar, ageBand: child.ageBand, createdAt: child.createdAt },
    progress,
    sessions: sessions.map((x) => ({
      id: x.id, topic: x.topicLabel, status: x.status, level: x.level, startedAt: x.startedAt, endedAt: x.endedAt,
      attempts: x.attempts.map((a) => {
        const item = x.items.find((i) => i.id === a.itemId);
        return {
          prompt: item?.prompt, activityType: item?.activityType, at: a.at, responseMode: a.response.mode, transcript: a.response.transcript ?? null,
          stars: a.result.stars, bands: a.result.criteria.filter((c) => c.band !== null).map(({ id, band }) => ({ id, band })),
        };
      }),
    })),
    report: report ? { generatedAt: report.generatedAt, narrative: report.narrative, disclaimer: report.disclaimer } : null,
  };
}

// Deletes everything the tutor stores for this parent: profiles, sessions, progress, reports, teacher
// judgments about their children's attempts, and the privacy settings including the PIN.
async function deleteAllData(parentId) {
  const children = await listChildren(parentId);
  let sessionsDeleted = 0;
  for (const child of children) sessionsDeleted += (await deleteChild(parentId, child.id)).sessionsDeleted;
  await privacyService.deleteParent(parentId);
  return { deleted: true, children: children.length, sessionsDeleted };
}

module.exports = {
  createChild, updateChild, listChildren, getOwnedChild, deleteChild, exportChildData, deleteAllData, minutesPractisedToday,
  startSession, getSession, submitAttempt, finishSession, getChildProgress,
  MAX_CHILDREN,
};
