# knomad — jobs & together platform spec

Status: draft · Scope: small, shippable in phases · Product name: **knomad**

knomad is one app with two peers of equal topical weight: **Jobs** (search,
intake, applications, and the application page) and **Together** (to-dos,
project trackers, learning progress, a reading shelf, and a light CRM). Neither is
a subset or a mode of the other. The app coordinates at least two people's growth
across jobs, shared learning, and progress: job tracking and the shared workspace
share one Dashboard, one Calendar, one scope switcher, and one sync model.
Everything is built on the Neon Function, Postgres, and the existing kniggur
graph. Dated items from both sides flow into the existing Calendar.

---

## 1. Goals

1. Two or more kniggurs can share a to-do list and see each other's changes.
2. A shared project can be tracked to done, with milestones and a progress bar.
3. To-dos, milestones, reading goals, and CRM follow-ups appear on the existing
   Calendar and link back to their source, beside job interviews and reminders,
   with equal prominence.
4. A person can track learning progress (for example Spanish) alone or with a circle.
5. Books live on shelves by category, with reading goals and progress.
6. A small CRM holds business contacts, interaction notes, and follow-up dates.
7. Personal use works without a circle; sharing is an upgrade, not a separate mode.
8. Job applications, shared job leads, and their events are first-class citizens of
   the same coordination model as Together items: one Dashboard, one Calendar, one
   scope, and one sync model span both.
9. The Jobs and Together surfaces have the same topical weight: neither is nested
   under, or reachable only through, the other.

## 2. Non-goals

- No chat product. Replies stay on shared jobs; this spec adds comments only where
  they are attached to an item.
- No hierarchy between job tracking and the shared workspace. Jobs and Together are
  peers; neither is a mode or a subset of the other.
- No CRDT or character-level collaboration. Shared rows use version checks.
- No server push notifications, email digests, or mobile apps in v1.
- No file attachments beyond a book cover URL and contact link.
- No public circles, discoverability, or per-field permissions.
- No billing or seats.

## 3. Product model

| Term | Meaning |
| --- | --- |
| **Kniggur** | A friend, as shown in the UI. Code, routes, and columns keep `friend`. |
| **Circle** | A named group of kniggurs who share items. One owner, many members. |
| **Scope** | `me` (personal) or a circle. Every item has exactly one scope. |
| **Item** | Any row in the new tables: task, list, project, skill, book, goal, contact. |
| **Jobs** | Job search, intake, applications, and the application page. A peer of Together. |
| **Together** | The shared-workspace page: kniggurs and the shared inbox, to-dos, projects, learning, shelf, CRM. A peer of Jobs, not a subset of them. |

Rules:

- A circle can only contain people who are already kniggurs with the owner.
- Any member can create and edit items in that circle. There is no approval flow.
- Personal items have `circle_id = null`. Sharing an item sets `circle_id` and bumps
  its version; the item moves to the circle for everyone.
- Leaving a circle removes access. Deleting a circle archives it and returns its
  items to the creator as personal items, so nothing is lost.
- A circle name is unique per owner. Users see "Owned by you" or the owner's name.

## 4. Navigation and screens

Jobs and Together are peer rail groups with equal weight; neither is nested under
the other. Together keeps the rail short and matches the "workspace for us" idea.
The scope switcher (`Just me`, then each circle) applies to Together items; job
applications stay personal (see open question 6), but job events and shared leads
still appear on the shared Dashboard and Calendar, so a circle coordinates people
across jobs, shared learning, and progress in one place.

```
Jobs
  Dashboard · Tracker · Application page · Find jobs
Together
  [ Just me ▾ ]  (scope switcher: Just me, then each circle)
  Kniggurs · To-dos · Projects · Learning · Shelf · CRM
```

Kniggurs and the shared inbox are a tab on Together, not a separate page: adding a
kniggur, sending a job, and replying to a job thread sit beside the workspace tools.

- **To-dos** — lists on the left, tasks on the right. Group by list, due date, or
  assignee. Inline add, check off, reassign, set due date, move to a project.
- **Projects** — cards with status, target date, milestone checklist, and progress.
  Opening a project shows its tasks and milestones.
- **Learning** — skill cards with a progress bar, target date, weekly minutes, and a
  log button. A shared circle skill shows one bar per member.
