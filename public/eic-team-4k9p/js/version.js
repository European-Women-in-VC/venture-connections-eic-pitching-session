// App version (version.json, written by `npm run build`) and the database check.

// ok unless the database is known and lacks the latest migration this code was built with
export function dbCheck(requiredMigration, appliedMigrations) {
  if (!requiredMigration || !Array.isArray(appliedMigrations)) return { ok: true, missing: null };
  const ok = appliedMigrations.includes(requiredMigration);
  return { ok, missing: ok ? null : requiredMigration };
}

export const versionLabel = (info, env) => `${info ? `v${info.version} · ${info.commit}` : 'dev build'} · ${env} DB`;

export async function loadVersion() {
  try {
    const res = await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
