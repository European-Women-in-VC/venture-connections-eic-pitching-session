import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GET, decodeEntities, parseSpeakers } from '../api/website-speakers.js';
import { changeFor, diffSpeakers } from '../public/eic-team-4k9p/js/sync.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const card = (slug, name, company) =>
  `<div class="comps_card"><div class="w-embed"><label class="speaker-check" data-speaker-toggle data-speaker="${slug}" data-speaker-name="${name}" data-speaker-company="${company}"><input type="checkbox"></label></div></div>`;

test('parses speaker cards in page order, decodes entities, dedupes, warns', () => {
  const html = [
    card('geniel-srl', 'Cinzia Coppola', 'Geniel srl'),
    card('kedi', 'Tuğba Önal Suzek', 'KEDİ MOBİL &amp; Co'),
    card('quantonite', 'Isabell  Kunst ', 'quantonite'),
    card('geniel-srl', 'Cinzia Coppola', 'Geniel srl'), // same card twice (e.g. desktop + mobile)
    card('geniel-srl', 'Someone Else', 'Geniel srl'),
    card('', 'No Slug', 'Nowhere'),
    `<label data-speaker-toggle data-speaker='single-quoted' data-speaker-name='O&#39;Neil' data-speaker-company=Acme>`,
  ].join('\n');

  const { speakers, warnings } = parseSpeakers(html);
  assert.deepEqual(speakers, [
    { slug: 'geniel-srl', name: 'Cinzia Coppola', company: 'Geniel srl' },
    { slug: 'kedi', name: 'Tuğba Önal Suzek', company: 'KEDİ MOBİL & Co' },
    { slug: 'quantonite', name: 'Isabell Kunst', company: 'quantonite' },
    { slug: 'single-quoted', name: "O'Neil", company: 'Acme' },
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /geniel-srl/);
  assert.match(warnings[1], /without a slug/);
});

test('decodes numeric and named entities', () => {
  assert.equal(decodeEntities('&#x130;&#304;&quot;&nbsp;&unknown;'), 'İİ" &unknown;');
});

test('endpoint fetches only the fixed pages and returns the cards', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(card('a', 'Ann', 'A Co'));
  };
  const res = await GET(new Request('https://x/api/website-speakers?source=staging&url=https://evil.example'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, 'staging');
  assert.deepEqual(body.speakers, [{ slug: 'a', name: 'Ann', company: 'A Co' }]);
  assert.match(urls[0], /^https:\/\/ventureconnections-co\.webflow\.io\/eic-women-leadership-programme\?_=\d+$/);

  await GET(new Request('https://x/api/website-speakers?source=whatever'));
  assert.match(urls[1], /^https:\/\/www\.ventureconnections\.co\//);
});

test('endpoint reports a website error as 502', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const res = await GET(new Request('https://x/api/website-speakers'));
  assert.equal(res.status, 502);
});

const db = [
  { id: '1', slug: 'geniel-srl', name: 'Cinzia Coppola', company: 'Geniel srl', availability: 'open' },
  { id: '2', slug: 'quantonite', name: 'Isabell Kunst', company: 'quantonite', availability: 'open' },
  { id: '3', slug: 'old-slug', name: 'Mari Taipale', company: 'CH-Bioforce', availability: 'open' },
  { id: '4', slug: 'gone', name: 'Gone Person', company: 'Gone Co', availability: 'open' },
  { id: '5', slug: 'already-closed', name: 'Closed Person', company: 'X', availability: 'closed' },
];

test('diff: in sync, changed name/company, renamed slug, new, missing', () => {
  const site = [
    { slug: 'geniel-srl', name: 'Cinzia Coppola', company: 'Geniel  srl ' }, // only whitespace differs
    { slug: 'quantonite', name: 'Isabell Kunst', company: 'Quantonite GmbH' },
    { slug: 'ch-bioforce-oy', name: 'mari taipale', company: 'CH-Bioforce Oy' },
    { slug: 'exognis', name: 'Ensieh Iranmehr', company: 'Exognis' },
  ];
  const { suggestions, inSync } = diffSpeakers(db, site, new Map([['4', 2]]));
  assert.equal(inSync, 1);
  assert.deepEqual(
    suggestions.map((s) => [s.type, s.speaker?.slug ?? s.site.slug, s.fields ?? s.requests]),
    [
      ['update', 'quantonite', { company: 'Quantonite GmbH' }],
      ['slug', 'old-slug', { slug: 'ch-bioforce-oy', name: 'mari taipale', company: 'CH-Bioforce Oy' }],
      ['add', 'exognis', undefined],
      ['missing', 'gone', 2],
    ],
  );
});

test('changeFor turns suggestions into database changes', () => {
  const site = [{ slug: 'exognis', name: 'Ensieh Iranmehr', company: 'Exognis' }];
  const { suggestions } = diffSpeakers([db[3]], site);
  assert.deepEqual(changeFor(suggestions.find((s) => s.type === 'add')), {
    create: { slug: 'exognis', name: 'Ensieh Iranmehr', company: 'Exognis', capacity: 4, availability: 'open' },
  });
  assert.deepEqual(changeFor(suggestions.find((s) => s.type === 'missing')), { id: '4', update: { availability: 'closed' } });
});

test('archived speakers: restore when the card is on the website, ignore otherwise', () => {
  const dbWithArchive = [
    { id: 'a', slug: 'back', name: 'Back Again', company: 'Old Co', availability: 'open', archived_at: '2026-10-01T00:00:00Z' },
    { id: 'b', slug: 'gone-for-good', name: 'Gone', company: 'G', availability: 'open', archived_at: '2026-10-01T00:00:00Z' },
  ];
  const { suggestions } = diffSpeakers(dbWithArchive, [{ slug: 'back', name: 'Back Again', company: 'New Co' }]);
  assert.deepEqual(suggestions.map((s) => [s.type, s.speaker.slug]), [['restore', 'back']]);
  assert.deepEqual(changeFor(suggestions[0]), { id: 'a', update: { company: 'New Co', archived_at: null } });
});
