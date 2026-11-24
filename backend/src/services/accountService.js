// Account-level data rights: export everything the tutor holds about a parent and their children, or erase it
// all, together with the sign-in account itself. (Per-child export and deletion, and "delete all tutor data",
// are also available separately in tutorSessionService.)
const store = require("../store");
const tutor = require("./tutorSessionService");
const privacy = require("./tutorPrivacyService");
const { toPublicUser, httpError } = require("./authService");
const context = require("../context/requestContext");
const { adminClient, memoryPreview } = require("../db/supabase");
const aiRequestLog = require("./aiRequestLogService");

async function currentUser(userId) {
  const user = memoryPreview() ? await store.users.get(userId) : context.getStore()?.user;
  if (!user) throw httpError(404, "user not found");
  return user;
}

async function exportData(userId) {
  const user = await currentUser(userId);
  const children = [];
  for (const child of await tutor.listChildren(userId)) children.push(await tutor.exportChildData(userId, child.id));
  const aiRequests = await aiRequestLog.listForUser(userId);
  return { exportedAt: new Date().toISOString(), user: toPublicUser(user), privacy: await privacy.getPrivacy(userId), children, aiRequests };
}

async function deleteAccount(userId) {
  const user = await currentUser(userId);
  await tutor.deleteAllData(userId);
  if (!memoryPreview()) {
    await aiRequestLog.deleteForUser(userId);
    const { error } = await adminClient().auth.admin.deleteUser(userId);
    if (error) throw httpError(503, "could not delete authentication account");
    return;
  }
  for (const [token, record] of await store.tokens.entries()) {
    const owner = typeof record === "string" ? record : record.userId;
    if (owner === userId) await store.tokens.delete(token);
  }
  await store.usersByEmail.delete(user.email);
  await store.users.delete(userId);
}

module.exports = { exportData, deleteAccount };
