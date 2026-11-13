const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const { rateLimit } = require("../middleware/security");
const tutor = require("../services/tutorSessionService");
const lessons = require("../services/tutorLessonService");
const topics = require("../data/tutorTopics.json").topics;

const router = express.Router();
router.use(requireAuth);

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

// Starting a session calls the language model, so it is limited more tightly than the other calls.
const startLimit = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.get("/topics", (req, res) => {
  res.json({ topics: lessons.topicIds.map((id) => ({ id, label: topics[id].label })) });
});

router.get("/children", handle(async (req, res) => {
  res.json({ children: await tutor.listChildren(req.user.id) });
}));

router.post("/children", handle(async (req, res) => {
  res.status(201).json({ child: await tutor.createChild(req.user.id, req.body) });
}));

router.delete("/children/:id", handle(async (req, res) => {
  res.json(await tutor.deleteChild(req.user.id, req.params.id));
}));

router.post("/sessions", startLimit, handle(async (req, res) => {
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

module.exports = router;
