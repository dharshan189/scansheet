-- ============================================================================
-- ScanSheet - Complete Supabase PostgreSQL Schema, RLS & Admin Setup
-- Non-destructive initialization: Safe for fresh projects and existing databases.
-- Run this entire script in Supabase Dashboard -> SQL Editor.
-- ============================================================================

-- 1. Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================================
-- 2. TABLES & INDEXES
-- ============================================================================

-- 2A. User Profiles (1-to-1 with auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text not null,
  name text,
  picture text,
  role text not null default 'user' check (role in ('user', 'admin')),
  auth_provider text not null default 'email',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Non-destructive column upgrade if profiles table already existed
alter table public.profiles
  add column if not exists auth_provider text not null default 'email';

create index if not exists idx_profiles_user_id on public.profiles (id);
create index if not exists idx_profiles_email on public.profiles (lower(email));
create index if not exists idx_profiles_role on public.profiles (role);

-- 2B. Conversion History (Scoped per user with RLS)
create table if not exists public.conversion_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  original_file_name text not null,
  output_file_name text not null,
  conversion_type text not null default 'table', -- 'table', 'document', 'mixed'
  status text not null default 'completed' check (status in ('processing', 'completed', 'failed')),
  row_count integer not null default 0,
  column_count integer not null default 0,
  source_file_url text,
  output_file_url text,
  document_model jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_conversion_history_user_id on public.conversion_history (user_id);
create index if not exists idx_conversion_history_user_created on public.conversion_history (user_id, created_at desc);
create index if not exists idx_conversion_history_status on public.conversion_history (status);

-- 2C. Uploaded File Metadata
create table if not exists public.file_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  file_name text not null,
  file_type text not null,
  file_size bigint not null default 0,
  storage_path text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_file_uploads_user_id on public.file_uploads (user_id);
create index if not exists idx_file_uploads_user_created on public.file_uploads (user_id, created_at desc);

-- ============================================================================
-- 3. SECURITY HELPERS & USER PROFILE TRIGGER
-- SECURITY DEFINER prevents RLS recursion when checking role membership.
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

create or replace function public.get_my_role()
returns text
language sql
security definer
set search_path = ''
as $$
  select role from public.profiles where id = (select auth.uid());
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, picture, role, auth_provider)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url',
    'user',
    coalesce(new.raw_app_meta_data->>'provider', 'email')
  )
  on conflict (id) do update set
    email = excluded.email,
    name = coalesce(excluded.name, public.profiles.name),
    picture = coalesce(excluded.picture, public.profiles.picture),
    auth_provider = coalesce(excluded.auth_provider, public.profiles.auth_provider),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Non-destructively backfill any existing auth users into public.profiles
insert into public.profiles (id, email, name, picture, role, auth_provider)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)),
  u.raw_user_meta_data->>'avatar_url',
  'user',
  coalesce(u.raw_app_meta_data->>'provider', 'email')
from auth.users u
on conflict (id) do nothing;

-- ============================================================================
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- Wraps auth.uid() & role helpers in SELECT for single-evaluation caching.
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

alter table public.conversion_history enable row level security;
alter table public.conversion_history force row level security;

alter table public.file_uploads enable row level security;
alter table public.file_uploads force row level security;

-- Profiles Policies
drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check (
    (select auth.uid()) = id
    and role = (select public.get_my_role())
  );

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles
  for select
  to authenticated
  using ((select public.is_admin()));

-- Conversion History Policies
drop policy if exists "Users can view own conversion history" on public.conversion_history;
create policy "Users can view own conversion history"
  on public.conversion_history
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own conversion history" on public.conversion_history;
create policy "Users can insert own conversion history"
  on public.conversion_history
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own conversion history" on public.conversion_history;
create policy "Users can update own conversion history"
  on public.conversion_history
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own conversion history" on public.conversion_history;
create policy "Users can delete own conversion history"
  on public.conversion_history
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Admins can view all conversion history" on public.conversion_history;
create policy "Admins can view all conversion history"
  on public.conversion_history
  for select
  to authenticated
  using ((select public.is_admin()));

-- File Uploads Policies
drop policy if exists "Users can view own uploads" on public.file_uploads;
create policy "Users can view own uploads"
  on public.file_uploads
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own uploads" on public.file_uploads;
create policy "Users can insert own uploads"
  on public.file_uploads
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own uploads" on public.file_uploads;
create policy "Users can update own uploads"
  on public.file_uploads
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own uploads" on public.file_uploads;
create policy "Users can delete own uploads"
  on public.file_uploads
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Admins can view all uploads" on public.file_uploads;
create policy "Admins can view all uploads"
  on public.file_uploads
  for select
  to authenticated
  using ((select public.is_admin()));

-- ============================================================================
-- 5. SUPABASE STORAGE BUCKETS & ISOLATION POLICIES
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values 
      ('scansheet-uploads', 'scansheet-uploads', false),
      ('scansheet-exports', 'scansheet-exports', false)
    on conflict (id) do nothing;
  end if;
end $$;

drop policy if exists "Users can read own storage files" on storage.objects;
create policy "Users can read own storage files"
  on storage.objects for select
  to authenticated
  using (bucket_id in ('scansheet-uploads', 'scansheet-exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can upload own storage files" on storage.objects;
create policy "Users can upload own storage files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id in ('scansheet-uploads', 'scansheet-exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users can delete own storage files" on storage.objects;
create policy "Users can delete own storage files"
  on storage.objects for delete
  to authenticated
  using (bucket_id in ('scansheet-uploads', 'scansheet-exports') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============================================================================
-- 6. SUPABASE REALTIME PUBLICATION (ADMIN LIVE USER & METRICS SYNC)
-- Respects RLS policies: only admins matching is_admin() receive all rows.
-- ============================================================================
alter table public.profiles replica identity full;
alter table public.conversion_history replica identity full;

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
