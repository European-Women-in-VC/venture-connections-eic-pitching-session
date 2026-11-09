// Query params of a page visit, cleaned once where they enter (availability + booking).
// The database picks the page version from them (public.resolve_page_version); unknown → main.
// Same limits as page_versions.param_key / param_value, so anything longer can never match.

const MAX_PARAMS = 20;
const MAX_KEY = 40;
const MAX_VALUE = 60;
const IGNORED = new Set(['fresh', 'speakers-debug']); // cache buster and debug switch of speakers.js

function entries(source) {
  if (typeof source === 'string') return [...new URLSearchParams(source)];
  if (source instanceof URLSearchParams) return [...source];
  if (source && typeof source === 'object' && !Array.isArray(source)) return Object.entries(source);
  return [];
}

// '?version=Partners' | URLSearchParams | { version: 'Partners' } → { version: 'partners' }
export function pageParams(source) {
  const out = {};
  for (const [rawKey, rawValue] of entries(source)) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (typeof rawValue !== 'string') continue;
    const key = String(rawKey).trim().toLowerCase();
    const value = rawValue.trim().toLowerCase();
    if (!key || !value || key.length > MAX_KEY || value.length > MAX_VALUE || IGNORED.has(key) || key in out) continue;
    out[key] = value;
  }
  return out;
}
