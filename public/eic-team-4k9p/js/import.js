// Import the Webflow form export (CSV) into the database. Pure functions: used by the panel and by the tests.
//
// Each CSV row becomes one item:
//   kind 'new'        email not in the database (or only archived) → creates an investor
//   kind 'adds'       active investor with this email, some speakers missing → adds them
//   kind 'test'       would be 'new' or 'adds', but looks like a test (reasons[]) → imported with the test tag
//   kind 'exists'     nothing to do: same booking already in the database, or the investor has all these speakers
//   kind 'invalid'    can't be imported (bad email, no speaker we know)

// Webflow's export: "Date, IP Address, Email, First Name, …, Speakers, Speakers Selected, …, Booking ID, Booking status"
const COLUMNS = {
  date: 'date',
  email: 'email',
  firstName: 'first name',
  lastName: 'last name',
  company: 'company',
  linkedin: 'linkedin',
  speakers: 'speakers',
  selected: 'speakers selected',
  recordIds: 'speakers record ids',
  bookingId: 'booking id',
  bookingStatus: 'booking status',
};
const SPEAKER_COLUMN = /^speaker:\s*(.+)$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLACEHOLDER_DOMAINS = /(^|\.)(example\.(com|org|net)|test\.[a-z]+|mailinator\.com|yopmail\.com)$/;

// RFC 4180: quoted fields, "" escapes, CRLF or LF, optional BOM
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// "10/26/2026 8:11:52 pm" (Webflow export, UTC) → ISO string
export function parseWebflowDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let hour = Number(m[4]);
  const ampm = m[7]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6] || 0))).toISOString();
}

const clean = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const list = (v, sep) => clean(v).split(sep).map(clean).filter(Boolean);
const truthy = (v) => /^(true|yes|on|1)$/i.test(clean(v));

// Reads the export into form rows (file order). Throws when it isn't a form export.
export function readFormExport(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) throw new Error('The file is empty.');
  const names = header.map((h) => clean(h).toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, names.indexOf(name)]));
  if (col.email < 0) throw new Error('No “Email” column. Is this the Webflow form export (CSV)?');
  const speakerColumns = header
    .map((h, i) => ({ i, label: clean(h).match(SPEAKER_COLUMN)?.[1] }))
    .filter((c) => c.label);

  return lines.map((cells, n) => {
    const get = (k) => (col[k] >= 0 ? clean(cells[col[k]]) : '');
    const raw = {};
    header.forEach((h, i) => {
      if (clean(cells[i]) !== '' && !/^ip address$/i.test(clean(h))) raw[clean(h)] = clean(cells[i]);
    });
    return {
      line: n + 2, // line in the file (header is line 1)
      submittedAt: parseWebflowDate(get('date')),
      date: get('date'),
      email: get('email').toLowerCase(),
      firstName: get('firstName'),
      lastName: get('lastName'),
      company: get('company'),
      linkedin: get('linkedin'),
      speakerTokens: list(get('speakers'), ';'),
      selectedNames: list(get('selected'), /;\s+/),
      checkedSpeakers: speakerColumns.filter((c) => truthy(cells[c.i])).map((c) => c.label),
      recordIds: list(get('recordIds'), ';'),
      bookingId: get('bookingId'),
      bookingStatus: get('bookingStatus'),
      raw,
    };
  });
}

// loose key for matching slugs, names and companies ("PhosPrint S．A．" → "phosprint-s-a")
export const looseKey = (v) =>
  clean(v)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function speakerIndex(speakers) {
  const index = new Map();
  const add = (key, sp) => key && !index.has(key) && index.set(key, sp);
  for (const sp of speakers) add(sp.slug, sp);
  for (const sp of speakers) [sp.slug, sp.company, `${sp.name} (${sp.company})`].forEach((v) => add(looseKey(v), sp));
  for (const sp of speakers) add(looseKey(sp.name), sp);
  return index;
}

// "Name (Company)" or slug or company → speaker
function findSpeaker(index, token) {
  const direct = index.get(token) || index.get(looseKey(token));
  if (direct) return direct;
  const m = token.match(/^(.*)\(([^()]*)\)\s*$/);
  return m ? index.get(looseKey(m[2])) || index.get(looseKey(m[1])) : null;
}

// speakers of a row, in pick order; tokens nobody matches → unknown
export function resolveSpeakers(row, speakers) {
  const index = speakerIndex(speakers);
  const found = [];
  const unknown = [];
  const take = (tokens, reportUnknown) =>
    tokens.forEach((t) => {
      const sp = findSpeaker(index, t);
      if (sp) found.includes(sp) || found.push(sp);
      else if (reportUnknown) unknown.push(t);
    });
  take(row.speakerTokens, true);
  take(row.selectedNames, !row.speakerTokens.length);
  take(row.checkedSpeakers, !row.speakerTokens.length && !row.selectedNames.length);
  // a token is only really unknown when the other columns didn't fill the gap
  const expected = Math.max(row.speakerTokens.length, row.selectedNames.length, row.checkedSpeakers.length);
  return { speakers: found, unknown: found.length >= expected ? [] : unknown };
}

