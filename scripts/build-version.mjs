// Writes public/eic-team-4k9p/version.json at build time (run by `npm run build`):
// { version (package.json), commit, builtAt, migration (latest file in supabase/migrations) }
// The panel shows it and warns when the database doesn't have that migration yet.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = /^\d{14}_(.+)\.sql$/;

export function versionInfo({ version, migrations, env, gitSha = '', now = new Date() }) {
  const sha = env.VERCEL_GIT_COMMIT_SHA || env.WORKERS_CI_COMMIT_SHA || gitSha.trim();
  const latest = migrations.filter((f) => MIGRATION.test(f)).sort().at(-1);
  return {
    version,
    commit: sha ? sha.slice(0, 7) : 'unknown',
    builtAt: now.toISOString(),
    migration: latest ? latest.match(MIGRATION)[1] : null,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  let gitSha = '';
  try {
    gitSha = execSync('git rev-parse HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    // no git on the build host: the host's commit variable or "unknown"
  }
  const info = versionInfo({
    version: JSON.parse(readFileSync(new URL('package.json', root))).version,
    migrations: readdirSync(new URL('supabase/migrations/', root)),
    env: process.env,
    gitSha,
  });
  writeFileSync(new URL('public/eic-team-4k9p/version.json', root), JSON.stringify(info, null, 2) + '\n');
  console.log(`version.json: v${info.version} · ${info.commit} · migration ${info.migration}`);
}
