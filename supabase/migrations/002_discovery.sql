-- Run this in Supabase SQL Editor (SQL Editor → New query → paste → Run)
-- Adds the discovery pipeline tables to the existing job tracker schema.

-- ── DISCOVERED JOBS ──────────────────────────────────────────────────────────
-- Raw pulls from job board APIs. Scored against user profile.
-- Separate from `jobs` (which tracks actual applications).

create table if not exists discovered_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  source          text not null,        -- 'adzuna', 'remotive'
  external_id     text not null,        -- source's own ID for dedup
  title           text not null,
  company         text not null,
  location        text,
  remote          text,                 -- 'Remote', 'Hybrid', 'On-site', ''
  comp            text,                 -- salary as listed, null if not stated
  url             text,
  jd              text,                 -- full job description (stripped HTML)
  posted_at       date,
  fetched_at      timestamptz not null default now(),
  score           integer check (score between 1 and 10),
  score_reason    text,
  archetype       text,
  comp_ok         text check (comp_ok in ('yes', 'no', 'unknown')),
  status          text not null default 'new'
                    check (status in ('new', 'saved', 'dismissed')),
  created_at      timestamptz not null default now(),
  unique (source, external_id)
);

create index if not exists discovered_jobs_user_idx    on discovered_jobs (user_id);
create index if not exists discovered_jobs_status_idx  on discovered_jobs (user_id, status);
create index if not exists discovered_jobs_score_idx   on discovered_jobs (user_id, score desc);
create index if not exists discovered_jobs_posted_idx  on discovered_jobs (user_id, posted_at desc);

alter table discovered_jobs enable row level security;

drop policy if exists "disc own select" on discovered_jobs;
drop policy if exists "disc own insert" on discovered_jobs;
drop policy if exists "disc own update" on discovered_jobs;
drop policy if exists "disc own delete" on discovered_jobs;

create policy "disc own select" on discovered_jobs for select using (auth.uid() = user_id);
create policy "disc own insert" on discovered_jobs for insert with check (auth.uid() = user_id);
create policy "disc own update" on discovered_jobs for update using (auth.uid() = user_id);
create policy "disc own delete" on discovered_jobs for delete using (auth.uid() = user_id);

-- ── USER PROFILE ─────────────────────────────────────────────────────────────
-- One row per user. Stores the scoring profile text and search keywords.

create table if not exists user_profile (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade unique,
  profile_text     text not null default '',
  search_keywords  jsonb not null default '["AI Product Manager","Technical Product Manager","Platform Product Manager","Data Product Manager","Product Operations Manager","Senior Product Manager"]'::jsonb,
  updated_at       timestamptz not null default now()
);

alter table user_profile enable row level security;

drop policy if exists "profile own select" on user_profile;
drop policy if exists "profile own insert" on user_profile;
drop policy if exists "profile own update" on user_profile;

create policy "profile own select" on user_profile for select using (auth.uid() = user_id);
create policy "profile own insert" on user_profile for insert with check (auth.uid() = user_id);
create policy "profile own update" on user_profile for update using (auth.uid() = user_id);

drop trigger if exists user_profile_set_updated_at on user_profile;
create trigger user_profile_set_updated_at before update on user_profile
  for each row execute function set_updated_at();
