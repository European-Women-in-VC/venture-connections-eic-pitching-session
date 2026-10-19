-- Archive instead of delete, record sources (website / team), submission history,
-- repeat submissions join the same investor, team functions, daily backup.

-- ---------------------------------------------------------------------------
-- Sources + archive columns
-- ---------------------------------------------------------------------------
create type public.record_source as enum ('website', 'panel');

alter table public.submissions
  add column source public.record_source not null default 'website',
  add column created_by text,
  add column archived_at timestamptz,
  add column archived_by text;

alter table public.meeting_requests
  add column source public.record_source not null default 'website',
  add column created_by text;

alter table public.speakers
  add column archived_at timestamptz,
  add column archived_by text;

create index submissions_active_email_idx on public.submissions (lower(email)) where archived_at is null;

-- who archived it (taken from the logged-in user, not from the client)
create function public.stamp_archived_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is null then
    new.archived_by = null;
  elsif old.archived_at is null then
    new.archived_by = coalesce(auth.jwt() ->> 'email', new.archived_by);
  end if;
  return new;
end;
$$;
create trigger submissions_archived_by before update of archived_at on public.submissions
  for each row execute function public.stamp_archived_by();
create trigger speakers_archived_by before update of archived_at on public.speakers
  for each row execute function public.stamp_archived_by();

-- ---------------------------------------------------------------------------
-- Submission history: every website submission as sent, plus team additions
-- ---------------------------------------------------------------------------
create table public.submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions (id) on delete cascade,
  booking_id text unique,                        -- website: one per visit (idempotency)
  source public.record_source not null,
  created_by text,                               -- team member email for panel events
  payload jsonb not null default '{}',           -- the form exactly as submitted
  speaker_slugs text[] not null default '{}',    -- picked in this submission, in order
  added_slugs text[] not null default '{}',      -- requests this submission created
  skipped_slugs text[] not null default '{}',    -- already requested before
  created_at timestamptz not null default now()
);
create index submission_events_submission_idx on public.submission_events (submission_id, created_at);
alter table public.submission_events enable row level security;

-- existing submissions become their first history entry
insert into public.submission_events (submission_id, booking_id, source, payload, speaker_slugs, added_slugs, created_at)
select
  s.id,
  s.booking_id,
  'website',
  jsonb_build_object(
    'email', s.email, 'firstName', s.first_name, 'lastName', s.last_name,
    'company', s.company, 'linkedin', s.linkedin, 'speakers', to_jsonb(s.speaker_slugs)
  ) || s.meta,
  s.speaker_slugs,
  s.speaker_slugs,
  s.created_at
from public.submissions s;

-- ---------------------------------------------------------------------------
-- Availability: archived investors free their places, archived speakers are closed
-- ---------------------------------------------------------------------------
create or replace view public.speaker_availability
with (security_invoker = true)
as
select
  sp.id,
  sp.slug,
  sp.name,
  sp.company,
  sp.capacity,
  sp.availability,
  c.used,
  c.confirmed,
  c.waitlisted,
  greatest(sp.capacity - c.used, 0) as remaining,
  case when sp.archived_at is null and sp.availability = 'open' then greatest(sp.capacity - c.used, 0) else 0 end as available,
  case
    when sp.archived_at is not null then 'closed'
    when c.used > sp.capacity then 'over_capacity'
    when sp.availability <> 'open' then sp.availability::text
    when sp.capacity - c.used <= 0 then 'full'
    else 'available'
  end as status
from public.speakers sp
cross join lateral (
  select
    count(*) filter (where public.request_takes_place(mr.status))::integer as used,
    count(*) filter (where mr.status in ('accepted_scheduling', 'scheduled_confirmed'))::integer as confirmed,
    count(*) filter (where mr.status = 'waitlisted')::integer as waitlisted
  from public.meeting_requests mr
  join public.submissions s on s.id = mr.submission_id
  where mr.speaker_id = sp.id and s.archived_at is null
) c;

