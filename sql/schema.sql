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
