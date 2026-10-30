import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionInfo } from '../scripts/build-version.mjs';
import { dbCheck, versionLabel } from '../public/eic-team-4k9p/js/version.js';

test('version info: package version, short commit from the host, latest migration name', () => {
  const info = versionInfo({
    version: '1.1.0',
    migrations: ['20261019120000_init.sql', '20261030090000_form_import.sql', '20261026090000_request_archive_tags.sql', 'README.md'],
    env: { VERCEL_GIT_COMMIT_SHA: '2abc9a4f00d1e2' },
    now: new Date('2026-10-30T14:00:00Z'),
  });
  assert.deepEqual(info, { version: '1.1.0', commit: '2abc9a4', builtAt: '2026-10-30T14:00:00.000Z', migration: 'form_import' });
});

test('version info: Cloudflare commit, then git, then unknown', () => {
  const base = { version: '1.0.0', migrations: [], now: new Date(0) };
  assert.equal(versionInfo({ ...base, env: { WORKERS_CI_COMMIT_SHA: 'cf12345678' } }).commit, 'cf12345');
  assert.equal(versionInfo({ ...base, env: {}, gitSha: 'abcdef123\n' }).commit, 'abcdef1');
  assert.equal(versionInfo({ ...base, env: {} }).commit, 'unknown');
  assert.equal(versionInfo({ ...base, env: {} }).migration, null);
});

test('database check: ok when the latest migration of the code is applied', () => {
  assert.deepEqual(dbCheck('form_import', ['init', 'form_import']), { ok: true, missing: null });
  assert.deepEqual(dbCheck('form_import', ['init', 'request_archive_tags']), { ok: false, missing: 'form_import' });
  assert.deepEqual(dbCheck(null, ['init']), { ok: true, missing: null }); // local run without a build
  assert.deepEqual(dbCheck('form_import', null), { ok: true, missing: null }); // database can't say (demo)
});

test('label: version, commit, database environment', () => {
  assert.equal(versionLabel({ version: '1.1.0', commit: '2abc9a4' }, 'production'), 'v1.1.0 · 2abc9a4 · production DB');
  assert.equal(versionLabel(null, 'staging'), 'dev build · staging DB');
});
