import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeImport,
  importKey,
  importRow,
  parseCsv,
  parseWebflowDate,
  readFormExport,
} from '../public/eic-team-4k9p/js/import.js';

const speakers = [
  { id: 's1', slug: 'proskope', name: 'Meghan Perkins', company: 'Proskope' },
  { id: 's2', slug: 'phosprint-s-a', name: 'Ioanna Zergioti', company: 'PhosPrint S.A.' },
  { id: 's3', slug: 'kedi-mobi-l-uygulama-anoni-m-i-rketi', name: 'Tuğba Önal Suzek Banu Kılıç', company: 'KEDİ MOBİL UYGULAMA ANONİM ŞİRKETİ' },
  { id: 's4', slug: 'bitagreen', name: 'Nora Van Cauwenbergh', company: 'Bitagreen' },
];

const HEADER =
  'Date,IP Address,Email,First Name,Last Name,Company,LinkedIn,Speaker: Meghan Perkins (Proskope),Speaker: Ioanna Zergioti (PhosPrint S．A．),Speakers,Speakers Selected,Booking ID,Booking status';
const line = (date, email, first, last, company, linkedin, checks, slugs, selected, bookingId = '', status = '') =>
  [date, '1.2.3.4', email, first, last, company, linkedin, ...checks, slugs, `"${selected}"`, bookingId, status].join(',');

test('parseCsv handles quotes, escaped quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"'],
  ]);
});

test('Webflow dates are read as UTC with am/pm', () => {
  assert.equal(parseWebflowDate('10/26/2026 8:11:52 pm'), '2026-10-26T20:11:52.000Z');
  assert.equal(parseWebflowDate('10/09/2026 12:07:41 pm'), '2026-10-09T12:07:41.000Z');
  assert.equal(parseWebflowDate('10/09/2026 12:07:41 am'), '2026-10-09T00:07:41.000Z');
});

test('reads the export; IP addresses are not kept', () => {
  const [row] = readFormExport(
    [HEADER, line('10/26/2026 8:11:52 pm', 'A@Fund.com', 'Ann', 'Lee', 'Fund', 'https://linkedin.com/in/ann', ['false', 'true'], 'phosprint-s-a', 'Ioanna Zergioti (PhosPrint S.A.)', 'b-1', 'booked')].join('\n'),
  );
  assert.equal(row.email, 'a@fund.com');
  assert.equal(row.submittedAt, '2026-10-26T20:11:52.000Z');
  assert.deepEqual(row.checkedSpeakers, ['Ioanna Zergioti (PhosPrint S．A．)']);
  assert.equal(row.raw['IP Address'], undefined);
  assert.throws(() => readFormExport('Name,Message\nx,y'), /Email/);
});

