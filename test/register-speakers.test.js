import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../api/register-speakers.js';
import { pageSourceFor } from '../lib/register-speakers.js';

const realFetch = globalThis.fetch;
const ORIGIN = 'https://www.ventureconnections.co';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  process.env.ALLOWED_ORIGINS = `${ORIGIN},https://ventureconnections-co.webflow.io`;
  delete process.env.AUTO_SPEAKER_AVAILABILITY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const card = (slug, name, company) =>
  `<label data-speaker-toggle data-speaker="${slug}" data-speaker-name="${name}" data-speaker-company="${company}">`;

// fake website + database; returns the calls so tests can inspect them
function fakeBackend({ pageHtml, dbSlugs }) {
  const calls = { pages: [], inserts: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('supabase.co')) {
      calls.pages.push(u);
      return new Response(pageHtml);
    }
    if ((opts.method || 'GET') === 'GET') {
      const asked = decodeURIComponent(u).match(/slug=in\.\(([^)]*)\)/)[1].split(',');
      return Response.json(asked.filter((s) => dbSlugs.includes(s)).map((slug) => ({ slug })));
    }
    const rows = JSON.parse(opts.body);
    calls.inserts.push({ url: u, prefer: opts.headers.Prefer, rows });
    return Response.json(rows.map(({ slug }) => ({ slug })));
  };
  return calls;
}

const post = (speakers, origin = ORIGIN) =>
  new Request('https://api.test/api/register-speakers', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin && { origin }) },
    body: JSON.stringify({ speakers }),
  });

test('adds a new card from the live page, with name/company from the page', async () => {
  const calls = fakeBackend({
    pageHtml: card('proskope', 'Meghan Perkins', 'Proskope') + card('SageWrite', 'Elena Callegari', 'SageWrite'),
    dbSlugs: ['proskope'],
  });
  // the visitor's request can't change name/company
  const res = await POST(post([{ slug: 'sagewrite', name: 'Hacker', company: 'Evil' }, { slug: 'proskope' }]));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { added: ['sagewrite'], notOnPage: [] });
  assert.equal(calls.inserts.length, 1);
  assert.match(calls.inserts[0].url, /speakers\?on_conflict=slug/);
  assert.match(calls.inserts[0].prefer, /ignore-duplicates/);
  const [row] = calls.inserts[0].rows;
  assert.deepEqual({ ...row, notes: undefined }, {
    slug: 'sagewrite', name: 'Elena Callegari', company: 'SageWrite', capacity: 4, availability: 'open', notes: undefined,
  });
  assert.match(row.notes, /Added automatically from the live website card/);
  assert.match(calls.pages[0], /^https:\/\/www\.ventureconnections\.co\//);
});

test('refuses speakers that are not on the page', async () => {
  const calls = fakeBackend({ pageHtml: card('proskope', 'Meghan Perkins', 'Proskope'), dbSlugs: ['proskope'] });
  const res = await POST(post([{ slug: 'invented-speaker' }, { slug: '../bad slug' }]));
  assert.deepEqual(await res.json(), { added: [], notOnPage: ['invented-speaker'] });
  assert.equal(calls.inserts.length, 0);
});

test('does nothing when everything is already in the database (no page read)', async () => {
  const calls = fakeBackend({ pageHtml: '', dbSlugs: ['proskope', 'sagewrite'] });
  const res = await POST(post([{ slug: 'proskope' }, { slug: 'sagewrite' }]));
  assert.deepEqual(await res.json(), { added: [], notOnPage: [] });
  assert.equal(calls.pages.length, 0);
});

test('webflow.io visitors are checked against the staging page; start state is configurable', async () => {
  process.env.AUTO_SPEAKER_AVAILABILITY = 'paused';
  const calls = fakeBackend({ pageHtml: card('newco', 'New Person', 'NewCo'), dbSlugs: [] });
  await POST(post([{ slug: 'newco' }], 'https://ventureconnections-co.webflow.io'));
  assert.match(calls.pages[0], /ventureconnections-co\.webflow\.io/);
  assert.equal(calls.inserts[0].rows[0].availability, 'paused');
  assert.equal(pageSourceFor('https://www.ventureconnections.co'), 'live');
  assert.equal(pageSourceFor('not a url'), 'live');
});

test('403 for other origins', async () => {
  const calls = fakeBackend({ pageHtml: '', dbSlugs: [] });
  const res = await POST(post([{ slug: 'x' }], 'https://evil.example'));
  assert.equal(res.status, 403);
  assert.equal(calls.pages.length + calls.inserts.length, 0);
});
