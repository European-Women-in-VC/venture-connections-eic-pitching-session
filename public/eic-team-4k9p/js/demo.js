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

const uuid = () => crypto.randomUUID();
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));

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
    created_at: hoursAgo(200),
    updated_at: hoursAgo(200),
  }));

  const submissions = [];
  const requests = [];
  let n = 0;
  INVESTORS.forEach(([first, last, company], i) => {
    const sub = {
      id: uuid(),
      booking_id: uuid(),
      email: `${last.replace(/\W/g, '').toLowerCase()}@example.com`,
      first_name: first,
      last_name: last,
      company,
      linkedin: `linkedin.com/in/${first.replace(/\W/g, '').toLowerCase()}-${last.replace(/\W/g, '').toLowerCase()}`,
      speaker_slugs: [],
      status: ['todo', 'in_progress', 'confirmed', 'todo', 'done', 'todo', 'in_progress', 'test', 'todo'][i],
      assignee: null,
      notes: i === 2 ? 'Prefers mornings.' : null,
      meta: { page: 'https://www.ventureconnections.co/eic-women-leadership-programme' },
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
    submissions.push(sub);
  });

  return { speakers, submissions, requests, admins: [{ email: 'demo@localhost', name: 'Demo admin' }] };
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
    const row = Object.assign(find(table, id), patch, { updated_at: new Date().toISOString() });
    changed();
    return Promise.resolve(clone(row));
  };

  return {
    async load() {
      await new Promise((r) => setTimeout(r, 150));
      return clone({
        speakers: [...db.speakers].sort((a, b) => a.name.localeCompare(b.name)),
        availability: db.speakers.map((s) => computeAvailability(s, db.requests)),
        submissions: [...db.submissions].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        requests: [...db.requests].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        admins: db.admins,
      });
    },
    updateRequest: (id, patch) => update('requests', id, patch),
    updateSubmission: (id, patch) => update('submissions', id, patch),
    updateSpeaker: (id, patch) => update('speakers', id, patch),
    async createSpeaker(row) {
      if (db.speakers.some((s) => s.slug === row.slug)) throw new Error('duplicate key value violates unique constraint "speakers_slug_key"');
      const created = { id: uuid(), assignee: null, notes: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
      db.speakers.push(created);
      changed();
      return clone(created);
    },
    async deleteSpeaker(id) {
      if (db.requests.some((r) => r.speaker_id === id)) throw new Error('violates foreign key constraint on table "meeting_requests"');
      db.speakers = db.speakers.filter((s) => s.id !== id);
      changed();
    },
    async deleteSubmission(id) {
      db.submissions = db.submissions.filter((s) => s.id !== id);
      db.requests = db.requests.filter((r) => r.submission_id !== id);
      changed();
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
