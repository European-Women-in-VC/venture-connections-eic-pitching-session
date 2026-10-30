// Cloudflare Worker entry: the same /api/* endpoints as on Vercel, everything else from public/ (static assets).
//
// Environments (one Worker, see wrangler.jsonc):
//   production  — `wrangler deploy` from main: SUPABASE_URL / SUPABASE_SECRET_KEY
//   staging     — `wrangler versions upload --var APP_ENV:staging` from other branches (preview URLs):
//                 STAGING_SUPABASE_URL / STAGING_SUPABASE_SECRET_KEY

import * as availability from '../api/availability.js';
import * as book from '../api/book.js';
import * as registerSpeakers from '../api/register-speakers.js';
import * as teamLink from '../api/team-link.js';
import * as websiteSpeakers from '../api/website-speakers.js';

const ROUTES = {
  '/api/availability': availability,
  '/api/book': book,
  '/api/register-speakers': registerSpeakers,
  '/api/team-link': teamLink,
  '/api/website-speakers': websiteSpeakers,
};

// The handlers read process.env (as on Vercel): fill it from the Worker's vars and secrets.
function applyEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[key] = value;
  }
  if (env.APP_ENV === 'staging') {
    process.env.SUPABASE_URL = env.STAGING_SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = env.STAGING_SUPABASE_SECRET_KEY;
  }
}

// GET /api/availability: short cache like Vercel's CDN (s-maxage). The Cache API works on custom domains;
// on *.workers.dev it is a no-op, so a per-instance memory copy covers that case. ?fresh=… skips both.
const memory = new Map(); // origin → { until, body, headers, status }
async function cachedAvailability(request, ctx, handler) {
  const url = new URL(request.url);
  if (url.searchParams.has('fresh')) return handler(request);

  const origin = request.headers.get('origin') || '';
  const seconds = Number(process.env.AVAILABILITY_CACHE_SECONDS ?? 10);
  const hit = memory.get(origin);
  if (hit && hit.until > Date.now()) return new Response(hit.body, { status: hit.status, headers: hit.headers });

  const cacheKey = new Request(`${url.origin}/api/availability?origin=${encodeURIComponent(origin)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const res = await handler(request);
  if (res.ok) {
    const body = await res.clone().text();
    const headers = Object.fromEntries(res.headers);
    memory.set(origin, { until: Date.now() + seconds * 1000, body, headers, status: res.status });
    const toCache = new Response(body, { headers: { ...headers, 'Cache-Control': `public, max-age=${seconds}` } });
    ctx.waitUntil(caches.default.put(cacheKey, toCache));
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = ROUTES[url.pathname.replace(/\/+$/, '')];
    if (!route) return env.ASSETS.fetch(request);

    applyEnv(env);
    const handler = route[request.method];
    if (!handler) {
      const allow = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k)).join(', ');
      return new Response('Method not allowed', { status: 405, headers: { Allow: allow } });
    }
    if (route === availability && request.method === 'GET') return cachedAvailability(request, ctx, handler);
    return handler(request);
  },
};