- **Shelf** — shelf tabs (Reading, Want to read, Finished, Paused), category filter,
  and a goal strip: "12 of 24 books this year", pages read, current streak.
- **CRM** — contact table with stage, company, last touch, next follow-up, and tags.
  Opening a contact shows a timeline of notes and a "log interaction" form.
- **Dashboard** — unified home of equal weight: job metric cards (applications,
  interviews, active pipeline, response rate) alongside Together cards (Today due
  tasks and milestones, Reading now, Follow-ups due). Each links to its source;
  neither group is nested under the other.
- **Calendar** — one month view spanning job interviews and reminders plus Together
  items (tasks, project targets, reading goals, CRM follow-ups), with source filters
  and coloured chips. Jobs and Together items share the same grid and day list.

Every tab supports both scopes. Switching scope does not navigate away; it filters
the same view. Empty states explain the difference between "Just me" and a circle.

## 5. Data model

Conventions, matching the existing server-owned tables:

- `id uuid primary key default gen_random_uuid()`
- `owner_id text not null` — the creator's verified auth subject.
- `circle_id uuid references knomad_circles(id) on delete set null` — null means personal.
- `version integer not null default 1` — optimistic concurrency token.
- `created_at` / `updated_at timestamptz not null default now()`
- `deleted_at timestamptz` — soft delete so removals propagate to other devices.
- Trigger `knomad_bump_version` sets `version = version + 1` and `updated_at = now()`
  on every update, except when only `version` is being read.
- Indexes: `(owner_id, updated_at desc)`, `(circle_id, updated_at desc)`, and partial
  indexes `where deleted_at is null`.
- Row-level security stays off. All access goes through the Function, which checks
  the JWT subject and circle membership. This matches `knomad_docs` today.

### 5.1 Circles

```sql
create table public.knomad_circles (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  name       text not null,
  color      text not null default 'accent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.knomad_circle_members (
  circle_id uuid not null references public.knomad_circles(id) on delete cascade,
  user_id   text not null,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
```

Membership is read with one join. A partial unique index on `(owner_id, lower(name))
where deleted_at is null` prevents duplicate circle names.

### 5.2 To-dos and projects

```sql
create table public.knomad_task_lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  circle_id  uuid references public.knomad_circles(id) on delete set null,
  name       text not null,
  color      text not null default 'accent',
  position   integer not null default 0,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.knomad_projects (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null,
  circle_id     uuid references public.knomad_circles(id) on delete set null,
  name          text not null,
  summary       text not null default '',
  status        text not null default 'active'
                check (status in ('planning', 'active', 'paused', 'done')),
  start_on      date,
  target_on     date,
  color         text not null default 'accent',
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table public.knomad_tasks (
  id             uuid primary key default gen_random_uuid(),
  owner_id       text not null,
  circle_id      uuid references public.knomad_circles(id) on delete set null,
  list_id        uuid references public.knomad_task_lists(id) on delete set null,
  project_id     uuid references public.knomad_projects(id) on delete set null,
  application_id text,          -- optional link to a job application
  title          text not null,
  notes          text not null default '',
  status         text not null default 'open'
                 check (status in ('open', 'doing', 'done')),
  priority       text not null default 'normal'
                 check (priority in ('low', 'normal', 'high')),
  assignee_id    text,          -- null means anyone in scope
  due_at         timestamptz,
  due_all_day    boolean not null default false,
  is_milestone   boolean not null default false,
  position       integer not null default 0,
  completed_at   timestamptz,
  completed_by   text,
  version        integer not null default 1,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
```

API rules:

- `list_id` and `project_id` must have the same `circle_id` as the task. The Function
  rejects a mismatch with `400`.
- A task with `is_milestone = true` must have a `project_id`.
- Project progress = done milestones / all milestones. If a project has no milestones,
  use done tasks / all tasks.
- `assignee_id` must be the owner or a member of the task's circle.
- Setting `status = 'done'` stamps `completed_at` and `completed_by`; reopening clears them.

### 5.3 Learning

