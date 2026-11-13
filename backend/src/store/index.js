// Production data lives in Supabase Postgres. Tests use isolated memory tables.
const { table } = require("./table");

module.exports = {
  users: table("interviewai_users", "id"),
  usersByEmail: table("interviewai_users_by_email", "email"),
  tokens: table("interviewai_tokens", "token"),
  sessions: table("interviewai_sessions", "id"),
  feedbacks: table("interviewai_feedbacks", "session_id"),
  sessionChats: table("interviewai_session_chats", "session_id"),
  // AI Speaking Tutor
  tutorChildren: table("tutor_children", "id"),
  tutorSessions: table("tutor_sessions", "id"),
  tutorProgress: table("tutor_progress", "child_id"),
  tutorReports: table("tutor_reports", "child_id"),
};
