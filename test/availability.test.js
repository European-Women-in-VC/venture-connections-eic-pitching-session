import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET, toAvailability } from '../api/availability.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co/';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.ALLOWED_ORIGINS = 'https://example.com, https://site.webflow.io/';
  delete process.env.AVAILABILITY_CACHE_SECONDS;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (origin, query = '') =>
  new Request('https://api.test/api/availability' + query, { headers: origin ? { origin } : {} });

test('maps view rows and statuses, skips empty slugs', () => {
  const out = toAvailability([
    { id: 'u1', slug: 'proskope', capacity: 4, used: 1, available: 3, status: 'available' },
    { id: 'u2', slug: 'geniel-srl', capacity: 4, used: 4, available: 0, status: 'full' },
    { id: 'u3', slug: 'over', capacity: 4, used: 5, available: 0, status: 'over_capacity' },
    { id: 'u4', slug: 'paused', capacity: 4, used: 0, available: 0, status: 'paused' },
    { id: 'u5', slug: 'closed', capacity: 4, used: 0, available: 0, status: 'closed' },
    { id: 'u6', slug: 'odd-status', capacity: 2, used: 0, available: 2, status: 'something-new' },
    { id: 'u7', slug: '', capacity: 4, used: 0, available: 4, status: 'available' },
    { id: 'u8', slug: 'hidden', capacity: 0, used: 0, available: 0, status: 'hidden' },
    { id: 'u9', slug: 'zero', capacity: 0, used: 0, available: 0, status: 'unavailable' },
  ]);
  assert.deepEqual(out, {
    proskope: { recordId: 'u1', capacity: 4, used: 1, available: 3, status: 'available' },
    'geniel-srl': { recordId: 'u2', capacity: 4, used: 4, available: 0, status: 'full' },
    over: { recordId: 'u3', capacity: 4, used: 5, available: 0, status: 'full' },
    paused: { recordId: 'u4', capacity: 4, used: 0, available: 0, status: 'paused' },
    closed: { recordId: 'u5', capacity: 4, used: 0, available: 0, status: 'closed' },
    'odd-status': { recordId: 'u6', capacity: 2, used: 0, available: 2, status: 'available' },
    hidden: { recordId: 'u8', capacity: 0, used: 0, available: 0, status: 'hidden' },
    zero: { recordId: 'u9', capacity: 0, used: 0, available: 0, status: 'unavailable' },
  });
});

test('asks the database for the visit\'s version (page params) with the secret key; CORS + cache headers', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
    return Response.json({
      version: { key: 'version', value: 'partners' },
      rows: [{ id: 'u1', slug: 'a', capacity: 2, used: 1, available: 1, status: 'available' }],
    });
  };

  const res = await GET(req('https://site.webflow.io', '?version=Partners&fresh=123'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    version: { key: 'version', value: 'partners' },
    availability: { a: { recordId: 'u1', capacity: 2, used: 1, available: 1, status: 'available' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/rpc/website_availability');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { p_params: { version: 'partners' } });
  assert.equal(calls[0].headers.apikey, 'sb_secret_test');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.webflow.io');
  assert.equal(res.headers.get('cache-control'), 'public, s-maxage=10, stale-while-revalidate=30');
});

test('no params → main version (version: null)', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ version: null, rows: [] });
  };
  const res = await GET(req());
  assert.deepEqual(await res.json(), { version: null, availability: {} });
  assert.deepEqual(calls, [{ p_params: {} }]);
});

test('cache time is configurable', async () => {
  process.env.AVAILABILITY_CACHE_SECONDS = '60';
  globalThis.fetch = async () => Response.json({ version: null, rows: [] });
  const res = await GET(req());
  assert.equal(res.headers.get('cache-control'), 'public, s-maxage=60, stale-while-revalidate=180');
});

test('no CORS header for unknown origin', async () => {
  globalThis.fetch = async () => Response.json({ version: null, rows: [] });
  const res = await GET(req('https://evil.example'));
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('502 on Supabase error, without leaking details', async () => {
  globalThis.fetch = async () => new Response('{"message":"permission denied"}', { status: 401 });
  const res = await GET(req('https://example.com'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Failed to load availability' });
});

test('500 when env is missing', async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  const res = await GET(req());
  assert.equal(res.status, 500);
});
