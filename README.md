# knomad

A local-first job search workspace. Add a job posting, and knomad reads the page, tailors your resume to it, drafts interview prep, and files the whole thing in your application tracker.

It works entirely offline on `localStorage`, and optionally syncs your profile, applications, and original resume files to Neon when you sign in. The Gemini API key always stays on the device.

## Neon backend

`neon.ts` declares one branch policy:

| Service | Use |
|---|---|
| **Postgres** | `public.knomad_docs` — one row per profile/application document, scoped by `user_id` |
| **Auth** | Managed Better Auth email/password sign-up and sign-in; the browser sends the session JWT to the Function |
| **Functions** | `knomadsync` — Hono API that verifies the JWT, reads/writes documents, uploads files, proxies AI, and seals realtime queries |
| **Object Storage** | Private `resumes` bucket for original uploaded resume files, reachable only through presigned URLs |
| **AI Gateway** | OpenAI-compatible `/v1/chat/completions`, used when you're signed in and have no local Gemini key |
| **Realtime** | Live SQL subscription on the signed-in user's rows; the browser pulls or applies changes immediately |

Sync rules:

- Each save is diffed locally and sent to the Function after a short debounce.
- The server keeps the row with the newest `client_updated_at` (last write wins).
- Deletions are soft (`deleted_at`) so they propagate instead of resurrecting.
- Realtime is best-effort; a 30-second poll covers reconnects, and the app also pulls when the tab becomes visible or the network returns.
- `knomad_gemini_key` is never included in a synced document.

## What it does

