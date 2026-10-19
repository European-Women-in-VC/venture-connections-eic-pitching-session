// In-memory store with fake data for trying the panel locally: http://localhost:4322/eic-team-4k9p/?demo
// Same interface as createSupabaseStore; nothing is sent anywhere.

import { computeAvailability } from './labels.js';

const SPEAKERS = [
  ['orbitra', 'Anna Kowalczyk', 'Orbitra'],
  ['nordvolt', 'Mikael Lindqvist', 'NordVolt'],
  ['helixmed', 'Sofia Marchetti', 'HelixMed'],
  ['quantaflow', 'Daniel Brenner', 'QuantaFlow'],
  ['agrisense', 'Olena Petrenko', 'AgriSense'],
  ['cyberveil', 'Tomasz Nowicki', 'CyberVeil'],
  ['lumenpay', 'Clara Dubois', 'LumenPay'],
  ['driftlogix', 'Jonas Weber', 'DriftLogix'],
];

const INVESTORS = [
  ['Laura', 'Schmidt', 'Northstar Ventures'],
  ['Pedro', 'Alves', 'Atlântico Capital'],
  ['Ingrid', 'Nilsen', 'Fjord Partners'],
  ['Marco', 'Rossi', 'Alpine Seed'],
  ['Hanna', 'Kowal', 'Vistula VC'],
  ['Elise', 'Martin', 'Seine Growth'],
  ['Jakub', 'Novak', 'Vltava Fund'],
  ['Sara', 'Lindgren', 'Baltic Angels'],
  ['<b>Tom</b>', "O'Neil", 'Escaping & Co'], // checks that names are rendered as text
];

const STATUS_CYCLE = [
  'new_request',
  'scheduled_confirmed',
  'needs_review',
  'accepted_scheduling',
  'hold_awaiting_speaker',
  'waitlisted',
  'declined',
  'new_request',
  'cancelled',
];

const DEMO_ADMIN = 'demo@localhost';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
const handle = (s) => s.replace(/\W/g, '').toLowerCase();

