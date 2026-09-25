-- Run this in Supabase SQL Editor after 002_discovery.sql
-- Adds tracked companies list + title filter columns + emoji flag on discovered_jobs.

-- ── TRACKED COMPANIES ────────────────────────────────────────────────────────
-- Curated list of companies whose ATS feeds we pull directly.
-- Provider auto-detected from careers_url pattern, or pinned via `provider`.

create table if not exists tracked_companies (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name         text not null,
  careers_url  text not null,
  provider     text,                -- 'greenhouse' | 'lever' | 'ashby' | null (auto)
  api          text,                -- optional explicit API URL override (greenhouse only)
  notes        text,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists tracked_companies_user_idx     on tracked_companies (user_id);
create index if not exists tracked_companies_enabled_idx  on tracked_companies (user_id, enabled);

alter table tracked_companies enable row level security;

drop policy if exists "tc own select" on tracked_companies;
drop policy if exists "tc own insert" on tracked_companies;
drop policy if exists "tc own update" on tracked_companies;
drop policy if exists "tc own delete" on tracked_companies;

create policy "tc own select" on tracked_companies for select using (auth.uid() = user_id);
create policy "tc own insert" on tracked_companies for insert with check (auth.uid() = user_id);
create policy "tc own update" on tracked_companies for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tc own delete" on tracked_companies for delete using (auth.uid() = user_id);

drop trigger if exists tracked_companies_set_updated_at on tracked_companies;
create trigger tracked_companies_set_updated_at before update on tracked_companies
  for each row execute function set_updated_at();

-- ── USER PROFILE: title filter columns ──────────────────────────────────────

alter table user_profile
  add column if not exists title_filter_positive jsonb not null default '[
    "Product Manager","Senior Product Manager","Staff Product Manager","Principal Product Manager",
    "Director of Product","Director, Product","Head of Product","VP of Product",
    "AI Product","Platform Product","Technical Product","Product Lead","Founding PM","Founding Product",
    "Product Strategy","Product Operations"
  ]'::jsonb,
  add column if not exists title_filter_negative jsonb not null default '[
    "Junior","Associate","Entry","Intern","Internship",
    "Program Manager","Project Manager","Product Marketing","Product Marketing Manager",
    "UX","Designer","Design Lead","Scrum Master","Agile Coach",
    "Software Engineer","Data Engineer","Data Scientist","ML Engineer","DevOps"
  ]'::jsonb;

-- ── DISCOVERED JOBS: tracked-company flag ───────────────────────────────────

alter table discovered_jobs
  add column if not exists tracked boolean not null default false,
  add column if not exists company_notes text;

-- ── SEED (optional): your starter list of tracked companies ─────────────────
-- Add the companies whose ATS job boards you want pulled directly on every run.
-- `provider` is 'greenhouse' | 'lever' | 'ashby' (or null to auto-detect from
-- careers_url). `api` is an optional explicit Greenhouse API URL override.
-- You can skip this block entirely and add companies from Settings in the UI,
-- or use the company-discovery helper to find a company's ATS automatically.
-- Re-runnable: the WHERE NOT EXISTS clause skips names you've already added.

do $$
declare
  uid uuid;
begin
  select user_id into uid from user_profile limit 1;
  if uid is null then
    raise notice 'No user_profile row found — sign in and save your profile once, then re-run this seed block.';
    return;
  end if;

  insert into tracked_companies (user_id, name, careers_url, provider, api, notes, enabled)
  select uid, name, careers_url, provider, api, notes, enabled
  from (values
    -- Replace these example rows with your own targets (one row per company).
    ('Example Co',     'https://job-boards.greenhouse.io/exampleco', 'greenhouse', null::text, 'Why this company is on your list.', true),
    ('Another Example','https://jobs.lever.co/anotherexample',       'lever',      null,       'Notes shown on its discovered jobs.', true)
  ) as v(name, careers_url, provider, api, notes, enabled)
  where not exists (
    select 1 from tracked_companies tc where tc.user_id = uid and tc.name = v.name
  );
end $$;
