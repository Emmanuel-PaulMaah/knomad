# knomad

A local-first job search workspace. Add a job posting, and knomad reads the page, tailors your resume to it, drafts interview prep, and files the whole thing in your application tracker.

It works entirely offline on `localStorage`, and optionally syncs your profile, applications, original resume files, and the job leads you share with kniggurs to Neon when you sign in. The Gemini API key always stays on the device.

## Neon backend

`neon.ts` declares one branch policy:

| Service | Use |
|---|---|
| **Postgres** | `public.knomad_docs` — one row per profile/application document, scoped by `user_id`; plus friendships, friend requests, shared job leads, circles, task lists, and shared tasks |
| **Auth** | Managed Better Auth email/password sign-up and sign-in; the browser sends the session JWT to the Function |
| **Functions** | `knomadsync` — Hono API that verifies the JWT, reads/writes documents, uploads files, proxies AI, and seals realtime queries |
| **Object Storage** | Private `resumes` bucket for original uploaded resume files, reachable only through presigned URLs |
| **AI Gateway** | OpenAI-compatible `/v1/chat/completions`, used when you're signed in and have no local Gemini key |
| **Realtime** | Live SQL subscription on the signed-in user's rows; the browser pulls or applies changes immediately |
| **Function Trigger** | `knomad-push-tick` POSTs to `/push/run` every minute so reminders, due tasks, CRM follow-ups, and project targets are sent with no tab open |

Sync rules:

- Each save is diffed locally and sent to the Function after a short debounce.
- The server keeps the row with the newest `client_updated_at` (last write wins), and reports each batch result so a dropped write is never shown as "synced".
- A device clock more than five minutes ahead is rejected with a 409; accepting it would let that timestamp outrank every later write from every other device.
- Deletions are soft (`deleted_at`) so they propagate instead of resurrecting.
- Realtime is best-effort; a 30-second poll covers reconnects, and the app also pulls when the tab becomes visible or the network returns.
- `knomad_gemini_key` is never included in a synced document.

## What it does

