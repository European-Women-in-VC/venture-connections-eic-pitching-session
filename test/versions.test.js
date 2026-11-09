import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMain,
  paramText,
  parseVersionForm,
  suggestValue,
  versionAvailability,
  versionLink,
} from '../public/eic-team-4k9p/js/versions.js';

const PAGE = 'https://www.ventureconnections.co/eic-women-leadership-programme';
const main = { id: 'main', name: 'Main', param_key: null, param_value: null, default_capacity: null, zero_capacity: 'unavailable', created_at: '2026-01-01' };
const partners = { id: 'p', name: 'Partners', param_key: 'version', param_value: 'partners', default_capacity: 2, zero_capacity: 'hide', created_at: '2026-02-01' };

test('link per version: main = the page itself, others add their param', () => {
  assert.equal(versionLink(PAGE, main), PAGE);
  assert.equal(versionLink(PAGE, partners), PAGE + '?version=partners');
  assert.equal(versionLink(PAGE + '?lang=en', partners), PAGE + '?lang=en&version=partners');
  assert.equal(paramText(main), 'no param');
  assert.equal(paramText(partners), 'version=partners');
  assert.equal(isMain(main), true);
  assert.equal(isMain(partners), false);
});

test('value suggested from the name', () => {
  assert.equal(suggestValue('Partners – Q4 Ünicorns!'), 'partners-q4-unicorns');
  assert.equal(suggestValue('  '), '');
});

test('form: key prefilled, value required, cleaned to the database rules', () => {
  const ok = parseVersionForm({ name: ' Angels ', param_key: 'Version', param_value: ' Angels-2026 ', default_capacity: '3', zero_capacity: 'hide', notes: '' }, [main, partners]);
  assert.deepEqual(ok, {
    ok: true,
    value: { name: 'Angels', param_key: 'version', param_value: 'angels-2026', default_capacity: 3, zero_capacity: 'hide', notes: null },
  });

  const bad = parseVersionForm({ name: '', param_key: 'fresh', param_value: 'has space', default_capacity: '-1', zero_capacity: 'x' }, [main]);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['default_capacity', 'name', 'param_key', 'param_value', 'zero_capacity']);
});

test('form: the same link twice is refused, except for the version being edited', () => {
  const raw = { name: 'P2', param_key: 'version', param_value: 'partners', default_capacity: '2', zero_capacity: 'unavailable' };
  assert.match(parseVersionForm(raw, [main, partners]).errors.param_value, /already/);
  assert.equal(parseVersionForm(raw, [main, partners], 'p').ok, true);
});

test('form: the main version keeps no param and no default capacity', () => {
  const res = parseVersionForm({ name: 'Main page', zero_capacity: 'hide', notes: 'x' }, [main], 'main', { main: true });
  assert.deepEqual(res, { ok: true, value: { name: 'Main page', zero_capacity: 'hide', notes: 'x' } });
});

// same rules as the database view speaker_version_availability (demo mode uses this)
test('capacity per speaker × version: separate pools, overrides, 0 shown or hidden', () => {
  const speakers = [
    { id: 'a', capacity: 4, availability: 'open' },
    { id: 'b', capacity: 4, availability: 'open' },
    { id: 'c', capacity: 4, availability: 'paused' },
  ];
  const overrides = [{ speaker_id: 'b', version_id: 'p', capacity: 0 }];
  const requests = [
    { speaker_id: 'a', version_id: 'main', status: 'new_request', submission_id: 's1', tags: [] },
    { speaker_id: 'a', version_id: 'p', status: 'accepted_scheduling', submission_id: 's2', tags: [] },
    { speaker_id: 'a', version_id: 'p', status: 'new_request', submission_id: 's3', tags: [] },
    { speaker_id: 'a', version_id: 'p', status: 'new_request', submission_id: 'test-sub', tags: [] },
  ];
  const rows = versionAvailability(speakers, [main, partners], overrides, requests, new Set(), new Set(['test-sub']));
  const row = (s, v) => rows.find((r) => r.id === s && r.version_id === v);

  assert.deepEqual(
    { ...row('a', 'main') },
    { id: 'a', version_id: 'main', capacity: 4, is_override: false, used: 1, confirmed: 0, waitlisted: 0, remaining: 3, available: 3, status: 'available' },
  );
  assert.equal(row('a', 'p').capacity, 2); // version default
  assert.equal(row('a', 'p').used, 2); // own pool; test investor not counted
  assert.equal(row('a', 'p').status, 'full');
  assert.equal(row('b', 'p').is_override, true);
  assert.equal(row('b', 'p').status, 'hidden'); // 0 + version hides
  assert.equal(row('c', 'p').status, 'paused');

  const shown = versionAvailability(speakers, [main, { ...partners, zero_capacity: 'unavailable' }], overrides, requests);
  assert.equal(shown.find((r) => r.id === 'b' && r.version_id === 'p').status, 'unavailable');
});

test('availability ignores archived requests, archived/test investors and test-tagged requests', () => {
  const speaker = { id: 'sp', capacity: 4, availability: 'open' };
  const requests = [
    { speaker_id: 'sp', submission_id: 'a', status: 'new_request', tags: [] },
    { speaker_id: 'sp', submission_id: 'b', status: 'scheduled_confirmed', tags: [] },
    { speaker_id: 'sp', submission_id: 'c', status: 'new_request', tags: [], archived_at: '2026-10-01' },
    { speaker_id: 'sp', submission_id: 'd', status: 'new_request', tags: ['test'] },
    { speaker_id: 'sp', submission_id: 'archived-inv', status: 'new_request', tags: [] },
    { speaker_id: 'sp', submission_id: 'test-inv', status: 'new_request', tags: [] },
    { speaker_id: 'other', submission_id: 'a', status: 'new_request', tags: [] },
  ].map((r) => ({ ...r, version_id: 'main' }));
  const [a] = versionAvailability([speaker], [main], [], requests, new Set(['archived-inv']), new Set(['test-inv']));
  assert.deepEqual(a, { id: 'sp', version_id: 'main', capacity: 4, is_override: false, used: 2, confirmed: 1, waitlisted: 0, remaining: 2, available: 2, status: 'available' });
  assert.equal(versionAvailability([{ ...speaker, archived_at: 'x' }], [main], [], requests)[0].status, 'closed');
});
