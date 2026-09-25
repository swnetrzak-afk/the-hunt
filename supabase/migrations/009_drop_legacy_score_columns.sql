-- Run in Supabase SQL Editor — LAST step of Hunt v2.5, step 10.
-- POINT OF NO RETURN. Only run after the new job_scores structure + Discover UI
-- (view read, comparison view, rescore indicator) are confirmed in production.
-- (On a fresh install there's no data to lose — just run it in sequence.)
--
-- Removes the five scoring columns from discovered_jobs now that scoring outputs
-- live in job_scores. All values are already preserved there (backfilled +
-- verified: 1064 scored rows == 1064 job_scores histories), so this drops
-- redundant data, not the only copy.
--
-- Dependencies checked: the discovered_jobs_scored view does NOT reference these
-- columns (it takes score fields from job_scores), so it is unaffected. The one
-- dependent index, discovered_jobs_score_idx (user_id, score DESC), is dropped
-- automatically with the score column.
--
-- Idempotent (drop ... if exists).

alter table discovered_jobs
  drop column if exists score,
  drop column if exists score_reason,
  drop column if exists archetype,
  drop column if exists comp_ok,
  drop column if exists ramp_cost;
