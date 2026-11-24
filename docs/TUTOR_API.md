# AI Speaking Tutor: API and setup guide

For whoever builds the child, parent and teacher screens and sets up Supabase. Everything here is implemented
and tested in `backend/` (see `backend/test/tutor-*.test.js`). Base path: `/api/tutor`.

## 1. Supabase setup

Run the files in `supabase/migrations/` **in filename order**. The tutor adds four, after the InterviewAI ones:

| File | Adds |
|---|---|
| `20261110000100_tutor_sessions.sql` | `tutor_children`, `tutor_sessions` |
| `20261113000100_tutor_progress.sql` | `tutor_progress` |
| `20261113000200_tutor_reports.sql` | `tutor_reports` |
| `20261124000100_tutor_privacy_review.sql` | `tutor_parents`, `tutor_judgments`, and the `teacher` role |

All tutor tables are key/value tables (`id`, `value jsonb`) reached only by the backend with the service key.
Row level security is on with no policies, so the browser can never read them directly. Do not give the frontend
a service key.

**Teachers.** A teacher is a normal Supabase Auth account whose profile role is `teacher`. An administrator sets it:

```sql
UPDATE public.profiles SET role = 'teacher' WHERE id = '<the teacher''s auth user id>';
```

**Environment** (`backend/.env`, see `.env.example`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `SUPABASE_*` | As for the rest of the backend |
| `TUTOR_PIN_SECRET` | Signs parent PIN tokens. Set a long random value in every deployment |
| `TUTOR_LLM_PROVIDER` | `local` or `openrouter`. Unset means lessons come only from the vetted fallback set |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | When the provider is `openrouter` |
| `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL` | When the provider is `local` |

## 2. Conventions

- Every route needs `Authorization: Bearer <token>` (Supabase access token; in the memory preview, the token from `/api/auth/register`).
- JSON in, JSON out. Errors look like `{ "error": "message", "code": "SOME_CODE" }` (`code` is optional).
- Routes marked **PIN** also need the header `X-Parent-Pin-Token: <token from /pin/verify>`.
- Routes marked **consent** need the parent's consent on record at the current version.
- Rate limits: starting a session 10 per minute, creating a report 5 per minute, PIN calls 20 per minute (per IP).

Common error codes: `CONSENT_REQUIRED`, `PIN_NOT_SET`, `PIN_REQUIRED`, `PIN_INCORRECT`, `PIN_LOCKED` (with a
`Retry-After` header), `DAILY_LIMIT_REACHED`, `CONSENT_VERSION_MISMATCH`.

## 3. The parent's first run

```
register / sign in  ->  GET /consent  ->  POST /consent  ->  POST /pin  ->  POST /pin/verify  ->  POST /children
```

| Method and path | Body | Notes |
|---|---|---|
| `GET /consent` | | `{ consent: { version, status, points: [{ id, en, vi }] } }`. Show the points to the parent. The text is a draft that must be reviewed before the pilot |
| `POST /consent` | `{ version }` | Must equal the current version. Records version and time |
| `GET /privacy` | | `{ privacy: { consent: { currentVersion, acceptedVersion, acceptedAt, upToDate }, permissions: { teacherReview, audioRetention, teacherAudioReview, updatedAt }, pinSet, dailyLimitMinutes, rawAudioStored } }`. Use `consent.upToDate` and `pinSet` to decide which screen to show |
| `POST /pin` | `{ pin, currentPin? }` | PIN is 4 to 6 digits. `currentPin` is required to change an existing PIN |
| `POST /pin/verify` | `{ pin }` | `{ token, expiresAt }`. The token lasts 10 minutes. Five wrong PINs lock it for five minutes |
| `PUT /privacy/permissions` **PIN** | any of `{ teacherReview, audioRetention, teacherAudioReview }` as booleans | All start `false`. `teacherAudioReview` needs `audioRetention`. Raw audio is **not stored by this release**; the audio flags only record the choice |
| `PUT /privacy/limit` **PIN** | `{ minutes }` (5 to 120, or `null`) | Daily practice limit. When used up, starting a lesson returns `DAILY_LIMIT_REACHED` |

## 4. Child profiles

A child has no password. A profile is `{ id, parentId, nickname, age, avatar, ageBand, createdAt }`, where
`ageBand` is derived (`A` for ages 6-7, `B` for 8-10). Avatars: `fox, panda, lion, bunny, owl, frog, bear, cat`.

| Method and path | Body | Notes |
|---|---|---|
| `GET /children` | | `{ children: [...] }`. No PIN: this is the profile picker the child sees |
| `POST /children` **consent** **PIN** | `{ nickname, age, avatar? }` | Nickname is 1 to 20 letters (not a real name). Up to 5 profiles |
| `PATCH /children/:id` **PIN** | any of `{ nickname, age, avatar }` | |
| `DELETE /children/:id` **PIN** | | Deletes the profile, sessions, progress, report and teacher judgments |
| `GET /children/:id/export` **PIN** | | The parent's copy of everything stored about the child (no answer key) |
| `DELETE /data` **PIN** | | Deletes everything the tutor stores for this parent, including the PIN and settings |

## 5. A lesson

The child plays; no PIN is needed, but consent must be on record.

```
GET /topics  ->  POST /sessions  ->  (POST /sessions/:id/attempts, repeated)  ->  done
```

- `GET /topics` -> `{ topics: [{ id, label }] }`. The child picks one. Topics are a fixed menu.
- `POST /sessions` **consent** with `{ childId, topicId }` -> `{ session }`. Generating the lesson takes a few
  seconds with a model (about 14 s on a small local model), so show a loading screen. If no model is configured, or the
  model's output fails the checks, vetted fallback content is used, so this always returns a full lesson.
- `GET /sessions/:id` -> the current state. `POST /sessions/:id/finish` ends a lesson early (no stars for the rest).

`session`:

```json
{
  "id": "tsess_…", "childId": "child_…", "topicId": "animals", "topicLabel": "Animals",
  "status": "active",                       // "active" | "completed" | "abandoned"
  "story": { "character": "Momo", "intro": "Momo is a little dragon. Momo likes animals." },
  "currentIndex": 0, "totalItems": 5,
  "current": { /* the activity to show now, see below; null when not active */ },
  "summary": { "starsEarned": 0, "starsPossible": 15, "activitiesDone": 0, "activitiesTotal": 5, "perActivity": [] }
}
```

`current` (the browser never receives the answer key):

```json
{
  "id": "i1",
  "activityType": "listen_repeat",           // "listen_repeat" | "name_picture" | "answer_question"
  "prompt": "Say: I see a cat.",             // what the tutor says / shows as subtitle
  "say": "I see a cat",                      // listen_repeat only: the sentence to repeat
  "picture": { "emoji": "🐱" },              // name_picture only (placeholder for real artwork)
  "choices": [{ "id": "cat", "label": "cat", "emoji": "🐱" }, …],   // picture-choice fallback, or null
  "hint": "It starts with \"c\"."            // or null
}
```

### Submitting an attempt

`POST /sessions/:id/attempts` with `{ itemId, response }`. Activities must be answered in order, one scored attempt
each. `response` is one of:

```json
{ "mode": "speech", "transcript": "I see a cat", "confidence": 0.91,
  "wordConfidences": [{ "word": "cat", "confidence": 0.88 }],
  "firstAttemptMs": 2300, "attemptCount": 1, "hintUsed": false }

{ "mode": "picture", "choiceId": "cat", "firstAttemptMs": 4100, "attemptCount": 1, "hintUsed": false }

{ "mode": "abandoned" }
```

- Use `picture` when speech input fails or the microphone is unavailable. `choiceId` must be one of `current.choices`.
  If `current.choices` is `null` there is no picture fallback for that activity.
- `confidence` and `wordConfidences` are optional (send what the speech service returns). `firstAttemptMs` is the
  time from the end of the tutor's prompt to the child's first attempt. Values are bounded on the server.
- Capture the microphone **only during the child's turn** (SRS FR-07), send **no audio** to this API, and play the tutor's
  speech with subtitles.

Response:

```json
{
  "result": { "stars": 3, "completed": true, "criteria": [{ "id": "clarity", "band": 5 }, …] },
  "feedback": "Great job!",                  // short encouragement written by code
  "reveal": "I see a cat",                   // the correct answer to show or say; may be null
  "done": false,
  "rewards": null,                           // when done: { newStickers: [{ id, label }], streak, level }
  "session": { /* updated session; session.current is the next activity */ }
}
```

The child-facing screens must not show numeric scores or failure screens (SRS FR-14): use `stars` (1 to 3), `feedback`
and `reveal`. `criteria` is for parent and teacher views.

## 6. Parent views (PIN)

- `GET /children/:id/progress` -> `{ child, progress }` where `progress` has `level`, `sessionsCompleted`, `starsTotal`,
  `streak { current, longest }`, `stickers [{ id, label, at }]`, `words [{ word, status, box, seen, correct, lastSeenAt }]`
  (`status`: `mastered`, `learning`, `needs practice`), `counts`, `wordsToPractice`, `favouriteTopic`, `recentSessions`.
- `POST /children/:id/report` -> `{ report }` (generates and stores a new report; it calls the model once).
  `GET /children/:id/report` returns the last one, or 404 if none yet. A report has `enoughData`, `facts`,
  `narrative { source: "ai" | "template", summary, strengths[], focus[], suggestions[] }` and a `disclaimer`
  that must be shown with it. With too little practice the narrative says so; show it as it is.

## 7. Teacher review

Roles `teacher` and `admin` only. A teacher sees **only** attempts from children whose parent currently has
`teacherReview` on, in de-identified form (no name, age, avatar or account, and no dates). Turning the permission off
removes access immediately. There is no audio in this release.

| Method and path | Body or query | Notes |
|---|---|---|
| `GET /review/queue` | `status=unjudged` (default) or `all`, `limit` (max 50), `after` (a `reviewId`) | `{ items, next }`; pass `next` as `after` for the next page |
| `GET /review/:reviewId` | | One item |
| `POST /review/:reviewId/judgment` | `{ verdict, note?, contentIssue? }` | `verdict`: `agree`, `too_high`, `too_low` (about the system's stars). `note` up to 500 characters. `contentIssue` flags unclear or unsuitable lesson content |
| `GET /review/summary` | | `{ reviewable, judged, agree, tooHigh, tooLow, contentIssues, agreementRate }`. `agreementRate` is the pilot's "teacher agreement with stars" measure |

An item: `{ reviewId, activityType, topic, ageBand, prompt, target, responseMode, transcript, chosenPicture,
system { stars, bands[], rubricVersion, confidence }, source ("ai" or "fallback"), judged, myJudgment }`.

## 8. What is not built yet

- **Speech.** The browser must do speech-to-text itself for now (for example the Web Speech API) and send the
  `transcript`, or use the existing `/api/speech` transcription route inherited from InterviewAI, which was built for
  adult speech and must be tested with children's voices. Tutor speech (text-to-speech) is also the browser's job for
  now. A server-side speech service for the tutor is planned.
- **Audio retention.** The audio permissions exist, but no audio is stored.
- **Real artwork.** Pictures are emoji placeholders.
- **Consent wording.** The text in `backend/src/data/tutorConsent.json` is a draft for review, not legal advice.
