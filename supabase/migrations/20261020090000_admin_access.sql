-- Admin panel (/admin): logged-in team members on the admins allowlist can read and edit the data.
-- Everyone else (anon key, or a logged-in user who is not on the list) sees nothing.
-- The booking API keeps using the secret key and is not affected.

create table public.admins (
  email text primary key check (email = lower(email)),
  name text,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- true when the logged-in user's email is on the allowlist
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- the public anon key never needs these tables
revoke all on public.admins, public.speakers, public.submissions, public.meeting_requests from anon;

create policy "admins can read the team list" on public.admins
  for select to authenticated using ((select public.is_admin()));

create policy "admins can read speakers" on public.speakers
  for select to authenticated using ((select public.is_admin()));
create policy "admins can add speakers" on public.speakers
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can edit speakers" on public.speakers
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete speakers" on public.speakers
  for delete to authenticated using ((select public.is_admin())); -- blocked by FK while a speaker has requests

create policy "admins can read submissions" on public.submissions
  for select to authenticated using ((select public.is_admin()));
create policy "admins can edit submissions" on public.submissions
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete submissions" on public.submissions
  for delete to authenticated using ((select public.is_admin()));

create policy "admins can read requests" on public.meeting_requests
  for select to authenticated using ((select public.is_admin()));
create policy "admins can add requests" on public.meeting_requests
  for insert to authenticated with check ((select public.is_admin()));
create policy "admins can edit requests" on public.meeting_requests
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins can delete requests" on public.meeting_requests
  for delete to authenticated using ((select public.is_admin()));

-- the view runs with the caller's rights, so the policies above decide what it returns
grant select on public.speaker_availability to authenticated;

-- live updates in the panel (Realtime respects the same policies)
alter publication supabase_realtime add table public.speakers, public.submissions, public.meeting_requests;