function seed() {
  const speakers = SPEAKERS.map(([slug, name, company], i) => ({
    id: uuid(),
    slug,
    name,
    company,
    capacity: 4,
    availability: i === 6 ? 'paused' : 'open',
    assignee: null,
    notes: null,
    archived_at: null,
    archived_by: null,
    created_at: hoursAgo(200),
    updated_at: hoursAgo(200),
  }));

  const submissions = [];
  const requests = [];
  const events = [];
  let n = 0;

  INVESTORS.forEach(([first, last, company], i) => {
    const fromPanel = i === 5;
    const sub = {
      id: uuid(),
      booking_id: fromPanel ? null : uuid(),
      email: `${handle(last)}@example.com`,
      first_name: first,
      last_name: last,
      company,
      linkedin: `linkedin.com/in/${handle(first)}-${handle(last)}`,
      speaker_slugs: [],
      status: ['todo', 'in_progress', 'confirmed', 'todo', 'done', 'todo', 'in_progress', 'test', 'todo'][i],
      source: fromPanel ? 'panel' : 'website',
      created_by: fromPanel ? DEMO_ADMIN : null,
      assignee: null,
      notes: i === 2 ? 'Prefers mornings.' : null,
      meta: { page: 'https://www.ventureconnections.co/eic-women-leadership-programme' },
      archived_at: null,
      archived_by: null,
      created_at: hoursAgo(i * 9 + 1),
      updated_at: hoursAgo(i * 9 + 1),
    };
    const picks = [0, 1, 2, 3].map((k) => speakers[(i + k * 3) % speakers.length]).slice(0, 1 + (i % 4));
    picks.forEach((sp, rank) => {
      sub.speaker_slugs.push(sp.slug);
      requests.push({
        id: uuid(),
        request_number: ++n,
        submission_id: sub.id,
        speaker_id: sp.id,
        status: STATUS_CYCLE[(i + rank) % STATUS_CYCLE.length],
        preference_rank: rank + 1,
        source: sub.source,
        created_by: sub.created_by,
        hold_until: null,
        speaker_response_at: null,
        scheduled_start: null,
        scheduled_end: null,
        confirmation_sent_at: null,
        closure_reason: null,
        assignee: null,
        internal_notes: rank === 0 && i % 3 === 0 ? 'Intro call done, waiting for speaker slots.' : null,
        created_at: sub.created_at,
        updated_at: sub.created_at,
      });
    });
    events.push({
      id: uuid(),
      submission_id: sub.id,
      booking_id: sub.booking_id,
      source: sub.source,
      created_by: sub.created_by,
      payload: fromPanel
        ? { action: 'create_investor', email: sub.email, firstName: first, lastName: last, company }
        : { email: sub.email, firstName: first, lastName: last, company, linkedin: sub.linkedin, speakers: sub.speaker_slugs, page: sub.meta.page },
      speaker_slugs: [...sub.speaker_slugs],
      added_slugs: [...sub.speaker_slugs],
      skipped_slugs: [],
      created_at: sub.created_at,
    });
    submissions.push(sub);
  });

  // Ingrid sent the form twice: second time one old speaker + one new one
  const ingrid = submissions[2];
  const extra = speakers.find((s) => !ingrid.speaker_slugs.includes(s.slug) && s.availability === 'open');
  ingrid.speaker_slugs.push(extra.slug);
  requests.push({
    ...requests.find((r) => r.submission_id === ingrid.id),
    id: uuid(),
    request_number: ++n,
    speaker_id: extra.id,
    status: 'new_request',
    preference_rank: 4,
    internal_notes: null,
    created_at: hoursAgo(3),
    updated_at: hoursAgo(3),
  });
  events.push({
    id: uuid(),
    submission_id: ingrid.id,
    booking_id: uuid(),
    source: 'website',
    created_by: null,
    payload: { email: ingrid.email, firstName: 'Ingrid', lastName: 'N.', company: 'Fjord', speakers: [ingrid.speaker_slugs[0], extra.slug] },
    speaker_slugs: [ingrid.speaker_slugs[0], extra.slug],
    added_slugs: [extra.slug],
    skipped_slugs: [ingrid.speaker_slugs[0]],
    created_at: hoursAgo(3),
  });

  return { speakers, submissions, requests, events, admins: [{ email: DEMO_ADMIN, name: 'Demo admin' }] };
}

