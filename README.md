# AI Speaking Tutor

A web app that lets children aged 6 to 10 practise basic spoken English in short, guided lessons.
A parent manages the account and the child profiles. The tutor speaks a short prompt, the child
answers by voice (or by tapping a picture if the microphone is not available), and **code, not an AI
model, scores the answer from one to three stars** using a versioned rubric.

This is a course project (HCMUTE, group 03, supervised by PhD. Mai Anh Tho) built for a partner
company that wants a cloud-based, scalable tutor. The repository started as **InterviewAI**, an adult
interview-practice app; its interview-specific code has been removed from the backend and the sign-in,
roles, logging and deployment setup were kept (see [History](#history)).

> **Status: work in progress.** The tutor's backend (scoring, AI-generated lessons, learner model, reports,
> consent, PIN, teacher review, speech) works and is tested. The child, parent and teacher **screens** are being
> built by teammates; the React app in `frontend/` is still the old interface until then. See
> [What works today](#what-works-today).

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
| Child profiles (age, avatar) and lesson sessions API (`/api/tutor`) | Done, tested |
| Storage (Postgres migrations; memory mode for tests) | Done |
| Learner model: word mastery, adaptive difficulty, stickers, streaks | Done, tested |
| Comprehensive learner report (code-computed facts, checked model narrative) | Done, tested |
| Parent consent, parent PIN, optional permissions (all off by default), daily limit, data export and deletion | Done, tested (backend) |
| Teacher role and review of de-identified attempts with judgments and an agreement rate | Done, tested (backend) |
| Contact-detail scrubbing of transcripts before storage and teacher display | Done, tested |
| Server-side speech: spoken answers to text and the tutor's voice (xAI or Groq adapters, cached voice lines, no audio stored) | Done and tested with mocked providers; **not tried against a real service**, and no provider has been verified for children's voices or data policy |
| Child-speech accuracy and latency check (`backend/scripts/evalStt.js`) | Script ready; needs permitted sample recordings and an API key |
| Raw audio retention | Not built. The permissions exist but no audio is stored |
| Child, parent and teacher web screens | In progress by teammates; see [docs/TUTOR_API.md](docs/TUTOR_API.md) |
| Removal of InterviewAI-only code | Backend done. The `frontend/` folder still has the old pages until the new screens replace them (see [History](#history)) |

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

- A parent account owns up to 5 child profiles. A profile is a nickname, an age (6 to 10, from which the
  age band is derived) and an avatar: no real name, no password.
- The parent records consent (version and time) before a profile or lesson can be created. Teacher review,
  audio retention and teacher audio review are separate choices that start **off**. A parent PIN (salted hash,
  five wrong tries lock it for five minutes) protects profile changes, progress, reports and privacy
  settings, and an optional daily practice limit stops new lessons once used up.
- Contact details (emails, links, phone numbers) are removed from transcripts before they are stored or shown.
- A teacher sees only de-identified attempts from parents who currently allow it, and loses access the moment a
  parent turns it off. The parent can export a child's data and delete it at any time.
- Starting a session stores a full lesson snapshot including the answer key and the rubric version, so
  any score can be reproduced. **The browser never receives the answer key.**
- Attempts must be answered in order and are scored on the server. Only the transcript is stored,
  never audio. Inputs from the browser are bounded before scoring; note that timings and attempt
  counts are reported by the browser, which is acceptable for a supervised pilot but not tamper-proof.
- Deleting a child profile deletes all of that child's sessions, progress, report and teacher judgments.
- The language model receives a topic, a level and practice words only, never anything that identifies
  a child.

### API

The full reference (endpoints, request and response shapes, the PIN flow, error codes and Supabase setup) is in
[docs/TUTOR_API.md](docs/TUTOR_API.md). In short:

- **Parent:** record consent, set a PIN, create child profiles, change permissions, see progress and reports, export
  or delete data. Profile changes, progress and privacy need the PIN.
- **Child:** pick a topic, start a lesson, answer activities one at a time (speech or picture choice).
- **Teacher:** review de-identified attempts from parents who allow it, and record whether they agree with the stars.

## Running locally

Requires Node.js 22.5 or newer. Full instructions (Supabase, sign-in, deployment) are in [docs/SETUP.md](docs/SETUP.md).

```bash
cd backend
npm ci
npm test                          # in-memory tables and stubbed providers: no database or API keys
cp .env.example .env
STORE_BACKEND=memory npm run dev  # temporary preview; seeds parent@tutor.test and teacher@tutor.test (password123)
```

On Windows PowerShell, set the variable first: `$env:STORE_BACKEND="memory"; npm run dev`.

Without a language model configured, lessons come from the vetted fallback set. To let a model write lessons, run a local
server such as LM Studio and set `TUTOR_LLM_PROVIDER=local`, `LOCAL_LLM_URL` and `LOCAL_LLM_MODEL` in `backend/.env`, then
check how much of the model's output survives validation with `npm run try:lessons`.

### Configuration for the tutor

| Variable | Purpose |
|---|---|
| `TUTOR_LLM_PROVIDER` | `local` or `openrouter`. Unset means no model, so only vetted fallback lessons |
| `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY` | Local OpenAI-compatible server (LM Studio, Ollama, llama.cpp). Nothing leaves the machine |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter. Pin one exact model id. Requests ask not to route to providers that train on prompts; verify the chosen model's data policy before real children use it |
| `OPENROUTER_ZDR` | `true` asks for zero-data-retention endpoints only |
| `TUTOR_LLM_TIMEOUT_MS` | Default 20000 (OpenRouter) or 90000 (local) |
| `TUTOR_PIN_SECRET` | Signs the short-lived parent PIN tokens. Set a long random value in every deployment |
| `TUTOR_STT_PROVIDER`, `TUTOR_TTS_PROVIDER`, `XAI_API_KEY`, `GROQ_API_KEY`, `TUTOR_TTS_VOICE` | Optional server-side speech (see [docs/TUTOR_API.md](docs/TUTOR_API.md)). Off unless a provider is chosen. The xAI speech-to-text returns no confidence, so Clarity is then left out of the score |

Every model call is logged (provider, model, prompt version, tokens, duration, status; no prompts or
replies) in the existing `ai_logs` table.

## Repository layout

```
backend/src/
  routes/tutor.js                    /api/tutor routes (see docs/TUTOR_API.md)
  routes/auth.js, users.js           sign-in, account export and deletion
  routes/admin.js, adminUsers.js     administrator tools (AI usage and logs, users)
  services/tutorScoringService.js    rubric scoring
  services/tutorLessonService.js     lesson generation and validation
  services/tutorLlm.js               local / OpenRouter client
  services/tutorSessionService.js    child profiles and sessions
  services/tutorProgressService.js   word mastery, levels, streaks, stickers
  services/tutorReportService.js     learner report
  services/tutorPrivacyService.js    consent, PIN, permissions, daily limit
  services/tutorReviewService.js     teacher review and judgments
  services/tutorSpeechService.js     speech to text and tutor voice
  services/aiTelemetry.js ...        AI request logging and health
  data/tutor*.json                   rubric, rules, word lists, topics, pictures, consent text
  prompts/                           versioned lesson and report prompts
backend/scripts/                     tryLessons, tryReport, evalStt, seedSupabaseUser, bootstrapAdmins
backend/test/                        tests (tutor-*.test.js and platform tests)
supabase/migrations/                 database schema
frontend/                            React + Vite app (being rebuilt for the tutor by teammates)
docs/                                setup, API guide and decision records
```

## History

The repository started as InterviewAI, an adult interview-practice app. Its interview, CV-search, chat and coach code has been
removed from the backend; the sign-in, roles, administrator tools, AI request logging, store layer and Docker setup were kept.
The old migrations stay in `supabase/migrations/` as history ([docs/SETUP.md](docs/SETUP.md) says which ones a new project needs). The
`frontend/` folder still contains the old interface until the new screens replace it, so its pages for interviews, documents,
the coach and plans no longer have a backend. The team's AI-usage log (`AI_USAGE.md`) records the earlier work.

## Known limitations

- The screens are being built by teammates and the speech services have only been tested against mocks, so the tutor
  has not yet been tried end to end by a child.
- The consent text (`backend/src/data/tutorConsent.json`) is a draft that must be reviewed by the supervisor, the partner
  company and, where required, legal advice. It does not replace the written permission the pilot needs.
- Pictures are emoji placeholders, and no audio is stored even if a parent turns the audio permissions on.
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
