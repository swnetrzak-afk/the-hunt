-- The Hunt v2.6.1 — duplicate review. Optional maintenance query, not a migration;
-- originally run after a one-off backfill that recovered real company names.
-- Read-only. Surfaces JSearch rows that now share a normalized (company + title)
-- key — i.e. the cross-board duplicates the backfill exposed. Review each group
-- and delete the losers by hand (keep the one that's scored / saved / newest).
--
-- The normalization mirrors roleKey() in netlify/functions/lib/run-fetch.js exactly:
--   lower → collapse whitespace → strip everything but [a-z0-9 ] → trim.

with keyed as (
  select
    id, company, title, status, tracker_id, posted_at, fetched_at,
    trim(regexp_replace(regexp_replace(lower(coalesce(company,'')), '\s+', ' ', 'g'), '[^a-z0-9 ]', '', 'g'))
      || '|' ||
    trim(regexp_replace(regexp_replace(lower(coalesce(title,'')),   '\s+', ' ', 'g'), '[^a-z0-9 ]', '', 'g'))
      as role_key
  from discovered_jobs
  where source = 'jsearch'
),
dups as (
  select role_key from keyed group by role_key having count(*) > 1
)
select
  k.role_key,
  count(*) over (partition by k.role_key) as group_size,
  k.id, k.company, k.title, k.status, k.tracker_id, k.posted_at, k.fetched_at
from keyed k
join dups d on d.role_key = k.role_key
order by k.role_key, k.fetched_at desc;

-- To remove a specific loser once reviewed (example — never run blind):
--   delete from discovered_jobs where id = '<uuid-of-the-row-to-drop>';
-- Note: deleting a discovered_jobs row cascades to its job_scores rows. Prefer
-- keeping any row where status <> 'new' (already saved/dismissed) or tracker_id is set.
