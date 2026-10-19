// GET /api/availability
// Returns capacity per speaker slug from the Airtable "EIC - Speakers" table:
// { "availability": { "<slug>": { "recordId": "rec…", "capacity": 4, "used": 1, "available": 3, "status": "available" } } }
//
// Capacity logic lives in Airtable (Capacity Used / Available Places / Capacity Status formulas);
// this endpoint only passes it through.

const FIELDS = ['Slug', 'Capacity', 'Capacity Used', 'Available Places', 'Capacity Status'];

// Airtable "Capacity Status" → status sent to the page
const STATUSES = {
  available: 'available',
  full: 'full',
  'over capacity': 'full',
  paused: 'paused',
  unavailable: 'unavailable',
  closed: 'closed',
};

const config = () => ({
  token: process.env.AIRTABLE_TOKEN,
  baseId: process.env.AIRTABLE_BASE_ID,
  table: process.env.AIRTABLE_TABLE || 'Speakers',
  // Airtable free plan allows ~1,000 API calls/month: cache for 5 min by default
  cacheSeconds: Number(process.env.AVAILABILITY_CACHE_SECONDS ?? 300),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
});

async function fetchAllRecords({ token, baseId, table }) {
  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  const records = [];
  let offset;

  do {
    const params = new URLSearchParams();
    FIELDS.forEach((f) => params.append('fields[]', f));
    if (offset) params.set('offset', offset);

    const res = await fetch(`${url}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

// Airtable formula/rollup fields can come back as arrays or strings
const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v) => Number(first(v)) || 0;

export function toAvailability(records) {
  const availability = {};
  for (const { id, fields: f } of records) {
    const slug = String(first(f.Slug) ?? '').trim();
    if (!slug) continue;

    const available = num(f['Available Places']);
    const rawStatus = String(first(f['Capacity Status']) ?? '').trim().toLowerCase();

    availability[slug] = {
      recordId: id, // Speakers record ID, for linking 1:1 Meetings in Make
      capacity: num(f.Capacity),
      used: num(f['Capacity Used']),
      available,
      status: STATUSES[rawStatus] || (available > 0 ? 'available' : 'full'),
    };
  }
  return availability;
}

// Per-instance copy, so requests that skip the CDN cache (e.g. ?fresh=…) don't reach Airtable either
let memo = null; // { at, availability }
export const resetCache = () => {
  memo = null;
};

export async function GET(request) {
  const cfg = config();
  const origin = request.headers.get('origin');
  const headers = { Vary: 'Origin' };
  if (origin && cfg.allowedOrigins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;

  if (!cfg.token || !cfg.baseId) {
    console.error('Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID');
    return Response.json({ error: 'Server not configured' }, { status: 500, headers });
  }

  try {
    const ttl = cfg.cacheSeconds * 1000;
    if (!memo || Date.now() - memo.at >= ttl) {
      memo = { at: Date.now(), availability: toAvailability(await fetchAllRecords(cfg)) };
    }
    return Response.json(
      { availability: memo.availability },
      {
        headers: {
          ...headers,
          'Cache-Control': `public, s-maxage=${cfg.cacheSeconds}, stale-while-revalidate=${cfg.cacheSeconds * 2}`,
        },
      },
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Failed to load availability' }, { status: 502, headers });
  }
}
