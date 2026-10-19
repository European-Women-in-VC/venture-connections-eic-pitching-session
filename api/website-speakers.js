// GET /api/website-speakers?source=live|staging
// Reads the published Webflow page and returns the speaker cards on it, in page order:
// { source, url, fetchedAt, speakers: [{ slug, name, company }], warnings: [] }
//
// The cards carry the data in the card checkbox embed:
//   <label data-speaker-toggle data-speaker="{{Slug}}" data-speaker-name="…" data-speaker-company="…">
// Only the fixed pages below can be fetched (no user-supplied URLs).

const PAGES = {
  live: process.env.WEBSITE_URL_LIVE || 'https://www.ventureconnections.co/eic-women-leadership-programme',
  staging:
    process.env.WEBSITE_URL_STAGING || 'https://ventureconnections-co.webflow.io/eic-women-leadership-programme',
};

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

export function parseSpeakers(html) {
  const speakers = [];
  const warnings = [];
  const seen = new Map();
  const tags = html.match(/<[a-z][^>]*\bdata-speaker-toggle\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const a = attributes(tag);
    const speaker = {
      slug: clean(a['data-speaker']).toLowerCase(),
      name: clean(a['data-speaker-name']),
      company: clean(a['data-speaker-company']),
    };
    if (!speaker.slug) {
      warnings.push(`A card without a slug (${speaker.name || speaker.company || 'no name'}) was skipped.`);
      continue;
    }
    const earlier = seen.get(speaker.slug);
    if (earlier) {
      if (earlier.name !== speaker.name || earlier.company !== speaker.company) {
        warnings.push(`Two cards use the slug “${speaker.slug}” with different names; the first one is used.`);
      }
      continue;
    }
    seen.set(speaker.slug, speaker);
    speakers.push(speaker);
  }
  return { speakers, warnings };
}

export async function GET(request) {
  const source = new URL(request.url).searchParams.get('source') === 'staging' ? 'staging' : 'live';
  const url = PAGES[source];
  const headers = { 'Cache-Control': 'public, s-maxage=15' };

  try {
    // cache-buster: get the page as published now, not an older CDN copy
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: { Accept: 'text/html', 'User-Agent': 'EIC-bookings-sync/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Website ${res.status}`);
    const { speakers, warnings } = parseSpeakers(await res.text());
    if (!speakers.length) warnings.push('No speaker cards found on the page. Is the card checkbox embed still there?');
    return Response.json({ source, url, fetchedAt: new Date().toISOString(), speakers, warnings }, { headers });
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Could not read the website page', source, url }, { status: 502 });
  }
}
