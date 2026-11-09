-- Page versions: one Webflow page, several links with their own speaker capacity.
--   main version   /eic-women-leadership-programme            (no param; capacity = speakers.capacity)
--   other versions /eic-women-leadership-programme?<key>=<value>
-- Each version is its own pool: a booking on version B never uses a place of the main version.
-- A speaker's capacity in a non-main version = their override, else the version's default capacity.
-- Unknown or archived param values book (and count) as the main version.

create type public.zero_capacity_display as enum ('unavailable', 'hide');

create table public.page_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  -- both null = the main version (exactly one, can't be archived)
  param_key text check (param_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$' and param_key not in ('fresh', 'speakers-debug')),
  param_value text check (param_value ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  is_main boolean generated always as (param_key is null) stored,
  default_capacity integer check (default_capacity between 0 and 99),
  zero_capacity public.zero_capacity_display not null default 'unavailable',
  notes text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz not null default now(),
  created_by text default lower(auth.jwt() ->> 'email'),
  updated_at timestamptz not null default now(),
  check ((param_key is null) = (param_value is null)),
  check ((param_key is null) = (default_capacity is null)), -- main uses speakers.capacity
  check (param_key is not null or archived_at is null),
  unique (param_key, param_value),
  unique (id, is_main)
);
create unique index page_versions_one_main on public.page_versions ((true)) where param_key is null;

create trigger page_versions_updated_at before update on public.page_versions
  for each row execute function public.set_updated_at();
create trigger page_versions_archived_by before update of archived_at on public.page_versions
  for each row execute function public.stamp_archived_by();

-- the main version stays the main version (and no other version becomes it)
create function public.page_versions_keep_main()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.param_key is null) <> (new.param_key is null) then
    raise exception 'main_version_fixed' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger page_versions_keep_main before update on public.page_versions
  for each row execute function public.page_versions_keep_main();

insert into public.page_versions (name, created_by) values ('Main', 'migration');

-- per speaker overrides, only for non-main versions (the composite key makes a main override impossible)
create table public.speaker_version_capacity (
  speaker_id uuid not null references public.speakers (id) on delete cascade,
  version_id uuid not null,
  version_is_main boolean not null default false check (not version_is_main),
  capacity integer not null check (capacity between 0 and 99),
  updated_at timestamptz not null default now(),
  updated_by text default lower(auth.jwt() ->> 'email'),
  primary key (speaker_id, version_id),
  foreign key (version_id, version_is_main) references public.page_versions (id, is_main) on delete cascade
);
create index speaker_version_capacity_version_idx on public.speaker_version_capacity (version_id);

create function public.main_version_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.page_versions where param_key is null;
$$;
revoke execute on function public.main_version_id() from public, anon;
grant execute on function public.main_version_id() to authenticated, service_role;

-- which version a page visit belongs to: its query params, e.g. { "version": "partners" } → that version, else main
create function public.resolve_page_version(p_params jsonb)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.id
       from jsonb_each_text(case when jsonb_typeof(p_params) = 'object' then p_params else '{}' end) p
       join public.page_versions v on v.param_key = lower(trim(p.key)) and v.param_value = lower(trim(p.value))
      where v.archived_at is null
      order by v.created_at
      limit 1),
    public.main_version_id()
  );
$$;
revoke execute on function public.resolve_page_version(jsonb) from public, anon, authenticated;
grant execute on function public.resolve_page_version(jsonb) to service_role;

-- every request belongs to one version (existing ones: main); website events remember it too
alter table public.meeting_requests add column version_id uuid references public.page_versions (id);
update public.meeting_requests set version_id = public.main_version_id();
alter table public.meeting_requests
  alter column version_id set default public.main_version_id(),
  alter column version_id set not null;
create index meeting_requests_version_idx on public.meeting_requests (version_id, speaker_id);

alter table public.submission_events add column version_id uuid references public.page_versions (id);

