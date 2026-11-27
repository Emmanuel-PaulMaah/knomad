-- knomad cloud sync schema
-- Applied with: npm run db:setup  (uses DATABASE_URL_UNPOOLED from .env.local)
--
-- One row per document:
--   profile      -> one row, doc_id = 'me'
--   application  -> one row per application, doc_id = application.id
--
-- Last write wins on client_updated_at. Deletions are soft so they propagate
-- to other devices. Row-level security stays OFF: Realtime rejects live
-- queries over RLS tables, and every read/write goes through the Function,
-- which scopes each query by the verified JWT subject.

create table if not exists public.knomad_docs (
  user_id           text        not null,
  kind              text        not null check (kind in ('profile', 'application')),
  doc_id            text        not null,
  payload           jsonb       not null default '{}'::jsonb,
  client_updated_at bigint      not null,
  server_updated_at timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, kind, doc_id)
);

create index if not exists knomad_docs_pull_idx
  on public.knomad_docs (user_id, server_updated_at);

-- Keep updated_at moving even when a later device sends the same timestamp.
create or replace function public.knomad_touch_doc()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at = now();
  return new;
end;
$$;

drop trigger if exists knomad_touch_doc on public.knomad_docs;

create trigger knomad_touch_doc
  before update on public.knomad_docs
  for each row
  execute function public.knomad_touch_doc();

-- ---------------------------------------------------------------------------
-- Friends and the shared job inbox.
--
-- These tables are server-owned: the browser only reaches them through the
-- Function, which scopes every query by the verified JWT subject. Account
-- names and emails come from neon_auth.user; profile headlines come from the
-- person's own synced profile document.
-- ---------------------------------------------------------------------------

create table if not exists public.knomad_friend_requests (
  id           uuid        primary key default gen_random_uuid(),
  from_user    text        not null,
  to_user      text        not null,
  status       text        not null default 'pending'
                           check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint knomad_friend_requests_distinct check (from_user <> to_user)
);

-- At most one open request per pair, in either direction.
create unique index if not exists knomad_friend_requests_pending_pair_idx
  on public.knomad_friend_requests (least(from_user, to_user), greatest(from_user, to_user))
  where status = 'pending';

create index if not exists knomad_friend_requests_inbox_idx
  on public.knomad_friend_requests (to_user, status, created_at desc);

create index if not exists knomad_friend_requests_outbox_idx
  on public.knomad_friend_requests (from_user, status, created_at desc);

create table if not exists public.knomad_friendships (
  user_a     text        not null,
  user_b     text        not null,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  constraint knomad_friendships_ordered check (user_a < user_b)
);

create index if not exists knomad_friendships_b_idx
  on public.knomad_friendships (user_b);

-- Presence is a single heartbeat row per signed-in user. The browser touches it
-- on the normal social poll; friends are shown online while the row is fresh.
-- Old rows are harmless and get overwritten the next time that person signs in.
create table if not exists public.knomad_presence (
  user_id      text        primary key,
  last_seen_at timestamptz not null default now()
);

create table if not exists public.knomad_shares (
  id              uuid        primary key default gen_random_uuid(),
  from_user       text        not null,
  to_user         text        not null,
  company         text        not null default '',
  position        text        not null default '',
  url             text        not null default '',
  note            text        not null default '',
  job_description text        not null default '',
  status          text        not null default 'inbox'
                              check (status in ('inbox', 'saved', 'dismissed')),
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  constraint knomad_shares_distinct check (from_user <> to_user)
);

create index if not exists knomad_shares_inbox_idx
  on public.knomad_shares (to_user, created_at desc);

create index if not exists knomad_shares_sent_idx
  on public.knomad_shares (from_user, created_at desc);

