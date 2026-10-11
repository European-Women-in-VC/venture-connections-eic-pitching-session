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

test('maps Airtable capacity fields and status, skips empty slugs', () => {
  const out = toAvailability([
    { id: 'rec1', fields: { Slug: 'proskope', Capacity: 4, 'Capacity Used': 1, 'Available Places': 3, 'Capacity Status': 'Available' } },
    { id: 'rec2', fields: { Slug: ['geniel-srl'], Capacity: '4', 'Capacity Used': [4], 'Available Places': 0, 'Capacity Status': 'Full' } },
    { id: 'rec3', fields: { Slug: 'over', Capacity: 4, 'Capacity Used': 5, 'Available Places': 0, 'Capacity Status': 'Over Capacity' } },
    { id: 'rec4', fields: { Slug: 'paused', Capacity: 4, 'Capacity Used': 0, 'Available Places': 0, 'Capacity Status': 'Paused' } },
    { id: 'rec5', fields: { Slug: 'closed', Capacity: 4, 'Available Places': 0, 'Capacity Status': 'Closed' } },
    { id: 'rec6', fields: { Slug: 'no-status', Capacity: 2, 'Available Places': 2 } },
    { id: 'rec7', fields: { 'Capacity Status': 'Available' } },
  ]);
  assert.deepEqual(out, {
    proskope: { recordId: 'rec1', capacity: 4, used: 1, available: 3, status: 'available' },
    'geniel-srl': { recordId: 'rec2', capacity: 4, used: 4, available: 0, status: 'full' },
    over: { recordId: 'rec3', capacity: 4, used: 5, available: 0, status: 'full' },
    paused: { recordId: 'rec4', capacity: 4, used: 0, available: 0, status: 'paused' },
    closed: { recordId: 'rec5', capacity: 4, used: 0, available: 0, status: 'closed' },
    'no-status': { recordId: 'rec6', capacity: 2, used: 0, available: 2, status: 'available' },
  });
});

test('follows Airtable pagination and sets CORS + cache headers', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const page2 = String(url).includes('offset=');
    return Response.json(
      page2
        ? { records: [{ id: 'recB', fields: { Slug: 'b', Capacity: 4, 'Capacity Used': 4, 'Capacity Status': 'Full' } }] }
        : { records: [{ id: 'recA', fields: { Slug: 'a', Capacity: 4, 'Capacity Used': 1, 'Available Places': 3, 'Capacity Status': 'Available' } }], offset: 'next' },
    );
  };

  const res = await GET(req('https://site.webflow.io'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    availability: {
      a: { recordId: 'recA', capacity: 4, used: 1, available: 3, status: 'available' },
      b: { recordId: 'recB', capacity: 4, used: 4, available: 0, status: 'full' },
    },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v0\/appTEST\/tblTEST\?/);
  assert.equal(calls[0].auth, 'Bearer test-token');
  assert.equal(new URL(calls[0].url).searchParams.getAll('fields[]').at(-1), 'Capacity Status');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.webflow.io');
  assert.match(res.headers.get('cache-control'), /s-maxage=10/);
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
