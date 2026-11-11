-- ============================================================================
-- ScanSheet - Enable Supabase Realtime Synchronization for Admin Dashboard
-- Idempotent migration: safe to run on existing projects in Supabase SQL Editor.
-- Configures supabase_realtime publication, replica identity, and profile backfill
-- while preserving strict Row Level Security (RLS) so ordinary users never
-- receive other users' rows or realtime events.
-- ============================================================================

-- 1. Set FULL replica identity on realtime-synced tables so UPDATE/DELETE events
--    and RLS evaluators always have complete row context.
alter table public.profiles replica identity full;
alter table public.conversion_history replica identity full;

-- 2. Add public.profiles and public.conversion_history to supabase_realtime safely
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'profiles'
    ) then
      execute 'alter publication supabase_realtime add table public.profiles';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'conversion_history'
    ) then
      execute 'alter publication supabase_realtime add table public.conversion_history';
    end if;
  end if;
end $$;

-- 3. Ensure every auth.users row has a 1-to-1 profile row without duplicates
insert into public.profiles (id, email, name, picture, role, auth_provider)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
  coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture'),
  'user',
  coalesce(u.raw_app_meta_data->>'provider', 'email')
from auth.users u
on conflict (id) do nothing;