test('classifies rows: new, adds, exists (booking id / all speakers / sent twice), test, invalid', () => {
  const csv = [
    HEADER,
    line('10/26/2026 9:00:00 am', 'new@fund.com', 'Ann', 'Lee', 'Fund', 'https://linkedin.com/in/ann', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', 'b-new', 'booked'),
    line('10/26/2026 9:05:00 am', 'new@fund.com', 'Ann', 'Lee', 'Fund', 'https://linkedin.com/in/ann', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', 'b-new-2', 'booked'),
    line('10/25/2026 9:00:00 am', 'known@vc.com', 'Bo', 'Ek', 'VC', '', ['true', 'true'], 'proskope;PhosPrint S.A.', 'Meghan Perkins (Proskope); Ioanna Zergioti (PhosPrint S.A.)', '', 'NOT SAVED: booking API error'),
    line('10/24/2026 9:00:00 am', 'done@vc.com', 'Cy', 'Do', 'VC', '', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', 'b-done', 'booked'),
    line('10/23/2026 9:00:00 am', 'all@vc.com', 'Di', 'Fa', 'VC', '', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', '', ''),
    line('10/22/2026 9:00:00 am', 'test@mail.com', 'test name', 'x', 'VC', 'linkedin.com/in/test', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', '', ''),
    line('10/21/2026 9:00:00 am', 'me+1@team.org', 'Me', 'Too', 'Team', '', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', '', ''),
    line('10/20/2026 9:00:00 am', 'nobody', 'No', 'Body', '', '', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)', '', ''),
    line('10/19/2026 9:00:00 am', 'gone@vc.com', 'Ex', 'Speaker', '', '', ['false', 'false'], 'old-speaker', 'Old Person (Old Co)', '', ''),
  ].join('\n');
  const data = {
    speakers,
    submissions: [
      { id: 'i1', email: 'known@vc.com', tags: [], archived_at: null },
      { id: 'i2', email: 'done@vc.com', tags: [], archived_at: null },
      { id: 'i3', email: 'all@vc.com', tags: [], archived_at: null },
    ],
    requests: [
      { submission_id: 'i1', speaker_id: 's1' },
      { submission_id: 'i3', speaker_id: 's1' },
    ],
    events: [{ booking_id: 'b-done', submission_id: 'i2' }],
    admins: [{ email: 'me@team.org' }],
    availability: [{ id: 's1', status: 'full' }, { id: 's2', status: 'available' }],
  };
  const items = analyzeImport(readFormExport(csv), data);
  const byEmail = (email, n = 0) => items.filter((i) => i.row.email === email)[n];

  assert.deepEqual(items.map((i) => i.row.line), [3, 2, 4, 5, 6, 7, 8, 9, 10]); // newest first
  assert.equal(byEmail('new@fund.com', 1).kind, 'new');
  assert.equal(byEmail('new@fund.com', 0).kind, 'exists'); // sent twice: the later one
  assert.match(byEmail('new@fund.com', 0).notes[0], /line 2/);

  const known = byEmail('known@vc.com');
  assert.equal(known.kind, 'adds');
  assert.deepEqual(known.speakers.map((s) => [s.slug, s.already, s.full]), [
    ['proskope', true, true],
    ['phosprint-s-a', false, false],
  ]);
  assert.match(known.notes.join(), /never saved/);

  assert.equal(byEmail('done@vc.com').kind, 'exists');
  assert.equal(byEmail('all@vc.com').kind, 'exists');

  const t = byEmail('test@mail.com');
  assert.equal(t.kind, 'test');
  assert.equal(t.would, 'new');
  assert.deepEqual(t.reasons, ['Email contains “test”', 'Name contains “test”', 'LinkedIn contains “test”']);
  assert.deepEqual(byEmail('me+1@team.org').reasons, ['Team member’s email']);

  assert.equal(byEmail('nobody').kind, 'invalid');
  const gone = byEmail('gone@vc.com');
  assert.equal(gone.kind, 'invalid');
  assert.match(gone.notes.join(), /Unknown speaker: old-speaker/);
});

test('speakers are matched by slug, company, old names and fullwidth dots', () => {
  const csv = [
    HEADER,
    line('10/09/2026 9:23:20 am', 'a@vc.com', 'A', 'B', '', '', ['false', 'true'], 'PhosPrint S.A.;kedi', 'Ioanna Zergioti (PhosPrint S.A.); Tuğba Önal Suzek (KEDİ MOBİL UYGULAMA ANONİM ŞİRKETİ)'),
  ].join('\n');
  const [item] = analyzeImport(readFormExport(csv), { speakers });
  assert.deepEqual(item.speakers.map((s) => s.slug), ['phosprint-s-a', 'kedi-mobi-l-uygulama-anoni-m-i-rketi']);
  assert.deepEqual(item.unknown, []);
});

test('import key and payload: booking id, else email + date; test rows get the test tag', () => {
  const rows = readFormExport(
    [HEADER, line('10/22/2026 9:00:00 am', 'test@mail.com', 'T', 'T', '', '', ['true', 'false'], 'proskope', 'Meghan Perkins (Proskope)')].join('\n'),
  );
  assert.equal(importKey(rows[0]), 'webflow:test@mail.com:2026-10-22T09:00:00.000Z');
  assert.equal(importKey({ ...rows[0], bookingId: 'abc' }), 'abc');
  const [item] = analyzeImport(rows, { speakers });
  const out = importRow(item);
  assert.deepEqual(out.tags, ['test']);
  assert.deepEqual(out.speakerIds, ['s1']);
  assert.equal(out.submittedAt, '2026-10-22T09:00:00.000Z');
  assert.deepEqual(out.payload.speakers, ['proskope']);
});
