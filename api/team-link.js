// POST /api/team-link   Authorization: Bearer <panel session>   { email, redirectTo }
//   → 200 { link, kind: 'invite' | 'recovery' }
// Login link for a team member, made by an owner in the panel's Team page. No email is sent: the owner
// copies the link and sends it. New login → invite link (set a password); existing login → set-password link.
// Needs the secret key (Auth admin), so it can't run in the browser. Checks: valid session, caller is an
// active owner, the email is an active member, the link goes back to this same site.

import { isConfigured, supabase, supabaseAuth, SupabaseError } from '../lib/supabase.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(request) {
  const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!isConfigured()) return reply(502, { error: 'server_error' });

  const token = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return reply(401, { error: 'not_signed_in' });

  let body;
  try {
    body = await request.json();
  } catch {
    return reply(422, { error: 'invalid_request' });
  }
  const email = String(body?.email || '').trim().toLowerCase();
  let redirectTo;
  try {
    redirectTo = new URL(body?.redirectTo);
  } catch {
    return reply(422, { error: 'invalid_redirect' });
  }
  if (!EMAIL.test(email)) return reply(422, { error: 'invalid_email' });
  if (redirectTo.origin !== new URL(request.url).origin) return reply(422, { error: 'invalid_redirect' });

  try {
    let actor;
    try {
      actor = (await supabaseAuth('user', { token })).email;
    } catch (err) {
      if (err instanceof SupabaseError && err.status < 500) return reply(401, { error: 'not_signed_in' });
      throw err;
    }

    const check = await supabase('rpc/team_link_check', { method: 'POST', body: { p_actor: actor, p_email: email } });
    if (!check.actorIsOwner) return reply(403, { error: 'not_allowed' });
    if (!check.memberActive) return reply(409, { error: 'not_a_member' });

    const kind = check.hasLogin ? 'recovery' : 'invite';
    const generated = await supabaseAuth('admin/generate_link', {
      method: 'POST',
      body: { type: kind, email, redirect_to: redirectTo.href },
    });
    const link = generated?.properties?.action_link || generated?.action_link;
    if (!link) throw new Error('generate_link returned no link');

    await supabase('rpc/team_log_link', { method: 'POST', body: { p_actor: actor, p_email: email, p_kind: kind } });
    return reply(200, { link, kind });
  } catch (err) {
    console.error(err);
    return reply(502, { error: 'server_error' });
  }
}
