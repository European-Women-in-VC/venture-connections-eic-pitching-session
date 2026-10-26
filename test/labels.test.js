import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAvailability, investorStage } from '../public/eic-team-4k9p/js/labels.js';

test('investor stage follows the most urgent request', () => {
  const st = (...statuses) => investorStage(statuses.map((status) => ({ status })));
  assert.equal(st('scheduled_confirmed', 'new_request'), 'needs_action');
  assert.equal(st('needs_review', 'declined'), 'needs_action');
  assert.equal(st('accepted_scheduling', 'scheduled_confirmed'), 'in_progress');
  assert.equal(st('hold_awaiting_speaker', 'waitlisted'), 'in_progress');
  assert.equal(st('scheduled_confirmed', 'declined', 'waitlisted'), 'confirmed');
  assert.equal(st('waitlisted', 'cancelled'), 'waitlisted');
  assert.equal(st('declined', 'expired'), 'closed');
  assert.equal(st(), 'closed');
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
  ];
  const a = computeAvailability(speaker, requests, new Set(['archived-inv']), new Set(['test-inv']));
  assert.deepEqual(a, { id: 'sp', used: 2, confirmed: 1, waitlisted: 0, remaining: 2, available: 2, status: 'available' });
  assert.equal(computeAvailability({ ...speaker, archived_at: 'x' }, requests).status, 'closed');
});
