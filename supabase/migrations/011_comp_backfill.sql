-- Run in Supabase SQL Editor AFTER 010_comp_normalization.sql, and after setting a comp
-- floor in Settings. One-time, best-effort backfill of numeric comp bounds for
-- rows that predate the ingest capture, plus a recompute of comp_ok from those
-- bounds. Going forward, bounds are captured at ingest and comp_ok in code.
--
-- Best-effort: only the regular "$XK–$YK" and "up to $YK" annual formats are
-- parsed (the bulk). Rows with per-unit suffixes ("$50/hour", "$15K/month") or
-- other shapes are left null → comp_ok 'unknown'; they self-correct when the
-- source re-serves them. Idempotent (guards on comp_min/comp_max is null).

-- 1. "$XK–$YK" ranges → numeric bounds (K = ×1000; dash is en-dash or hyphen)
update discovered_jobs
set comp_min = (regexp_match(comp, '^\$([0-9]+)K'))[1]::int * 1000,
    comp_max = (regexp_match(comp, '[–-]\$([0-9]+)K$'))[1]::int * 1000
where comp ~ '^\$[0-9]+K[–-]\$[0-9]+K$'
  and comp_min is null and comp_max is null;

-- 2. "up to $YK" → max only
update discovered_jobs
set comp_max = (regexp_match(comp, '\$([0-9]+)K'))[1]::int * 1000
where comp ~ '^up to \$[0-9]+K$'
  and comp_min is null and comp_max is null;

-- 3. Recompute comp_ok on every job_scores row from the bounds + the floor.
--    comp_ok is now a deterministic property of (job comp, floor), uniform
--    across a job's scoring events, so all rows are set consistently.
update job_scores js
set comp_ok = case
    when f.f is null then 'unknown'
    when dj.comp_max is not null then (case when dj.comp_max >= f.f then 'yes' else 'no' end)
    when dj.comp_min is not null then (case when dj.comp_min >= f.f then 'yes' else 'unknown' end)
    else 'unknown' end
from discovered_jobs dj, (select comp_floor as f from user_profile limit 1) f
where js.discovered_job_id = dj.id;
