import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignSpeakerKeys, slugify } from '../lib/speaker-keys.js';

const between = (file) => {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const m = src.match(/\/\/ <speaker-keys>\n([\s\S]*?)\/\/ <\/speaker-keys>/);
  assert.ok(m, `${file} has the <speaker-keys> block`);
  // the page script indents the block inside its IIFE: remove the common indentation before comparing
  const lines = m[1].split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n').trim();
};

test('the page script uses exactly the same key rules as the server', () => {
  assert.equal(between('../public/speakers.js'), between('../lib/speaker-keys.js'));
});

test('slugify', () => {
  assert.equal(slugify('SageWrite'), 'sagewrite');
  assert.equal(slugify('  V. G. Freyia Labs Ltd '), 'v-g-freyia-labs-ltd');
  assert.equal(slugify('Önal & Şirket—İstanbul'), 'onal-sirket-istanbul');
  assert.equal(slugify('kedi-mobi-l-uygulama-anoni-m-i-rketi'), 'kedi-mobi-l-uygulama-anoni-m-i-rketi'); // valid slugs stay
  assert.equal(slugify(null), '');
});

test('keys: cleanup, empty, duplicates, same person repeated', () => {
  const keys = assignSpeakerKeys([
    { slug: 'proskope', name: 'Meghan Perkins', company: 'Proskope' },
    { slug: 'proskope', name: 'Meghan Perkins', company: 'Proskope' }, // same person again (mobile copy)
    { slug: 'proskope', name: 'New Person', company: 'NewCo' }, // copied card
    { slug: 'proskope', name: 'Third Person', company: 'Proskope' }, // copied, same company text
    { slug: 'SageWrite', name: 'Elena', company: 'SageWrite' },
    { slug: '', name: 'Empty', company: '' },
  ]).map((k) => [k.key, k.reason]);
  assert.deepEqual(keys, [
    ['proskope', ''],
    ['proskope', ''],
    ['newco', 'duplicate of another card'],
    ['proskope-third-person', 'duplicate of another card'],
    ['sagewrite', 'cleaned up'],
    ['empty', 'empty data-speaker'],
  ]);
});
