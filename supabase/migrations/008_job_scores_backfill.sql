-- Run in Supabase SQL Editor AFTER 007_job_scores.sql.
-- Hunt v2.5 architecture: step 3 — backfill existing scores into job_scores.
--
-- Copies every already-scored discovered_jobs row into job_scores as one
-- historical scoring event. Defaults, per the v2.5 decision record:
--   pipeline rows -> scoring_source 'nightly', model 'claude-haiku-4-5'
--   manual rows   -> scoring_source 'manual',  model 'claude-sonnet-4-6'
--   scored_at     -> fetched_at (best available approximation of scoring time)
--
-- Known limitation: the ~20-25 pipeline rows that were rescored (Sonnet) before
-- v2.5 cannot be distinguished from nightly Haiku scores in the historical data,
-- so they are labeled 'nightly'/'claude-haiku-4-5' like the rest. Provenance is
-- correct going forward; the history is approximate. (As of backfill time there
-- are zero 'manual' rows, so the manual branch is a no-op today — kept for
-- correctness if any manual row is added before this runs.)
--
-- Idempotent: the NOT EXISTS guard means re-running never double-inserts.

insert into job_scores
  (discovered_job_id, user_id, score, score_reason, archetype,
   comp_ok, ramp_cost, model, scoring_source, scored_at)
select
  dj.id, dj.user_id, dj.score, dj.score_reason, dj.archetype,
  dj.comp_ok, dj.ramp_cost,
  case when dj.entry_source = 'manual' then 'claude-sonnet-4-6'
       else 'claude-haiku-4-5' end,
  case when dj.entry_source = 'manual' then 'manual'
       else 'nightly' end,
  dj.fetched_at
from discovered_jobs dj
where dj.score is not null
  and not exists (
    select 1 from job_scores js where js.discovered_job_id = dj.id
  );

-- ── Verification (step 4 gate) ───────────────────────────────────────────────
-- Row counts should match: scored discovered_jobs == job_scores rows.
select
  (select count(*) from discovered_jobs where score is not null) as scored_jobs,
  (select count(*) from job_scores)                              as job_scores_rows,
  (select count(*) from job_scores where scoring_source = 'nightly') as nightly_rows,
  (select count(*) from job_scores where scoring_source = 'manual')  as manual_rows;
