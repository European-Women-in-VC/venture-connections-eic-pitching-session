import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEditProduct, memberAccess, memberStatus } from '../public/eic-team-4k9p/js/team.js';

const member = (over = {}) => ({ isOwner: false, roles: {}, disabledAt: null, hasLogin: true, lastSignInAt: '2026-10-30T10:00:00Z', ...over });

test('status: disabled wins, then invited (no sign-in yet), else active', () => {
  assert.equal(memberStatus(member()), 'active');
  assert.equal(memberStatus(member({ hasLogin: false, lastSignInAt: null })), 'invited');
  assert.equal(memberStatus(member({ hasLogin: true, lastSignInAt: null })), 'invited');
  assert.equal(memberStatus(member({ disabledAt: '2026-10-30T11:00:00Z' })), 'disabled');
});

test('access per product: owner edits everything; otherwise the role, or none', () => {
  assert.equal(memberAccess(member({ isOwner: true }), 'eic-bookings'), 'owner');
  assert.equal(memberAccess(member({ roles: { 'eic-bookings': 'viewer' } }), 'eic-bookings'), 'viewer');
  assert.equal(memberAccess(member({ roles: { 'eic-bookings': 'editor' } }), 'other'), 'none');
});

test('what the logged-in user may do in a product (from my_access)', () => {
  const access = { isOwner: false, products: [{ slug: 'eic-bookings', role: 'viewer' }] };
  assert.equal(canEditProduct(access, 'eic-bookings'), false);
  assert.equal(canEditProduct({ ...access, products: [{ slug: 'eic-bookings', role: 'editor' }] }, 'eic-bookings'), true);
  assert.equal(canEditProduct(null, 'eic-bookings'), false);
});
