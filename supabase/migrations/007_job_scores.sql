-- Run in Supabase SQL Editor (SQL Editor → New query → paste → Run).
-- Hunt v2.5 architecture: scoring data layer.
--
-- Moves scoring outputs out of discovered_jobs into a dedicated job_scores
-- table (one row per scoring event) so score history and model provenance are
-- preserved instead of overwritten on rescore. Adds discovered_jobs_scored,
-- a view that flattens each job together with its most-recent score for the UI.
--
-- This is step 2 of the v2.5 sequence (schema only). It does NOT backfill data
-- (see 008_job_scores_backfill.sql) and does NOT drop the old scoring columns
-- from discovered_jobs (see 009_drop_legacy_score_columns.sql).
--
-- Safe to re-run.

-- ── JOB_SCORES: one row per scoring event ────────────────────────────────────
-- discovered_jobs describes the job; job_scores describes what happened when it
-- was scored. model is a free text string (not an enum) because model versions
-- turn over. scoring_source distinguishes the nightly pipeline from the two
-- Sonnet paths: 'manual' (first score of a manually-triaged job) and 'rescore'
-- (re-scoring an existing job).

create table if not exists job_scores (
  id                 uuid primary key default gen_random_uuid(),
  discovered_job_id  uuid not null references discovered_jobs(id) on delete cascade,
  user_id            uuid not null references auth.users(id)      on delete cascade,
  score              integer check (score between 1 and 10),
  score_reason       text,
  archetype          text,
  comp_ok            text check (comp_ok   in ('yes','no','unknown')),
  ramp_cost          text check (ramp_cost in ('high','low','n/a')),
  model              text not null,
  scoring_source     text not null
                       check (scoring_source in ('nightly','manual','rescore')),
  scored_at          timestamptz not null default now()
);

create index if not exists job_scores_job_scored_idx
  on job_scores (discovered_job_id, scored_at desc);   -- latest-per-job lookup + FK
create index if not exists job_scores_user_idx
  on job_scores (user_id);                             -- RLS predicate

alter table job_scores enable row level security;

drop policy if exists "js own select" on job_scores;
drop policy if exists "js own insert" on job_scores;
drop policy if exists "js own update" on job_scores;
drop policy if exists "js own delete" on job_scores;

create policy "js own select" on job_scores for select using (auth.uid() = user_id);
create policy "js own insert" on job_scores for insert with check (auth.uid() = user_id);
create policy "js own update" on job_scores for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "js own delete" on job_scores for delete using (auth.uid() = user_id);

-- ── VIEW: each job flattened with its most-recent score ──────────────────────
-- Explicit column list (NOT dj.*) on purpose: it omits the five score columns
-- still living on discovered_jobs, so (a) there is no name collision now, and
-- (b) the later column-drop (step 10) won't break this view — it depends only
-- on the columns discovered_jobs keeps.
--
-- security_invoker = true makes the underlying discovered_jobs / job_scores RLS
-- apply as the querying user. Without it the view would run as its owner and
-- bypass RLS entirely (every user would see everyone's rows). Requires PG15+.

create or replace view discovered_jobs_scored
  with (security_invoker = true) as
select
  dj.id, dj.user_id, dj.source, dj.external_id, dj.title, dj.company,
  dj.location, dj.remote, dj.comp, dj.url, dj.jd, dj.posted_at, dj.fetched_at,
  dj.status, dj.created_at, dj.tracked, dj.company_notes, dj.tracker_id,
  dj.entry_source, dj.dismiss_reason,
  s.score, s.score_reason, s.archetype, s.comp_ok, s.ramp_cost,
  s.model as score_model, s.scoring_source, s.scored_at, s.id as score_id
from discovered_jobs dj
left join lateral (
  select * from job_scores js
  where js.discovered_job_id = dj.id
  order by js.scored_at desc, js.id desc
  limit 1
) s on true;

grant select on discovered_jobs_scored to anon, authenticated;
