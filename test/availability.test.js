import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET, toAvailability } from '../api/availability.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.AIRTABLE_TOKEN = 'test-token';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  process.env.AIRTABLE_TABLE = 'tblTEST';
  process.env.ALLOWED_ORIGINS = 'https://example.com, https://site.webflow.io/';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (origin) => new Request('https://api.test/api/availability', { headers: origin ? { origin } : {} });

test('maps records, skips empty slugs, defaults capacity', () => {
  const out = toAvailability([
    { fields: { Slug: 'nordvolt', Booked: 2, Capacity: 4 } },
    { fields: { Slug: 'agrisense' } },
    { fields: { Slug: ['cyberveil'], Booked: [4], Capacity: '4' } },
    { fields: { Booked: 1 } },
  ]);
  assert.deepEqual(out, {
    nordvolt: { booked: 2, capacity: 4 },
    agrisense: { booked: 0, capacity: 4 },
    cyberveil: { booked: 4, capacity: 4 },
  });
});

test('follows Airtable pagination and sets CORS + cache headers', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const page2 = String(url).includes('offset=');
    return Response.json(
      page2
        ? { records: [{ fields: { Slug: 'b', Booked: 4 } }] }
        : { records: [{ fields: { Slug: 'a', Booked: 1 } }], offset: 'next' },
    );
  };

  const res = await GET(req('https://site.webflow.io'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    availability: { a: { booked: 1, capacity: 4 }, b: { booked: 4, capacity: 4 } },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v0\/appTEST\/tblTEST\?/);
  assert.equal(calls[0].auth, 'Bearer test-token');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.webflow.io');
  assert.match(res.headers.get('cache-control'), /s-maxage=15/);
});

test('no CORS header for unknown origin', async () => {
  globalThis.fetch = async () => Response.json({ records: [] });
  const res = await GET(req('https://evil.example'));
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('502 on Airtable error, without leaking details', async () => {
  globalThis.fetch = async () => new Response('INVALID_PERMISSIONS', { status: 403 });
  const res = await GET(req('https://example.com'));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'Failed to load availability' });
});

test('500 when env is missing', async () => {
  delete process.env.AIRTABLE_TOKEN;
  const res = await GET(req());
  assert.equal(res.status, 500);
});
