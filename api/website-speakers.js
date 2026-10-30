// GET /api/website-speakers?source=live|staging
// Reads the published Webflow page and returns the speaker cards on it, in page order:
// { source, url, fetchedAt, speakers: [{ slug, name, company }], warnings: [] }
//
// The cards carry the data in the card checkbox embed:
//   <label data-speaker-toggle data-speaker="{{Slug}}" data-speaker-name="…" data-speaker-company="…">
// Only the fixed pages below can be fetched (no user-supplied URLs).

import { assignSpeakerKeys } from '../lib/speaker-keys.js';

// read on use (on Cloudflare the env is filled per request, after this module is loaded)
export const pages = () => ({
  live: process.env.WEBSITE_URL_LIVE || 'https://www.ventureconnections.co/eic-women-leadership-programme',
  staging:
    process.env.WEBSITE_URL_STAGING || 'https://ventureconnections-co.webflow.io/eic-women-leadership-programme',
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function attributes(tag) {
  const attrs = {};
  const re = /([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

const clean = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

// Cards in page order with clean, unique keys (same rules as the page script, lib/speaker-keys.js).
// A card repeated for the same person (e.g. desktop + mobile) is listed once.
export function parseSpeakers(html) {
  const tags = html.match(/<[a-z][^>]*\bdata-speaker-toggle\b[^>]*>/gi) || [];
  const cards = tags.map((tag) => {
    const a = attributes(tag);
    return { slug: clean(a['data-speaker']), name: clean(a['data-speaker-name']), company: clean(a['data-speaker-company']) };
  });
  const keys = assignSpeakerKeys(cards);

  const speakers = [];
  const warnings = [];
  const seen = new Set();
  cards.forEach((card, i) => {
    const { key, reason } = keys[i];
    if (seen.has(key)) return;
    seen.add(key);
    speakers.push({ slug: key, name: card.name, company: card.company });
    const who = card.name || card.company || 'a card';
    if (reason === 'empty data-speaker') warnings.push(`${who}: the card has no data-speaker; using “${key}” (from the company name).`);
    else if (reason === 'duplicate of another card') warnings.push(`${who}: data-speaker “${card.slug}” is already used by another card (copied card?); using “${key}”.`);
    else if (reason === 'cleaned up') warnings.push(`${who}: data-speaker “${card.slug}” was cleaned up to “${key}”.`);
  });
  return { speakers, warnings };
}

// Read one of the fixed pages. maxAgeMs > 0 reuses a recent copy (used by auto-registration,
// which can be called by every visitor); the panel's comparison always reads it fresh.
const pageCache = new Map(); // source → { at, result }
export async function readWebsiteSpeakers(source, maxAgeMs = 0) {
  const cached = pageCache.get(source);
  if (maxAgeMs > 0 && cached && Date.now() - cached.at < maxAgeMs) return cached.result;

  const url = pages()[source];
  // cache-buster: get the page as published now, not an older CDN copy
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
    headers: { Accept: 'text/html', 'User-Agent': 'EIC-bookings-sync/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Website ${res.status}`);
  const { speakers, warnings } = parseSpeakers(await res.text());
  if (!speakers.length) warnings.push('No speaker cards found on the page. Is the card checkbox embed still there?');
  const result = { source, url, fetchedAt: new Date().toISOString(), speakers, warnings };
  pageCache.set(source, { at: Date.now(), result });
  return result;
}

export async function GET(request) {
  const source = new URL(request.url).searchParams.get('source') === 'staging' ? 'staging' : 'live';
  try {
    return Response.json(await readWebsiteSpeakers(source), { headers: { 'Cache-Control': 'public, s-maxage=15' } });
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Could not read the website page', source, url: pages()[source] }, { status: 502 });
  }
}
