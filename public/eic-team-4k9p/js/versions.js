// Page versions: one Webflow page, several links with their own speaker capacity. Pure functions: panel + tests.
// Database: page_versions, speaker_version_capacity, speaker_version_availability
// (migration 20261109090000_page_versions.sql).
//
// Glossary
//   main version     the page without a version param; its capacity is speakers.capacity
//   version          the page + ?<param_key>=<param_value>; its own pool of places per speaker
//   default capacity a version's capacity for every speaker without an override
//   override         one speaker's capacity in one (non-main) version
//   zero capacity    what the website does with a 0-capacity speaker in a version: 'unavailable' or 'hide'

import { CONFIRMED, TAKES_PLACE, hasTestTag } from './labels.js';

export const ZERO_CAPACITY = [
  { value: 'unavailable', label: 'Show as unavailable', hint: 'Card stays on the page, greyed out' },
  { value: 'hide', label: 'Hide the speaker', hint: 'Card and checkbox don’t appear on this version' },
];

export const isMain = (v) => v?.param_key == null;
export const paramText = (v) => (isMain(v) ? 'no param' : `${v.param_key}=${v.param_value}`);

export function versionLink(pageUrl, v) {
  if (isMain(v)) return pageUrl;
  const url = new URL(pageUrl);
  url.searchParams.set(v.param_key, v.param_value);
  return url.href;
}

const slug = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
export const suggestValue = (name) => slug(name).slice(0, 60).replace(/-+$/, '');

// same rules as the page_versions checks
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const RESERVED_KEYS = new Set(['fresh', 'speakers-debug']);

// drawer form → row for page_versions, or { ok: false, errors: { field: message } }.
// editingId: the version being edited (its own link isn't a duplicate). main: only name / zero / notes change.
export function parseVersionForm(raw, versions, editingId = null, { main = false } = {}) {
  const errors = {};
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 80) errors.name = 'Give the version a name (up to 80 characters).';
  const zero_capacity = raw.zero_capacity;
  if (!ZERO_CAPACITY.some((z) => z.value === zero_capacity)) errors.zero_capacity = 'Choose what happens to speakers with 0 places.';
  const notes = String(raw.notes ?? '').trim() || null;
  if (main) return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, zero_capacity, notes } };

  const param_key = String(raw.param_key ?? '').trim().toLowerCase();
  const param_value = String(raw.param_value ?? '').trim().toLowerCase();
  const default_capacity = Number(raw.default_capacity);
  if (!KEY_RE.test(param_key) || RESERVED_KEYS.has(param_key)) errors.param_key = 'Lowercase letters, numbers, - and _ (e.g. “version”).';
  if (!VALUE_RE.test(param_value)) errors.param_value = 'Lowercase letters, numbers, - and _ (e.g. “partners”).';
  else if (versions.some((v) => v.id !== editingId && v.param_key === param_key && v.param_value === param_value)) {
    errors.param_value = 'Another version already uses this link.';
  }
  if (String(raw.default_capacity ?? '').trim() === '' || !Number.isInteger(default_capacity) || default_capacity < 0 || default_capacity > 99) {
    errors.default_capacity = 'A whole number from 0 to 99.';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, param_key, param_value, default_capacity, zero_capacity, notes } };
}

// Mirror of the view speaker_version_availability (demo mode): one row per speaker × version.
export function versionAvailability(speakers, versions, overrides, requests, archivedSubmissionIds = new Set(), testSubmissionIds = new Set()) {
  const override = new Map(overrides.map((o) => [`${o.speaker_id}|${o.version_id}`, o.capacity]));
  const counted = requests.filter(
    (r) => !r.archived_at && !archivedSubmissionIds.has(r.submission_id) && !testSubmissionIds.has(r.submission_id) && !hasTestTag(r),
  );
  const rows = [];
  for (const v of versions) {
    for (const sp of speakers) {
      const own = override.get(`${sp.id}|${v.id}`);
      const capacity = isMain(v) ? sp.capacity : (own ?? v.default_capacity);
      const mine = counted.filter((r) => r.speaker_id === sp.id && r.version_id === v.id);
      const used = mine.filter((r) => TAKES_PLACE.has(r.status)).length;
      const remaining = Math.max(capacity - used, 0);
      let status = 'available';
      if (sp.archived_at) status = 'closed';
      else if (capacity === 0 && v.zero_capacity === 'hide') status = 'hidden';
      else if (used > capacity) status = 'over_capacity';
      else if (sp.availability !== 'open') status = sp.availability;
      else if (capacity === 0) status = 'unavailable';
      else if (capacity - used <= 0) status = 'full';
      rows.push({
        id: sp.id,
        version_id: v.id,
        capacity,
        is_override: own !== undefined,
        used,
        confirmed: mine.filter((r) => CONFIRMED.has(r.status)).length,
        waitlisted: mine.filter((r) => r.status === 'waitlisted').length,
        remaining,
        available: !sp.archived_at && sp.availability === 'open' ? remaining : 0,
        status,
      });
    }
  }
  return rows;
}
