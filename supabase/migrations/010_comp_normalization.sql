-- Run in Supabase SQL Editor. Comp normalization for reliable comp_ok.
--
-- Adds annualized numeric comp bounds to discovered_jobs (captured at ingest)
-- and a structured comp_floor to user_profile, so comp_ok can be computed in
-- code instead of asked of the model — the floor comparison is deterministic
-- arithmetic, which small models (Haiku) get wrong on formatted strings like
-- "$180K–$200K". The human-readable `comp` display string is unchanged.
--
-- Safe to re-run.

-- ── SETTINGS: structured comp floor ──────────────────────────────────────────
alter table user_profile
  add column if not exists comp_floor integer;   -- annual USD; null = no floor set

-- ── DISCOVERED_JOBS: annualized numeric bounds ───────────────────────────────
-- Captured from each source's raw salary fields at ingest (annualized in code).
-- Null where the source gives no structured comp (Ashby summary strings,
-- Greenhouse, manual entries) — those score as comp_ok = 'unknown'.
alter table discovered_jobs
  add column if not exists comp_min integer,
  add column if not exists comp_max integer;

-- ── VIEW: expose the numeric bounds to the UI/rescore ────────────────────────
-- comp_min / comp_max appended at the end so CREATE OR REPLACE only *adds*
-- columns (Postgres forbids reordering/removing existing view columns).
create or replace view discovered_jobs_scored
  with (security_invoker = true) as
select
  dj.id, dj.user_id, dj.source, dj.external_id, dj.title, dj.company,
  dj.location, dj.remote, dj.comp, dj.url, dj.jd, dj.posted_at, dj.fetched_at,
  dj.status, dj.created_at, dj.tracked, dj.company_notes, dj.tracker_id,
  dj.entry_source, dj.dismiss_reason,
  s.score, s.score_reason, s.archetype, s.comp_ok, s.ramp_cost,
  s.model as score_model, s.scoring_source, s.scored_at, s.id as score_id,
  dj.comp_min, dj.comp_max
from discovered_jobs dj
left join lateral (
  select * from job_scores js
  where js.discovered_job_id = dj.id
  order by js.scored_at desc, js.id desc
  limit 1
) s on true;
