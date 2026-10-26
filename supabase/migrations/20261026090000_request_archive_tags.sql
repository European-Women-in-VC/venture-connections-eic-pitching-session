-- Archive single meeting requests, free tags on investors and requests ('test' is special:
-- not counted against speaker capacity), bulk tag editing for the panel.

alter table public.meeting_requests
  add column archived_at timestamptz,
  add column archived_by text,
  add column tags text[] not null default '{}';

alter table public.submissions
  add column tags text[] not null default '{}';

create trigger meeting_requests_archived_by before update of archived_at on public.meeting_requests
  for each row execute function public.stamp_archived_by();

-- tags: lowercase, trimmed, unique, sorted
create function public.normalize_tags()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.tags = array(
    select distinct lower(trim(t)) from unnest(coalesce(new.tags, '{}')) t where trim(t) <> '' order by 1
  );
  return new;
end;
$$;
create trigger submissions_normalize_tags before insert or update of tags on public.submissions
  for each row execute function public.normalize_tags();
create trigger meeting_requests_normalize_tags before insert or update of tags on public.meeting_requests
  for each row execute function public.normalize_tags();

-- the old investor status "test" becomes the test tag (statuses are replaced by an automatic stage in the panel)
update public.submissions set tags = array['test'] where status = 'test';

-- Capacity: archived requests, requests of archived investors and anything tagged 'test' don't take places
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
  where mr.speaker_id = sp.id
    and mr.archived_at is null
    and s.archived_at is null
    and not ('test' = any (mr.tags))
    and not ('test' = any (s.tags))
) c;

-- Bulk add/remove tags (runs with the caller's rights: row-level security limits it to admins)
create function public.panel_set_tags(
  p_kind text,
  p_ids uuid[],
  p_add text[] default '{}',
  p_remove text[] default '{}'
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_add text[] := array(select lower(trim(t)) from unnest(coalesce(p_add, '{}')) t where trim(t) <> '');
  v_remove text[] := array(select lower(trim(t)) from unnest(coalesce(p_remove, '{}')) t);
  v_count integer;
begin
  if p_kind = 'requests' then
    update public.meeting_requests
      set tags = array(select t from unnest(tags || v_add) t where not (t = any (v_remove)))
      where id = any (p_ids);
  elsif p_kind = 'investors' then
    update public.submissions
      set tags = array(select t from unnest(tags || v_add) t where not (t = any (v_remove)))
      where id = any (p_ids);
  else
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.panel_set_tags(text, uuid[], text[], text[]) from public, anon;
grant execute on function public.panel_set_tags(text, uuid[], text[], text[]) to authenticated;

-- daily backup already includes whole rows, so the new columns are covered automatically
