// npm run smoke [-- <base URL> …]: checks the deployed hosts after a deploy. Exit code 1 if anything fails.
// Per host: panel page, speakers.js, version.json = package.json version, availability lists speakers
// (reads through the API with the live site's origin, so missing secrets or a broken database show up).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOSTS = [
  'https://venture-connections-eic-pitching-session.oleh-boilo.workers.dev',
  'https://venture-connections-eic-pitching-se.vercel.app',
];
const ORIGIN = 'https://www.ventureconnections.co';

async function check(name, run) {
  try {
    const detail = await run();
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: err.message };
  }
}

async function get(fetch, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return res;
}

export function smokeHost(base, { fetch = globalThis.fetch, origin = ORIGIN, version }) {
  return Promise.all([
    check('panel', async () => `${(await get(fetch, `${base}/eic-team-4k9p/`)).status}`),
    check('speakers.js', async () => `${(await get(fetch, `${base}/speakers.js`)).status}`),
    check('version', async () => {
      const info = await (await get(fetch, `${base}/eic-team-4k9p/version.json?_=${Date.now()}`)).json();
      if (info.version !== version) throw new Error(`deployed ${info.version} (${info.commit}), expected ${version}`);
      return `v${info.version} · ${info.commit}`;
    }),
    check('availability', async () => {
      const body = await (await get(fetch, `${base}/api/availability?fresh=${Date.now()}`, { headers: { Origin: origin } })).json();
      const n = Object.keys(body.availability || {}).length;
      if (!n) throw new Error('no speakers returned');
      return `${n} speakers`;
    }),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const hosts = process.argv.slice(2).length ? process.argv.slice(2) : HOSTS;
  let failed = 0;
  for (const base of hosts) {
    console.log(base);
    for (const c of await smokeHost(base, { version })) {
      if (!c.ok) failed++;
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(13)} ${c.detail}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}
