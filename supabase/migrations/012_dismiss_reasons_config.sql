-- The Hunt v2.6 — UX & configuration layer
-- Run in Supabase SQL Editor. Re-runnable (idempotent).
--
-- 1. Move the dismiss-reason list out of the hardcoded <select> + CHECK constraint
--    into a config column on user_profile. The dropdown reads this at runtime, so
--    adding/removing a reason becomes a Settings change, not a deploy.
-- 2. Drop the CHECK constraint on discovered_jobs.dismiss_reason — the config is
--    now the validation layer.

-- ── 1. dismiss_reasons config on user_profile ───────────────────────────────
-- JSONB array of {value,label}. Seeded with the 8 reasons currently hardcoded in
-- index.html, verbatim, so the live dropdown is unchanged. Adding the column with
-- a default backfills the existing profile row automatically.

alter table user_profile
  add column if not exists dismiss_reasons jsonb not null default '[
    {"value":"location","label":"Location — wrong geography or office requirement"},
    {"value":"not-actually-remote","label":"Not actually remote despite the tag"},
    {"value":"skills-gap","label":"Skills gap — required tech / domain I don''t have"},
    {"value":"wrong-archetype","label":"Wrong archetype — not the kind of PM role I want"},
    {"value":"comp","label":"Comp — below floor or red flag pay"},
    {"value":"culture-signal","label":"Culture signal — Glassdoor, layoffs, alignment theater"},
    {"value":"expired-listing","label":"Expired / ghost listing"},
    {"value":"other","label":"Other"}
  ]'::jsonb;

-- ── 2. Drop the CHECK constraint on discovered_jobs.dismiss_reason ───────────
-- Added inline in 004_dismiss_reason.sql (auto-named discovered_jobs_dismiss_reason_check).
-- Self-verifying: finds whatever CHECK references dismiss_reason and drops it by its
-- real name, so a naming mismatch can't leave the constraint silently in place.
-- Idempotent — a no-op once the constraint is gone. Existing dismissed rows keep their values.

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'discovered_jobs'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%dismiss_reason%';
  if c is not null then
    execute format('alter table discovered_jobs drop constraint %I', c);
  end if;
end $$;
