import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityCacheKey } from '../worker/index.js';

const key = (query, origin = 'https://site.webflow.io') =>
  availabilityCacheKey(new URL('https://api.test/api/availability' + query), origin);

test('each page version has its own cached availability', () => {
  assert.notEqual(key(''), key('?version=partners'));
  assert.notEqual(key('?version=partners'), key('?version=other'));
  assert.notEqual(key('?version=partners', 'https://a.example'), key('?version=partners', 'https://b.example'));
});

test('same visit, same key: case, order and the fresh switch don’t matter', () => {
  assert.equal(key('?version=Partners&utm_source=x'), key('?utm_source=x&version=partners'));
  assert.equal(key('?version=partners&fresh=1'), key('?version=partners'));
});
