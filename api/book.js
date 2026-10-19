// POST /api/book
// Books 1–4 speakers for an investor in one database transaction (public.book_meetings).
//
// Request JSON:
//   { bookingId, email, firstName, lastName, company?, linkedin?, speakers: ["slug", …], website? (honeypot) }
// Responses:
//   200 { ok: true, duplicate?: true, unknown?: [slugs not in the database] }
//   409 { ok: false, error: "unavailable", unavailable: [slugs] }   nothing saved
//   422 { ok: false, error: "invalid_email" | "invalid_selection" | "invalid_request" }
//   403 { ok: false, error: "forbidden" }                            origin not in ALLOWED_ORIGINS
//   502 { ok: false, error: "server_error" }

import { corsHeaders } from '../lib/cors.js';
import { isConfigured, supabase, SupabaseError } from '../lib/supabase.js';

const MAX_SPEAKERS = 4;
const str = (v, max = 256) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function OPTIONS(request) {
  const headers = corsHeaders(request);
  if (!headers['Access-Control-Allow-Origin']) return new Response(null, { status: 403, headers });
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const reply = (status, body) => Response.json(body, { status, headers });

  // only the Webflow site may book
  if (!headers['Access-Control-Allow-Origin']) return reply(403, { ok: false, error: 'forbidden' });

  if (!isConfigured()) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
    return reply(502, { ok: false, error: 'server_error' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return reply(422, { ok: false, error: 'invalid_request' });
  }
  if (!body || typeof body !== 'object') return reply(422, { ok: false, error: 'invalid_request' });

  // honeypot: bots fill every field; pretend it worked and save nothing
  if (str(body.website)) return reply(200, { ok: true });

  const speakers = Array.isArray(body.speakers) ? body.speakers.map((s) => str(s, 120)).filter(Boolean) : [];
  if (speakers.length === 0 || speakers.length > MAX_SPEAKERS) {
    return reply(422, { ok: false, error: 'invalid_selection' });
  }

  try {
    const result = await supabase('rpc/book_meetings', {
      method: 'POST',
      body: {
        p_booking_id: str(body.bookingId, 100) || null,
        p_email: str(body.email, 254),
        p_first_name: str(body.firstName),
        p_last_name: str(body.lastName),
        p_speaker_slugs: speakers,
        p_company: str(body.company),
        p_linkedin: str(body.linkedin, 512),
        p_meta: {
          page: str(body.page, 512),
          userAgent: str(request.headers.get('user-agent'), 512),
          origin: request.headers.get('origin'),
        },
      },
    });

    if (result && result.ok) {
      return reply(200, { ok: true, duplicate: Boolean(result.duplicate), unknown: result.unknown || [] });
    }
    if (result && result.error === 'unavailable') {
      return reply(409, { ok: false, error: 'unavailable', unavailable: result.unavailable || [] });
    }
    console.error('Unexpected book_meetings result', result);
    return reply(502, { ok: false, error: 'server_error' });
  } catch (err) {
    // validation errors raised by book_meetings come back as PostgREST 400s
    if (err instanceof SupabaseError && err.status === 400) {
      const known = ['invalid_email', 'invalid_selection'].find((code) => err.body.includes(code));
      if (known) return reply(422, { ok: false, error: known });
    }
    console.error(err);
    return reply(502, { ok: false, error: 'server_error' });
  }
}
