-- Optional Postgres schema for sessions + audit (Stage 3+)
create table if not exists sessions (
  thread_id text primary key,
  project_slug text not null,
  session_id text,
  permission_mode text not null default 'default',
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  thread_id text,
  tool text not null,
  input jsonb,
  decision text not null,
  reason text
);

create index if not exists audit_log_thread_idx on audit_log(thread_id, ts desc);
