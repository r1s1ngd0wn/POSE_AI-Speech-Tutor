// Parent-side privacy controls for the tutor (SRS FR-02, FR-04, FR-17, FR-18, FR-19).
//
//   - Consent: the parent accepts a versioned consent text; the version and time are recorded (FR-02).
//   - Permissions: teacher review, audio retention and teacher audio review are separate and OFF by
//     default (FR-02). Teacher audio review needs audio retention (FR-19). Raw audio is not stored by
//     this release at all; the audio flags only record the parent's choice for when it is.
//   - Parent PIN: 4 to 6 digits, stored as a salted scrypt hash. Verifying it returns a short-lived signed
//     token that the browser sends on routes that need the PIN (profile settings, progress, privacy). Five
//     wrong PINs lock the PIN for five minutes (FR-04).
//   - Daily practice limit in minutes, optional (FR-04).
//
// A teacher's access is checked against the parent's current permission on every request, so turning a
// permission off takes effect immediately (FR-17).

const crypto = require("node:crypto");
const store = require("../store");
const { httpError } = require("../utils/httpError");
const consent = require("../data/tutorConsent.json");

const PIN_FORMAT = /^\d{4,6}$/;
const MAX_FAILED_PINS = 5;
const LOCK_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const PERMISSION_KEYS = ["teacherReview", "audioRetention", "teacherAudioReview"];

let fallbackSecret = null;
// Set TUTOR_PIN_SECRET in any deployment with more than one server process; the fallback is per process.
function secret() {
  const configured = (process.env.TUTOR_PIN_SECRET || "").trim();
  if (configured) return configured;
  fallbackSecret ??= crypto.randomBytes(32).toString("hex");
  return fallbackSecret;
}

const emptyParent = (parentId) => ({
  parentId,
  consent: null,
  permissions: { teacherReview: false, audioRetention: false, teacherAudioReview: false, updatedAt: null },
  pin: null,
  dailyLimitMinutes: null,
  failedPins: 0,
  lockedUntil: null,
  createdAt: new Date().toISOString(),
});

async function getParent(parentId) {
  return (await store.tutorParents.get(parentId)) ?? emptyParent(parentId);
}
const saveParent = (parent) => store.tutorParents.set(parent.parentId, parent);

// --- consent -----------------------------------------------------------------------------------

function consentText() {
  return { version: consent.version, status: consent.status, points: consent.points };
}

async function recordConsent(parentId, version, now = new Date().toISOString()) {
  if (version !== consent.version) throw httpError(400, "That is not the current consent version.", "CONSENT_VERSION_MISMATCH");
  const parent = await getParent(parentId);
  parent.consent = { version, acceptedAt: now };
  await saveParent(parent);
  return publicPrivacy(parent);
}

const hasConsent = (parent) => parent.consent?.version === consent.version;

// --- PIN ---------------------------------------------------------------------------------------

const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function checkPin(parent, pin, now) {
  if (parent.lockedUntil && new Date(parent.lockedUntil).getTime() > now) {
    const seconds = Math.ceil((new Date(parent.lockedUntil).getTime() - now) / 1000);
    throw Object.assign(httpError(429, `Too many wrong PINs. Try again in ${seconds} seconds.`, "PIN_LOCKED"), { retryAfterSeconds: seconds });
  }
  const ok = parent.pin && typeof pin === "string" && PIN_FORMAT.test(pin) && safeEqual(hashPin(pin, parent.pin.salt), parent.pin.hash);
  if (ok) {
    parent.failedPins = 0;
    parent.lockedUntil = null;
    return true;
  }
  parent.failedPins += 1;
  if (parent.failedPins >= MAX_FAILED_PINS) {
    parent.failedPins = 0;
    parent.lockedUntil = new Date(now + LOCK_MS).toISOString();
  }
  await saveParent(parent);
  throw httpError(403, "That PIN is not correct.", "PIN_INCORRECT");
}

