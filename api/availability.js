// GET /api/availability?<the page's own query string>
// Capacity per speaker slug for the page version the visit belongs to (e.g. ?version=partners; none → main):
// { "version": { "key": "version", "value": "partners" } | null,
//   "availability": { "<slug>": { "recordId": "<speaker uuid>", "capacity": 4, "used": 1, "available": 3, "status": "available" } } }
//
// Capacity logic lives in the database (website_availability → speaker_version_availability); this endpoint only passes it through.

import { corsHeaders } from '../lib/cors.js';
import { isConfigured, supabase } from '../lib/supabase.js';
import { pageParams } from '../lib/page-params.js';

// view status → status sent to the page
const STATUSES = {
  available: 'available',
  full: 'full',
  over_capacity: 'full',
  paused: 'paused',
  unavailable: 'unavailable',
  closed: 'closed',
  hidden: 'hidden', // capacity 0 in a version set to hide such speakers
};

const cacheSeconds = () => Number(process.env.AVAILABILITY_CACHE_SECONDS ?? 10);

export function toAvailability(rows) {
  const availability = {};
  for (const row of rows) {
    const slug = String(row.slug ?? '').trim();
    if (!slug) continue;

    const available = Number(row.available) || 0;
    availability[slug] = {
      recordId: row.id,
      capacity: Number(row.capacity) || 0,
      used: Number(row.used) || 0,
      available,
      status: STATUSES[row.status] || (available > 0 ? 'available' : 'full'),
    };
  }
  return availability;
}

export async function GET(request) {
  const headers = corsHeaders(request);

  if (!isConfigured()) {
    console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY');
    return Response.json({ error: 'Server not configured' }, { status: 500, headers });
  }

  try {
    const result = await supabase('rpc/website_availability', {
      method: 'POST',
      body: { p_params: pageParams(new URL(request.url).searchParams) },
    });
    const s = cacheSeconds();
    return Response.json(
      { version: result?.version ?? null, availability: toAvailability(result?.rows || []) },
      { headers: { ...headers, 'Cache-Control': `public, s-maxage=${s}, stale-while-revalidate=${s * 3}` } },
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Failed to load availability' }, { status: 502, headers });
  }
}
