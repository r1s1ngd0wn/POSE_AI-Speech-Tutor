// Seeds two known logins for the temporary memory preview only (idempotent: checks first), so there is always an
// account to develop and demo against. A parent can sign in and set up consent, a PIN and child profiles; the
// teacher can review attempts that a parent has allowed. Persistent environments create accounts through
// Supabase Auth and `npm run seed:auth`, never through this file.
const store = require("../store");
const authService = require("../services/authService");

const PARENT = { email: "parent@tutor.test", password: "password123", name: "Test Parent" };
const TEACHER = { email: "teacher@tutor.test", password: "password123", name: "Test Teacher" };

async function seedTestAccount() {
  if (!(await store.usersByEmail.has(PARENT.email))) await authService.register(PARENT);
  if (!(await store.usersByEmail.has(TEACHER.email))) {
    const { user } = await authService.register(TEACHER);
    await store.users.set(user.id, { ...(await store.users.get(user.id)), role: "teacher" });
  }
}

module.exports = { seedTestAccount, PARENT, TEACHER };
