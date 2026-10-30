import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smokeHost } from '../scripts/smoke.mjs';

const BASE = 'https://host.example';
const site = (overrides = {}) => {
  const routes = {
    '/eic-team-4k9p/': () => new Response('<html>panel</html>'),
    '/speakers.js': () => new Response('/* speakers */'),
    '/eic-team-4k9p/version.json': () => Response.json({ version: '1.1.0', commit: 'abc1234' }),
    '/api/availability': (req) =>
      req.headers.get('origin') === 'https://www.ventureconnections.co'
        ? Response.json({ availability: { proskope: { available: 4 }, bitagreen: { available: 1 } } })
        : new Response('forbidden', { status: 403 }),
    ...overrides,
  };
  return async (url, init = {}) => {
    const req = new Request(url, init);
    return (routes[new URL(url).pathname] || (() => new Response('', { status: 404 })))(req);
  };
};

const run = (fetch, version = '1.1.0') =>
  smokeHost(BASE, { fetch, origin: 'https://www.ventureconnections.co', version });

test('a healthy host passes every check', async () => {
  const checks = await run(site());
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [
    ['panel', true],
    ['speakers.js', true],
    ['version', true],
    ['availability', true],
  ]);
  assert.match(checks[3].detail, /2 speakers/);
});

test('missing secrets (500 from the API) fail the availability check', async () => {
  const checks = await run(site({ '/api/availability': () => Response.json({ error: 'Server not configured' }, { status: 500 }) }));
  const availability = checks.find((c) => c.name === 'availability');
  assert.equal(availability.ok, false);
  assert.match(availability.detail, /500.*Server not configured/);
});

test('an older deploy fails the version check; no speakers fails availability', async () => {
  const checks = await run(site({ '/api/availability': () => Response.json({ availability: {} }) }), '1.2.0');
  assert.equal(checks.find((c) => c.name === 'version').ok, false);
  assert.match(checks.find((c) => c.name === 'version').detail, /1\.1\.0.*expected 1\.2\.0/);
  assert.equal(checks.find((c) => c.name === 'availability').ok, false);
});
