-- Team members and roles, shared by all products (schema core).
--   owner   member flag: manages the team, can read and edit every product
--   editor  per product: read and edit
--   viewer  per product: read only
-- Disabled members lose access at once (rows stay for history). The core schema is not exposed to the
-- Data API: the panel goes through the public functions below, which check the caller.
-- public.admins becomes a view (same columns), so older panel versions keep working.

create schema core;
revoke all on schema core from public, anon;
grant usage on schema core to authenticated;

create type core.member_role as enum ('editor', 'viewer');

create table core.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table core.members (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text,
  is_owner boolean not null default false,
  disabled_at timestamptz,
  disabled_by text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now()
);

create table core.memberships (
  member_id uuid not null references core.members (id) on delete cascade,
  product_id uuid not null references core.products (id) on delete cascade,
  role core.member_role not null,
  created_at timestamptz not null default now(),
  created_by text,
  primary key (member_id, product_id)
);

-- who changed what in the team
create table core.member_events (
  id bigint generated always as identity primary key,
  member_id uuid not null references core.members (id) on delete cascade,
  actor text,
  action text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index member_events_member_idx on core.member_events (member_id, created_at);

alter table core.products enable row level security;
alter table core.members enable row level security;
alter table core.memberships enable row level security;
alter table core.member_events enable row level security;
-- no policies: only the security definer functions below read or write these tables

insert into core.products (slug, name) values ('eic-bookings', 'EIC Pitching Session bookings');

-- today's admins keep what they have: everything (owner)
insert into core.members (email, name, is_owner, created_at, created_by)
select email, nullif(trim(name), ''), true, created_at, 'migration' from public.admins;
insert into core.member_events (member_id, actor, action, details)
select id, 'migration', 'created', jsonb_build_object('from', 'admins', 'is_owner', true) from core.members;

-- ---------------------------------------------------------------------------
-- Access checks (by the logged-in user's email)
-- ---------------------------------------------------------------------------
create function core.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from core.members
  where email = lower(coalesce(auth.jwt() ->> 'email', '')) and disabled_at is null;
$$;

create function core.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from core.members m where m.id = core.current_member_id() and m.is_owner);
$$;

-- p_roles: the roles that count, e.g. '{editor}' for editing, '{editor,viewer}' for reading
create function core.has_role(p_product text, p_roles core.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.is_owner() or exists (
    select 1 from core.memberships ms
    join core.products p on p.id = ms.product_id and p.archived_at is null
    where ms.member_id = core.current_member_id() and p.slug = p_product and ms.role = any (p_roles)
  );
$$;

create function core.can_read(p_product text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.has_role(p_product, '{editor,viewer}');
$$;

create function core.can_edit(p_product text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.has_role(p_product, '{editor}');
$$;

revoke execute on all functions in schema core from public, anon;
grant execute on function core.current_member_id(), core.is_owner(), core.has_role(text, core.member_role[]),
  core.can_read(text), core.can_edit(text) to authenticated;

-- is_admin() = can edit the EIC bookings: every edit policy and panel function keeps using it
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.can_edit('eic-bookings');
$$;

-- reading: editors and viewers
create or replace function public.can_read_eic()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.can_read('eic-bookings');
$$;
revoke execute on function public.can_read_eic() from public, anon;
grant execute on function public.can_read_eic() to authenticated;

alter policy "admins can read speakers" on public.speakers using ((select public.can_read_eic()));
alter policy "admins can read submissions" on public.submissions using ((select public.can_read_eic()));
alter policy "admins can read requests" on public.meeting_requests using ((select public.can_read_eic()));
alter policy "admins can read submission history" on public.submission_events using ((select public.can_read_eic()));

-- the team list the panel already reads (assignees): now the active members with access to the EIC bookings
drop policy "admins can read the team list" on public.admins;
drop table public.admins;
create function public.eic_team()
returns table (email text, name text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.email, m.name, m.created_at
  from core.members m
  where m.disabled_at is null
    and core.can_read('eic-bookings')
    and (m.is_owner or exists (
      select 1 from core.memberships ms join core.products p on p.id = ms.product_id
      where ms.member_id = m.id and p.slug = 'eic-bookings'
    ));
$$;
revoke execute on function public.eic_team() from public, anon;
grant execute on function public.eic_team() to authenticated;

create view public.admins
with (security_invoker = true)
as
select * from public.eic_team();
revoke all on public.admins from public, anon;
grant select on public.admins to authenticated;

-- ---------------------------------------------------------------------------
-- What the logged-in user may do (the panel asks once after login)
-- ---------------------------------------------------------------------------
create function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', m.email,
    'name', m.name,
    'isOwner', m.is_owner,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('slug', p.slug, 'name', p.name,
                                          'role', case when m.is_owner then 'editor' else ms.role::text end)
                       order by p.name)
      from core.products p
      left join core.memberships ms on ms.product_id = p.id and ms.member_id = m.id
      where p.archived_at is null and (m.is_owner or ms.role is not null)
    ), '[]')
  )
  from core.members m
  where m.id = core.current_member_id();
$$;
revoke execute on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

-- ---------------------------------------------------------------------------
-- Team management (owners only)
-- ---------------------------------------------------------------------------
create function core.require_owner()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not core.is_owner() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return lower(auth.jwt() ->> 'email');
end;
$$;

-- one active owner must always remain
create function core.assert_an_owner_remains()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from core.members where is_owner and disabled_at is null) then
    raise exception 'last_owner' using errcode = '22023', hint = 'At least one active owner must remain.';
  end if;
end;
$$;