-- ---------------------------------------------------------------------------
-- Website booking: repeat submissions (same email) join the same investor
-- ---------------------------------------------------------------------------
-- Returns one of:
--   { ok: true,  submission_id, unknown: [...], already: [slugs requested before], repeat: bool }
--   { ok: true,  submission_id, duplicate: true }                 same booking_id sent again
--   { ok: false, error: 'unavailable', unavailable: [slugs] }     nothing saved
create or replace function public.book_meetings(
  p_booking_id text,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_speaker_slugs text[],
  p_company text default null,
  p_linkedin text default null,
  p_meta jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_slugs text[];
  v_submission_id uuid;
  v_repeat boolean := false;
  v_already text[] := '{}';
  v_new text[];
  v_added text[];
  v_unavailable text[];
  v_unknown text[];
  v_rank integer;
begin
  select coalesce(array_agg(slug order by first_pos), '{}')
    into v_slugs
    from (
      select trim(s) as slug, min(pos) as first_pos
      from unnest(p_speaker_slugs) with ordinality as u(s, pos)
      where trim(coalesce(s, '')) <> ''
      group by trim(s)
    ) d;

  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if cardinality(v_slugs) = 0 or cardinality(v_slugs) > 4 then
    raise exception 'invalid_selection' using errcode = '22023';
  end if;

  -- same visit submitted twice (double click, retry) → first result
  if p_booking_id is not null then
    select submission_id into v_submission_id from public.submission_events where booking_id = p_booking_id;
    if found then
      return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'duplicate', true);
    end if;
  end if;

  -- one investor per email: serialise submissions for the same email
  perform pg_advisory_xact_lock(hashtext('book:' || v_email));
  select id into v_submission_id
    from public.submissions
    where lower(email) = v_email and archived_at is null
    order by created_at
    limit 1;
  v_repeat := v_submission_id is not null;

  if v_repeat then
    select coalesce(array_agg(sp.slug), '{}') into v_already
      from public.meeting_requests mr
      join public.speakers sp on sp.id = mr.speaker_id
      where mr.submission_id = v_submission_id and sp.slug = any (v_slugs);
  end if;
  v_new := array(select s from unnest(v_slugs) s where not (s = any (v_already)));

  -- lock and check only the speakers this submission adds
  perform 1 from public.speakers where slug = any (v_new) order by id for update;
  select coalesce(array_agg(sa.slug), '{}') into v_unavailable
    from public.speaker_availability sa
    where sa.slug = any (v_new) and sa.status <> 'available';
  if cardinality(v_unavailable) > 0 then
    return jsonb_build_object('ok', false, 'error', 'unavailable', 'unavailable', to_jsonb(v_unavailable));
  end if;

  v_unknown := array(select s from unnest(v_new) s where not exists (select 1 from public.speakers sp where sp.slug = s));

  if v_repeat then
    -- keep the team's edits; only fill empty fields and record the new picks
    update public.submissions set
      first_name = coalesce(first_name, nullif(trim(p_first_name), '')),
      last_name = coalesce(last_name, nullif(trim(p_last_name), '')),
      company = coalesce(company, nullif(trim(p_company), '')),
      linkedin = coalesce(linkedin, nullif(trim(p_linkedin), '')),
      speaker_slugs = speaker_slugs || array(select s from unnest(v_new) s where not (s = any (speaker_slugs)))
    where id = v_submission_id;
  else
    insert into public.submissions (booking_id, email, first_name, last_name, company, linkedin, speaker_slugs, meta, source)
    values (
      p_booking_id, v_email,
      nullif(trim(p_first_name), ''), nullif(trim(p_last_name), ''),
      nullif(trim(p_company), ''), nullif(trim(p_linkedin), ''),
      v_slugs, coalesce(p_meta, '{}'), 'website'
    )
    returning id into v_submission_id;
  end if;

  select coalesce(max(preference_rank), 0) into v_rank from public.meeting_requests where submission_id = v_submission_id;
  with inserted as (
    insert into public.meeting_requests (submission_id, speaker_id, preference_rank, source)
    select v_submission_id, sp.id, (v_rank + u.pos)::smallint, 'website'
    from unnest(v_new) with ordinality as u(slug, pos)
    join public.speakers sp on sp.slug = u.slug
    returning speaker_id
  )
  select coalesce(array_agg(sp.slug), '{}') into v_added from inserted i join public.speakers sp on sp.id = i.speaker_id;

  insert into public.submission_events (submission_id, booking_id, source, payload, speaker_slugs, added_slugs, skipped_slugs)
  values (
    v_submission_id, p_booking_id, 'website',
    jsonb_build_object(
      'email', p_email, 'firstName', p_first_name, 'lastName', p_last_name,
      'company', p_company, 'linkedin', p_linkedin, 'speakers', to_jsonb(p_speaker_slugs)
    ) || coalesce(p_meta, '{}'),
    v_slugs, v_added, v_already
  );

  return jsonb_build_object(
    'ok', true, 'submission_id', v_submission_id, 'unknown', to_jsonb(v_unknown),
    'already', to_jsonb(v_already), 'repeat', v_repeat
  );
