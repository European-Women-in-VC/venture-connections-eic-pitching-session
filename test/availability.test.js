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

const req = (origin) => new Request('https://api.test/api/availability', { headers: origin ? { origin } : {} });

test('maps view rows and statuses, skips empty slugs', () => {
  const out = toAvailability([
    { id: 'u1', slug: 'proskope', capacity: 4, used: 1, available: 3, status: 'available' },
    { id: 'u2', slug: 'geniel-srl', capacity: 4, used: 4, available: 0, status: 'full' },
    { id: 'u3', slug: 'over', capacity: 4, used: 5, available: 0, status: 'over_capacity' },
    { id: 'u4', slug: 'paused', capacity: 4, used: 0, available: 0, status: 'paused' },
    { id: 'u5', slug: 'closed', capacity: 4, used: 0, available: 0, status: 'closed' },
    { id: 'u6', slug: 'odd-status', capacity: 2, used: 0, available: 2, status: 'something-new' },
    { id: 'u7', slug: '', capacity: 4, used: 0, available: 4, status: 'available' },
  ]);
  assert.deepEqual(out, {
    proskope: { recordId: 'u1', capacity: 4, used: 1, available: 3, status: 'available' },
    'geniel-srl': { recordId: 'u2', capacity: 4, used: 4, available: 0, status: 'full' },
    over: { recordId: 'u3', capacity: 4, used: 5, available: 0, status: 'full' },
    paused: { recordId: 'u4', capacity: 4, used: 0, available: 0, status: 'paused' },
    closed: { recordId: 'u5', capacity: 4, used: 0, available: 0, status: 'closed' },
    'odd-status': { recordId: 'u6', capacity: 2, used: 0, available: 2, status: 'available' },
  });
});

test('reads the view with the secret key and sets CORS + cache headers', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    return Response.json([{ id: 'u1', slug: 'a', capacity: 4, used: 1, available: 3, status: 'available' }]);
  };

  const res = await GET(req('https://site.webflow.io'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    availability: { a: { recordId: 'u1', capacity: 4, used: 1, available: 3, status: 'available' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://proj.supabase.co/rest/v1/speaker_availability?select=id,slug,capacity,used,available,status',
  );
  assert.equal(calls[0].headers.apikey, 'sb_secret_test');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.webflow.io');
  assert.equal(res.headers.get('cache-control'), 'public, s-maxage=10, stale-while-revalidate=30');
});

test('cache time is configurable', async () => {
  process.env.AVAILABILITY_CACHE_SECONDS = '60';
  globalThis.fetch = async () => Response.json([]);
  const res = await GET(req());
  assert.equal(res.headers.get('cache-control'), 'public, s-maxage=60, stale-while-revalidate=180');
});

test('no CORS header for unknown origin', async () => {
  globalThis.fetch = async () => Response.json([]);
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
