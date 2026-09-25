-- Run in Supabase SQL Editor (SQL Editor → New query → paste → Run).
-- Hunt v2 architecture: schema layer.
--
-- Adds to discovered_jobs:
--   tracker_id     — FK link to the tracker `jobs` row this discovery became
--   ramp_cost      — domain-fit signal from the restructured scoring prompt
--   entry_source   — distinguishes nightly-pipeline rows from manual-triage rows
--
-- Creates company_scans for the manual triage flow (reusable lookup).
--
-- Safe to re-run.

-- ── DISCOVERED_JOBS: new columns ─────────────────────────────────────────────

alter table discovered_jobs
  add column if not exists tracker_id uuid
    references jobs(id) on delete set null,
  add column if not exists ramp_cost text
    check (ramp_cost in ('high','low','n/a') or ramp_cost is null),
  add column if not exists entry_source text not null default 'pipeline'
    check (entry_source in ('pipeline','manual'));

create index if not exists discovered_jobs_tracker_idx
  on discovered_jobs (tracker_id)
  where tracker_id is not null;

create index if not exists discovered_jobs_entry_source_idx
  on discovered_jobs (user_id, entry_source);

-- ── COMPANY_SCANS: new table ─────────────────────────────────────────────────
-- One row per company quick scan. Reusable lookup — stage 1 of manual triage
-- checks this table before calling the API. Case-insensitive unique on company
-- name per user so "Acme" and "acme" hit the same cache row.

create table if not exists company_scans (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  company_name         text not null,
  verdict              text not null
                         check (verdict in ('thumbs_up','thumbs_down')),
  bottom_line          text,
  proceeded_to_score   boolean not null default false,
  created_at           timestamptz not null default now()
);

create unique index if not exists company_scans_user_company_uniq
  on company_scans (user_id, lower(company_name));

create index if not exists company_scans_user_created_idx
  on company_scans (user_id, created_at desc);

alter table company_scans enable row level security;

drop policy if exists "cs own select" on company_scans;
drop policy if exists "cs own insert" on company_scans;
drop policy if exists "cs own update" on company_scans;
drop policy if exists "cs own delete" on company_scans;

create policy "cs own select" on company_scans for select using (auth.uid() = user_id);
create policy "cs own insert" on company_scans for insert with check (auth.uid() = user_id);
create policy "cs own update" on company_scans for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cs own delete" on company_scans for delete using (auth.uid() = user_id);
