// POST /api/register-speakers   { speakers: [{ slug }] }  →  { added: [slugs], notOnPage: [slugs] }
// Called by speakers.js for cards the database doesn't know yet. See lib/register-speakers.js.

import { corsHeaders } from '../lib/cors.js';
import { isConfigured } from '../lib/supabase.js';
import { registerFromWebsite } from '../lib/register-speakers.js';

export function OPTIONS(request) {
  const headers = corsHeaders(request);
  if (!headers['Access-Control-Allow-Origin']) return new Response(null, { status: 403, headers });
  return new Response(null, {
    status: 204,
    headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
  });
}

export async function POST(request) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const reply = (status, body) => Response.json(body, { status, headers });
  if (!headers['Access-Control-Allow-Origin']) return reply(403, { error: 'forbidden' });
  if (!isConfigured()) return reply(502, { error: 'server_error' });

  let body;
  try {
    body = await request.json();
  } catch {
    return reply(422, { error: 'invalid_request' });
  }
  const slugs = Array.isArray(body?.speakers) ? body.speakers.map((s) => s?.slug) : [];

  try {
    return reply(200, await registerFromWebsite(slugs, request.headers.get('origin')));
  } catch (err) {
    console.error(err);
    return reply(502, { error: 'server_error' });
  }
}