-- ---------------------------------------------------------------------------
-- Capacity per speaker × version (same rules as before, counted per version)
-- ---------------------------------------------------------------------------
create view public.speaker_version_availability
with (security_invoker = true)
as
select
  sp.id,
  v.id as version_id,
  sp.slug,
  sp.name,
  sp.company,
  cap.capacity,
  cap.is_override,
  sp.availability,
  c.used,
  c.confirmed,
  c.waitlisted,
  greatest(cap.capacity - c.used, 0) as remaining,
  case when sp.archived_at is null and sp.availability = 'open' then greatest(cap.capacity - c.used, 0) else 0 end as available,
  case
    when sp.archived_at is not null then 'closed'
    when cap.capacity = 0 and v.zero_capacity = 'hide' then 'hidden'
    when c.used > cap.capacity then 'over_capacity'
    when sp.availability <> 'open' then sp.availability::text
    when cap.capacity = 0 then 'unavailable'
    when cap.capacity - c.used <= 0 then 'full'
    else 'available'
  end as status
from public.speakers sp
cross join public.page_versions v
left join public.speaker_version_capacity o on o.speaker_id = sp.id and o.version_id = v.id
cross join lateral (
  select
    case when v.param_key is null then sp.capacity else coalesce(o.capacity, v.default_capacity) end as capacity,
    o.capacity is not null as is_override
) cap
cross join lateral (
  select
    count(*) filter (where public.request_takes_place(mr.status))::integer as used,
    count(*) filter (where mr.status in ('accepted_scheduling', 'scheduled_confirmed'))::integer as confirmed,
    count(*) filter (where mr.status = 'waitlisted')::integer as waitlisted
  from public.meeting_requests mr
  join public.submissions s on s.id = mr.submission_id
  where mr.speaker_id = sp.id
    and mr.version_id = v.id
    and mr.archived_at is null
    and s.archived_at is null
    and not ('test' = any (mr.tags))
    and not ('test' = any (s.tags))
) c;

-- the old view = the main version (older panels and the smoke check keep working)
create or replace view public.speaker_availability
with (security_invoker = true)
as
select id, slug, name, company, capacity, availability, used, confirmed, waitlisted, remaining, available, status
from public.speaker_version_availability
where version_id = public.main_version_id();

-- what the website shows for a visit: the resolved version + one row per speaker
create function public.website_availability(p_params jsonb default '{}')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with v as (select public.resolve_page_version(p_params) as id)
  select jsonb_build_object(
    'version', (select case when pv.param_key is null then null else jsonb_build_object('key', pv.param_key, 'value', pv.param_value) end
                from public.page_versions pv join v on v.id = pv.id),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'slug', a.slug, 'capacity', a.capacity, 'used', a.used,
                                                          'available', a.available, 'status', a.status))
                      from public.speaker_version_availability a join v on v.id = a.version_id), '[]')
  );