const baseEmail = (email) => {
  const [local = '', domain = ''] = String(email).toLowerCase().split('@');
  return `${local.split('+')[0]}@${domain}`;
};
const hasTest = (v) => /test/i.test(String(v || ''));

export const importKey = (row) => row.bookingId || `webflow:${row.email}:${row.submittedAt || row.date}`;

// Reasons a row looks like a test (empty = looks real)
export function testReasons(row, { submissions = [], admins = [] } = {}) {
  const reasons = [];
  const [local, domain = ''] = row.email.split('@');
  if (hasTest(local)) reasons.push('Email contains “test”');
  if (PLACEHOLDER_DOMAINS.test(domain)) reasons.push('Placeholder email domain');
  if (admins.some((a) => baseEmail(a.email) === baseEmail(row.email))) reasons.push('Team member’s email');
  if (hasTest(row.firstName) || hasTest(row.lastName)) reasons.push('Name contains “test”');
  if (hasTest(row.linkedin)) reasons.push('LinkedIn contains “test”');
  const same = submissions.filter((s) => baseEmail(s.email) === baseEmail(row.email));
  if (same.some((s) => (s.tags || []).includes('test'))) reasons.push('Same email is tagged test in the panel');
  else if (same.length && same.every((s) => s.archived_at)) reasons.push('Same email is archived in the panel');
  return reasons;
}

// data: { speakers, submissions, requests, events, admins, availability }
export function analyzeImport(rows, data) {
  const speakers = (data.speakers || []).filter((s) => !s.archived_at);
  const eventByKey = new Map((data.events || []).filter((e) => e.booking_id).map((e) => [e.booking_id, e]));
  const availability = new Map((data.availability || []).map((a) => [a.id, a]));
  const seen = new Map(); // email + speakers → earlier line in the file

  // oldest first, like the database writes them
  const ordered = [...rows].sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)) || b.line - a.line);
  const items = ordered.map((row) => {
    const key = importKey(row);
    const { speakers: picked, unknown } = resolveSpeakers(row, speakers);
    const item = { row, key, kind: 'new', speakers: [], unknown, reasons: [], notes: [], investor: null };

    if (/NOT SAVED/i.test(row.bookingStatus)) item.notes.push('The booking API failed for this one — it was never saved.');
    else if (!row.bookingId) item.notes.push('Sent before the booking API (no Booking ID).');
    if (unknown.length) item.notes.push(`Unknown speaker${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);

    if (!EMAIL.test(row.email)) return { ...item, kind: 'invalid', notes: ['Invalid email address.', ...item.notes] };
    if (!picked.length) return { ...item, kind: 'invalid', notes: ['No speaker that is in the database.', ...item.notes] };

    const investor = (data.submissions || []).find((s) => s.email.toLowerCase() === row.email && !s.archived_at) || null;
    const have = new Set(investor ? (data.requests || []).filter((r) => r.submission_id === investor.id).map((r) => r.speaker_id) : []);
    item.investor = investor;
    item.speakers = picked.map((sp) => {
      const a = availability.get(sp.id);
      return { id: sp.id, slug: sp.slug, name: sp.name, company: sp.company, already: have.has(sp.id), full: !!a && a.status !== 'available' };
    });

    const event = eventByKey.get(key);
    if (event) {
      const owner = (data.submissions || []).find((s) => s.id === event.submission_id);
      const where = owner?.archived_at ? ' (investor archived)' : (owner?.tags || []).includes('test') ? ' (tagged test)' : '';
      return { ...item, kind: 'exists', investor: owner || investor, notes: [`This booking is already in the database${where}.`, ...item.notes] };
    }
    if (item.speakers.every((s) => s.already)) {
      return { ...item, kind: 'exists', notes: ['The investor already has all these speakers.', ...item.notes] };
    }

    const dupKey = `${row.email}|${picked.map((s) => s.id).sort().join(',')}`;
    if (seen.has(dupKey)) {
      return { ...item, kind: 'exists', notes: [`Same email and speakers as line ${seen.get(dupKey)} of the file (sent twice).`, ...item.notes] };
    }
    seen.set(dupKey, row.line);

    item.kind = investor ? 'adds' : 'new';
    item.reasons = testReasons(row, data);
    if (item.reasons.length) item.would = item.kind;
    if (item.reasons.length) item.kind = 'test';
    return item;
  });
  // newest first, like the export
  return items.sort((a, b) => String(b.row.submittedAt).localeCompare(String(a.row.submittedAt)) || a.row.line - b.row.line);
}

// what the database function receives for one picked item
export function importRow(item) {
  const r = item.row;
  return {
    key: item.key,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    company: r.company,
    linkedin: r.linkedin,
    speakerIds: item.speakers.map((s) => s.id),
    submittedAt: r.submittedAt,
    tags: item.kind === 'test' ? ['test'] : [],
    payload: {
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      company: r.company,
      linkedin: r.linkedin,
      speakers: r.speakerTokens.length ? r.speakerTokens : r.selectedNames,
      bookingId: r.bookingId || null,
      bookingStatus: r.bookingStatus || null,
      submittedAt: r.submittedAt,
      raw: r.raw,
    },
  };
}