-- members with their roles, login state and recent changes
create function public.team_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform core.require_owner();
  return jsonb_build_object(
    'products', (select coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'name', name) order by name), '[]')
                 from core.products where archived_at is null),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'email', m.email, 'name', m.name, 'isOwner', m.is_owner,
        'disabledAt', m.disabled_at, 'disabledBy', m.disabled_by,
        'createdAt', m.created_at, 'createdBy', m.created_by,
        'hasLogin', u.id is not null, 'lastSignInAt', u.last_sign_in_at,
        'roles', (select coalesce(jsonb_object_agg(p.slug, ms.role), '{}')
                  from core.memberships ms join core.products p on p.id = ms.product_id where ms.member_id = m.id),
        'events', (select coalesce(jsonb_agg(jsonb_build_object('action', e.action, 'actor', e.actor, 'details', e.details,
                                                                 'at', e.created_at) order by e.created_at desc), '[]')
                   from (select * from core.member_events where member_id = m.id order by created_at desc limit 20) e)
      ) order by m.disabled_at nulls first, lower(coalesce(m.name, m.email))), '[]')
      from core.members m
      left join auth.users u on lower(u.email) = m.email)
  );
end;
$$;

-- add or update a member. p_roles: { "<product slug>": "editor" | "viewer" | null (no access) }
create function public.team_save_member(
  p_email text,
  p_name text default null,
  p_is_owner boolean default false,
  p_roles jsonb default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := core.require_owner();
  v_email text := lower(trim(p_email));
  v_id uuid;
  v_before jsonb;
  v_slug text;
  v_role text;
begin
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_roles, '{}')) <> 'object' then
    raise exception 'invalid_roles' using errcode = '22023';
  end if;

  select id, jsonb_build_object('name', name, 'isOwner', is_owner,
           'roles', (select coalesce(jsonb_object_agg(p.slug, ms.role), '{}')
                     from core.memberships ms join core.products p on p.id = ms.product_id where ms.member_id = m.id))
    into v_id, v_before
    from core.members m where email = v_email;

  if v_id is null then
    insert into core.members (email, name, is_owner, created_by)
    values (v_email, nullif(trim(p_name), ''), coalesce(p_is_owner, false), v_actor)
    returning id into v_id;
  else
    update core.members set name = nullif(trim(p_name), ''), is_owner = coalesce(p_is_owner, false), updated_at = now()
    where id = v_id;
  end if;

  for v_slug, v_role in select key, value #>> '{}' from jsonb_each(coalesce(p_roles, '{}')) loop
    if not exists (select 1 from core.products where slug = v_slug) then
      raise exception 'unknown_product' using errcode = '22023', detail = v_slug;
    end if;
    if v_role is null or v_role = '' then
      delete from core.memberships ms using core.products p
        where p.id = ms.product_id and ms.member_id = v_id and p.slug = v_slug;
    elsif v_role in ('editor', 'viewer') then
      insert into core.memberships (member_id, product_id, role, created_by)
      select v_id, p.id, v_role::core.member_role, v_actor from core.products p where p.slug = v_slug
      on conflict (member_id, product_id) do update set role = excluded.role;
    else
      raise exception 'invalid_role' using errcode = '22023', detail = v_role;
    end if;
  end loop;

  perform core.assert_an_owner_remains();
  insert into core.member_events (member_id, actor, action, details)
  values (v_id, v_actor, case when v_before is null then 'created' else 'updated' end,
          jsonb_build_object('before', v_before, 'name', nullif(trim(p_name), ''), 'isOwner', coalesce(p_is_owner, false),
                             'roles', coalesce(p_roles, '{}')));
  return v_id;
end;
$$;

-- disable (no access, rows kept) or enable again
create function public.team_set_disabled(p_member_id uuid, p_disabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := core.require_owner();
begin
  if p_disabled and p_member_id = core.current_member_id() then
    raise exception 'cannot_disable_self' using errcode = '22023';
  end if;
  update core.members
    set disabled_at = case when p_disabled then coalesce(disabled_at, now()) end,
        disabled_by = case when p_disabled then coalesce(disabled_by, v_actor) end,
        updated_at = now()
    where id = p_member_id;
  if not found then
    raise exception 'member_not_found' using errcode = '22023';
  end if;
  perform core.assert_an_owner_remains();
  insert into core.member_events (member_id, actor, action) values (p_member_id, v_actor, case when p_disabled then 'disabled' else 'enabled' end);
end;
$$;

-- for the /api/team endpoint (secret key only): may p_actor create a login link for p_email?
create function public.team_link_check(p_actor text, p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'actorIsOwner', exists (select 1 from core.members where email = lower(trim(p_actor)) and is_owner and disabled_at is null),
    'memberActive', exists (select 1 from core.members where email = lower(trim(p_email)) and disabled_at is null),
    'hasLogin', exists (select 1 from auth.users where lower(email) = lower(trim(p_email)))
  );
$$;

create function public.team_log_link(p_actor text, p_email text, p_kind text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into core.member_events (member_id, actor, action, details)
  select id, lower(trim(p_actor)), 'login_link', jsonb_build_object('kind', p_kind)
  from core.members where email = lower(trim(p_email));
$$;

revoke execute on function core.require_owner(), core.assert_an_owner_remains() from public, anon, authenticated;
revoke execute on function public.team_list(), public.team_save_member(text, text, boolean, jsonb),
  public.team_set_disabled(uuid, boolean) from public, anon;
grant execute on function public.team_list(), public.team_save_member(text, text, boolean, jsonb),
  public.team_set_disabled(uuid, boolean) to authenticated;
revoke execute on function public.team_link_check(text, text), public.team_log_link(text, text, text) from public, anon, authenticated;
grant execute on function public.team_link_check(text, text), public.team_log_link(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Daily backup also covers the team
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
