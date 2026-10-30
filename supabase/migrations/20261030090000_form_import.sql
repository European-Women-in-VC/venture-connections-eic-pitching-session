-- Import Webflow form submissions (CSV export) from the panel.
-- The panel parses the CSV and decides what to import; this function writes the picked rows.
-- Each row keeps its import key in submission_events.booking_id (the Booking ID, or
-- "webflow:<email>:<date>" for rows sent before the booking API), so a row is never imported twice.

alter type public.record_source add value if not exists 'import';

-- p_rows: [{ key, email, firstName, lastName, company, linkedin, speakerIds: [uuid], submittedAt, tags: [text], payload: {} }]
-- Rows are written oldest first; a row whose email already has an active investor joins that investor.
-- Returns one result per row (match them by key):
--   { key, ok: true, submission_id, created: bool, added: [slugs], skipped: [slugs] }
--   { key, ok: true, duplicate: true, submission_id }       key imported before (or sent through the API)
--   { key, ok: false, error }                                nothing written for this row
create function public.panel_import_submissions(
  p_rows jsonb,
  p_status public.request_status default 'new_request'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := auth.jwt() ->> 'email';
  v_row jsonb;
  v_key text;
  v_email text;
  v_at timestamptz;
  v_tags text[];
  v_speaker_ids uuid[];
  v_slugs text[];
  v_submission_id uuid;
  v_created boolean;
  v_rank integer;
  v_added text[];
  v_skipped text[];
  v_results jsonb := '[]';
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'invalid_rows' using errcode = '22023';
  end if;

  for v_row in
    select r from jsonb_array_elements(p_rows) with ordinality as t(r, pos)
    order by (r ->> 'submittedAt')::timestamptz nulls last, pos
  loop
    v_key := nullif(trim(v_row ->> 'key'), '');
    v_email := lower(trim(v_row ->> 'email'));
    begin
      if v_key is null then
        raise exception 'missing_key';
      end if;
      if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'invalid_email';
      end if;
      v_at := coalesce((v_row ->> 'submittedAt')::timestamptz, now());
      v_tags := array(select jsonb_array_elements_text(coalesce(v_row -> 'tags', '[]')));
      v_speaker_ids := array(select (jsonb_array_elements_text(coalesce(v_row -> 'speakerIds', '[]')))::uuid);
      select coalesce(array_agg(sp.slug order by u.pos), '{}') into v_slugs
        from unnest(v_speaker_ids) with ordinality as u(id, pos) join public.speakers sp on sp.id = u.id;
      if cardinality(v_slugs) = 0 then
        raise exception 'no_known_speakers';
      end if;

      -- already imported, or the same booking arrived through the API
      select submission_id into v_submission_id from public.submission_events where booking_id = v_key;
      if found then
        v_results := v_results || jsonb_build_object('key', v_key, 'ok', true, 'duplicate', true, 'submission_id', v_submission_id);
        continue;
      end if;

      perform pg_advisory_xact_lock(hashtext('book:' || v_email));
      select id into v_submission_id
        from public.submissions
        where lower(email) = v_email and archived_at is null
        order by created_at
        limit 1;
      v_created := v_submission_id is null;

      if v_created then
        insert into public.submissions (booking_id, email, first_name, last_name, company, linkedin, speaker_slugs,
                                        tags, meta, source, created_by, created_at)
        values (
          case when exists (select 1 from public.submissions where booking_id = v_key) then null else v_key end,
          v_email,
          nullif(trim(v_row ->> 'firstName'), ''), nullif(trim(v_row ->> 'lastName'), ''),
          nullif(trim(v_row ->> 'company'), ''), nullif(trim(v_row ->> 'linkedin'), ''),
          v_slugs, v_tags, jsonb_build_object('importedFrom', 'webflow_csv'), 'import', v_actor, v_at
        )
        returning id into v_submission_id;
      else
        -- keep the team's edits; only fill empty fields, add tags and new picks
        update public.submissions set
          first_name = coalesce(first_name, nullif(trim(v_row ->> 'firstName'), '')),
          last_name = coalesce(last_name, nullif(trim(v_row ->> 'lastName'), '')),
          company = coalesce(company, nullif(trim(v_row ->> 'company'), '')),
          linkedin = coalesce(linkedin, nullif(trim(v_row ->> 'linkedin'), '')),
          tags = tags || v_tags,
          speaker_slugs = speaker_slugs || array(select s from unnest(v_slugs) s where not (s = any (speaker_slugs)))
        where id = v_submission_id;
      end if;

      select coalesce(array_agg(sp.slug), '{}') into v_skipped
        from public.meeting_requests mr join public.speakers sp on sp.id = mr.speaker_id
        where mr.submission_id = v_submission_id and mr.speaker_id = any (v_speaker_ids);

      select coalesce(max(preference_rank), 0) into v_rank from public.meeting_requests where submission_id = v_submission_id;
      with inserted as (
        insert into public.meeting_requests (submission_id, speaker_id, status, preference_rank, source, created_by, tags, created_at)
        select v_submission_id, u.id, p_status, (v_rank + row_number() over (order by u.pos))::smallint, 'import', v_actor, v_tags, v_at
        from unnest(v_speaker_ids) with ordinality as u(id, pos)
        where exists (select 1 from public.speakers sp where sp.id = u.id)
          and not exists (select 1 from public.meeting_requests mr where mr.submission_id = v_submission_id and mr.speaker_id = u.id)
        returning speaker_id
      )
      select coalesce(array_agg(sp.slug), '{}') into v_added from inserted i join public.speakers sp on sp.id = i.speaker_id;

      insert into public.submission_events (submission_id, booking_id, source, created_by, payload, speaker_slugs, added_slugs, skipped_slugs, created_at)
      values (v_submission_id, v_key, 'import', v_actor,
              coalesce(v_row -> 'payload', '{}') || jsonb_build_object('action', 'import', 'status', p_status, 'importedAt', now()),
              v_slugs, v_added, v_skipped, v_at);

      v_results := v_results || jsonb_build_object(
        'key', v_key, 'ok', true, 'submission_id', v_submission_id, 'created', v_created,
        'added', to_jsonb(v_added), 'skipped', to_jsonb(v_skipped));
    exception
      when others then
        v_results := v_results || jsonb_build_object('key', v_key, 'ok', false, 'error', sqlerrm);
    end;
  end loop;
  return v_results;
end;
$$;

revoke execute on function public.panel_import_submissions(jsonb, public.request_status) from public, anon;
grant execute on function public.panel_import_submissions(jsonb, public.request_status) to authenticated;
