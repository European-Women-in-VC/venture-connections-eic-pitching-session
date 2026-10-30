-- Names of the applied migrations, so the panel can warn when its code is newer than the database
-- (code deployed before its migration). Names only, for logged-in users.
create function public.applied_migrations()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(name order by version), '{}') from supabase_migrations.schema_migrations;
$$;

revoke execute on function public.applied_migrations() from public, anon;
grant execute on function public.applied_migrations() to authenticated;
