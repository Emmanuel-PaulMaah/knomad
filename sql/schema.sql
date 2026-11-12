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