```sql
create table public.knomad_skills (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  circle_id   uuid references public.knomad_circles(id) on delete set null,
  name        text not null,
  kind        text not null default 'skill'
              check (kind in ('language', 'skill', 'course', 'other')),
  target_note text not null default '',
  started_on  date,
  target_on   date,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.knomad_skill_progress (
  skill_id    uuid not null references public.knomad_skills(id) on delete cascade,
  user_id     text not null,
  progress    integer not null default 0 check (progress between 0 and 100),
  weekly_goal integer not null default 0,   -- minutes, 0 = no goal
  updated_at  timestamptz not null default now(),
  primary key (skill_id, user_id)
);

create table public.knomad_skill_logs (
  id            uuid primary key default gen_random_uuid(),
  skill_id      uuid not null references public.knomad_skills(id) on delete cascade,
  user_id       text not null,
  minutes       integer not null default 0 check (minutes >= 0),
  note          text not null default '',
  progress_after integer check (progress_after between 0 and 100),
  logged_on     date not null default current_date,
  created_at    timestamptz not null default now()
);
```

- A personal skill has one progress row for its owner.
- A circle skill starts with one progress row per member when created, or the first
  time a member opens it. Members only write their own row.
- Progress is entered manually (slider) or updated from a log entry. Logging minutes
  never overwrites a manually set higher progress; the client sends the value it shows.
- Weekly goal progress is computed from logs for the current Monday–Sunday week.

### 5.4 Shelf

```sql
create table public.knomad_books (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  circle_id   uuid references public.knomad_circles(id) on delete set null,
  title       text not null,
  author      text not null default '',
  category    text not null default 'General',
  shelf       text not null default 'want'
              check (shelf in ('want', 'reading', 'finished', 'paused')),
  pages_total integer not null default 0 check (pages_total >= 0),
  pages_read  integer not null default 0 check (pages_read >= 0),
  rating      integer check (rating between 1 and 5),
  started_on  date,
  finished_on date,
  cover_url   text not null default '',
  link_url    text not null default '',
  notes       text not null default '',
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table public.knomad_shelf_categories (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  circle_id  uuid references public.knomad_circles(id) on delete set null,
  name       text not null,
  position   integer not null default 0,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.knomad_reading_goals (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  circle_id  uuid references public.knomad_circles(id) on delete set null,
  metric     text not null check (metric in ('books', 'pages')),
  period     text not null check (period in ('year', 'quarter', 'month', 'custom')),
  target     integer not null check (target > 0),
  starts_on  date not null,
  ends_on    date not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
```

- Each scope has its own category list in `knomad_shelf_categories`: the circle
  owner curates the circle's list (starting from suggestions such as Fiction,
  Business, Design, Science, Biography), and a personal reader curates their own.
  Members pick from that list when adding a book; retiring a category leaves the
  label on existing books, and the shelf still filters by those old labels.
- A book may carry an optional `link_url` (for example a Google Drive copy).
  Only http and https URLs are accepted, and the shelf opens them in a new tab.
- Moving a book to `finished` stamps `finished_on` and requires `pages_read = pages_total`
  unless the book has no page count.
- Goal progress is computed, not stored: count finished books or pages between
  `starts_on` and `ends_on`. A circle goal counts the union of member books, de-duplicated
  by title and author, and shows each member's contribution.

### 5.5 CRM

```sql
create table public.knomad_contacts (
  id               uuid primary key default gen_random_uuid(),
  owner_id         text not null,
  visibility       text not null default 'private'
                   check (visibility in ('private', 'circle')),
  circle_id        uuid references public.knomad_circles(id) on delete set null,
  linked_user_id   text,        -- set when the contact is also a kniggur
  name             text not null,
  company          text not null default '',
  role             text not null default '',
  email            text not null default '',
  phone            text not null default '',
  url              text not null default '',
  source           text not null default '',
  stage            text not null default 'lead'
                   check (stage in ('lead', 'talking', 'active', 'dormant')),
  tags             text[] not null default '{}',
  last_contact_on  date,
  next_follow_up_on date,
  notes            text not null default '',
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint knomad_contacts_circle check (
    (visibility = 'private' and circle_id is null) or
    (visibility = 'circle' and circle_id is not null)
  )
);

create table public.knomad_contact_notes (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references public.knomad_contacts(id) on delete cascade,
  author_id    text not null,
  body         text not null,
  happened_on  date not null default current_date,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
```

- Contacts are private by default. Sharing a contact requires choosing a circle in the
  same action, so `visibility` and `circle_id` never disagree.
- Logging a note updates `last_contact_on` to the later of the current value and the
  note date.
- Stages are fixed; tags and sources are free text with suggestions.

## 6. Calendar integration

