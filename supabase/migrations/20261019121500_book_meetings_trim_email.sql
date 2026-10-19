-- Validate the email after trimming spaces (" a@b.co " was rejected before).
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
  v_unavailable text[];
  v_unknown text[];
begin
  -- unique, trimmed slugs in pick order
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

  -- same visit submitted twice (double click, retry) → return the first result
  if p_booking_id is not null then
    select id into v_submission_id from public.submissions where booking_id = p_booking_id;
    if found then
      return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'duplicate', true);
    end if;
  end if;

  -- lock the chosen speakers (fixed order → no deadlocks); parallel bookings for them wait here
  perform 1 from public.speakers where slug = any (v_slugs) order by id for update;

  select coalesce(array_agg(sa.slug), '{}')
    into v_unavailable
    from public.speaker_availability sa
    where sa.slug = any (v_slugs) and sa.status <> 'available';

  if cardinality(v_unavailable) > 0 then
    return jsonb_build_object('ok', false, 'error', 'unavailable', 'unavailable', to_jsonb(v_unavailable));
  end if;

  select coalesce(array_agg(s), '{}')
    into v_unknown
    from unnest(v_slugs) s
    where not exists (select 1 from public.speakers sp where sp.slug = s);

  insert into public.submissions (booking_id, email, first_name, last_name, company, linkedin, speaker_slugs, meta)
  values (
    p_booking_id,
    v_email,
    nullif(trim(p_first_name), ''),
    nullif(trim(p_last_name), ''),
    nullif(trim(p_company), ''),
    nullif(trim(p_linkedin), ''),
    v_slugs,
    coalesce(p_meta, '{}')
  )
  returning id into v_submission_id;

  insert into public.meeting_requests (submission_id, speaker_id, preference_rank)
  select v_submission_id, sp.id, u.pos::smallint
  from unnest(v_slugs) with ordinality as u(slug, pos)
  join public.speakers sp on sp.slug = u.slug;

  return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'unknown', to_jsonb(v_unknown));
exception
  when unique_violation then
    -- two identical requests at the same moment: the other one won
    select id into v_submission_id from public.submissions where booking_id = p_booking_id;
    return jsonb_build_object('ok', true, 'submission_id', v_submission_id, 'duplicate', true);
end;
$$;
