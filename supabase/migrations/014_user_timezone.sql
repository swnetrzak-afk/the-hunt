-- user_profile.timezone: the owner's IANA timezone ("what day is it for me").
-- Added for The Squirrel's Desk (it lives in this project's `desk` schema and
-- reads this column), but it's a fact about the user, so it lives here.
--
-- Not null, no default: a missing timezone is an error, never a guess.
-- Validated on save against Postgres's own timezone list, so a typo is
-- rejected when it's written instead of breaking date math later.
-- Moving? Update the row — no code change.
--
-- Requires the app's profile save to be an UPDATE (not a whole-row upsert):
-- an upsert's insert row is NOT NULL-checked before the conflict is seen.
-- That change ships in the same PR as this file.
--
-- Safe to re-run.

alter table user_profile add column if not exists timezone text;

update user_profile set timezone = 'America/New_York' where timezone is null;

alter table user_profile alter column timezone set not null;

create or replace function public.user_profile_check_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'unknown timezone: %', coalesce(new.timezone, '<null>');
  end if;
  return new;
end $$;

drop trigger if exists user_profile_check_timezone on user_profile;
create trigger user_profile_check_timezone
  before insert or update of timezone on user_profile
  for each row execute function public.user_profile_check_timezone();
