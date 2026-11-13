# AI Speaking Tutor

A web app that lets children aged 6 to 10 practise basic spoken English in short, guided lessons.
A parent manages the account and the child profiles. The tutor speaks a short prompt, the child
answers by voice (or by tapping a picture if the microphone is not available), and **code, not an AI
model, scores the answer from one to three stars** using a versioned rubric.

This is a course project (HCMUTE, group 03, supervised by PhD. Mai Anh Tho) built for a partner
company that wants a cloud-based, scalable tutor. The repository started as **InterviewAI**, an adult
interview-practice app, and is being converted. The tutor lives alongside the InterviewAI code it
reuses (login, roles, logging, tests, Docker); parts that do not belong to the tutor are still here and
are marked below.

> **Status: work in progress.** The tutor's backend (scoring, lesson generation, child profiles and
> lesson sessions) works and is tested. There is **no child-facing screen yet**; the React app in
> `frontend/` is still the InterviewAI interface. See [What works today](#what-works-today).

## Scope

The scope follows the Software Requirements Specification, v0.3 (pilot release), plus three changes
requested by the supervisor after it was written. The SRS has not been updated for those three yet.

**Pilot scope (SRS v0.3)**

- Children aged 6 to 10 in two age bands: Band A (6 to 7) and Band B (8 to 10).
- Three activity types: **Listen and Repeat**, **Name the Picture**, **Answer the Question**.
- One configured speech-to-text, text-to-speech and language-model service.
- Deterministic scoring in code. The language model never assigns or changes a score.
- Picture-choice fallback when speech input fails.
- A parent account with child profiles, consent, and a parent PIN.
- Separate, off-by-default permissions for teacher review of transcripts and for keeping audio.
- A teacher who reviews only permitted, de-identified attempts.
- Not in the pilot: load targets, multiple providers with automatic switching, a curriculum editor,
  weekly email summaries, per-phoneme pronunciation scoring.

**Supervisor changes (planned, not yet in the SRS)**

1. The AI generates the lesson content (setting, questions, accepted answers) from topics children
   like, such as animals, nature or a made-up character. Scoring stays in code.
2. The app tracks each child's progress to personalise and adapt later lessons.
3. The accumulated progress feeds a comprehensive written overview of the learner.

## What works today

| Area | Status |
|---|---|
| Rubric scoring (Clarity, Accuracy, Completeness, Participation; stars) | Done, tested |
| Lesson generation by a language model, with code-side validation and vetted fallback lessons | Done, tested; measured once against a local model (see below) |
| Child profiles and lesson sessions API (`/api/tutor`) | Done, tested |
| Storage for child profiles and sessions (Postgres migration; memory mode for tests) | Done |
| Speech-to-text and text-to-speech for the tutor | Not started. The InterviewAI Groq Whisper service (`/api/speech`) still exists but is not wired into the tutor. xAI is a candidate and is unverified |
| Child-facing web screens | Not started |
| Learner model: word mastery, adaptive difficulty, stickers, streaks | Not started |
| Comprehensive learner report | Not started |
| Parent PIN, consent flow, teacher review, roles for the tutor | Not started. Any signed-in account can currently act as a parent |
| Removal of InterviewAI-only code | Not started (see [Legacy InterviewAI code](#legacy-interviewai-code)) |

## How it works

```
Browser (React)  ──HTTPS/JSON──▶  Express API  ──▶  Postgres (Supabase)
                                      │
                                      ├─▶ scoring module   (deterministic, no AI)
                                      ├─▶ lesson generator ──▶ language model (OpenRouter or a local server)
                                      └─▶ speech adapters   (planned)
```

### Scoring

`backend/src/services/tutorScoringService.js` with the rubric in `backend/src/data/tutorRubric.json`
(`tutor-1.0-provisional`). Each completed activity gets a band from 1 to 5 on the criteria that apply
to it, and the weighted average becomes stars.

| Criterion | Weight | Measured from |
|---|---|---|
| Clarity | 0.3 | Mean speech-recogniser confidence on the target words |
| Accuracy | 0.3 | Share of target words said, or a correct picture choice |
| Completeness | 0.2 | Whether the expected phrase was completed (Answer the Question only) |
| Participation | 0.2 | Time to first attempt, repeat attempts, hint use |

Four or more gives three stars, 2.5 or more gives two, otherwise one. Criteria that do not apply (for
example Clarity for a picture choice, or any criterion that cannot be measured) are omitted and the
remaining weights are renormalised. An abandoned activity gets no stars. The thresholds, including the
lower Band A clarity thresholds, are provisional teaching defaults that a teacher must review before
the pilot. Speech-recogniser confidence is a rough intelligibility signal, not a pronunciation test.

### Lesson generation

`backend/src/services/tutorLessonService.js`. The child picks a topic from a fixed menu (animals,
colors, food, nature, space); children never type a topic. The language model is asked for a short
story setup and five items. **Nothing it writes reaches a child until code has checked it:**

- Every word must be on an allowlist: a basic word list, the topic's vocabulary, practice words from
  the learner model, and the story character's name (`backend/src/data/tutorWords.json`,
  `tutorTopics.json`). This also keeps unsafe vocabulary out.
- Questions that ask for personal information are rejected, as are franchise character names.
- Sentence length limits depend on the age band.
- Pictures come from a curated set. Picture-choice options are built by code, and for open questions
  ("What animal do you like?") the model only names a category and an answer template; code expands the
  accepted answers.
- Any item that fails is replaced from that topic's vetted fallback lesson, so a broken or missing
  model reply never breaks a lesson. Each item is recorded as `ai` or `fallback`, with rejection
  reasons.

The check cannot detect a *wrong but well-formed* answer key (for example "Is the sky green? Yes").
The stored lesson snapshot and the planned teacher sample review are the safeguards for that.

Measured once, over 20 lessons with a local `gemma-4` model: 91% of items passed validation, no call
failed, and a lesson took about 14 seconds (mostly hidden reasoning), so lessons are generated when a
session starts, not during a turn. This is one small run, not a general result. Reproduce it with
`node scripts/tryLessons.js`.

### Sessions and privacy

`backend/src/services/tutorSessionService.js`.

- A parent account owns up to 5 child profiles. A profile is a nickname and an age band: no real name,
  no password.
- Starting a session stores a full lesson snapshot including the answer key and the rubric version, so
  any score can be reproduced. **The browser never receives the answer key.**
- Attempts must be answered in order and are scored on the server. Only the transcript is stored,
  never audio. Inputs from the browser are bounded before scoring; note that timings and attempt
  counts are reported by the browser, which is acceptable for a supervised pilot but not tamper-proof.
- Deleting a child profile deletes all of that child's sessions.
- The language model receives a topic, a level and practice words only, never anything that identifies
  a child.

### API

All routes need a signed-in user.

| Method and path | Purpose |
|---|---|
| `GET /api/tutor/topics` | Topic menu |
| `GET /api/tutor/children`, `POST /api/tutor/children` | List or create child profiles |
| `DELETE /api/tutor/children/:id` | Delete a profile and its sessions |
| `POST /api/tutor/sessions` | Start a lesson (`childId`, `topicId`); rate limited to 10 per minute |
| `GET /api/tutor/sessions/:id` | Current state and the current activity |
| `POST /api/tutor/sessions/:id/attempts` | Submit an attempt (`itemId` and a `response` with `mode` of `speech`, `picture` or `abandoned`) |
| `POST /api/tutor/sessions/:id/finish` | End a session early |

## Running locally

Requires Node.js 22.5 or newer.

```bash
cd backend
npm install
npm test
```

`npm test` uses Node's test runner on in-memory tables, so it needs no database or API keys.

To run the API without a database, use the in-memory preview (not for production, data is lost on
restart):

```bash
cd backend
cp .env.example .env
STORE_BACKEND=memory npm run dev
```

On Windows PowerShell, set the variable first: `$env:STORE_BACKEND="memory"; npm run dev`.

Without a language model configured, lessons come from the vetted fallback set. To let a model write
lessons, run a local server such as LM Studio and set in `backend/.env`:

```
TUTOR_LLM_PROVIDER=local
LOCAL_LLM_URL=http://localhost:1234/v1
LOCAL_LLM_MODEL=gemma-4
```

Then check how much of the model's output survives validation:

```bash
node scripts/tryLessons.js 2
```

For a persistent setup, create a Supabase project, copy `backend/.env.example` to `backend/.env`, set
`DATABASE_URL` and the Supabase keys, and apply the files in `supabase/migrations/` in order. The
tutor's tables are in `20261110000100_tutor_sessions.sql`. Sign-in setup (Supabase Auth, Google login,
roles) is described in [docs/DUC_SETUP.md](docs/DUC_SETUP.md). Docker Compose (`docker-compose.yml`) still
starts the backend and the frontend; it needs the same Supabase settings.

### Configuration for the tutor

| Variable | Purpose |
|---|---|
| `TUTOR_LLM_PROVIDER` | `local` or `openrouter`. Unset means no model, so only vetted fallback lessons. The InterviewAI LLM settings never enable the tutor by themselves |
| `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY` | Local OpenAI-compatible server (LM Studio, Ollama, llama.cpp). Nothing leaves the machine |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter. Pin one exact model id. Requests ask not to route to providers that train on prompts; verify the chosen model's data policy before real children use it |
| `OPENROUTER_ZDR` | `true` asks for zero-data-retention endpoints only |
| `TUTOR_LLM_TIMEOUT_MS` | Default 20000 (OpenRouter) or 90000 (local) |

Every model call is logged (provider, model, prompt version, tokens, duration, status; no prompts or
replies) in the existing `ai_logs` table.

## Repository layout

```
backend/src/
  services/tutorScoringService.js    rubric scoring
  services/tutorLessonService.js     lesson generation and validation
  services/tutorLlm.js               local / OpenRouter client
  services/tutorSessionService.js    child profiles and sessions
  routes/tutor.js                    /api/tutor routes
  data/tutor*.json                   rubric, word lists, topics, pictures
  prompts/tutor-lesson.md            versioned lesson prompt
backend/scripts/tryLessons.js        live check of lesson generation
backend/test/tutor-*.test.js         tutor tests
supabase/migrations/                 database schema
frontend/                            React + Vite app (still the InterviewAI interface)
docs/                                setup notes and decision records
```

## Legacy InterviewAI code

These parts of the repository belong to the app this project was converted from and are not part of the
tutor. They still run and have tests, and will be removed or replaced as the tutor takes over:

- Interview scenarios, scoring and feedback (`scoringService.js`, `sessionService.js`, `aiSimulator.js`,
  `data/scenarios.json`, `data/rubric.json`) and the Dashboard, Interview and Feedback pages.
- The CV and job-description pipeline: document upload, embeddings, retrieval, and the Coach and
  post-interview chat (`documentService`, `ragService`, `chatService`, `coachService`, the Documents and
  Coach pages, the pgvector migrations).
- The Gemini and Groq integrations built for those features.

What the tutor reuses: Supabase sign-in and roles, request logging, rate limiting and security headers,
the key/value store layer, the test setup, and Docker. Configuration for the legacy features is
documented in `backend/.env.example` and `docs/DUC_SETUP.md`.

## Known limitations

- No child-facing interface and no speech integration yet, so the tutor cannot be tried end to end by a
  child.
- The rubric thresholds, word lists and topic vocabulary are drafts that need review by a teacher.
- Whether a particular speech or language service is acceptable for children's data, and how well it
  recognises children's voices, has not been verified. This must be checked before any pilot with
  children, with a parent present and written permission.
- Provider prices and costs are estimates kept outside this repository and change often; none are
  guaranteed.

## Team

Nguyen Anh Khoa and Nguyen Hang Hai Long, group 03, HCMUTE. AI assistance used in this project is
logged in [AI_USAGE.md](AI_USAGE.md).

**Credits for the base code.** The tutor was built on InterviewAI, an earlier project by the same team
together with Tran Huu Duc. Duc wrote the Supabase sign-in and roles, admin pages, practice plans and AI
request logging that the tutor still reuses. The commit history of that earlier work is squashed into
this repository's first commit.