There is no second calendar and no duplicate event table. The existing Calendar is
already derived (`allEvents()` reads `state.applications[].events`). Extend that idea:

```
scheduleItems() = application events
                + tasks with due_at
                + projects with target_on (kind: milestone, all-day)
                + reading goals ending (kind: reading goal, all-day)
                + contacts with next_follow_up_on (kind: follow-up, all-day)
```

Each item is normalised to:

```js
{ id, source, sourceId, title, at, allDay, kind, circleId, applicationId, href }
```

- `source` is `application | task | project | reading | crm`.
- Date-only values (`target_on`, goal end, follow-up) render at 09:00 local with
  `allDay: true`, in the same top strip as other all-day items.
- Shared items show a small circle chip and the creator's initials. Personal items
  show "Only you" in the detail popover.
- Clicking an item opens its source: task sheet, project page, shelf goal, contact,
  or the existing application page.
- The Calendar header gains a filter: **All**, **Just me**, then one entry per circle.
  Filters persist in localStorage.
- Reminders keep the current client-side model (`REMINDER_LABELS`, no server push).
  Tasks reuse the same minute options; v1 shows an in-app toast when the tab is open.
- Deleting or completing a task removes it from the calendar on the next render. A
  completed task with a due date may render struck through until the day ends;
  the filter "Hide done" controls this.

## 7. API

All routes live in `src/function/index.ts`, use the existing `requireUser` helper,
and return the standard error shape. List routes accept `?scope=me|circle:<uuid>&since=<iso>`.
Writes accept `version` and return `409` with `{ error, current }` on a stale version.

