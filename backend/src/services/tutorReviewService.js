// Teacher review of system scores (SRS FR-19, FR-20).
//
// A teacher sees only attempts from children whose parent currently has "teacher review" turned on, and
// only in de-identified form: no nickname, age, avatar, account or child id, and no dates. The review id
// is the random session id plus the activity id, which cannot be traced to a child without the database.
// Access is checked against the parent's permission on every call, so a parent who turns the permission
// off removes new teacher access immediately. Transcripts are scrubbed of contact details again before
// display. Raw audio is not stored by this release, so no audio is ever offered.
//
// The teacher records whether they agree with the system's stars and may add a short note about the
// scoring or about unclear content. The share of agreement is the pilot's "teacher agreement" measure.

const store = require("../store");
const { httpError } = require("../utils/httpError");
const { scrubContactDetails } = require("../utils/scrub");
const privacyService = require("./tutorPrivacyService");

const VERDICTS = ["agree", "too_high", "too_low"];
const NOTE_MAX = 500;
const PAGE_MAX = 50;

const reviewIdOf = (sessionId, itemId) => `${sessionId}.${itemId}`;

// Parents who currently allow teacher review.
async function permittedParentIds() {
  const parents = await store.tutorParents.values();
  return new Set(parents.filter((p) => p.permissions?.teacherReview).map((p) => p.parentId));
}

function targetOf(item) {
  if (item.activityType === "listen_repeat") return item.say;
  if (item.activityType === "name_picture") return item.pictureKey;
  return item.answerCategory ? `(any ${item.answerCategory})` : item.acceptedAnswers?.[0]?.text ?? null;
}

function chosenLabel(item, response) {
  return item.choices?.find((c) => c.id === response.choiceId)?.label ?? null;
}

// The de-identified view of one scored attempt.
function view(session, attempt, item, judgment) {
  const { result, response } = attempt;
  return {
    reviewId: reviewIdOf(session.id, attempt.itemId),
    activityType: item.activityType,
    topic: session.topicLabel,
    ageBand: session.ageBand,
    prompt: item.prompt,
    target: targetOf(item),
    responseMode: response.mode,
    transcript: response.mode === "speech" ? scrubContactDetails(response.transcript ?? "") : null,
    chosenPicture: response.mode === "picture" ? chosenLabel(item, response) : null,
    system: {
      stars: result.stars,
      bands: result.criteria.filter((c) => c.band !== null).map(({ id, band }) => ({ id, band })),
      rubricVersion: result.rubricVersion,
      confidence: result.inputs?.clarity?.confidence ?? null,
    },
    source: item.source, // "ai" or "fallback": lets a teacher flag AI-written content
    judged: Boolean(judgment),
    myJudgment: judgment ? { verdict: judgment.verdict, note: judgment.note, contentIssue: judgment.contentIssue } : null,
  };
}

async function collect(teacherId) {
  const allowed = await permittedParentIds();
  const rows = [];
  for (const parentId of allowed) {
    for (const session of await store.tutorSessions.valuesWhere("parentId", parentId)) {
      for (const attempt of session.attempts) {
        if (!attempt.result.completed) continue;
        const item = session.items.find((i) => i.id === attempt.itemId);
        if (!item) continue;
        rows.push({ session, attempt, item });
      }
    }
  }
  const judgments = await store.tutorJudgments.values();
  const mine = new Map(judgments.filter((j) => j.teacherId === teacherId).map((j) => [j.reviewId, j]));
  return { rows, mine };
}

// status: "unjudged" (default) or "all"; paged by review id.
async function queue(teacherId, { status = "unjudged", limit = 20, after } = {}) {
  const size = Math.min(PAGE_MAX, Math.max(1, Number.isInteger(limit) ? limit : 20));
  const { rows, mine } = await collect(teacherId);
  const views = rows
    .map(({ session, attempt, item }) => view(session, attempt, item, mine.get(reviewIdOf(session.id, attempt.itemId))))
    .filter((v) => status === "all" || !v.judged)
    .sort((a, b) => (a.reviewId < b.reviewId ? -1 : 1))
    .filter((v) => !after || v.reviewId > after);
  const page = views.slice(0, size);
  return { items: page, next: views.length > size ? page[page.length - 1].reviewId : null };
}

async function find(teacherId, reviewId) {
  const { rows, mine } = await collect(teacherId);
  const hit = rows.find(({ session, attempt }) => reviewIdOf(session.id, attempt.itemId) === reviewId);
  // Same answer whether the attempt does not exist or its parent has not (or no longer) allowed review.
  if (!hit) throw httpError(404, "review item not found");
  return { hit, judgment: mine.get(reviewId) };
}

async function get(teacherId, reviewId) {
  const { hit, judgment } = await find(teacherId, reviewId);
  return view(hit.session, hit.attempt, hit.item, judgment);
}

async function judge(teacherId, reviewId, { verdict, note, contentIssue } = {}, now = new Date().toISOString()) {
  if (!VERDICTS.includes(verdict)) throw httpError(400, `verdict must be one of: ${VERDICTS.join(", ")}`);
  if (note !== undefined && note !== null && typeof note !== "string") throw httpError(400, "note must be text");
  const { hit } = await find(teacherId, reviewId);
  const judgment = {
    id: `${reviewId}:${teacherId}`,
    reviewId,
    sessionId: hit.session.id, // lets deleting a child delete the judgments about their attempts
    teacherId,
    verdict,
    note: scrubContactDetails(String(note ?? "")).slice(0, NOTE_MAX),
    contentIssue: Boolean(contentIssue),
    systemStars: hit.attempt.result.stars,
    rubricVersion: hit.attempt.result.rubricVersion,
    createdAt: now,
  };
  await store.tutorJudgments.set(judgment.id, judgment);
  return view(hit.session, hit.attempt, hit.item, judgment);
}

// Agreement between the teacher(s) and the system's stars on the permitted sample.
async function summary(teacherId) {
  const { rows, mine } = await collect(teacherId);
  const reviewable = rows.length;
  const judged = [...mine.values()].filter((j) => rows.some(({ session, attempt }) => reviewIdOf(session.id, attempt.itemId) === j.reviewId));
  const count = (v) => judged.filter((j) => j.verdict === v).length;
  return {
    reviewable,
    judged: judged.length,
    agree: count("agree"),
    tooHigh: count("too_high"),
    tooLow: count("too_low"),
    contentIssues: judged.filter((j) => j.contentIssue).length,
    agreementRate: judged.length ? Math.round((100 * count("agree")) / judged.length) / 100 : null,
  };
}

async function deleteForSession(sessionId) {
  for (const j of await store.tutorJudgments.valuesWhere("sessionId", sessionId)) await store.tutorJudgments.delete(j.id);
}

module.exports = { queue, get, judge, summary, deleteForSession, VERDICTS };
