# AI request metadata

Every outbound model, speech or voice call records one row in `public.ai_logs`. Instrumentation sits at the outbound provider
attempt (`trackAiRequest` in `backend/src/services/aiTelemetry.js`); do not add a second summary row in the code that calls it.
A call that fails or times out is logged with its status. An unconfigured provider makes no call and logs nothing.

| capability | operation | caller |
| --- | --- | --- |
| `lesson` | `json` | lesson generation and learner-report narratives (`tutorLlm`), one row per attempt |
| `speech` | `transcribe` | a child's spoken answer sent to the speech-to-text provider |
| `tts` | `speak` | a tutor line sent to the text-to-speech provider (cached lines make no call) |

`provider` is `local`, `openrouter`, `xai` or `groq`. The HTTP request context supplies `request_id` and the owner. Tokens come from the
provider's usage figures; missing usage or a model with no entry in `config/pricing.json` leaves usage or cost `NULL`. A cost is a
list-price estimate, not an invoice.

**Never stored:** prompts, lesson or report text, transcripts, audio, tool arguments, API keys or raw provider errors. The log
therefore holds no child's words.

## Database

Created by `20261024000200_plans_actions_logs.sql` and extended by `20261025000100_unified_ai_logs.sql`. Dashboards read only
`ai_logs`, behind backend admin authorization (`GET /api/admin/ai-usage`, `/api/admin/ai-logs`); the client roles have no access.
`aiRequestLogService` keeps `listForUser` and `deleteForUser` for account export and erasure. Rows written before the unified table
used a text owner id in `legacy_user_id`; new rows use the authenticated user's UUID in `user_id`.

If the older `interviewai_ai_request_logs` table exists (the InterviewAI project), the migration copies it once and replay does not
duplicate rows; a new project has no such table and the step does nothing.

## Verification

`npm test` from `backend`. The SQL tests run the migrations in an embedded PostgreSQL, including the optional legacy table and replay.
Provider tests stub HTTP and persistence and make no paid calls.
