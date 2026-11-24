// Production data lives in Supabase Postgres. Tests use isolated memory tables.
// users, usersByEmail and tokens only back the temporary memory-preview sign-in; Supabase Auth is used otherwise.
const { table } = require("./table");

module.exports = {
  users: table("interviewai_users", "id"),
  usersByEmail: table("interviewai_users_by_email", "email"),
  tokens: table("interviewai_tokens", "token"),
  // AI Speaking Tutor
  tutorChildren: table("tutor_children", "id"),
  tutorSessions: table("tutor_sessions", "id"),
  tutorProgress: table("tutor_progress", "child_id"),
  tutorReports: table("tutor_reports", "child_id"),
  tutorParents: table("tutor_parents", "parent_id"),
  tutorJudgments: table("tutor_judgments", "id"),
};
