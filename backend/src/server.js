require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const { seedTestAccount } = require("./db/seed");
const { checkConnection } = require("./db/postgres");
const { securityHeaders, rateLimit } = require("./middleware/security");
const { randomUUID } = require('node:crypto');
const requestContext = require('./context/requestContext');
const requireAuth = require('./middleware/requireAuth');
const requireRole = require('./middleware/requireRole');

const isProduction = process.env.NODE_ENV === "production";

const app = express();
app.use((req, res, next) => requestContext.run({ requestId: randomUUID() }, next));

if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);

app.use(cors({ origin: process.env.CORS_ORIGIN || (isProduction ? false : "*") }));
app.use(securityHeaders);
app.use(express.json({ limit: "50kb", inflate: false }));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get('/api/health/ai', (req, res) => res.json(require('./services/aiHealth').status()));
app.use('/api/admin', requireAuth, requireRole('admin'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/users', require('./routes/adminUsers'));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/tutor", require("./routes/tutor"));

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
    return res.status(status).json({ error: "internal server error" });
  }
  const message = err.type === "entity.parse.failed" ? "request body is not valid JSON" : err.message;
  res.status(status).json({ error: message, ...(err.code ? { code: err.code } : {}) });
});

async function start() {
  if (process.env.STORE_BACKEND === "memory") {
    if (isProduction) throw new Error("memory store is only for local preview and tests");
    console.warn("AI Speaking Tutor is running in temporary memory preview mode; data will not persist.");
  } else {
    await checkConnection();
  }
  // Persistent environments create test users explicitly through seed:auth.
  if (process.env.STORE_BACKEND === 'memory' && !isProduction) await seedTestAccount();
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`AI Speaking Tutor backend listening on http://localhost:${port}`));
}

if (require.main === module) start().catch((err) => {
  console.error("AI Speaking Tutor backend could not start:", err.message);
  process.exitCode = 1;
});
module.exports = { app, start };