- **Dashboard** — metric cards for applications, interviews in the last 7 days, active pipeline, and response rate, plus a 14-day activity chart, a status breakdown, your next scheduled events, recent activity, and a preview of your base resume.
- **Job search** — type a role, and knomad queries three public remote-job APIs, keeps matching titles, and marks which postings are open to Nigeria (or another country you pick). It is rule-based, with no AI and no API key.
- **One-click job intake** — the big **+** opens a flow that reads the job page, extracts the company and role, rewrites your resume, writes interview prep, and saves the application.
- **Profile** — name, photo, headline, contact details, links, summary, skills, and your base resume. The photo is cropped to a square, stored with the profile, and shown on the dashboard and top bar. Upload a resume file or paste the text, and knomad fills the profile fields from it (see [Resume autofill](#resume-autofill)).
- **Tracker** — search and filter applications, then open any one as a full application page with overview, resume, and interview-practice tabs.
- **Application page** — status, notes, the job description used, scheduled interviews and reminders, a tailored resume preview, and interview practice in one place.
- **Tailored resume document** — every generated resume is rendered as a styled document, with copy, print, and PDF download actions.
- **Interview practice** — a step-by-step sequence: read a likely question, write your answer, move to the next one, then get an overall score and per-question feedback.
- **Calendar** — month view of every interview and reminder, with a day list and the next 30 days at a glance.
- **Settings** — optional cloud sign-in and sync, a Google Gemini API key, browser notifications, a JSON backup export, or erase local and cloud data.

## Job search

Open **Find jobs** in the sidebar, type a role, and pick the country you can work from (Nigeria by default). Results show the job title, provider, stated location, and a direct link. **Track** opens the normal Add job flow with the URL, company, title, and description already filled in.

The search is entirely deterministic. No model scores the roles, and no API key is needed.

**Sources.** Knomad asks three public, key-less APIs that allow browser requests:

| Provider | Endpoint | Notes |
|---|---|---|
| Jobicy | `jobicy.com/api/jobs` | Tagged search, plus Jobicy's worldwide-only feed; the last 7 days |
| Remote OK | `remoteok.com/api` | Full public feed; needs the follow link and attribution shown in the page footer |
| Remotive | `remotive.com/api/remote-jobs` | Latest public batch; role matching happens locally |

**Eligibility.** The location string each provider publishes decides the verdict:

- **Open** — mentions Nigeria (or the selected country), Worldwide, Anywhere, Global, or Africa. "South Africa" is treated as a country, not the region.
- **Maybe** — EMEA. Nigeria is geographically in Africa, but companies often use EMEA to mean Europe and the Middle East, so these are hidden by default.
- **Not verified** — blank, bare "Remote", or "Region not stated". Hidden by default because the posting does not actually promise your country.
- **Restricted** — any other stated region (USA, Europe, LATAM, APAC, a city, a time-zone requirement).

When a board leaves its location field blank, knomad looks in the description for an explicit `Remote:`, `Location:`, or "open to candidates in…" phrase before giving up. Results are filtered in the browser, so unchecking **Only roles open to…** is instant. If every matched role is unverified or restricted, the empty state offers a one-click **Show all matched roles** action.

**Role matching.** The query is lowercased and split into tokens. Arrangement words ("remote", "full-time") and seniority words ("senior", "lead") are dropped, and small synonym groups map developer↔engineer, frontend↔front end, support↔customer service, and similar pairs. A role is kept when the share of matched tokens is at least 60% for a one- or two-token query, or 50% for a longer one. Provider-side search is loose, so this local pass is what removes unrelated listings.

Provider failures are isolated: if one API is down, the other two still return results, and the provider chip shows **unavailable**. Responses are cached in memory for ten minutes.

Run the search tests with:

```bash
npm run test:search
```

**Limitations.** The public feeds skew heavily toward US-only roles, and most Remote OK postings leave their location blank. A strict search can therefore return only a handful of verified roles. Eligibility is read from the posting's own metadata — always confirm the location on the job page before applying.

## One job, one flow

1. Click the **+** on the dashboard (or **Add job** in the top bar).
2. Paste the posting URL.
3. Answer the short **Quick check** step: knomad points at requirements the posting stresses that your base resume doesn't obviously cover. Add a note only if it's true, choose **Use my answers**, or choose **Skip &amp; generate**. Esc closes the whole flow without saving.
4. knomad fetches the page, pulls out the company, role, and description, then produces:
   - a resume rewritten for that posting,
   - interview questions with talking points, questions to ask, and topics to review,
   - a tracker entry marked **Applied**.
5. If the draft mentions dates, years, metrics, or company names that aren't in your profile or base resume, a **Before filing** screen lists each one. Choose **Edit answers and regenerate** to send new notes through the draft again, **Save this resume** if the detail is real, or **Discard &amp; start over**.
6. The saved application opens as a full page so you can change status, add notes, schedule an interview, preview or download the resume, and practice the interview questions.

If the page blocks automated readers, open the *Paste the description* field and drop the text in. knomad uses it directly.

## Dashboard metrics

The dashboard reads from your local applications and updates every time you add a job or change a status.

| Card | What it counts |
|---|---|
| Applications | Every application, with how many were added in the rolling last 7 days |
| Interviews · 7d | Applications whose status moved to **Interviewing** in the last 7 days |
| Active pipeline | Applications currently **Applied** or **Interviewing** |
| Response rate | Share of applications that moved past **Applied** |

Two charts sit below the cards:

- **Activity** — applications added per day over the last 14 days. Hover a bar for the date and count.
- **Status breakdown** — current status distribution with counts and percentages, plus a response-rate footer.

To make interview counts accurate, every status change is timestamped. Each application stores a `statusHistory` array; changing status in the detail view appends an entry instead of overwriting the old one. Applications saved before this feature existed get a single history entry from their current status and applied date.

The metrics are straightforward counts, not projections. With no applications the cards show zero and the charts show an empty state.

## Calendar and reminders

Every application can hold any number of scheduled events. Open an application from the dashboard or tracker, then use **Interviews & reminders** to add one:

- **Type** — an interview or a plain reminder.
- **Date & time** — stored in your local timezone.
- **Remind me** — at the time, 15 minutes, 1 hour, 1 day, or 1 week before.
- **Title or note** — optional; falls back to "Interview" or "Reminder".

The **Calendar** page shows a Sunday-start month grid with a dot for each scheduled day. Select a day to see its events, step through months with the arrows, or jump back with **Today**. The sidebar lists the next 30 days, and the dashboard's **Next up** card shows the soonest events. Clicking an event on the dashboard opens its application.

Reminders are checked while knomad is open:

- An in-app toast fires when a reminder is due.
- If you allow browser notifications in **Settings → Reminders**, you also get a system notification.
- Reminders that came due while the page was closed fire on the next load, unless the event started more than 60 minutes ago.
- Fired reminders are recorded under `knomad_notified` so the same reminder doesn't fire twice.

Browser notifications need a secure context (`https://` or `localhost`). On `file://` or when permission is blocked, knomad keeps working with in-app toasts.

## AI mode vs. basic mode

| | With a Gemini key | Signed in, no key | Neither |
|---|---|---|---|
| Model route | Browser → Google Gemini | Browser → Neon Function → AI Gateway | none |
| Resume | Rewritten and reordered for the posting, starting from your profile header | Same, using the gateway's model catalog | Your base resume with the profile header plus a keyword-gap report |
| Interview prep | Tailored questions and talking points | Same | General questions built from the role and posting keywords |
| Company/role detection | Done by the model when the page is unclear | Done by the model | Pulled from schema.org `JobPosting`, page metadata, title, and domain |

Add a Gemini key in **Settings**, or use the link there to grab one from Google AI Studio. knomad tries `gemini-2.5-flash`, then `gemini-2.0-flash`, then `gemini-1.5-flash`, and remembers whichever responds. If no Google key is present but you're signed in, it asks the Function to call the Neon AI Gateway. If every route fails, it saves the basic version rather than losing the application.

AI Gateway access is credit-gated on Neon. If the account has no gateway credits, `/ai/chat` returns a clear message and knomad falls back to basic mode.

The prompt includes every profile variable (name, headline, email, phone, location, links, summary, skills) plus the full base resume, and forbids inventing employers, dates, degrees, or metrics. It also instructs the model to copy the profile header verbatim onto the top of the resume. If the model omits both name and email anyway, knomad prepends the profile header itself.

## Getting started

Install dependencies and build the app:

```bash
npm install
npm run build
npm run dev
```

`npm run dev` serves the app at `http://localhost:8000`. The app must be served over HTTP(S), not opened as a `file://` URL, because the auth client needs an origin and `localStorage` behaves differently per scheme.

### Neon setup

```bash
neon login                     # once per machine
neon deploy --env .env.local   # provisions auth, functions, storage, gateway, realtime
npm run db:setup               # applies sql/schema.sql
npm run test                   # exercises every service end to end
```

`neon deploy` writes the branch's secrets to `.env.local`. Add the three public browser URLs to the same file:

```bash
VITE_NEON_AUTH_URL=https://<branch>-neonauth.<region>.aws.neon.tech/neondb/auth
VITE_NEON_SYNC_URL=https://<branch-id>-knomadsync<function-host-suffix>
VITE_NEON_REALTIME_URL=wss://<realtime-host>
```

`neon deploy` prints the Function invocation URL; `neon functions get knomadsync` prints it again. `NEON_REALTIME_URL` is pulled by `neon deploy`. Rebuild after changing any `VITE_*` value.

Add the app origins (`http://localhost:8000` and your production URL) as trusted domains in the Neon Auth settings, and allow them in the branch's Realtime allowed origins.

### Tests

`npm test` signs up a throwaway user, mints a JWT, and checks:

1. Function health and injected service env.
2. Neon Auth sign-up and `/token`.
3. JWT verification in the Function.
4. Postgres write, stale-write rejection, and read-back.
5. Object Storage upload and presigned download.
6. Realtime: sealed query + live change delivery.
7. AI Gateway chat completion (reported as `blocked` when the account has no gateway credits).

Playwright remains available for browser tests.

## Project structure

```
knomad/
├── index.html            # Layout, modals, and all styles (dark single-page app)
├── main.js               # State, storage, sync engine, page reading, resume parsing, AI, rendering
├── job-search.js         # Public job APIs, eligibility rules, token matching, no AI
├── sync.js               # Browser Neon Auth + Function + Realtime clients
├── neon.ts               # Neon branch policy (auth, functions, bucket, gateway, realtime)
├── src/function/index.ts # knomadsync Hono API, JWT verification, Postgres/S3/AI/Realtime
├── sql/schema.sql        # knomad_docs table
├── scripts/setup-db.mjs  # Applies the schema
├── scripts/test-services.mjs # End-to-end service proof
├── scripts/test-job-search.mjs # Eligibility and role-matching tests
├── package.json          # Scripts and dependencies
└── README.md
```

## How pages are read

Browsers block cross-origin fetches, so `fetchJobPage()` tries three paths in order:

1. **Direct fetch** — works only when the site sends permissive CORS headers.
2. **[allorigins](https://allorigins.win/)** — returns the raw HTML, which is parsed for schema.org `JobPosting` JSON-LD and Open Graph metadata.
3. **[Jina Reader](https://r.jina.ai/)** — returns a readable text rendering of the page.

If all three fail or return too little text, the flow stops with an error and a **Try another link** button. Pasting the description bypasses network reading entirely.

Both readers are third-party services. If a page is sensitive or under NDA, paste the text instead.

## Resume parsing

- **TXT / MD** — read directly.
- **PDF** — parsed in the browser with [pdf.js](https://mozilla.github.io/pdf.js/). Text items are grouped into visual lines so names, headings, and contact rows survive extraction.
- **DOCX** — unzipped with [JSZip](https://stuk.github.io/jszip/) and the document XML is read.
- **DOC** — unsupported; save as DOCX or paste the text.

pdf.js and JSZip load from jsDelivr on demand. If a library can't load (offline, blocked CDN), knomad asks you to paste the text instead. You can always paste resume text directly into the profile.

## Resume autofill

Uploading a resume (or pasting text and clicking **Fill profile**) fills the profile from the resume automatically:

| Field | How it is found |
|---|---|
| Name | First plausible name line near the top (2–4 words, no digits, email, or links) |
| Headline | The line directly below the name, unless it is contact info or a section heading |
| Email | First email address in the header block |
| Phone | Phone-shaped number in the header block |
| Location | `City, ST` pattern in the header, with "open to remote" preserved when present |
| Links | LinkedIn (`/in/`), GitHub, and the first other URL or domain |
| Summary | Text under SUMMARY, PROFILE, ABOUT, or OBJECTIVE |
| Skills | Entries under SKILLS / TECHNICAL SKILLS / COMPETENCIES, with a keyword fallback against the whole resume |

This is heuristic, not AI. It only fills fields it can actually detect — anything it misses stays as you typed it, and fields it does find are overwritten. Review the result and click **Save profile**.

Profile variables and the base resume are both used as the source of truth for every job-specific resume:

- **AI mode** — the prompt receives the full profile and the base resume, and is told to use the profile header verbatim and never invent facts.
- **Basic mode** — the profile header is placed on top of the base resume, followed by the keyword-gap report.

If a generated resume has neither your name nor your email, knomad prepends the profile header as a safety net.

## Application page

Opening an application from the dashboard, tracker, or calendar goes to a full page rather than a modal. The page has three tabs:

- **Overview** — status, applied date, posting link, notes, the job description used, and the interview/reminder scheduler.
- **Resume** — the tailored resume rendered as a document, with copy, print, and PDF actions.
- **Interview practice** — the step-by-step practice flow plus the generated interview brief.

The back arrow returns to whichever page you came from (dashboard, tracker, or calendar). Changing status, saving notes, or adding an event rerenders the page without resetting the active tab or practice progress.

## Resume preview, print, and PDF

`parseResumeDocument()` turns the plain-text resume into a small document model: a header (name, headline, contact), sections split on ALL-CAPS headings, and paragraph versus bullet items. The preview renders that model as a paper-like document in the same visual language as the app.

- **Copy text** copies the raw tailored resume.
- **Print** opens the browser print dialog. A dedicated print stylesheet strips the app chrome and prints only the resume document.
- **Download PDF** builds a letter-size PDF with [jsPDF](https://github.com/parallax/jsPDF), loaded on demand from jsDelivr. The filename combines your name, company, and role.

The `---` + `BASIC MODE NOTES` block from basic mode stays in storage but is hidden from both the preview and the PDF. If jsPDF cannot load (offline or blocked CDN), knomad falls back to the print dialog so you still get a document.

## Interview practice

The **Interview practice** tab pulls likely questions from the generated brief. It looks for a `LIKELY QUESTIONS` section and numbered questions such as `1. …`, using the `Talking point:` line under each as a hint. If the brief has fewer than six usable questions, knomad adds general questions built from the role and company.

1. Read the question.
2. Write the answer as you would say it out loud.
3. Optionally open a hint.
4. Move forward or back; answers save to `localStorage` as you type.
5. On the last question, choose **Finish & score**.

Scoring is local and deterministic, not AI. Each answer is judged on:

| Signal | What helps |
|---|---|
| Length | Roughly 60–180 spoken words |
| Structure | STAR language: situation, task, action, result |
| Specifics | Numbers, percentages, timeframes, scale |
| Impact | Outcome verbs such as increased, reduced, shipped, saved |
| Job language | Terms drawn from the role and posting |
| Ownership | Clear "I did" statements |
| Filler | Fewer "um," "like," "just," "basically" |

The results screen shows an overall score, a per-question score, your answer, and 2–4 concrete suggestions. **Practice again** clears the answers and starts over. Answers, scores, and feedback are stored on the application in `interviewSession`.

## Data and privacy

Stored under these `localStorage` keys:

| Key | Contents |
|---|---|
| `knomad_profile` | Name, profile photo (data URL), contact details, links, summary, skills, resume text, file name, and archived file key |
| `knomad_applications` | Applications, statuses, status history, notes, tailored resumes, interview prep, job descriptions, scheduled interviews/reminders, and practice answers/scores |
| `knomad_gemini_key` | Your Gemini API key — device-local only, never synced |
| `knomad_notified` | Reminder keys that have already fired, so they don't repeat |
| `knomad_sync_clocks_<userId>` | Per-user last-write-wins timestamps |
| `knomad_sync_cursor_<userId>` | Per-user server cursor for incremental pulls |

- The Gemini key is used only for direct calls from your browser to `generativelanguage.googleapis.com`. It is never included in a synced document.
- When you sign in, profile and application documents (and uploaded resume files) are sent to your Neon branch. Row access is scoped by the verified JWT subject.
- Job URLs are sent to the reader services above when fetching a page.
- **Settings → Export backup** writes a JSON file; **Erase all local data** removes local data and, when signed in, soft-deletes the cloud copies too.
- Cloud sync is optional. Signing out leaves your local workspace intact.

## Known limitations

- **Job descriptions from LinkedIn and similar sites** often fail to load through readers; use the paste field.
- **No job-description-only mode** — a URL is still required even when you paste the description.
- **Company/role detection is heuristic** in basic mode. The model usually fixes it in AI mode, and you can rename fields only by editing the saved data.
- **Resume output is rendered HTML and PDF**, but the underlying tailored resume is still plain text with no rich formatting controls.
- **Interview scoring is heuristic** — it measures length, structure, specifics, and language, not the truth or quality of your experience. Treat the score as a practice prompt, not a verdict.
- **PDF and resume-file parsing need a CDN** — jsPDF, pdf.js, and JSZip load from jsDelivr. When they are unavailable, knomad falls back to printing or asks you to paste text.
- **Profile autofill is heuristic** — it can miss a name on unusual layouts or grab the wrong line. Review the filled fields before saving, and use the **Fill profile** button after editing resume text.
- **Reminders require knomad to be open** — there is no background service worker. System notifications also need notification permission and a secure context.
- **No recurring events** — each interview or reminder is a single date and time.
- **No import** — backups can be exported but not restored in-app yet.
- **Cloud sync is per document** — two devices editing the same application offline resolve by last write, not by field-level merge.
- **AI Gateway needs credits** — auth and routing work on every plan, but model requests return `paid_plan_required` until the Neon org adds gateway credits.
- **Realtime is best-effort** — reconnects and expired sealed queries fall back to the 30-second poll.

## Possible next steps

- Import a backup file.
- Add a manual "no link" application flow.
- Export the tailored resume as DOCX.
- Let users edit company and role before generating.
- Add Playwright end-to-end tests for intake, profile save, and tracker actions.

## License

ISC (see `package.json`). Update this if the project uses a different license.