async function setPin(parentId, { pin, currentPin } = {}, now = Date.now()) {
  if (typeof pin !== "string" || !PIN_FORMAT.test(pin)) throw httpError(400, "The PIN must be 4 to 6 digits.", "PIN_INVALID");
  const parent = await getParent(parentId);
  if (parent.pin) await checkPin(parent, currentPin, now);
  const salt = crypto.randomBytes(16).toString("hex");
  parent.pin = { salt, hash: hashPin(pin, salt), setAt: new Date(now).toISOString() };
  await saveParent(parent);
  return publicPrivacy(parent);
}

function signToken(parentId, expiresAt) {
  return crypto.createHmac("sha256", secret()).update(`${parentId}:${expiresAt}`).digest("hex");
}

async function verifyPin(parentId, pin, now = Date.now()) {
  const parent = await getParent(parentId);
  if (!parent.pin) throw httpError(403, "Set a parent PIN first.", "PIN_NOT_SET");
  await checkPin(parent, pin, now);
  await saveParent(parent);
  const expiresAt = now + TOKEN_TTL_MS;
  return { token: `${expiresAt}.${signToken(parentId, expiresAt)}`, expiresAt: new Date(expiresAt).toISOString() };
}

// Throws unless the parent has a PIN and the token is a valid, unexpired one for this parent.
async function assertPinToken(parentId, token, now = Date.now()) {
  const parent = await getParent(parentId);
  if (!parent.pin) throw httpError(403, "Set a parent PIN first.", "PIN_NOT_SET");
  const [expiresAt, signature] = String(token ?? "").split(".");
  const valid = Number(expiresAt) > now && signature && safeEqual(signature, signToken(parentId, expiresAt));
  if (!valid) throw httpError(403, "Enter your parent PIN to continue.", "PIN_REQUIRED");
}

// --- permissions and limit ---------------------------------------------------------------------

async function setPermissions(parentId, patch = {}, now = new Date().toISOString()) {
  const parent = await getParent(parentId);
  const next = { ...parent.permissions };
  for (const key of Object.keys(patch)) {
    if (!PERMISSION_KEYS.includes(key)) throw httpError(400, `Unknown permission: ${key}`);
    if (typeof patch[key] !== "boolean") throw httpError(400, `${key} must be true or false.`);
    next[key] = patch[key];
  }
  // Listening to audio needs the audio to be kept: asking for it without retention is an error, and
  // stopping retention also stops teacher listening.
  if (patch.teacherAudioReview === true && !next.audioRetention) throw httpError(400, "Teacher audio review needs audio retention to be on.");
  if (!next.audioRetention) next.teacherAudioReview = false;
  parent.permissions = { ...next, updatedAt: now };
  await saveParent(parent);
  return publicPrivacy(parent);
}

async function setDailyLimit(parentId, minutes) {
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 120)) {
    throw httpError(400, "The daily limit must be a whole number of minutes from 5 to 120, or null for no limit.");
  }
  const parent = await getParent(parentId);
  parent.dailyLimitMinutes = minutes;
  await saveParent(parent);
  return publicPrivacy(parent);
}

// --- views and deletion ------------------------------------------------------------------------

function publicPrivacy(parent) {
  return {
    consent: {
      currentVersion: consent.version,
      acceptedVersion: parent.consent?.version ?? null,
      acceptedAt: parent.consent?.acceptedAt ?? null,
      upToDate: hasConsent(parent),
    },
    permissions: { ...parent.permissions },
    pinSet: Boolean(parent.pin),
    dailyLimitMinutes: parent.dailyLimitMinutes,
    rawAudioStored: false,
  };
}

async function getPrivacy(parentId) {
  return publicPrivacy(await getParent(parentId));
}

async function deleteParent(parentId) {
  await store.tutorParents.delete(parentId);
}

module.exports = {
  consentText, recordConsent, hasConsent, getParent, getPrivacy,
  setPin, verifyPin, assertPinToken, setPermissions, setDailyLimit, deleteParent,
  CONSENT_VERSION: consent.version, MAX_FAILED_PINS, TOKEN_TTL_MS,
};
