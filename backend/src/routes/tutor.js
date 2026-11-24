const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const requireRole = require("../middleware/requireRole");
const { rateLimit } = require("../middleware/security");
const tutor = require("../services/tutorSessionService");
const lessons = require("../services/tutorLessonService");
const reportService = require("../services/tutorReportService");
const privacy = require("../services/tutorPrivacyService");
const review = require("../services/tutorReviewService");
const { httpError } = require("../utils/httpError");
const topics = require("../data/tutorTopics.json").topics;

const router = express.Router();
router.use(requireAuth);

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.retryAfterSeconds) res.setHeader("Retry-After", error.retryAfterSeconds);
    next(error);
  }
};

// Consent must be on record (current version) before a profile is created or a lesson is started (FR-02).
const consented = async (req, res, next) => {
  try {
    if (!privacy.hasConsent(await privacy.getParent(req.user.id))) throw httpError(403, "Parent consent is required first.", "CONSENT_REQUIRED");
    next();
  } catch (error) {
    next(error);
  }
};

// Routes that change profiles, show progress or change privacy need the parent PIN token (FR-04).
const pinned = async (req, res, next) => {
  try {
    await privacy.assertPinToken(req.user.id, req.headers["x-parent-pin-token"]);
    next();
  } catch (error) {
    next(error);
  }
};
const teacherOnly = requireRole("teacher", "admin");

// Starting a session or a report calls the language model, and PIN checks guard a short secret.
const startLimit = rateLimit({ windowMs: 60 * 1000, max: 10 });
const reportLimit = rateLimit({ windowMs: 60 * 1000, max: 5 });
const pinLimit = rateLimit({ windowMs: 60 * 1000, max: 20 });

router.get("/topics", (req, res) => {
  res.json({ topics: lessons.topicIds.map((id) => ({ id, label: topics[id].label })) });
});

// --- consent, PIN, privacy settings ---------------------------------------------------------------

router.get("/consent", (req, res) => res.json({ consent: privacy.consentText() }));

router.post("/consent", handle(async (req, res) => {
  res.status(201).json({ privacy: await privacy.recordConsent(req.user.id, req.body?.version) });
}));

router.get("/privacy", handle(async (req, res) => {
  res.json({ privacy: await privacy.getPrivacy(req.user.id) });
}));

router.post("/pin", pinLimit, handle(async (req, res) => {
  res.status(201).json({ privacy: await privacy.setPin(req.user.id, req.body) });
}));

router.post("/pin/verify", pinLimit, handle(async (req, res) => {
  res.json(await privacy.verifyPin(req.user.id, req.body?.pin));
}));

router.put("/privacy/permissions", pinned, handle(async (req, res) => {
  res.json({ privacy: await privacy.setPermissions(req.user.id, req.body) });
}));

router.put("/privacy/limit", pinned, handle(async (req, res) => {
  const minutes = req.body?.minutes === undefined ? undefined : req.body.minutes;
  if (minutes === undefined) throw httpError(400, "minutes is required (a number, or null for no limit).");
  res.json({ privacy: await privacy.setDailyLimit(req.user.id, minutes) });
}));

router.delete("/data", pinned, handle(async (req, res) => {
  res.json(await tutor.deleteAllData(req.user.id));
}));

// --- child profiles -------------------------------------------------------------------------------

// The profile picker is shown to the child, so listing needs no PIN; changing profiles does.
router.get("/children", handle(async (req, res) => {
  res.json({ children: await tutor.listChildren(req.user.id) });
}));

router.post("/children", consented, pinned, handle(async (req, res) => {
  res.status(201).json({ child: await tutor.createChild(req.user.id, req.body) });
}));

router.patch("/children/:id", pinned, handle(async (req, res) => {
  res.json({ child: await tutor.updateChild(req.user.id, req.params.id, req.body) });
}));

router.delete("/children/:id", pinned, handle(async (req, res) => {
  res.json(await tutor.deleteChild(req.user.id, req.params.id));
}));

router.get("/children/:id/progress", pinned, handle(async (req, res) => {
  res.json(await tutor.getChildProgress(req.user.id, req.params.id));
}));

router.post("/children/:id/report", pinned, reportLimit, handle(async (req, res) => {
  res.status(201).json({ report: await reportService.generateReport(req.user.id, req.params.id) });
}));

router.get("/children/:id/report", pinned, handle(async (req, res) => {
  res.json({ report: await reportService.getReport(req.user.id, req.params.id) });
}));

router.get("/children/:id/export", pinned, handle(async (req, res) => {
  res.json(await tutor.exportChildData(req.user.id, req.params.id));
}));

// --- lessons (the child plays; no PIN, but consent must be on record) ---------------------------

router.post("/sessions", consented, startLimit, handle(async (req, res) => {
  res.status(201).json({ session: await tutor.startSession(req.user.id, req.body) });
}));

router.get("/sessions/:id", handle(async (req, res) => {
  res.json({ session: await tutor.getSession(req.user.id, req.params.id) });
}));

router.post("/sessions/:id/attempts", handle(async (req, res) => {
  res.json(await tutor.submitAttempt(req.user.id, req.params.id, req.body));
}));

router.post("/sessions/:id/finish", handle(async (req, res) => {
  res.json({ session: await tutor.finishSession(req.user.id, req.params.id) });
}));

// --- teacher review (role teacher or admin) -----------------------------------------------------

router.get("/review/summary", teacherOnly, handle(async (req, res) => {
  res.json({ summary: await review.summary(req.user.id) });
}));

router.get("/review/queue", teacherOnly, handle(async (req, res) => {
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  res.json(await review.queue(req.user.id, { status: req.query.status, limit, after: req.query.after }));
}));

router.get("/review/:reviewId", teacherOnly, handle(async (req, res) => {
  res.json({ item: await review.get(req.user.id, req.params.reviewId) });
}));

router.post("/review/:reviewId/judgment", teacherOnly, handle(async (req, res) => {
  res.status(201).json({ item: await review.judge(req.user.id, req.params.reviewId, req.body) });
}));

module.exports = router;