$$;
revoke execute on function public.website_availability(jsonb) from public, anon, authenticated;
grant execute on function public.website_availability(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Panel: who may read and change versions and capacities
-- ---------------------------------------------------------------------------
alter table public.page_versions enable row level security;
alter table public.speaker_version_capacity enable row level security;
create policy "team can read versions" on public.page_versions for select to authenticated using ((select public.can_read_eic()));
create policy "editors can add versions" on public.page_versions for insert to authenticated with check ((select public.is_admin()));
create policy "editors can edit versions" on public.page_versions for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "team can read capacities" on public.speaker_version_capacity for select to authenticated using ((select public.can_read_eic()));
create policy "editors can add capacities" on public.speaker_version_capacity for insert to authenticated with check ((select public.is_admin()));
create policy "editors can edit capacities" on public.speaker_version_capacity for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "editors can reset capacities" on public.speaker_version_capacity for delete to authenticated using ((select public.is_admin()));
grant select, insert, update on public.page_versions to authenticated;
grant select, insert, update, delete on public.speaker_version_capacity to authenticated;
grant select on public.speaker_version_availability to authenticated;
revoke all on public.page_versions, public.speaker_version_capacity, public.speaker_version_availability from anon;

-- capacity of many speakers in one version. Main: speakers.capacity. Others: override, or null = back to the default.
-- Runs with the caller's rights (row-level security: editors only). Returns the number of speakers changed.
create function public.panel_set_capacity(p_version_id uuid, p_speaker_ids uuid[], p_capacity integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_main boolean;
  v_count integer;
begin
  select is_main into v_main from public.page_versions where id = p_version_id;
  if v_main is null then
    raise exception 'version_not_found' using errcode = '22023';
  end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 99) then
    raise exception 'invalid_capacity' using errcode = '22023';
  end if;

  if v_main then
    if p_capacity is null then
      raise exception 'invalid_capacity' using errcode = '22023';
    end if;
    update public.speakers set capacity = p_capacity where id = any (p_speaker_ids);
    get diagnostics v_count = row_count;
  elsif p_capacity is null then
    delete from public.speaker_version_capacity where version_id = p_version_id and speaker_id = any (p_speaker_ids);
    v_count := cardinality(p_speaker_ids);
  else
    insert into public.speaker_version_capacity (speaker_id, version_id, capacity)
    select unnest(p_speaker_ids), p_version_id, p_capacity
    on conflict (speaker_id, version_id) do update
      set capacity = excluded.capacity, updated_at = now(), updated_by = lower(auth.jwt() ->> 'email');
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end;
$$;
revoke execute on function public.panel_set_capacity(uuid, uuid[], integer) from public, anon;
grant execute on function public.panel_set_capacity(uuid, uuid[], integer) to authenticated;

alter publication supabase_realtime add table public.page_versions, public.speaker_version_capacity;

-- ---------------------------------------------------------------------------
-- Website booking: the visit's version decides which pool is checked and used
-- ---------------------------------------------------------------------------
drop function public.book_meetings(text, text, text, text, text[], text, text, jsonb);
create function public.book_meetings(
  p_booking_id text,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_speaker_slugs text[],
  p_company text default null,
  p_linkedin text default null,
  p_meta jsonb default '{}',
  p_params jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_version_id uuid := public.resolve_page_version(p_params);
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

  -- lock and check only the speakers this submission adds, in this version's pool
  perform 1 from public.speakers where slug = any (v_new) order by id for update;
  select coalesce(array_agg(sa.slug), '{}') into v_unavailable
    from public.speaker_version_availability sa
    where sa.version_id = v_version_id and sa.slug = any (v_new) and sa.status <> 'available';
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
    insert into public.meeting_requests (submission_id, speaker_id, preference_rank, source, version_id)
    select v_submission_id, sp.id, (v_rank + u.pos)::smallint, 'website', v_version_id
    from unnest(v_new) with ordinality as u(slug, pos)
    join public.speakers sp on sp.slug = u.slug
    returning speaker_id
  )
  select coalesce(array_agg(sp.slug), '{}') into v_added from inserted i join public.speakers sp on sp.id = i.speaker_id;

  insert into public.submission_events (submission_id, booking_id, source, payload, speaker_slugs, added_slugs, skipped_slugs, version_id)
  values (
    v_submission_id, p_booking_id, 'website',
    jsonb_build_object(
      'email', p_email, 'firstName', p_first_name, 'lastName', p_last_name,
      'company', p_company, 'linkedin', p_linkedin, 'speakers', to_jsonb(p_speaker_slugs), 'params', coalesce(p_params, '{}')
    ) || coalesce(p_meta, '{}'),
    v_slugs, v_added, v_already, v_version_id
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
revoke execute on function public.book_meetings(text, text, text, text, text[], text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.book_meetings(text, text, text, text, text[], text, text, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Daily backup also covers versions
-- ---------------------------------------------------------------------------
create or replace function backup.take_snapshot()
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
    'page_versions', coalesce((select jsonb_agg(to_jsonb(t)) from public.page_versions t), '[]'),
    'speaker_version_capacity', coalesce((select jsonb_agg(to_jsonb(t)) from public.speaker_version_capacity t), '[]'),
    'core_products', coalesce((select jsonb_agg(to_jsonb(t)) from core.products t), '[]'),
    'core_members', coalesce((select jsonb_agg(to_jsonb(t)) from core.members t), '[]'),
    'core_memberships', coalesce((select jsonb_agg(to_jsonb(t)) from core.memberships t), '[]'),
    'core_member_events', coalesce((select jsonb_agg(to_jsonb(t)) from core.member_events t), '[]')
  )
  returning id into v_id;
  delete from backup.snapshots where taken_at < now() - interval '30 days';
  return v_id;
end;
$$;
