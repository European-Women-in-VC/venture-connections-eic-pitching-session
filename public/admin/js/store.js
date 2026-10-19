// Data access for the panel. Reads and writes go straight to Supabase with the logged-in
// user's session; row-level security (admins allowlist) decides what is allowed.

const TABLES = ['speakers', 'submissions', 'meeting_requests'];

const must = ({ data, error }) => {
  if (error) throw error;
  return data;
};

export function createSupabaseStore(client) {
  return {
    async load() {
      const [speakers, availability, submissions, requests, admins] = await Promise.all([
        client.from('speakers').select('*').order('name').then(must),
        client
          .from('speaker_availability')
          .select('id, used, confirmed, waitlisted, remaining, available, status')
          .then(must),
        client.from('submissions').select('*').order('created_at', { ascending: false }).then(must),
        client.from('meeting_requests').select('*').order('created_at', { ascending: false }).then(must),
        client.from('admins').select('email, name').order('email').then(must),
      ]);
      return { speakers, availability, submissions, requests, admins };
    },

    updateRequest: (id, patch) =>
      client.from('meeting_requests').update(patch).eq('id', id).select().single().then(must),
    updateSubmission: (id, patch) =>
      client.from('submissions').update(patch).eq('id', id).select().single().then(must),
    updateSpeaker: (id, patch) => client.from('speakers').update(patch).eq('id', id).select().single().then(must),
    createSpeaker: (row) => client.from('speakers').insert(row).select().single().then(must),
    deleteSpeaker: (id) => client.from('speakers').delete().eq('id', id).then(must),
    deleteSubmission: (id) => client.from('submissions').delete().eq('id', id).then(must),

    // calls onChange on any insert/update/delete; onLive(true|false) for the "Live" indicator
    subscribe(onChange, onLive) {
      const channel = client.channel('admin-panel');
      TABLES.forEach((table) => channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange));
      channel.subscribe((status) => onLive(status === 'SUBSCRIBED'));
      return () => client.removeChannel(channel);
    },
  };
}