> **Shipped status.** `/space` currently returns a full snapshot (no `?since` delta yet).
> `/circles`, `/circles/:id`, `/circles/:id/members`, `/task-lists`, `/task-lists/:id`,
> `/tasks`, `/tasks/:id`, `/projects`, `/projects/:id`, `/books`, `/books/:id`,
> `/shelf-categories`, `/contacts`, and `/contacts/:id/notes` are live. The skill,
> reading-goal, and export routes below are the design for later phases, not shipped
> endpoints.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/space` | Snapshot: circles, members, lists, tasks, projects, skills, progress, books, goals, contacts. Includes `cursor` and `serverTime`. |
| `GET` | `/space?since=` | Delta of changed and soft-deleted rows across all scopes the user can read. |
| `POST` | `/circles` | Create a circle. |
| `PATCH` | `/circles/:id` | Rename, recolour, archive. Owner only. |
| `POST` | `/circles/:id/members` | Add an existing kniggur. Owner only. |
| `DELETE` | `/circles/:id/members/:userId` | Remove a member, or leave. |
| `POST` | `/task-lists` | Create a list. |
| `PATCH` | `/task-lists/:id` | Rename, recolour, reorder, share to a circle. |
| `DELETE` | `/task-lists/:id` | Soft delete; tasks become listless, not deleted. |
| `POST` | `/projects` | Create a project. |
| `PATCH` | `/projects/:id` | Edit name, summary, status, start date, and target date. |
| `DELETE` | `/projects/:id` | Soft delete; tasks stay and lose the project link. |
| `POST` | `/tasks` | Create. |
| `PATCH` | `/tasks/:id` | Edit, complete, reorder, assign, set due date, move scope. |
| `DELETE` | `/tasks/:id` | Soft delete. |
| `POST` | `/skills` | Create a skill, with progress rows for the scope. |
| `PATCH` | `/skills/:id` | Edit name, target, scope. |
| `PUT` | `/skills/:id/progress` | Write the caller's progress and weekly goal. |
| `POST` | `/skills/:id/logs` | Log minutes or a session. |
| `DELETE` | `/skills/:id` | Soft delete. |
| `POST` | `/books` | Add a book. |
| `PATCH` | `/books/:id` | Edit, move shelf, update pages, share. |
| `DELETE` | `/books/:id` | Soft delete. |
| `POST` | `/shelf-categories` | Create a category for a personal or circle shelf. Owner only for a circle. |
| `DELETE` | `/shelf-categories/:id` | Soft delete; existing books keep the label. Owner only. |
| `POST` | `/reading-goals` | Create a goal. |
| `PATCH` | `/reading-goals/:id` | Edit target or period. |
| `DELETE` | `/reading-goals/:id` | Soft delete. |
| `POST` | `/contacts` | Create a contact, private or circle. |
| `PATCH` | `/contacts/:id` | Edit, change stage, change visibility, set follow-up. |
| `DELETE` | `/contacts/:id` | Soft delete and cascade-hide notes. |
| `POST` | `/contacts/:id/notes` | Log an interaction. |
| `DELETE` | `/contacts/:id/notes/:noteId` | Soft delete a note (author or circle owner). |
| `GET` | `/space/export` | JSON export of every scope the user can read. |

Response shape for `/space` (Phase 1):

```json
{
  "cursor": "2026-11-20T09:14:02.113Z",
  "circles": [{ "id": "...", "ownerId": "...", "name": "Lagos crew", "color": "accent", "role": "owner", "version": 1 }],
  "members": [{ "circleId": "...", "userId": "...", "role": "owner", "joinedAt": "..." }],
  "taskLists": [], "projects": [], "tasks": [],
  "people": { "<userId>": { "id": "...", "name": "...", "email": "...", "headline": "..." } }
}
```

Later phases add `skills`, `skillProgress`, `skillLogs`, `readingGoals`, and
the remaining CRM fields to the same snapshot.

Access rule, in one helper:

```ts
requireCircleMember(circleId, userId) // throws 403 unless the user is a member
```

Every read filters `circle_id is null and owner_id = $user` OR
`circle_id in (select circle_id from knomad_circle_members where user_id = $user)`.
Every write re-checks that rule against the row's scope before updating.

## 8. Sync, offline, and conflicts

- **One cache.** `/space` is stored in localStorage as `knomad_space_<userId>`. The UI
  renders from that cache immediately, then refreshes. Phase 1 caches one full snapshot,
  not one per scope.
- **Poll.** Refresh on the existing 30-second cloud poll, on tab focus, and when the
  Together page or Calendar opens. If Realtime is enabled, subscribe to the new
  tables and treat any change as a cursor invalidation.
- **Writes.** Optimistic UI: apply locally, enqueue `{ method, path, body, baseVersion }`
  in `knomad.space.pending.v1`, then send. On success, replace the row with the server
  response. On failure, roll back and toast.
- **Conflicts.** A `409` means someone edited first. Phase 1 toasts and reloads the
  snapshot, so the server row wins visibly and no one keeps a silent stale copy. The
  fuller dialog — "Changed by [name] a moment ago", **Use theirs**, **Keep mine** — is
  planned for Phase 6.
- **Offline.** Reads come from cache and are marked "Offline, showing last sync".
  Mutations queue and replay in order when the session returns. If the token expired,
  keep the queue and prompt sign-in. A queue older than 7 days is dropped with a notice.
- **Deletes** are soft (`deleted_at`). The delta endpoint returns tombstones so other
  devices remove rows. A nightly job may hard-delete rows older than 90 days.
- **No CRDTs.** Whole-row version checks are enough for lists this size.

## 9. Permissions and privacy

- Personal rows never leave the account. Circle rows are visible to current members only.
- Membership checks happen in the Function on every request; the browser never holds a
  database credential.
- Removing a member immediately hides that circle's data from them. The remaining circle
  keeps its items.
- Archiving a circle sets `circle_id = null` on its items and keeps `owner_id` as the
  creator, so items become personal to the creator. Members lose access.
- Contacts default to `private`. A shared contact is visible to the whole circle; there
  is no per-note privacy flag in v1, so the UI warns before sharing a contact that has
  notes.
- The export endpoint returns JSON only. Account deletion follows the existing account
  flow and cascades the new tables by `owner_id`.
- No analytics or third-party scripts are added.

## 10. Phases

**Phase 1 — Circles and shared to-dos**
Schema, `/circles`, `/task-lists`, `/tasks`, Together page with To-dos tab, scope
switcher, calendar merge for tasks.
Done when: two accounts in one circle see each other's adds, edits, and check-offs
within one poll. Together requires sign-in, the same as Kniggurs; the existing
signed-out app keeps working without it.

*Shipped in this phase:*

- Tables `knomad_circles`, `knomad_circle_members`, `knomad_task_lists`, `knomad_tasks`,
  with a `knomad_bump_version()` trigger on every versioned table.
- `/space`, circle create/rename/archive and member add/remove, list create/edit/delete,
  task create/edit/delete, all versioned.
- Together page: `Just me` / circle switcher, To-dos tab, lists, inline title edits,
  due dates, circle assignees, and a local per-user cache (`knomad_space_<userId>`).
- Calendar merge through `scheduleItems()`, per-source filter (`knomad_cal_scope`),
  open-from-calendar, and complete-from-calendar.
- Dashboard Activity counts completed Together tasks and finished books beside added
  applications; Status breakdown adds Together open/done tasks and reading/finished
  books. Settings hides both charts (`knomad_dash_insights`).
- E2E coverage in `scripts/test-services.mjs`.

*Deliberately deferred to Phase 6:* `?since` deltas and tombstones, the offline mutation
queue, the conflict dialog (Phase 1 toasts and reloads the snapshot), Realtime
invalidation, and export. The cache is full-snapshot, not scope-keyed.

**Phase 2 — Projects (shipped)**
`knomad_projects`, the `project_id` task link, `/projects`, milestones, progress bars,
the project detail modal, task-to-project assignment, calendar target chips, and
Dashboard target rows are live. Progress is done milestones over all milestones,
falling back to done tasks over all tasks. Milestone completion is a normal task
write, so another member sees the new progress on the shared 30-second poll.

**Phase 3 — Learning**
Skills, per-member progress, logs, weekly goal, calendar target date.
Done when: a circle skill shows one bar per member and each member can only write their own.

**Phase 4 — Shelf**
Books, shelves, categories, and page progress are live. Reading goals, computed goal
progress, and Dashboard "Reading now" remain.
Done when: a finished book updates the yearly goal immediately and a circle goal shows
per-member contributions.

**Phase 5 — CRM (shipped)**
Contacts, notes, stages, tags, follow-ups, calendar entries, and the Together CRM tab are live.
Contacts are private by default; a circle scope shares them. Logging a note updates
`last_contact_on`; follow-ups appear on the Calendar and Dashboard. Note deletion is
author or circle-owner. Done when: logging a note updates last touch and a follow-up
appears on the Calendar and Dashboard.

**Phase 6 — Hardening**
Realtime invalidation, offline queue replay, conflict dialog, export, tests in
`scripts/test-services.mjs` for every new route, and README updates.

## 11. Tests

Add to `scripts/test-services.mjs`:

- Circle create, add member, non-member gets `403` on read and write.
- Task create in a circle, edit with stale version returns `409` and the current row.
- Personal task is invisible to the other account.
- Task due date appears in `/space` and in the client's `scheduleItems()`.
- Project create, task-to-project move, milestone completion, and project target in
  `/space`; deleting a project leaves its tasks behind.
- A milestone without a project is rejected with `400`.
- Skill progress is per user and a member cannot write another member's row.
- Book moved to `finished` counts in a `books` goal.
- Contact stays private until shared; shared contact is readable by the circle.
- Soft-deleted rows arrive as tombstones in `/space?since=`.

Phase 1's "Together" test covers circle create and member add, a stale edit returning
`409` with the current row, personal-task invisibility, a member completing a shared
task, and archive detaching rows back to their creator. Inaccessible rows currently
return `404` rather than revealing that they exist; the point is covered by the
personal-invisibility check. The project bullets live in that same block; the skill
and reading-goal bullets arrive with their phases.

## 12. Open questions

1. **Circle invites.** Recommend direct add among existing kniggurs (no accept step),
   matching how shared jobs already behave. Confirm.
2. **Circle reading goal.** One shared goal per circle, or one goal per member shown
   side by side? Recommend one shared goal with per-member contribution.
3. **Personal data location.** Recommend server-owned personal rows (same tables,
   `circle_id = null`) so a phone and laptop stay in sync. This differs from
   `knomad_docs`, which is last-write-wins; the new tables use versions everywhere.
4. **CRM sharing default.** Confirmed: private by default with an explicit shared
   scope (`visibility = 'circle'`); contacts and notes are hidden unless the contact
   belongs to the signed-in user's circle or is the owner's personal contact.
5. **Page name.** "Together" is the working label. Alternatives: "Crew", "Shared".
6. **Job sharing scope.** Should job applications become circle-scoped (shared
   tracking), or stay personal with shared leads as today? Recommend keeping
   applications personal and letting circles coordinate around shared tasks,
   projects, learning, and CRM, while the Dashboard and Calendar present jobs and
   Together items with equal weight. Confirm before any job-sharing change.
