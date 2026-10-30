// Minimal server-side Supabase client (PostgREST over fetch, no dependencies).
// Uses the secret key, which bypasses RLS: never expose it to the browser.

const config = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_SECRET_KEY,
});

export const isConfigured = () => {
  const { url, key } = config();
  return Boolean(url && key);
};

export class SupabaseError extends Error {
  constructor(status, body) {
    super(`Supabase ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

// supabase('speaker_availability?select=slug')                     → GET a table/view
// supabase('rpc/book_meetings', { method: 'POST', body: { … } })  → call a database function
export async function supabase(path, { method = 'GET', body, prefer } = {}) {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Accept: 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(prefer && { Prefer: prefer }), // e.g. 'resolution=ignore-duplicates,return=representation'
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new SupabaseError(res.status, text);
  return text ? JSON.parse(text) : null;
}

// supabaseAuth('user', { token })                                  → the user a session token belongs to
// supabaseAuth('admin/generate_link', { method: 'POST', body })      → Auth admin call (secret key)
export async function supabaseAuth(path, { method = 'GET', body, token } = {}) {
  const { url, key } = config();
  const res = await fetch(`${url}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Accept: 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new SupabaseError(res.status, text);
  return text ? JSON.parse(text) : null;
}