exception
  when unique_violation then
    select submission_id into v_submission_id from public.submission_events where booking_id = p_booking_id;
    return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'duplicate', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Team functions (panel): checked against the admins allowlist
-- ---------------------------------------------------------------------------
-- Adds meeting requests to an investor. Skips speakers they already have. Returns the number added.
create function public.panel_add_requests(
  p_submission_id uuid,
  p_speaker_ids uuid[],
  p_status public.request_status default 'new_request',
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_rank integer;
  v_added text[];
  v_skipped text[];
  v_picked text[];
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.submissions where id = p_submission_id and archived_at is null) then
    raise exception 'investor_not_found' using errcode = '22023';
  end if;

  select coalesce(array_agg(sp.slug order by u.pos), '{}') into v_picked
    from unnest(p_speaker_ids) with ordinality as u(id, pos) join public.speakers sp on sp.id = u.id;
  select coalesce(array_agg(sp.slug), '{}') into v_skipped
    from public.meeting_requests mr join public.speakers sp on sp.id = mr.speaker_id
    where mr.submission_id = p_submission_id and mr.speaker_id = any (p_speaker_ids);

  select coalesce(max(preference_rank), 0) into v_rank from public.meeting_requests where submission_id = p_submission_id;
  with inserted as (
    insert into public.meeting_requests (submission_id, speaker_id, status, preference_rank, source, created_by, internal_notes)
    select p_submission_id, u.id, p_status, (v_rank + row_number() over (order by u.pos))::smallint, 'panel', v_actor, nullif(trim(p_note), '')
    from unnest(p_speaker_ids) with ordinality as u(id, pos)
    where exists (select 1 from public.speakers sp where sp.id = u.id and sp.archived_at is null)
      and not exists (select 1 from public.meeting_requests mr where mr.submission_id = p_submission_id and mr.speaker_id = u.id)
    returning speaker_id
  )
  select coalesce(array_agg(sp.slug), '{}') into v_added from inserted i join public.speakers sp on sp.id = i.speaker_id;

  if cardinality(v_added) > 0 then
    insert into public.submission_events (submission_id, source, created_by, payload, speaker_slugs, added_slugs, skipped_slugs)
    values (p_submission_id, 'panel', v_actor,
            jsonb_build_object('action', 'add_requests', 'status', p_status, 'note', nullif(trim(p_note), '')),
            v_picked, v_added, v_skipped);
  end if;
  return cardinality(v_added);
end;
$$;

