import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../api/team-link.js';

const realFetch = globalThis.fetch;
const PANEL = 'https://panel.test/eic-team-4k9p/';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// fake Supabase Auth + database; returns the calls
function fakeSupabase({ users = { 'tok-owner': 'owner@team.org', 'tok-editor': 'editor@team.org' }, check, linkBody } = {}) {
  const calls = { links: [], logs: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') {
      const email = users[(opts.headers.Authorization || '').replace('Bearer ', '')];
      return email ? Response.json({ id: 'u1', email }) : Response.json({ msg: 'invalid JWT' }, { status: 401 });
    }
    if (u.pathname === '/rest/v1/rpc/team_link_check') {
      const { p_actor, p_email } = JSON.parse(opts.body);
      return Response.json(
        check?.(p_actor, p_email) ?? { actorIsOwner: p_actor === 'owner@team.org', memberActive: p_email !== 'stranger@x.org', hasLogin: p_email === 'known@team.org' },
      );
    }
    if (u.pathname === '/auth/v1/admin/generate_link') {
      const body = JSON.parse(opts.body);
      calls.links.push({ body, apikey: opts.headers.apikey });
      return Response.json(linkBody ?? { properties: { action_link: `https://proj.supabase.co/auth/v1/verify?type=${body.type}&token=t` } });
    }
    if (u.pathname === '/rest/v1/rpc/team_log_link') {
      calls.logs.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const post = (body, token = 'tok-owner') =>
  new Request('https://panel.test/api/team-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

test('owner gets an invite link for a new member; the link is logged, no email is sent', async () => {
  const calls = fakeSupabase();
  const res = await POST(post({ email: ' New@Team.org ', redirectTo: PANEL }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'invite');
  assert.match(body.link, /type=invite/);
  assert.deepEqual(calls.links[0].body, { type: 'invite', email: 'new@team.org', redirect_to: PANEL });
  assert.equal(calls.links[0].apikey, 'sb_secret_test');
  assert.deepEqual(calls.logs, [{ p_actor: 'owner@team.org', p_email: 'new@team.org', p_kind: 'invite' }]);
});

test('a member who already has a login gets a set-password (recovery) link', async () => {
  fakeSupabase({ linkBody: { action_link: 'https://proj.supabase.co/auth/v1/verify?type=recovery&token=t' } });
  const res = await POST(post({ email: 'known@team.org', redirectTo: PANEL }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).kind, 'recovery');
});

test('refused: no token, bad token, not an owner, not a member, other site, bad email', async () => {
  const calls = fakeSupabase();
  const status = async (req) => (await POST(req)).status;
  assert.equal(await status(post({ email: 'new@team.org', redirectTo: PANEL }, null)), 401);
  assert.equal(await status(post({ email: 'new@team.org', redirectTo: PANEL }, 'tok-forged')), 401);
  assert.equal(await status(post({ email: 'new@team.org', redirectTo: PANEL }, 'tok-editor')), 403);
  assert.equal(await status(post({ email: 'stranger@x.org', redirectTo: PANEL })), 409);
  assert.equal(await status(post({ email: 'new@team.org', redirectTo: 'https://evil.example/' })), 422);
  assert.equal(await status(post({ email: 'not-an-email', redirectTo: PANEL })), 422);
  assert.equal(calls.links.length, 0);
});
