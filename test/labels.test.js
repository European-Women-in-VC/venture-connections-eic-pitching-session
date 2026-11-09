import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investorStage } from '../public/eic-team-4k9p/js/labels.js';

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
