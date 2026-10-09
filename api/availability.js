// GET /api/availability
// Returns booking counts per speaker slug from Airtable:
// { "availability": { "<slug>": { "booked": 2, "capacity": 4, "recordId": "rec…" } } }

const DEFAULT_CAPACITY = 4;

const config = () => ({
  token: process.env.AIRTABLE_TOKEN,
  baseId: process.env.AIRTABLE_BASE_ID,
  table: process.env.AIRTABLE_TABLE || 'Speakers',
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
    ['Slug', 'Capacity', 'Booked'].forEach((f) => params.append('fields[]', f));
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

export function toAvailability(records) {
  const availability = {};
  for (const { id, fields: f } of records) {
    const slug = String(first(f.Slug) ?? '').trim();
    if (!slug) continue;
    availability[slug] = {
      booked: Number(first(f.Booked)) || 0,
      capacity: Number(first(f.Capacity)) || DEFAULT_CAPACITY,
      recordId: id, // Speakers record ID, for the Bookings → Speakers link in Make
    };
  }
  return availability;
}

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
    const availability = toAvailability(await fetchAllRecords(cfg));
    return Response.json(
      { availability },
      { headers: { ...headers, 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=60' } },
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Failed to load availability' }, { status: 502, headers });
  }
}
