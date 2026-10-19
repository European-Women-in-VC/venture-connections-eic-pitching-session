// Data access for the panel. Reads and writes go straight to Supabase with the logged-in
// user's session; row-level security (admins allowlist) decides what is allowed.

const TABLES = ['speakers', 'submissions', 'meeting_requests', 'submission_events'];

const must = ({ data, error }) => {
  if (error) throw error;
  return data;
};

export function createSupabaseStore(client) {
  return {
    async load() {
      const [speakers, availability, submissions, requests, events, admins] = await Promise.all([
        client.from('speakers').select('*').order('name').then(must),
        client
          .from('speaker_availability')
          .select('id, used, confirmed, waitlisted, remaining, available, status')
          .then(must),
        client.from('submissions').select('*').order('created_at', { ascending: false }).then(must),
        client.from('meeting_requests').select('*').order('created_at', { ascending: false }).then(must),
        client.from('submission_events').select('*').order('created_at', { ascending: false }).then(must),
        client.from('admins').select('email, name').order('email').then(must),
      ]);
      return { speakers, availability, submissions, requests, events, admins };
    },

    updateRequest: (id, patch) =>
      client.from('meeting_requests').update(patch).eq('id', id).select().single().then(must),
    updateSubmission: (id, patch) =>
      client.from('submissions').update(patch).eq('id', id).select().single().then(must),
    updateSpeaker: (id, patch) => client.from('speakers').update(patch).eq('id', id).select().single().then(must),
    createSpeaker: (row) => client.from('speakers').insert(row).select().single().then(must),

    // archive = soft delete (the panel can't delete; permanent deletes only in Supabase)
    archiveSubmission: (id, archived) =>
      client.from('submissions').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id).select().single().then(must),
    archiveSpeaker: (id, archived) =>
      client.from('speakers').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id).select().single().then(must),

    // team additions (database functions record source = panel, who did it, and a history entry)
    addRequests: (submissionId, speakerIds, status = 'new_request', note = null) =>
      client
        .rpc('panel_add_requests', { p_submission_id: submissionId, p_speaker_ids: speakerIds, p_status: status, p_note: note })
        .then(must),
    createInvestor: (inv) =>
      client
        .rpc('panel_create_investor', {
          p_email: inv.email,
          p_first_name: inv.first_name,
          p_last_name: inv.last_name,
          p_company: inv.company,
          p_linkedin: inv.linkedin,
          p_notes: inv.notes,
          p_speaker_ids: inv.speaker_ids,
          p_status: inv.status,
        })
        .then(must),

    // speaker cards on the published Webflow page (source of truth for slug / name / company)
    async fetchWebsiteSpeakers(source = 'live') {
      const res = await fetch(`/api/website-speakers?source=${encodeURIComponent(source)}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Website check failed (${res.status})`);
      return body;
    },

    // calls onChange on any insert/update/delete; onLive(true|false) for the "Live" indicator
    subscribe(onChange, onLive) {
      const channel = client.channel('admin-panel');
      TABLES.forEach((table) => channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange));
      channel.subscribe((status) => onLive(status === 'SUBSCRIBED'));
      return () => client.removeChannel(channel);
    },
  };
}
