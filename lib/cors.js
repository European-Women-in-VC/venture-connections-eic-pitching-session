// CORS for the Webflow domains listed in ALLOWED_ORIGINS (comma-separated).

const allowedOrigins = () =>
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

export function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const headers = { Vary: 'Origin' };
  if (origin && allowedOrigins().includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
