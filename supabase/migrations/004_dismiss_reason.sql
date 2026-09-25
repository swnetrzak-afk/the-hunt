-- Run in Supabase SQL Editor. Adds dismiss_reason column to discovered_jobs.
-- The reason is captured when a user dismisses a job from the Discover tab,
-- enabling later Claude-assisted review of dismissed roles for profile tuning.

alter table discovered_jobs
  add column if not exists dismiss_reason text
    check (dismiss_reason in (
      'location',
      'skills-gap',
      'wrong-archetype',
      'comp',
      'culture-signal',
      'expired-listing',
      'not-actually-remote',
      'other'
    ) or dismiss_reason is null);

create index if not exists discovered_jobs_dismiss_idx
  on discovered_jobs (user_id, status, dismiss_reason)
  where status = 'dismissed';
