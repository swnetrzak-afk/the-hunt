-- Run in Supabase SQL Editor after 005_triage_company_scans.sql.
-- Pre-populates company_scans with all enabled tracked_companies as
-- pre-vetted thumbs_up entries — they were already curated when added to
-- the tracked list, so the manual triage flow should skip the API call
-- entirely on cache hit.
--
-- Re-runnable: NOT EXISTS guard prevents duplicate inserts.

insert into company_scans (user_id, company_name, verdict, bottom_line, proceeded_to_score)
select
  tc.user_id,
  tc.name,
  'thumbs_up',
  'Tracked company — pre-vetted at portfolio setup.' ||
    case when coalesce(tc.notes, '') <> '' then ' ' || tc.notes else '' end,
  false
from tracked_companies tc
where tc.enabled = true
  and not exists (
    select 1
    from company_scans cs
    where cs.user_id = tc.user_id
      and lower(cs.company_name) = lower(tc.name)
  );