-- Replies under a shared job. Both the sender and the recipient can post; a
-- message is unread for the other person until they open the thread.
create table if not exists public.knomad_share_messages (
  id         uuid        primary key default gen_random_uuid(),
  share_id   uuid        not null references public.knomad_shares(id) on delete cascade,
  author_id  text        not null,
  body       text        not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists knomad_share_messages_thread_idx
  on public.knomad_share_messages (share_id, created_at);

create index if not exists knomad_share_messages_unread_idx
  on public.knomad_share_messages (share_id, read_at);

-- ---------------------------------------------------------------------------
-- Together: circles, shared to-do lists, and shared tasks.
--
-- Personal rows have circle_id = null and owner_id = the signed-in user.
-- Circle rows carry circle_id and are readable by every member. Every write
-- is scoped by the Function, the same way friends and shares are.
--
-- version is the optimistic-concurrency token: the client sends the version it
-- last saw, the update only applies when it still matches, and knomad_bump_version
-- increments it. updated_at also moves, which is what pulls return.
-- ---------------------------------------------------------------------------

create or replace function public.knomad_bump_version()
returns trigger
language plpgsql
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create table if not exists public.knomad_circles (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   text        not null,
  name       text        not null,
  color      text        not null default 'accent',
  version    integer     not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists knomad_circles_owner_name_idx
  on public.knomad_circles (owner_id, lower(name))
  where deleted_at is null;

create index if not exists knomad_circles_owner_idx
  on public.knomad_circles (owner_id, updated_at desc);

create table if not exists public.knomad_circle_members (
  circle_id uuid        not null references public.knomad_circles(id) on delete cascade,
  user_id   text        not null,
  role      text        not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);

create index if not exists knomad_circle_members_user_idx
  on public.knomad_circle_members (user_id);

create table if not exists public.knomad_task_lists (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   text        not null,
  circle_id  uuid        references public.knomad_circles(id) on delete set null,
  name       text        not null,
  color      text        not null default 'accent',
  position   integer     not null default 0,
  version    integer     not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists knomad_task_lists_owner_idx
  on public.knomad_task_lists (owner_id, updated_at desc);

create index if not exists knomad_task_lists_circle_idx
  on public.knomad_task_lists (circle_id, updated_at desc);

-- Projects group tasks around one outcome. A project has a status, a target
-- date, and optional milestones (tasks with project_id + is_milestone).
create table if not exists public.knomad_projects (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   text        not null,
  circle_id  uuid        references public.knomad_circles(id) on delete set null,
  name       text        not null,
  summary    text        not null default '',
  status     text        not null default 'active'
             check (status in ('planning', 'active', 'paused', 'done')),
  start_on   date,
  target_on  date,
  color      text        not null default 'accent',
  version    integer     not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists knomad_projects_owner_idx
  on public.knomad_projects (owner_id, updated_at desc);

create index if not exists knomad_projects_circle_idx
  on public.knomad_projects (circle_id, updated_at desc);

create table if not exists public.knomad_tasks (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       text        not null,
  circle_id      uuid        references public.knomad_circles(id) on delete set null,
  list_id        uuid        references public.knomad_task_lists(id) on delete set null,
  project_id     uuid        references public.knomad_projects(id) on delete set null,
  application_id text,
  title          text        not null,
  notes          text        not null default '',
  status         text        not null default 'open'
                             check (status in ('open', 'doing', 'done')),
  priority       text        not null default 'normal'
                             check (priority in ('low', 'normal', 'high')),
  assignee_id    text,
  due_at         timestamptz,
  due_all_day    boolean     not null default false,
  is_milestone   boolean     not null default false,
  position       integer     not null default 0,
  completed_at   timestamptz,
  completed_by   text,
  version        integer     not null default 1,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists knomad_tasks_owner_idx
  on public.knomad_tasks (owner_id, updated_at desc);

create index if not exists knomad_tasks_circle_idx
  on public.knomad_tasks (circle_id, updated_at desc);

-- Projects came after tasks, so existing databases add the link in place.
alter table public.knomad_tasks
  add column if not exists project_id uuid references public.knomad_projects(id) on delete set null;

alter table public.knomad_tasks
  add column if not exists is_milestone boolean not null default false;

create index if not exists knomad_tasks_list_idx
  on public.knomad_tasks (list_id, position, created_at);

create index if not exists knomad_tasks_project_idx
  on public.knomad_tasks (project_id, position, created_at)
  where project_id is not null and deleted_at is null;

create index if not exists knomad_tasks_due_idx
  on public.knomad_tasks (due_at)
  where due_at is not null and deleted_at is null;

-- The shared shelf: books move between four shelves and carry page progress.
-- A finished book is stamped on the server so a goal count can be computed.
create table if not exists public.knomad_books (
  id          uuid        primary key default gen_random_uuid(),
  owner_id    text        not null,
  circle_id   uuid        references public.knomad_circles(id) on delete set null,
  title       text        not null,
  author      text        not null default '',
  category    text        not null default 'General',
  shelf       text        not null default 'want'
              check (shelf in ('want', 'reading', 'finished', 'paused')),
  pages_total integer     not null default 0 check (pages_total >= 0),
  pages_read  integer     not null default 0 check (pages_read >= 0),
  rating      integer     check (rating between 1 and 5),
  started_on  date,
  finished_on date,
  cover_url   text        not null default '',
  link_url    text        not null default '',
  notes       text        not null default '',
  version     integer     not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Databases created before the link field need it added in place.
alter table public.knomad_books
  add column if not exists link_url text not null default '';

create index if not exists knomad_books_owner_idx
  on public.knomad_books (owner_id, updated_at desc);

create index if not exists knomad_books_circle_idx
  on public.knomad_books (circle_id, updated_at desc);

drop trigger if exists knomad_books_touch on public.knomad_books;
create trigger knomad_books_touch
  before update on public.knomad_books
  for each row
  execute function public.knomad_bump_version();

-- Categories are curated per scope: a personal list for one reader, or a
-- circle list the owner maintains so everyone adds books with the same labels.
create table if not exists public.knomad_shelf_categories (
  id         uuid        primary key default gen_random_uuid(),
  owner_id   text        not null,
  circle_id  uuid        references public.knomad_circles(id) on delete set null,
  name       text        not null,
  position   integer     not null default 0,
  version    integer     not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists knomad_shelf_categories_circle_name_idx
  on public.knomad_shelf_categories (circle_id, lower(name))
  where circle_id is not null and deleted_at is null;

create unique index if not exists knomad_shelf_categories_owner_name_idx
  on public.knomad_shelf_categories (owner_id, lower(name))
  where circle_id is null and deleted_at is null;

drop trigger if exists knomad_shelf_categories_touch on public.knomad_shelf_categories;
create trigger knomad_shelf_categories_touch
  before update on public.knomad_shelf_categories
  for each row
  execute function public.knomad_bump_version();

-- The light CRM: business contacts and their interaction timeline.
-- Contacts are private unless they carry a circle_id, and visibility always
-- agrees with that column so a private row can never leak a circle id.
create table if not exists public.knomad_contacts (
  id               uuid        primary key default gen_random_uuid(),
  owner_id         text        not null,
  visibility       text        not null default 'private'
                   check (visibility in ('private', 'circle')),
  circle_id        uuid        references public.knomad_circles(id) on delete set null,
  linked_user_id   text,
  name             text        not null,
  company          text        not null default '',
  role             text        not null default '',
  email            text        not null default '',
  phone            text        not null default '',
  url              text        not null default '',
  source           text        not null default '',
  stage            text        not null default 'lead'
                   check (stage in ('lead', 'talking', 'active', 'dormant')),
  tags             text[]      not null default '{}',
  last_contact_on  date,
  next_follow_up_on date,
  notes            text        not null default '',
  version          integer     not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint knomad_contacts_circle check (
    (visibility = 'private' and circle_id is null) or
    (visibility = 'circle' and circle_id is not null)
  )
);

create index if not exists knomad_contacts_owner_idx
  on public.knomad_contacts (owner_id, updated_at desc);

create index if not exists knomad_contacts_circle_idx
  on public.knomad_contacts (circle_id, updated_at desc);

create index if not exists knomad_contacts_follow_up_idx
  on public.knomad_contacts (next_follow_up_on)
  where next_follow_up_on is not null and deleted_at is null;

drop trigger if exists knomad_contacts_touch on public.knomad_contacts;
create trigger knomad_contacts_touch
  before update on public.knomad_contacts
  for each row
  execute function public.knomad_bump_version();

-- Notes are the contact timeline. A note belongs to the contact, so access is
-- inherited from it; there is no separate circle_id here.
create table if not exists public.knomad_contact_notes (
  id          uuid        primary key default gen_random_uuid(),
  contact_id  uuid        not null references public.knomad_contacts(id) on delete cascade,
  author_id   text        not null,
  body        text        not null,
  happened_on date        not null default current_date,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists knomad_contact_notes_contact_idx
  on public.knomad_contact_notes (contact_id, happened_on desc, created_at desc);

create index if not exists knomad_contact_notes_author_idx
  on public.knomad_contact_notes (author_id, created_at desc);

drop trigger if exists knomad_circles_touch on public.knomad_circles;
create trigger knomad_circles_touch
  before update on public.knomad_circles
  for each row
  execute function public.knomad_bump_version();

drop trigger if exists knomad_task_lists_touch on public.knomad_task_lists;
create trigger knomad_task_lists_touch
  before update on public.knomad_task_lists
  for each row
  execute function public.knomad_bump_version();

drop trigger if exists knomad_tasks_touch on public.knomad_tasks;
create trigger knomad_tasks_touch
  before update on public.knomad_tasks
  for each row
  execute function public.knomad_bump_version();

drop trigger if exists knomad_projects_touch on public.knomad_projects;
create trigger knomad_projects_touch
  before update on public.knomad_projects
  for each row
  execute function public.knomad_bump_version();

-- ---------------------------------------------------------------------------
-- Web Push.
--
-- A browser subscribes once and the Function keeps the credentials, so a
-- reminder, a due task, or an inbox reply can reach Chrome with no tab open.
-- The endpoint is the browser's identity and is unique: signing in on the same
-- browser re-points the row at the current account instead of duplicating it.
--
-- knomad_push_log is the dedupe lock. A notification is claimed with an insert
-- before it is sent, so overlapping cron ticks or a retried delivery cannot
-- send the same reminder twice.
-- ---------------------------------------------------------------------------

create table if not exists public.knomad_push_subscriptions (
  endpoint     text        primary key,
  user_id      text        not null,
  p256dh       text        not null,
  auth         text        not null,
  timezone     text        not null default '',
  user_agent   text        not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists knomad_push_subscriptions_user_idx
  on public.knomad_push_subscriptions (user_id, last_seen_at desc);

create table if not exists public.knomad_push_log (
  user_id    text        not null,
  dedupe_key text        not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, dedupe_key)
);

create index if not exists knomad_push_log_sent_idx
  on public.knomad_push_log (sent_at);