-- Creates an investor (and optional requests) from the panel. Returns the new investor id.
create function public.panel_create_investor(
  p_email text,
  p_first_name text default null,
  p_last_name text default null,
  p_company text default null,
  p_linkedin text default null,
  p_notes text default null,
  p_speaker_ids uuid[] default '{}',
  p_status public.request_status default 'new_request'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_email text := lower(trim(p_email));
  v_id uuid;
  v_slugs text[];
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('book:' || v_email));
  if exists (select 1 from public.submissions where lower(email) = v_email and archived_at is null) then
    raise exception 'investor_exists' using errcode = '23505';
  end if;

  select coalesce(array_agg(sp.slug order by u.pos), '{}') into v_slugs
    from unnest(p_speaker_ids) with ordinality as u(id, pos) join public.speakers sp on sp.id = u.id and sp.archived_at is null;

  insert into public.submissions (email, first_name, last_name, company, linkedin, notes, speaker_slugs, source, created_by)
  values (v_email, nullif(trim(p_first_name), ''), nullif(trim(p_last_name), ''), nullif(trim(p_company), ''),
          nullif(trim(p_linkedin), ''), nullif(trim(p_notes), ''), v_slugs, 'panel', v_actor)
  returning id into v_id;

  insert into public.meeting_requests (submission_id, speaker_id, status, preference_rank, source, created_by)
  select v_id, sp.id, p_status, row_number() over (order by u.pos)::smallint, 'panel', v_actor
  from unnest(p_speaker_ids) with ordinality as u(id, pos)
  join public.speakers sp on sp.id = u.id and sp.archived_at is null;

  insert into public.submission_events (submission_id, source, created_by, payload, speaker_slugs, added_slugs)
  values (v_id, 'panel', v_actor,
          jsonb_build_object('action', 'create_investor', 'email', v_email, 'firstName', p_first_name, 'lastName', p_last_name,
                             'company', p_company, 'linkedin', p_linkedin, 'status', p_status),
          v_slugs, v_slugs);
  return v_id;
end;
$$;

revoke execute on function public.panel_add_requests(uuid, uuid[], public.request_status, text) from public, anon;
revoke execute on function public.panel_create_investor(text, text, text, text, text, text, uuid[], public.request_status) from public, anon;
grant execute on function public.panel_add_requests(uuid, uuid[], public.request_status, text) to authenticated;
grant execute on function public.panel_create_investor(text, text, text, text, text, text, uuid[], public.request_status) to authenticated;

-- ---------------------------------------------------------------------------
-- No deleting from the panel: archive instead (permanent delete only in Supabase)
-- ---------------------------------------------------------------------------
drop policy "admins can delete speakers" on public.speakers;
drop policy "admins can delete submissions" on public.submissions;
drop policy "admins can delete requests" on public.meeting_requests;
revoke delete on public.speakers, public.submissions, public.meeting_requests from authenticated;

revoke all on public.submission_events from anon;
revoke insert, update, delete on public.submission_events from authenticated;
create policy "admins can read submission history" on public.submission_events
  for select to authenticated using ((select public.is_admin()));
alter publication supabase_realtime add table public.submission_events;

-- ---------------------------------------------------------------------------
-- Daily backup: snapshot of all tables, kept 30 days (schema not exposed to the API)
-- ---------------------------------------------------------------------------
create schema if not exists backup;
revoke all on schema backup from public, anon, authenticated;

create table backup.snapshots (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  data jsonb not null
);

create function backup.take_snapshot()
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into backup.snapshots (data)
  select jsonb_build_object(
    'speakers', coalesce((select jsonb_agg(to_jsonb(t)) from public.speakers t), '[]'),
    'submissions', coalesce((select jsonb_agg(to_jsonb(t)) from public.submissions t), '[]'),
    'meeting_requests', coalesce((select jsonb_agg(to_jsonb(t)) from public.meeting_requests t), '[]'),
    'submission_events', coalesce((select jsonb_agg(to_jsonb(t)) from public.submission_events t), '[]'),
    'admins', coalesce((select jsonb_agg(to_jsonb(t)) from public.admins t), '[]')
  )
  returning id into v_id;
  delete from backup.snapshots where taken_at < now() - interval '30 days';
  return v_id;
end;
$$;

create extension if not exists pg_cron;
select cron.schedule('eic-daily-backup', '15 2 * * *', 'select backup.take_snapshot()');
select backup.take_snapshot(); -- first snapshot right away
