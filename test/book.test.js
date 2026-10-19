import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONS, POST } from '../api/book.js';

const realFetch = globalThis.fetch;
const ORIGIN = 'https://site.webflow.io';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.ALLOWED_ORIGINS = `https://example.com,${ORIGIN}`;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (body, origin = ORIGIN) =>
  new Request('https://api.test/api/book', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin && { origin }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = {
  bookingId: 'b-1',
  email: 'ann@example.com',
  firstName: 'Ann',
  lastName: 'Lee',
  company: 'Fund',
  linkedin: 'https://linkedin.com/in/ann',
  speakers: ['proskope', 'geniel-srl'],
  page: 'https://site.webflow.io/eic',
};

function mockRpc(result, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
    return new Response(typeof result === 'string' ? result : JSON.stringify(result), { status });
  };
  return calls;
}

test('books and passes the form to book_meetings', async () => {
  const calls = mockRpc({ ok: true, submission_id: 'x', unknown: [] });
  const res = await POST(post(valid));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, duplicate: false, unknown: [] });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/rpc/book_meetings');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.apikey, 'sb_secret_test');
  assert.deepEqual({ ...calls[0].body, p_meta: undefined }, {
    p_booking_id: 'b-1',
    p_email: 'ann@example.com',
    p_first_name: 'Ann',
    p_last_name: 'Lee',
    p_speaker_slugs: ['proskope', 'geniel-srl'],
    p_company: 'Fund',
    p_linkedin: 'https://linkedin.com/in/ann',
    p_meta: undefined,
  });
  assert.equal(calls[0].body.p_meta.page, 'https://site.webflow.io/eic');
  assert.equal(calls[0].body.p_meta.origin, ORIGIN);
});

test('409 with the speakers that are no longer available', async () => {
  mockRpc({ ok: false, error: 'unavailable', unavailable: ['proskope'] });
  const res = await POST(post(valid));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, error: 'unavailable', unavailable: ['proskope'] });
});

test('duplicate booking id is still a success', async () => {
  mockRpc({ ok: true, submission_id: 'x', duplicate: true });
  const res = await POST(post(valid));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
});

test('database validation errors become 422', async () => {
  mockRpc('{"code":"22023","message":"invalid_email"}', 400);
  const res = await POST(post({ ...valid, email: 'nope' }));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { ok: false, error: 'invalid_email' });
});

test('rejects 0 or more than 4 speakers without calling the database', async () => {
  const calls = mockRpc({ ok: true });
  for (const speakers of [[], ['a', 'b', 'c', 'd', 'e'], 'proskope']) {
    const res = await POST(post({ ...valid, speakers }));
    assert.equal(res.status, 422);
  }
  assert.equal(calls.length, 0);
});

test('rejects invalid JSON', async () => {
  const res = await POST(post('{not json'));
  assert.equal(res.status, 422);
});

test('403 for origins outside ALLOWED_ORIGINS, without calling the database', async () => {
  const calls = mockRpc({ ok: true });
  for (const origin of ['https://evil.example', null]) {
    const res = await POST(post(valid, origin));
    assert.equal(res.status, 403);
  }
  assert.equal(calls.length, 0);
});

test('honeypot: pretends success, saves nothing', async () => {
  const calls = mockRpc({ ok: true });
  const res = await POST(post({ ...valid, website: 'http://spam.example' }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('502 on database errors, without leaking details', async () => {
  mockRpc('{"message":"connection refused"}', 500);
  const res = await POST(post(valid));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, error: 'server_error' });
});

test('CORS preflight only for allowed origins', async () => {
  const ok = OPTIONS(new Request('https://api.test/api/book', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type');

  const bad = OPTIONS(new Request('https://api.test/api/book', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
  assert.equal(bad.status, 403);
});