export function createDemoStore() {
  const db = seed();
  let listener = () => {};
  const changed = () => setTimeout(listener, 50);
  const find = (table, id) => {
    const row = db[table].find((r) => r.id === id);
    if (!row) throw new Error('Row not found');
    return row;
  };
  const update = (table, id, patch) => {
    const row = Object.assign(find(table, id), patch, { updated_at: now() });
    changed();
    return Promise.resolve(clone(row));
  };
  const archive = (table, id, archived) =>
    update(table, id, { archived_at: archived ? now() : null, archived_by: archived ? DEMO_ADMIN : null });
  const fail = (message) => Promise.reject(new Error(message));

  function addRequests(submissionId, speakerIds, status = 'new_request', note = null) {
    const sub = find('submissions', submissionId);
    if (sub.archived_at) return fail('investor_not_found');
    const have = new Set(db.requests.filter((r) => r.submission_id === submissionId).map((r) => r.speaker_id));
    let rank = Math.max(0, ...db.requests.filter((r) => r.submission_id === submissionId).map((r) => r.preference_rank || 0));
    const added = [];
    for (const id of speakerIds) {
      const sp = db.speakers.find((s) => s.id === id && !s.archived_at);
      if (!sp || have.has(id)) continue;
      have.add(id);
      added.push(sp.slug);
      db.requests.push({
        id: uuid(),
        request_number: db.requests.length + 1,
        submission_id: submissionId,
        speaker_id: id,
        status,
        preference_rank: ++rank,
        source: 'panel',
        created_by: DEMO_ADMIN,
        hold_until: null,
        speaker_response_at: null,
        scheduled_start: null,
        scheduled_end: null,
        confirmation_sent_at: null,
        closure_reason: null,
        assignee: null,
        internal_notes: note || null,
        created_at: now(),
        updated_at: now(),
      });
    }
    if (added.length) {
      const picked = speakerIds.map((id) => db.speakers.find((s) => s.id === id)?.slug).filter(Boolean);
      db.events.push({
        id: uuid(),
        submission_id: submissionId,
        booking_id: null,
        source: 'panel',
        created_by: DEMO_ADMIN,
        payload: { action: 'add_requests', status, note },
        speaker_slugs: picked,
        added_slugs: added,
        skipped_slugs: picked.filter((s) => !added.includes(s)),
        created_at: now(),
      });
      sub.speaker_slugs.push(...added.filter((s) => !sub.speaker_slugs.includes(s)));
    }
    changed();
    return Promise.resolve(added.length);
  }

  return {
    async load() {
      await new Promise((r) => setTimeout(r, 150));
      const archivedSubs = new Set(db.submissions.filter((s) => s.archived_at).map((s) => s.id));
      return clone({
        speakers: [...db.speakers].sort((a, b) => a.name.localeCompare(b.name)),
        availability: db.speakers.map((s) => computeAvailability(s, db.requests, archivedSubs)),
        submissions: [...db.submissions].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        requests: [...db.requests].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        events: [...db.events].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        admins: db.admins,
      });
    },
    updateRequest: (id, patch) => update('requests', id, patch),
    updateSubmission: (id, patch) => update('submissions', id, patch),
    updateSpeaker: (id, patch) => update('speakers', id, patch),
    archiveSubmission: (id, archived) => archive('submissions', id, archived),
    archiveSpeaker: (id, archived) => archive('speakers', id, archived),
    async createSpeaker(row) {
      if (db.speakers.some((s) => s.slug === row.slug)) throw new Error('duplicate key value violates unique constraint "speakers_slug_key"');
      const created = { id: uuid(), assignee: null, notes: null, archived_at: null, archived_by: null, created_at: now(), updated_at: now(), ...row };
      db.speakers.push(created);
      changed();
      return clone(created);
    },
    addRequests,
    async createInvestor(inv) {
      const email = String(inv.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid_email');
      if (db.submissions.some((s) => s.email === email && !s.archived_at)) throw new Error('investor_exists');
      const sub = {
        id: uuid(),
        booking_id: null,
        email,
        first_name: inv.first_name || null,
        last_name: inv.last_name || null,
        company: inv.company || null,
        linkedin: inv.linkedin || null,
        speaker_slugs: [],
        status: 'todo',
        source: 'panel',
        created_by: DEMO_ADMIN,
        assignee: null,
        notes: inv.notes || null,
        meta: {},
        archived_at: null,
        archived_by: null,
        created_at: now(),
        updated_at: now(),
      };
      db.submissions.push(sub);
      db.events.push({
        id: uuid(),
        submission_id: sub.id,
        booking_id: null,
        source: 'panel',
        created_by: DEMO_ADMIN,
        payload: { action: 'create_investor', email, firstName: inv.first_name, lastName: inv.last_name, company: inv.company },
        speaker_slugs: [],
        added_slugs: [],
        skipped_slugs: [],
        created_at: now(),
      });
      if (inv.speaker_ids?.length) await addRequests(sub.id, inv.speaker_ids, inv.status);
      changed();
      return sub.id;
    },
    // fake website: one company renamed, one slug changed, one new card, one speaker removed
    async fetchWebsiteSpeakers(source = 'live') {
      await new Promise((r) => setTimeout(r, 300));
      const speakers = db.speakers
        .filter((s) => s.slug !== 'driftlogix')
        .map((s) => ({ slug: s.slug, name: s.name, company: s.company }))
        .map((s) => (s.slug === 'agrisense' ? { ...s, company: 'AgriSense Labs' } : s))
        .map((s) => (s.slug === 'cyberveil' ? { ...s, slug: 'cyberveil-security' } : s));
      speakers.push({ slug: 'exognis', name: 'Ensieh Iranmehr', company: 'Exognis' });
      return {
        source,
        url: 'https://www.ventureconnections.co/eic-women-leadership-programme',
        fetchedAt: now(),
        speakers,
        warnings: source === 'staging' ? ['Demo warning: two cards use the slug “orbitra” with different names.'] : [],
      };
    },
    subscribe(onChange, onLive) {
      listener = onChange;
      setTimeout(() => onLive(true), 300);
      return () => {
        listener = () => {};
      };
    },
  };
}
