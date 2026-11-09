import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageParams } from '../lib/page-params.js';

test('query string → lowercase, trimmed params (the database matches them to a version)', () => {
  assert.deepEqual(pageParams('?version=Partners&utm_source=LinkedIn'), { version: 'partners', utm_source: 'linkedin' });
  assert.deepEqual(pageParams(new URLSearchParams('Version=%20B%20')), { version: 'b' });
  assert.deepEqual(pageParams({ Version: ' Partners ' }), { version: 'partners' });
});

test('drops what can never be a version: panel helpers, empty, too long, non-text', () => {
  assert.deepEqual(pageParams('?fresh=123&speakers-debug&version=&x=' + 'a'.repeat(61) + '&ok=1'), { ok: '1' });
  assert.deepEqual(pageParams({ a: 1, b: null, c: ['x'], d: 'y' }), { d: 'y' });
  assert.deepEqual(pageParams('?' + 'k'.repeat(41) + '=v'), {});
});

test('at most 20 params; the first value of a repeated key wins', () => {
  const many = Array.from({ length: 30 }, (_, i) => `k${i}=v`).join('&');
  assert.equal(Object.keys(pageParams(many)).length, 20);
  assert.deepEqual(pageParams('?version=a&version=b'), { version: 'a' });
});

test('anything else → no params (main version)', () => {
  for (const bad of [null, undefined, 42, ['version=a'], '']) assert.deepEqual(pageParams(bad), {});
});
