-- Run this once in the Supabase SQL editor (SQL Editor → New query → paste → Run).

create table if not exists jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title             text not null,
  company           text not null,
  status            text not null default 'applied'
                      check (status in ('applied','interviewing','rejected','declined','lost')),
  remote            text,
  comp              text,
  contact           text,
  url               text,
  notes             text,
  summary           text,
  requirements      text,
  jd                text,
  date_applied      date,
  last_status_date  date,
  status_history    jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists jobs_user_id_idx        on jobs (user_id);
create index if not exists jobs_user_status_idx    on jobs (user_id, status);
create index if not exists jobs_user_created_idx   on jobs (user_id, created_at desc);

-- Row Level Security: each user can only see/touch their own rows.
alter table jobs enable row level security;

drop policy if exists "own rows select" on jobs;
drop policy if exists "own rows insert" on jobs;
drop policy if exists "own rows update" on jobs;
drop policy if exists "own rows delete" on jobs;

create policy "own rows select" on jobs for select using (auth.uid() = user_id);
create policy "own rows insert" on jobs for insert with check (auth.uid() = user_id);
create policy "own rows update" on jobs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows delete" on jobs for delete using (auth.uid() = user_id);

-- Keep updated_at fresh on every row update.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_set_updated_at on jobs;
create trigger jobs_set_updated_at before update on jobs
  for each row execute function set_updated_at();
