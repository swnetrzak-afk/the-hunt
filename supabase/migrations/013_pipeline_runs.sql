-- pipeline_runs: one row per fetch run (manual "Fetch now" or nightly).
-- Powers the client's "run complete" signal (poll status → toast + auto-refresh)
-- and is the foundation for v3 run logging (history beyond Netlify log retention).
--
-- Written server-side only (service key bypasses RLS); the client just SELECTs
-- its own rows to know when a run finished.

create table if not exists pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  trigger      text not null default 'manual',    -- 'manual' | 'nightly'
  status       text not null default 'running',   -- 'running' | 'done' | 'error'
  summary      jsonb,                             -- { inserted, scored, skipped, errors }
  detail       text,                              -- optional note (e.g. 'profile empty', error msg)
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists pipeline_runs_user_started_idx
  on pipeline_runs (user_id, started_at desc);

alter table pipeline_runs enable row level security;

-- The client reads its own runs; all writes are server-side via the service key.
drop policy if exists "pr own select" on pipeline_runs;
create policy "pr own select" on pipeline_runs for select using (auth.uid() = user_id);