- **Dashboard** — metric cards for applications, interviews in the last 7 days, active pipeline, and response rate, plus activity and status charts that also count Together work, your next scheduled items from the calendar, a **This week** digest, recent activity, and a daily Wiktionary word with a resume-relevant Wikipedia read.
- **Job search** — type a role, and knomad queries four public remote-job APIs, keeps matching titles, and marks which postings are open to Nigeria (or another country you pick). It is rule-based, with no AI and no API key.
- **Kniggurs & shared inbox** — on the **Together** page, add people by email, accept requests from the notifications card, and send any application (or a new lead) to a friend with a note. Jobs land in their shared inbox, where **Track job** starts the normal intake flow with the title, company, link, and description already filled in, so the recipient's own resume and cover letter are generated from their profile. Each shared job has a reply thread so you can talk about that lead.
- **Together** — the shared workspace (circles, to-do lists, projects, learning, shelf, CRM), a peer of Jobs with equal topical weight. Dated items appear on the calendar next to interviews and reminders, and the Dashboard shows job metrics and Together cards side by side, so a shared plan and your own job search live in one month view.
- **One-click job intake** — the big **+** opens with three ways in: **Job link**, **Paste description** (for blocked or login-walled pages, keeping the link for Open posting), and **Manual entry** for referrals or applications filed elsewhere. The link path reads the page, extracts the company and role, rewrites your resume, writes interview prep, and saves the application. Re-adding a link that is already tracked offers to open the existing application instead of silently duplicating it.
- **Profile** — name, photo, headline, contact details, links, summary, skills, and your base resume. Saved details appear as a read-only profile sheet; click any detail (or **Edit profile**) to open the fields, then use **Save profile** to keep the changes or **Cancel** to discard them. The photo is cropped to a square, stored with the profile, and shown on the dashboard and top bar. Upload a resume file or paste the text, and knomad fills the profile fields from it (see [Resume autofill](#resume-autofill)).
- **Tracker** — search, filter, and sort applications (newest, oldest, company, next step due, or **Needs attention**), then open any one as a full application page. Every row keeps the source link: click the hostname or **Open posting** to jump back to the original job page, and read the **Next step** column for what is due next. The count line shows how many rows need attention.
- **Application page** — stage, autosaved notes, a **Next step** with a due date, an editable applied date, the job description used, scheduled interviews and reminders, the tailored resume, a cover letter you can generate on demand, and interview practice in one place. **Re-tailor** regenerates the resume and cover letter from the saved description; notes, events, and practice answers stay. **Follow up in 7 days** sets the next step and puts a reminder on the calendar.
- **Tailored resume document** — every generated resume is rendered as a styled document, with copy, print, PDF, and Word (`.doc`) download actions. A matching cover letter is generated with the tailoring and can be edited inline (it saves as you type), with **Generate cover letter** / **Regenerate**, copy, PDF, and Word download actions on the same tab.
- **Interview practice** — a step-by-step sequence: read a likely question, write your answer, move at your own pace, then get a local writing signal (length, structure, keywords, fillers) and per-question feedback. It does not verify your facts.
- **Calendar** — month view of every interview, reminder, to-do due date, project target, and CRM follow-up, with a source filter, a day list, and the next 30 days at a glance. Calendar and application-event rows have an **Add to Google Calendar** link that opens a prefilled Google event, plus an **ICS** download; the calendar header exports the whole current view as a `.ics` file so reminders still work with the tab closed.
- **Settings** — optional cloud sign-in and sync, a Google Gemini API key, browser notifications, a JSON backup export, or erase local and cloud data.

## Job search

Open **Find jobs** in the sidebar, type a role, and pick the country you can work from (Nigeria by default). Results show the job title, provider, stated location, and a direct link. **Track** opens the normal Add job flow with the URL, company, title, and description already filled in.

The search is entirely deterministic. No model scores the roles, and no API key is needed.

**Sources.** Knomad asks four public, key-less APIs that allow browser requests:

| Provider | Endpoint | Notes |
|---|---|---|
| Jobicy | `jobicy.com/api/jobs` | Tagged search, plus Jobicy's worldwide-only feed; the last 7 days |
| Remote OK | `remoteok.com/api` | Full public feed; needs the follow link and attribution shown in the page footer |
| Remotive | `remotive.com/api/remote-jobs` | Latest public batch; role matching happens locally |
| AI training (aitrainer.work) | `aitrainer.work/api/jobs.json` | Newest 500 roles from 28 AI-training platforms, including Mercor, Ethos, Alignerr, Outlier and Mindrift. CC BY 4.0: each listing links to its aitrainer.work page, which carries the apply link. Older pages load on request |

**Eligibility.** The location string each provider publishes decides the verdict:

- **Open** — mentions Nigeria (or the selected country), Worldwide, Anywhere, Global, or Africa. "South Africa" is treated as a country, not the region.
- **Maybe** — EMEA. Nigeria is geographically in Africa, but companies often use EMEA to mean Europe and the Middle East, so these are hidden by default.
- **Not verified** — blank, bare "Remote", or "Region not stated". Hidden by default because the posting does not actually promise your country.
- **Restricted** — any other stated region (USA, Europe, LATAM, APAC, a city, a time-zone requirement).

When a board leaves its location field blank, knomad looks in the description for an explicit `Remote:`, `Location:`, or "open to candidates in…" phrase before giving up. Results are filtered in the browser, so unchecking **Only roles open to…** is instant. If every matched role is unverified or restricted, the empty state offers a one-click **Show all matched roles** action.

**Role matching.** The query is lowercased and split into tokens. Arrangement words ("remote", "full-time") and seniority words ("senior", "lead") are dropped, and small synonym groups map developer↔engineer, frontend↔front end, support↔customer service, and similar pairs. A role is kept when the share of matched tokens is at least 60% for a one- or two-token query, or 50% for a longer one. Provider-side search is loose, so this local pass is what removes unrelated listings.

Provider failures are isolated: if one API is down, the other providers still return results, and the provider chip shows **unavailable**. Responses are cached in memory for ten minutes; the AI-training feed is cached for an hour because its publisher asks consumers to read it only once or twice a day.

The AI-training feed has no keyword search, so the first search scans its newest 500 roles and then applies the normal role and eligibility rules. Below the results, **Load 500 older roles** fetches the next page, appends any new matches, and shows how many of the feed's roles have been scanned so far. Every batch is cached by offset, so paging back over the same page does not hit the network again.

Mercor and Ethos do not publish their own job-board APIs, and their marketplace pages are login- or matching-gated. Their roles reach knomad through aitrainer.work's licensed feed instead of a scraper, so the listings stay attributable and the app keeps working when either platform changes its site.

Run the job-search and daily-read tests with:

```bash
npm run test:search
npm run test:daily
```

**Limitations.** The public feeds skew heavily toward US-only roles, and most Remote OK postings leave their location blank. A strict search can therefore return only a handful of verified roles. Eligibility is read from the posting's own metadata — always confirm the location on the job page before applying.

## Kniggurs & shared inbox (Together tab)

Kniggurs live in your knomad account, so the **Together → Kniggurs** tab needs you to be signed in. Your circles, to-dos, shelf, and CRM are one tab away on the same page.

1. Open **Together** and select the **Kniggurs** tab, then enter a friend's email. They need an existing knomad account.
2. They see the request under **Requests** and choose **Accept** or **Decline**. If both people add each other at the same time, the second request completes the friendship instead of leaving two pending invites.
3. Send a job in one of two ways:
   - **Send a job** in the **Shared jobs** card on the Kniggurs tab opens a short form: pick the friend, add a company, role, link, and note.
   - **Send to friend** on any application page carries that application's company, role, link, and job description with it.
   - **Send** on a job search result shares that lead before you track it yourself.
4. The recipient sees it in the **Inbox** tab of the **Shared jobs** card, with an unread count on the rail icon. They can **Open posting**, **Track job**, **Mark read**, or **Dismiss** it. **Track job** starts the normal Add job flow with the details prefilled.
5. **Reply** under any shared job opens a thread with that friend. Both people can post; the other side sees an unread badge on the thread and a toast from any page. Opening a thread marks the other person's replies read. Replying to a dismissed job brings it back to the recipient's inbox.

**Sent** is the second tab on the same card and keeps a record of what you shared; each sent job has the same reply thread. The tabs show how many jobs are on each side, so a conversation you started is never buried in a separate card. Dismissing a job hides it from the recipient's inbox but leaves the sender's copy intact. Removing a friend also cancels any unanswered request between the two of you, and stops new jobs from being sent either way.

The inbox refreshes with the normal 30-second cloud poll, when the tab becomes visible, and whenever you open the Together page. Unread counts, reply notifications, and new-job toasts work from any page. A reply box you are actively typing in is left alone by the silent poll; drafts stay put until you send or close the thread.

While you are signed in, that same poll refreshes your presence heartbeat. A kniggur who has polled in the last 90 seconds shows a small sage dot after their name and a ring on their avatar — in the friend list, requests, shared-job inbox and sent lists, reply threads, circle members, task assignees, and contact notes. Hidden tabs stop polling, so someone who closes the tab or leaves the page turns offline after the window passes. Once they are offline, the friend list and circle roster show a relative **last seen** time ("last seen 12m ago", "last seen yesterday"); hovering a name or avatar anywhere presence appears shows the exact timestamp.

Friend actions need a valid session token, not just a remembered account. If that token can no longer be minted, knomad clears the stale signed-in state and asks you to sign in again — Settings never keeps claiming you are synced while new requests are being rejected.

## Together: the shared workspace (a peer of Jobs)

**Together** is the shared workspace, equal in weight to Jobs: it is not a subset of
job tracking, and job tracking is not a subset of it. It also owns the **Kniggurs**
tab, so adding kniggurs, sending job leads, and replying to their threads happen on
the same page as your lists, shelf, and CRM. The workspace itself is scoped to one of
two things at a time:

- **Just me** — your own lists and tasks. They are still server-owned when you are signed in, but no one else can read them.
- **A circle** — a named group of your kniggurs. Every member sees the circle's lists and tasks, and can edit or complete them.

Create a circle with **New circle**, then add kniggurs from the circle card. Only people you have already added as kniggurs can join, and only the circle owner can add or remove members. **Delete circle** archives it for everyone; its lists and tasks return to the person who created them instead of being erased.

Lists group tasks (for example *Applications*, *Portfolio*, or *This week*). Each task has a title, optional notes, a list, a due date, and — inside a circle — an assignee. Checking a task marks it done everywhere, including on the calendar. Personal tasks can only be assigned to you.

**Projects** group tasks around one outcome. A project has a name, a summary, a status (planning, active, paused, or done), a target date, and a progress bar. A **milestone** is a project checkpoint: it always belongs to one project, never lives in a list, and is never assigned. It is the only thing that drives the progress bar. To-dos are work items that can optionally be attached to a project from the To-dos tab; they remain list items and never become milestones. A project task can be promoted to a milestone from the project view, which drops its list and assignee, or a project with no milestones falls back to done tasks out of all tasks, labelled as task progress. Opening a project shows its milestones and tasks. A project target appears on the Calendar and in the Dashboard's Today card; milestone due dates appear there as milestones.

Due tasks are merged into the **Calendar** page next to interviews and reminders. CRM follow-ups appear there too and open the contact. The calendar's source filter switches between all sources, just yours, or one circle. Clicking a task on the calendar opens it in Together, and the ✓ button on the calendar row completes it without leaving the page.

Shared rows use optimistic concurrency. Every list and task carries a `version`; a save sends the version it last saw, and a stale write is refused with the current row, so two people editing at once cannot silently overwrite each other. When that happens, knomad says so and reloads the latest snapshot.

The page refreshes with the normal 30-second cloud poll, when the tab becomes visible, and whenever you open Together. A local cache per account keeps the last snapshot visible while the first request is in flight.

**Shelf is live.** Add a book, pick its category and page count, then move it between Want to read, Reading, Paused, and Finished. Circle owners curate the category list - starting from suggestions or adding their own - and members pick from it; page progress, ratings, optional Google Drive or web links (opened in a new tab), and the four shelves are shared with the selected circle, and finishing a book stamps the date.

**CRM is live.** Add a contact with name, company, role, stage, email, phone, source, tags, and an optional next follow-up. Contacts are private to you; with a circle selected they are shared with that circle. Open a contact to see its timeline and log interactions with a date and optional next follow-up; logging an interaction updates the contact's last touch. Contacts with a follow-up date appear on the Calendar and in the Dashboard's Today card. The **Learning** tab is still a placeholder; learning progress, reading goals, and the remaining CRM plans live in [docs/friends-platform-spec.md](docs/friends-platform-spec.md).

## One job, one flow

1. Click the **+** on the dashboard (or **Add job** in the top bar).
2. Pick a way in: **Job link**, **Paste description**, or **Manual entry**.
   - **Job link** — paste the posting URL. If the same posting is already tracked (ignoring tracking parameters and a trailing slash), knomad offers to open the existing application instead of creating a duplicate.
   - **Paste description** — for pages that block readers. The link is optional but recommended: without it the application has no source link.
   - **Manual entry** — company, role, optional link, applied date, and notes. This skips tailoring, works without a base resume, and is the path for referrals or applications you filed elsewhere.
3. For a generated application, answer the short **Quick check** step: knomad points at requirements the posting stresses that your base resume doesn't obviously cover. Add a note only if it's true, choose **Use my answers**, or choose **Generate without answers**. Esc closes the whole flow without saving.
4. knomad fetches the page, pulls out the company, role, and description, then produces:
   - a resume rewritten for that posting,
   - interview questions with talking points, questions to ask, and topics to review,
   - a tracker entry marked **Applied**.
5. If the draft mentions dates, years, metrics, or company names that aren't in your profile or base resume, a **Before filing** screen lists each one, shows the source link so you can reopen the posting while you check, and previews the drafted resume. Choose **Edit answers and regenerate** to send new notes through the draft again, **Save this resume** if the detail is real, or **Discard &amp; start over**.
6. The saved application opens as a full page so you can change stage, add notes, set a next step, fix the applied date, schedule an interview, preview or download the resume, and practice the interview questions. Use **Re-tailor** to regenerate the resume and cover letter from the saved description later.

If the page blocks automated readers, switch to **Paste description** and drop the text in. knomad uses it directly and keeps the link attached, so **Open posting** still works from the tracker and application page.

## Dashboard metrics

The dashboard reads from your local applications and updates every time you add a job or change a status.

| Card | What it counts |
|---|---|
| Applications | Every application, with how many were added in the rolling last 7 days |
| Interviews · 7d | Applications whose status moved to **Interviewing** in the last 7 days |
| Active pipeline | Applications currently **Applied** or **Interviewing** |
| Response rate | Share of applications that moved past **Applied** |

Two charts can sit below the cards, each toggled separately:

- **Activity** — applications added plus Together tasks completed and books finished per day over the last 14 days, drawn as one stacked bar per day. Hover a bar for the date and the split, or read the Jobs and Together totals below the axis.
- **Status breakdown** — current application status distribution with counts and percentages, plus a Together group for open/done tasks and reading/finished books, and a combined footer.

**Settings → Dashboard** shows an independent checkbox for each chart. Turning both off leaves a narrower dashboard. The preferences are per browser (`knomad_dash_activity` and `knomad_dash_status`) and are not synced.

To make interview counts accurate, every status change is timestamped. Each application stores a `statusHistory` array; changing status in the detail view appends an entry instead of overwriting the old one. Applications saved before this feature existed get a single history entry from their current status and applied date.

The metrics are straightforward counts, not projections. With no applications the cards show zero; the charts stay empty until you add a job or finish something in Together.

## Application stages

Every application sits in one ordered pipeline stage. The detail-page selector groups them so the list stays short:

| Group | Stages |
|---|---|
| Applied | Saved, Applied |
| Interviewing | Recruiter screen, Interviewing, Take-home |
| Offer | Offer, Negotiating, Accepted |
| Closed | Rejected, Withdrawn |

The four dashboard buckets (Applied, Interviewing, Offer, Rejected) still drive the metric cards, charts, and tracker filter, so the existing numbers keep working. Each granular stage folds into one bucket: Saved and Applied count as Applied, Recruiter screen and Take-home count as Interviewing, and Negotiating and Accepted count as Offer.

When you change the stage, the app appends `{ status, stage, at }` to `statusHistory` and the tracker shows the new stage label. Applications saved before stages existed are read from their old status — `applied`, `interviewing`, `offer`, or `rejected` — and keep working without a migration step. A legacy `interviewing` record stays at the generic Interviewing stage rather than being promoted to a specific round.

Each stage also has a soft aging threshold. The tracker shows how many days the application has been in its current stage and turns the line amber once it passes the threshold: Saved 3 days, Applied 10, Recruiter screen 4, Interviewing 7, Take-home 4, Offer 3, Negotiating 5. Closed stages (Accepted, Rejected, Withdrawn) never age. The same aging rule feeds **Needs attention** on the tracker and the dashboard digest, so a stalled application surfaces without a manual reminder.

## Weekly digest

The dashboard also has a **This week** card that pulls the week into one place. It covers the rolling last seven days and the next seven:

- **Added this week** — applications filed in the last seven days.
- **Moved forward** — application stage changes in the last seven days, with the new stage and date.
- **Coming up** — interviews and reminders in the next seven days.
- **Needs attention** — overdue next steps and applications that have sat in one stage past its aging threshold.

Each row opens that application. If nothing changed, the card says so and suggests adding a job or setting a next step. The digest is generated entirely on this device from `statusHistory`, `nextAction`, `dateApplied`, and scheduled events; there are no emails, cron jobs, or background services.

## Daily read

Below the metric cards, the dashboard shows today's Wiktionary **Word of the Day** and a Wikipedia **Article of the day**. Both come from keyless, browser-side Wikimedia APIs, so they work without a model or API key.

The article starts with the day's featured article. If one of the day's most-read articles matches a skill or resume keyword, knomad picks that article instead and says which term matched; otherwise the featured article stays. The word is always today's Wiktionary entry, with its definition and part of speech. When the word or article overlaps your resume, the card names the matching terms. One source failing leaves the other card visible, and both responses are cached for six hours.

## Daily read portal

**Settings → Daily read** adds a Wikipedia portal selector for the article. The selected portal (or **Auto**, which reads your headline, summary, and skills) determines which Wikipedia article-of-the-day the card shows, and the option is saved with your profile (`dailyPortal`). The portal article is fetched from a clean, curated Wikipedia source page, summarized by the Wikipedia summary API, and cached for 24 hours. If the portal source or summary fails, knomad falls back to the general featured/most-read feed instead of failing the card.

The available portals and how they are chosen:

- **Computer science & programming** — from `Portal:Computer programming/Selected articles` (featured, good, and vital picks).
- **Mathematics**, **Physics**, **Medicine**, and **Literature** — from each WikiProject's recognized content list (featured and good articles).
- **General Wikipedia feed** — the existing featured and most-read articles, chosen by skills as before.
- **Auto** — tries each portal in order (computer programming first) against your headline, summary, skills, and resume; if none matches well, the feed is used. Developer profiles with Python, JavaScript, SQL, Kubernetes, and similar terms usually land in computer programming.

Article picks rotate by date, so the daily portal read changes every day even inside one portal. The word-of-the-day text and Wiktionary parsing are unaffected.

## Calendar and reminders

Every application can hold any number of scheduled events. Open an application from the dashboard or tracker, then use **Interviews & reminders** to add one:

- **Type** — an interview or a plain reminder.
- **Date & time** — stored in your local timezone.
- **Remind me** — at the time, 15 minutes, 1 hour, 1 day, or 1 week before.
- **Title or note** — optional; falls back to "Interview" or "Reminder".

The **Calendar** page shows a Sunday-start month grid with a dot for each scheduled day. Select a day to see its items, step through months with the arrows, or jump back with **Today**. The source filter narrows the view to **All sources**, **Just mine**, or a single circle, and is remembered on this device. The sidebar lists the 30 days from the selected day (or from today when the selected day is past), and the dashboard's **Next up** card shows the soonest items from the same calendar feed, each tagged with a source pill. Its small dropdown chooses the timeline covered — **1d**, **7d**, or **30d** — and the choice is remembered on this device. Clicking a row opens its application, task, project, or contact.

Calendar items come from four places: application interviews/reminders, Together tasks with a due date, project target dates, and CRM contacts with a next follow-up. A task row opens the task, and its check button marks the task done in place; a follow-up row opens the contact.

Each row's calendar icon opens Google Calendar with the title, time (or all-day date), and source already filled in. Each application-event row also has an **ICS** download, and **Export .ics** in the calendar header exports everything currently in view. These are one-way, per-click exports: edits or deletions in knomad do not update the copy elsewhere, so change it there too if plans change. Timed items are sent as one-hour blocks and use the browser's time zone.

Reminders are checked while knomad is open, and pushed to Chrome when it is not:

- An in-app toast fires when a reminder is due.
- With **Settings → Reminders** enabled, the browser registers a Web Push subscription. The Function then sends a real notification for reminders, tasks that come due, CRM follow-ups, project targets, new shared jobs, replies, and kniggur requests — even with every knomad tab closed.
- Reminders that came due while the page was closed fire on the next load, unless the event started more than 60 minutes ago. The push tick uses the same grace window. Date-only items (follow-ups and project targets) fire once at 09:00 in your time zone on the day itself.
- **Subscribed browsers** under the reminder switch lists every device that receives pushes, with its time zone and last activity. The one you are using is tagged, and **Remove** drops an old device.
- The page records fired reminders under `knomad_notified`; the Function records pushed ones in `knomad_push_log`, so neither side repeats one.
- Every push notification opens knomad on the page it belongs to: the calendar for a reminder, To-dos for a due task, CRM for a follow-up, Projects for a target date, and the Kniggurs inbox for a job or reply.
- **Send a test notification** in Settings proves the whole path without waiting for a reminder.

Push needs a secure context (`https://` or `localhost`), notification permission, a signed-in account, and VAPID keys on the branch (see [Neon setup](#neon-setup)). Without any of those, knomad falls back to in-app toasts and page-level notifications while the tab is open, and the **Add to Google Calendar** link and **.ics** download still work as an independent copy.

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
npm run push:keys              # prints VAPID_* lines; paste them into .env.local
neon deploy --env .env.local   # provisions auth, functions, storage, gateway, realtime, push tick
npm run db:setup               # applies sql/schema.sql (including the push tables)
npm run test                   # exercises every service end to end
npm run test:push              # checks push encryption and headers locally
```

`npm run push:keys` generates a VAPID key pair once. Keep it: changing either key invalidates every browser subscription, and each person has to enable notifications again. `neon deploy` fails on the default branch until both keys are in the env file it is given, because a Function without them cannot sign a push.

If `neon deploy` reports `function triggers not available for this project`, deploy the Function alone with `neon functions deploy knomadsync --src src/function/index.ts --env KEY=VALUE` (one per Function secret) and retry once the project has Function Triggers. Without the trigger, inbox notifications still arrive immediately; reminders and due tasks only fire while a tab is open.

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
8. Friends: a second account requests, accepts, receives a shared job, marks it read, dismisses it, then revives it with a reply and exchanges messages both ways.
9. Together: personal tasks and contacts stay private, a stale version is refused with the current row, a circle member sees a shared task, project, and contact, completes a project milestone, a logged contact note updates last touch, and archiving the circle detaches its rows back to their creator.

Playwright remains available for browser tests.

## Project structure

```
knomad/
├── index.html            # Layout, modals, and all styles (dark single-page app)
├── main.js               # State, storage, sync engine, page reading, resume parsing, AI, rendering
├── job-search.js         # Public job APIs, eligibility rules, token matching, no AI
├── sync.js               # Browser Neon Auth + Function + Realtime clients
├── neon.ts               # Neon branch policy (auth, functions, bucket, gateway, realtime)
├── src/function/index.ts # knomadsync Hono API, JWT verification, Postgres/S3/AI/Realtime/push
├── src/function/push.ts  # Web Push encryption (RFC 8291) and VAPID signing (RFC 8292)
├── public/sw.js          # Service worker: renders pushes, routes a click into the app
├── sql/schema.sql        # knomad_docs, friendships, presence, shared jobs, circles, tasks, projects, books, contacts, push
├── scripts/setup-db.mjs  # Applies the schema
├── scripts/gen-vapid.mjs # Prints a VAPID key pair for Web Push
├── scripts/test-services.mjs # End-to-end service proof
├── scripts/test-push.mjs # Push encryption and header checks (no network)
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

pdf.js and JSZip ship with the app as lazily loaded chunks. If a chunk can't load (offline, blocked by a proxy), knomad asks you to paste the text instead. You can always paste resume text directly into the profile.

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

- **Overview** — stage, applied date, posting link, autosaved notes, the **Next step** with a due date, the collapsed job description used, and the interview/reminder scheduler.
- **Resume** — the tailored resume rendered as a document, with copy, print, PDF, Word, and **Re-tailor** actions, plus the editable cover letter written for the same posting, with copy, PDF, and Word download.
- **Interview practice** — the step-by-step practice flow.

The back arrow returns to whichever page you came from (dashboard, tracker, or calendar). Changing stage, editing notes, or adding an event rerenders the page without resetting the active tab or practice progress; notes and next-step fields save as you type and are only re-rendered when the field is not focused.

## Resume preview, print, and PDF

`parseResumeDocument()` turns the plain-text resume into a small document model: a header (name, headline, contact), sections split on ALL-CAPS headings, and paragraph versus bullet items. The preview renders that model as a paper-like document in the same visual language as the app.

- **Copy text** copies the raw tailored resume.
- **Print** opens the browser print dialog. A dedicated print stylesheet strips the app chrome and prints only the resume document.
- **Download PDF** builds a letter-size PDF with [jsPDF](https://github.com/parallax/jsPDF), bundled and loaded on demand. The filename combines your name, company, and role.
- **Download Word** writes a Word-compatible `.doc` from the same document model, ready to open in Word or upload to Google Docs.
- **Re-tailor** runs the tailoring again from the saved job description and your current profile, replacing the resume and cover letter after a confirmation. Notes, events, and practice answers stay.

The `---` + `BASIC MODE NOTES` block from basic mode stays in storage but is hidden from both the preview and the PDF. If jsPDF cannot load (offline, or the chunk is blocked), knomad falls back to the print dialog so you still get a document.

## Keyword coverage

The **Resume** tab also shows a **Keyword coverage** card. It compares the saved job description and role against the tailored resume and your profile, then groups the posting terms it recognises:

- **Covered** — the term already appears in the tailored resume.
- **In profile only** — you list it in your profile or base resume, but the tailored resume leaves it out. These are the easiest wins.
- **Missing** — the term appears nowhere, so add it only if it is true for you.

Coverage is a local, case-insensitive word match over a built-in skills/tools/soft-skills list plus any skills you saved in your profile. It is **not** an ATS score: it cannot tell whether a term is used well, and it may miss skills that are not in the list. The `--- BASIC MODE NOTES` block is excluded, so basic mode does not inflate the result. Treat it as a checklist, not a grade.

## Interview practice

The **Interview practice** tab pulls likely questions drafted during tailoring. It looks for a `LIKELY QUESTIONS` section and numbered questions such as `1. …`, using the `Talking point:` line under each as a hint. If the drafted prep has fewer than six usable questions, knomad adds general questions built from the role and company.

Each question is tagged **Behavioral**, **Motivation**, or **Technical** from its wording. Behavioral questions are the default and get the most guidance.

1. Read the question and its type.
2. Behavioral questions show a live **STAR checklist** (Situation, Task, Action, Result) that lights up as you type.
3. Optionally open a hint or the **Model outline** — a plain skeleton with placeholders, never invented facts, to fill from your own experience.
4. Choose **Start practice** to keep hints and outlines, or **Start mock interview** to hide them and lock the Back button so it feels like the real thing.
5. Move forward; answers save to `localStorage` as you type.
6. On the last question, choose **Finish & score**.

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

The results screen shows an overall signal, a per-question score, a compact rubric (Structure, Specifics, Ownership, Outcome), a likely follow-up question, your answer, and 2–4 concrete suggestions. **Practice again** clears the answers and starts over. Answers, scores, rubric, and feedback are stored on the application in `interviewSession`.

## Data and privacy

Stored under these `localStorage` keys:

| Key | Contents |
|---|---|
| `knomad_profile` | Name, profile photo (data URL), contact details, links, summary, skills, resume text, file name, and archived file key. Also stores the daily read portal (`dailyPortal`). |
| `knomad_applications` | Applications, stages, statuses, status history, notes, next step and due date, tailored resumes, interview prep, job descriptions, clarifications, scheduled interviews/reminders, and practice answers/scores |
| `knomad_gemini_key` | Your Gemini API key — device-local only, never synced |
| `knomad_notified` | Reminder keys that have already fired, so they don't repeat |
| `knomad_sync_clocks_<userId>` | Per-user last-write-wins timestamps |
| `knomad_sync_cursor_<userId>` | Per-user server cursor for incremental pulls |
| `knomad_space_<userId>` | Last loaded circles, lists, tasks, contacts, and member names, so Together renders before the first request returns |
| `knomad_cal_scope` | The calendar source filter you last chose (`all`, `me`, or a circle id) |
| `knomad_upcoming_window` | The dashboard **Next up** timeline (`1d`, `7d`, or `30d`) |
| `knomad_dash_activity` | Whether the dashboard Activity chart is shown (`on` or `off`) |
| `knomad_dash_status` | Whether the dashboard Status breakdown chart is shown (`on` or `off`) |
| `knomad_dash_insights` | Legacy shared flag from older builds; read once to seed the two preferences above |

- The Gemini key is used only for direct calls from your browser to `generativelanguage.googleapis.com`. It is never included in a synced document.
- When you sign in, profile and application documents (and uploaded resume files) are sent to your Neon branch. Row access is scoped by the verified JWT subject.
- Friendships, pending requests, shared job leads, their reply threads, circles, task lists, projects, tasks, books, and contacts are stored in the same branch and scoped to the signed-in user. Push subscriptions are stored with a push-service endpoint, two public encryption keys, and your time zone; the VAPID private key stays in the Function. A friend can see your account name, email, profile headline, and the jobs, notes, replies, and circle tasks you share with them — nothing else from your workspace. Only the two people on a share can read or post in its thread; only circle members can read its lists and tasks.
- **Settings → Erase all local data** clears your workspace documents but does not remove friendships, shared jobs, circles, or shared tasks; remove friends individually in Together → Kniggurs, and archive circles on Together, if you want to disconnect.
- Job URLs are sent to the reader services above when fetching a page.
- **Settings → Export backup** writes a JSON file; **Erase all local data** removes local data and, when signed in, soft-deletes the cloud copies too.
- Destructive actions (deleting an application, event, task, list, project, book, contact, note, circle, or shared job; clearing the resume or Gemini key; erasing data) ask for confirmation in a shared card. Cancel, Escape, and clicking the backdrop all abort; the destructive button is never focused by default.
- Cloud sync is optional. Signing out leaves your local workspace intact.

## Known limitations

- **Job descriptions from LinkedIn and similar sites** often fail to load through readers; use the paste mode.
- **A source link is recommended but optional** — paste and manual entries can be saved without a URL. Those rows show **No source link** and have no **Open posting** action.
- **Company/role detection is heuristic** in basic mode. The model usually fixes it in AI mode, and you can rename fields only by editing the saved data.
- **Resume output is rendered HTML, PDF, and .doc**, but the underlying tailored resume is still plain text with no rich formatting controls.
- **Interview scoring is a heuristic writing signal** — it measures length, structure, specifics, and language, not the truth or quality of your experience. Treat it as a practice prompt, not a verdict.
- **PDF and resume-file parsing load on demand** — jsPDF, pdf.js, and JSZip are bundled as separate chunks and fetched the first time you use them. When that fails, knomad falls back to printing or asks you to paste text.
- **Profile autofill is heuristic** — it can miss a name on unusual layouts or grab the wrong line. Review the filled fields before saving, and use the **Fill profile** button after editing resume text.
- **Push needs the branch keys and a signed-in account** — with no VAPID keys, or while signed out, notifications only fire while the tab is open. Chrome must also be running: Web Push wakes a closed tab, not a closed browser profile that has been quit.
- **The push tick runs every minute** — a reminder can arrive up to a minute after its time. Reminders and due tasks are deduped in `knomad_push_log`, so a tick that repeats or overlaps never sends one twice.
- **A Next step date is tracked, not scheduled** — it sorts and marks the tracker, but only **Follow up in 7 days** (and scheduled events) put a date on the calendar.
- **No recurring events** — each interview or reminder is a single date and time.
- **No import** — backups can be exported but not restored in-app yet.
- **Cloud sync is per document** — two devices editing the same application offline resolve by last write, not by field-level merge.
- **AI Gateway needs credits** — auth and routing work on every plan, but model requests return `paid_plan_required` until the Neon org adds gateway credits.
- **Realtime is best-effort** — reconnects and expired sealed queries fall back to the 30-second poll.
- **Friends are invited by email** — there are no usernames, contact import, or group shares. The recipient must already have a knomad account.

## Possible next steps

- Import a backup file.
- Add a manual "no link" application flow.
- Export the tailored resume as DOCX.
- Let users edit company and role before generating.
- Add Playwright end-to-end tests for intake, profile save, and tracker actions.

## License

ISC (see `package.json`). Update this if the project uses a different license.
