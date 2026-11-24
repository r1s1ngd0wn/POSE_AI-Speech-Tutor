# Setup, running and deployment

How to run the AI Speaking Tutor backend locally, set up Supabase and sign-in, and deploy. For the API itself see
[TUTOR_API.md](TUTOR_API.md).

## 1. Run it without any cloud account

Requires Node.js 22.5 or newer.

```bash
cd backend
npm ci
npm test                       # no database or API keys needed
STORE_BACKEND=memory npm run dev
```

On Windows PowerShell set the variable first: `$env:STORE_BACKEND="memory"; npm run dev`.

The memory preview keeps everything in RAM (nothing persists, never use it in production) and seeds two logins,
both with password `password123`: `parent@tutor.test` (a parent) and `teacher@tutor.test` (a teacher).
Without a language model configured, lessons come from the vetted fallback set; see section 5 to add one.

## 2. Supabase

1. Create the team's Supabase project and invite the others through the project organization. Do not share service
   keys in chat or in source control.
2. Apply the migrations in `supabase/migrations/` in filename order (Supabase CLI: `supabase login`, `supabase link
   --project-ref <ref>`, `supabase db push`; or paste them into the SQL editor). Review the list before applying it to
   a shared project.

   | Migration | Needed by the tutor? |
   |---|---|
   | `20261024000100_profiles.sql` | Yes: profiles, roles, account status |
   | `20261024000200_plans_actions_logs.sql` | Yes, for the `ai_logs` table (it also creates InterviewAI plan tables the tutor does not use) |
   | `20261025000100_unified_ai_logs.sql`, `20261026000100_admin_ai_usage_summary.sql`, `20261026000200_enforce_auth_account_status.sql` | Yes: AI logging, the admin usage summary, account status |
   | `20261110000100_tutor_sessions.sql`, `20261113000100_tutor_progress.sql`, `20261113000200_tutor_reports.sql`, `20261124000100_tutor_privacy_review.sql` | Yes: the tutor's tables and the `teacher` role |
   | `20261023000100_app_store.sql` | No: tables for the memory-preview sign-in only |
   | `20261023000200_rag.sql`, `20261023000300_document_library.sql`, `20261024000300_long_rag_rls.sql` | No: InterviewAI's CV and document search. They need the `vector` extension. In a **new** project you can skip these three together; they stay in the repository for the existing InterviewAI project |

3. Only the backend connects to the tutor tables, with the service key. Row level security is on with no policies, so the browser
   cannot read them. Never put the service key, database URL or a provider key in frontend code.

## 3. Sign-in (Supabase Auth and Google)

1. In Google Cloud create a Web OAuth client. Its authorized callback is
   `https://<project-ref>.supabase.co/auth/v1/callback`. Configure the consent screen and test users as your Google project needs.
2. In Supabase Auth, Providers, enable Google with that client ID and secret. Set the Site URL to the frontend origin and allow
   `http://localhost:5173/login` plus your deployed frontend's `/login` under redirect URLs.
3. Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env`. Put the public URL and anon key in
   both; the database connection and service key only in the backend.
4. Use a Session pooler or direct database connection reachable from where the backend runs.

New Auth users start with their own data: accounts are not merged with old ones by matching email.

## 4. A real test account, an administrator and teachers

- **Test account.** Set `TEST_USER_EMAIL` and a unique `TEST_USER_PASSWORD` (12+ characters) in `backend/.env`, then
  `npm run seed:auth` in `backend/`. It creates a confirmed email/password account and does not change an existing one.
- **Administrator.** After the first real admin has signed up and verified their email, set `ADMIN_EMAILS` to a comma-separated
  list and run `npm run bootstrap:admins`. It grants existing verified accounts the admin role.
- **Teachers.** A teacher is an account whose profile role is `teacher`. An administrator sets it:

  ```sql
  UPDATE public.profiles SET role = 'teacher' WHERE id = '<the teacher''s auth user id>';
  ```

## 5. Language model and speech (all optional)

Everything is off until chosen. Without a model, lessons use the vetted fallback content; without a speech provider the
browser does speech.

| Setting | Use |
|---|---|
| `TUTOR_LLM_PROVIDER=local` with `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL` | A local OpenAI-compatible server (LM Studio and similar). Nothing leaves the machine |
| `TUTOR_LLM_PROVIDER=openrouter` with `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter. Pin one model and check its data policy before children use it |
| `TUTOR_STT_PROVIDER` (`xai` or `groq`), `TUTOR_TTS_PROVIDER=xai`, `XAI_API_KEY`, `GROQ_API_KEY` | Server-side speech. Not verified for children's voices or data policy |
| `TUTOR_PIN_SECRET` | **Required** in any deployment: signs the parent PIN tokens |

Useful checks (each needs the relevant setting): `npm run try:lessons` (how much of the model's lesson text passes
validation), `npm run try:report`, and `npm run eval:stt -- <folder of permitted recordings>` (child-speech accuracy and latency).

## 6. AI request logging and health

Every model, speech and voice call records metadata in `public.ai_logs`: provider, model, capability, operation, prompt version,
token counts, duration and status. Prompts, children's words, audio, replies and keys are never stored. See
[../backend/docs/unified-ai-logs.md](../backend/docs/unified-ai-logs.md).

`backend/src/config/pricing.json` holds list prices used for a `cost_usd` estimate. Models with no entry get a null cost. Add
the model you choose, with the date and source of its price; it is an estimate, not an invoice.

`GET /api/health/ai` reports whether a tutor model is configured and the outcome of the most recent model call. It makes no paid request.
Speech and voice failures do not change it.

## 7. Verification

```bash
npm test --prefix backend
```

The tests use in-memory tables and stubbed providers (no paid calls), run every migration in an embedded PostgreSQL and check the
database-level rules. They do not apply migrations to a live Supabase project.

## 8. Deployment

- **Render:** create a Blueprint from `render.yaml`, fill the secret values (including `TUTOR_PIN_SECRET`) and set `CORS_ORIGIN` to
  the exact frontend origin. `/api/health` is the health check. Do not enable the memory preview in production.
- **Vercel:** import the repository with root directory `frontend`, Vite, build `npm run build`, output `dist`. Set `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY` and `VITE_API_BASE_URL=https://<backend>/api`.
- **Docker:** put the variables in an ignored repo-root `.env` and run `docker compose up --build`. Compose passes only public Supabase
  settings to the frontend build. A local model server must be reachable from inside the container (`host.docker.internal`, not `localhost`).
