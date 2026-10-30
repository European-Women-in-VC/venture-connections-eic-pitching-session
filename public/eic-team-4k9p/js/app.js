// EIC Bookings admin panel — /eic-team-4k9p
// Login: Supabase Auth (email + password, invite only). Data: Supabase with the user's session;
// only emails on public.admins can read or edit (row-level security).
// Local demo with fake data: http://localhost:4322/eic-team-4k9p/?demo

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { createSupabaseStore } from './store.js';
import { createDemoStore } from './demo.js';
import { changeFor, diffSpeakers } from './sync.js';
import {
  CAPACITY_STATUSES,
  CLOSED,
  CLOSURE_REASONS,
  CONFIRMED,
  DOTS,
  REQUEST_STATUS,
  REQUEST_STATUSES,
  SOURCES,
  SPEAKER_STATE,
  SPEAKER_STATES,
  STAGE,
  STAGES,
  TEST_TAG,
  hasTestTag,
  investorStage,
  SUBMISSION_STATUS,
  SUBMISSION_STATUSES,
  TAKES_PLACE,
  TONES,
} from './labels.js';

// Which database: the production addresses use production, every other address (branch previews,
// localhost) uses the staging project. Publishable keys are safe in the browser: without a logged-in
// admin they can't read anything.
const ENVIRONMENTS = {
  production: {
    url: 'https://pxlfskkmakgmfgcwrqay.supabase.co',
    key: 'sb_publishable_DToIGOE5HyUELkgj4XLfIg_6nuRftcx',
  },
  staging: {
    url: 'https://ordkpipvkpumdgpgmoxx.supabase.co',
    key: 'sb_publishable_eslOrlWhbn4eHJc4nE-4-A_20R70VPp',
  },
};
const PRODUCTION_HOSTS = [
  'venture-connections-eic-pitching-session.oleh-boilo.workers.dev', // Cloudflare (production Worker)
  'venture-connections-eic-pitching-se.vercel.app', // Vercel (until the switch-over is finished)
  'venture-connections-eic-pitching-session-oboilos-projects.vercel.app',
];
const ENV = PRODUCTION_HOSTS.includes(location.hostname) ? 'production' : 'staging';
const { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY } = ENVIRONMENTS[ENV];
const DEMO = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('demo');
// this page's own address (works whatever the folder is called); used for password-reset links
const PANEL_URL = location.origin + location.pathname.replace(/\/?$/, '/');

const app = document.getElementById('app');

// never mix up staging and production: badge + tab title
if (ENV !== 'production' || DEMO) {
  const label = DEMO ? 'Demo data' : 'Staging · test database';
  document.title = `[${DEMO ? 'Demo' : 'Staging'}] ${document.title}`;
  const badge = document.createElement('div');
  badge.className =
    'pointer-events-none fixed top-2 left-1/2 z-50 -translate-x-1/2 rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold tracking-wide text-amber-950 uppercase shadow-md';
  badge.textContent = label;
  document.body.append(badge);
}
const drawerRoot = document.getElementById('drawer-root');
const toasts = document.getElementById('toasts');

// invite / password-reset links arrive as #access_token=…&type=invite|recovery (read before the client clears it)
const hashParams = new URLSearchParams(location.hash.slice(1));
let linkType = hashParams.get('type'); // cleared once the password is set
const linkError = hashParams.get('error_description');

const client = DEMO
  ? null
  : createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });

const state = {
  store: null,
  user: null,
  live: false,
  loaded: false,
  data: { speakers: [], availability: [], submissions: [], requests: [], events: [], admins: [] },
  view: 'overview',
  filters: {
    requests: { q: '', chip: 'active', speaker: '', source: '', tag: '', sort: { key: 'created', dir: 'desc' } },
    investors: { q: '', chip: 'all', source: '', tag: '', sort: { key: 'created', dir: 'desc' } },
    speakers: { q: '', chip: 'all', sort: { key: 'name', dir: 'asc' } },
  },
  // ticked rows per table (bulk editing)
  selected: { requests: new Set(), investors: new Set(), speakers: new Set() },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
const fmtShort = (iso) => (iso ? shortFmt.format(new Date(iso)) : '—');

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return fmtShort(iso);
}

const pad = (n) => String(n).padStart(2, '0');
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const nullIfEmpty = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());

const fullName = (s) => [s?.first_name, s?.last_name].filter(Boolean).join(' ') || s?.email || 'Unknown';
const initials = (s) =>
  (
    [s?.first_name, s?.last_name]
      .filter(Boolean)
      .map((p) => p[0])
      .join('') || (s?.email || '?')[0]
  ).toUpperCase();

const pill = (label, tone) =>
  `<span class="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone] || TONES.gray}">${esc(label)}</span>`;
const dot = (tone) => `<span class="inline-block size-2 shrink-0 rounded-full ${DOTS[tone] || DOTS.gray}"></span>`;

const CARD = 'rounded-xl border border-slate-200 bg-white shadow-xs';
const BTN = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';
const BTN_PRIMARY = `${BTN} bg-brand-600 text-white shadow-xs hover:bg-brand-700`;
const BTN_SECONDARY = `${BTN} border border-slate-300 bg-white text-slate-700 shadow-xs hover:bg-slate-50`;
const BTN_DANGER = `${BTN} text-rose-600 hover:bg-rose-50`;
const INPUT = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';
const SELECT = `${INPUT} pr-8`;

const ICONS = {
  overview: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />',
  requests: '<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />',
  investors: '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />',
  speakers: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />',
  search: '<path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />',
  download: '<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />',
  close: '<path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />',
  plus: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />',
  logout: '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />',
  arrow: '<path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />',
  menu: '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />',
  layoutSide: '<rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" /><path stroke-linecap="round" d="M9.75 4.5v15" />',
  layoutRail: '<rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" /><path stroke-linecap="round" d="M7.5 4.5v15" />',
  layoutTop: '<rect x="3.75" y="4.5" width="16.5" height="15" rx="2.25" /><path stroke-linecap="round" d="M3.75 9h16.5" />',
  sync: '<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />',
};
const icon = (name, cls = 'size-5') =>
  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>`;

function toast(message, tone = 'success', action = null) {
  const el = document.createElement('div');
  const tones = {
    success: 'border-emerald-200 bg-white text-slate-800 [&_i]:bg-emerald-500',
    error: 'border-rose-200 bg-rose-50 text-rose-800 [&_i]:bg-rose-500',
  };
  el.className = `pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm shadow-lg transition duration-300 ${tones[tone]}`;
  el.innerHTML = `<i class="mt-1.5 size-2 shrink-0 rounded-full"></i><span class="flex-1"></span>`;
  el.querySelector('span').textContent = message;
  const hide = () => {
    el.classList.add('opacity-0', 'translate-y-1');
    setTimeout(() => el.remove(), 300);
  };
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'shrink-0 font-semibold text-brand-600 hover:text-brand-800';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hide();
      action.onClick();
    });
    el.append(btn);
  }
  toasts.append(el);
  setTimeout(hide, action ? 10000 : tone === 'error' ? 6000 : 2800);
}

const errorText = (err) => {
  const msg = String(err?.message || err || 'Something went wrong');
  if (/speakers_slug_key|duplicate key.*slug/i.test(msg)) return 'A speaker with this slug already exists.';
  if (/foreign key/i.test(msg)) return 'This speaker still has meeting requests, so it can’t be deleted.';
  if (/speakers_slug_check|check constraint.*slug/i.test(msg)) return 'Slug may only contain lowercase letters, numbers and single dashes.';
  if (/investor_exists/.test(msg)) return 'An investor with this email already exists. Open their card and add speakers there.';
  if (/investor_not_found/.test(msg)) return 'This investor is archived or no longer exists.';
  if (/invalid_email/.test(msg)) return 'Please enter a valid email address.';
  if (/JWT|not authorized|not_allowed|permission|row-level security|PGRST116/i.test(msg)) return 'You don’t have permission for this change. Try signing in again.';
  return msg;
};

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
function derived() {
  const { speakers, availability, submissions, requests, events = [] } = state.data;
  const archivedSubs = new Set(submissions.filter((s) => s.archived_at).map((s) => s.id));
  const testSubs = new Set(submissions.filter(hasTestTag).map((s) => s.id));
  // a request is archived itself, or together with its investor
  const requestArchived = (r) => Boolean(r.archived_at) || archivedSubs.has(r.submission_id);
  // test = the request or its investor is tagged 'test' (not counted in totals or on the website)
  const isTest = (r) => hasTestTag(r) || testSubs.has(r.submission_id);
  // "live" = not archived: what the lists, totals and dropdowns show
  const live = {
    speakers: speakers.filter((s) => !s.archived_at),
    submissions: submissions.filter((s) => !s.archived_at),
    requests: requests.filter((r) => !requestArchived(r)),
  };
  // for totals: also without test data
  const real = {
    submissions: live.submissions.filter((s) => !hasTestTag(s)),
    requests: live.requests.filter((r) => !isTest(r)),
  };
  const allTags = [...new Set([...submissions, ...requests].flatMap((x) => x.tags || []))].sort();
  const eventsBySubmission = new Map();
  for (const e of events) {
    if (!eventsBySubmission.has(e.submission_id)) eventsBySubmission.set(e.submission_id, []);
    eventsBySubmission.get(e.submission_id).push(e);
  }
  const websiteSends = (id) => (eventsBySubmission.get(id) || []).filter((e) => e.source === 'website').length;
  const speakerById = new Map(speakers.map((s) => [s.id, s]));
  const submissionById = new Map(submissions.map((s) => [s.id, s]));
  const availabilityById = new Map(availability.map((a) => [a.id, a]));
  const requestsBySubmission = new Map();
  const requestsBySpeaker = new Map();
  for (const r of requests) {
    if (!requestsBySubmission.has(r.submission_id)) requestsBySubmission.set(r.submission_id, []);
    requestsBySubmission.get(r.submission_id).push(r);
    if (!requestsBySpeaker.has(r.speaker_id)) requestsBySpeaker.set(r.speaker_id, []);
    requestsBySpeaker.get(r.speaker_id).push(r);
  }
  for (const list of requestsBySubmission.values()) list.sort((a, b) => (a.preference_rank || 99) - (b.preference_rank || 99));
  const stageOf = (subId) => investorStage((requestsBySubmission.get(subId) || []).filter((r) => !r.archived_at));
  // why a request needs a second look
  const flagsOf = (r) => {
    const flags = [];
    const sub = submissionById.get(r.submission_id);
    const sp = speakerById.get(r.speaker_id);
    if (r.archived_at) flags.push({ label: 'Archived', tone: 'gray', title: `Archived ${fmtDate(r.archived_at)}${r.archived_by ? ' by ' + r.archived_by : ''}` });
    if (sub?.archived_at) flags.push({ label: 'Investor archived', tone: 'gray', title: `${fullName(sub)} was archived — this request is archived with them` });
    if (sp?.archived_at) flags.push({ label: 'Speaker archived', tone: 'red', title: `${sp.name} is archived and can’t be booked` });
    else if (sp && sp.availability !== 'open') flags.push({ label: `Speaker ${SPEAKER_STATE[sp.availability]?.label.toLowerCase()}`, tone: 'amber', title: `${sp.name} isn’t open for bookings` });
    if (isTest(r)) flags.push({ label: 'Test', tone: 'yellow', title: hasTestTag(r) ? 'Tagged test' : 'The investor is tagged test' });
    return flags;
  };
  return {
    speakerById, submissionById, availabilityById, requestsBySubmission, requestsBySpeaker, live, real,
    eventsBySubmission, websiteSends, requestArchived, isTest, stageOf, flagsOf, allTags,
  };
}

// ---------- tags ----------
const tagChip = (tag, removable = false) =>
  `<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium ring-1 ring-inset ${
    tag === TEST_TAG ? 'bg-yellow-50 text-yellow-800 ring-yellow-600/30' : 'bg-slate-100 text-slate-700 ring-slate-300/70'
  }">#${esc(tag)}${removable ? `<button type="button" data-tag-remove="${esc(tag)}" class="-mr-0.5 text-slate-400 hover:text-rose-600" aria-label="Remove tag ${esc(tag)}">×</button>` : ''}</span>`;
const tagChips = (tags) => (tags || []).map((t) => tagChip(t)).join('');
const flagChips = (flags) => flags.map((f) => `<span title="${esc(f.title)}">${pill(f.label, f.tone)}</span>`).join('');

// tag editor inside side panels: chips + input; the hidden field holds the JSON list
function tagsEditor(name, tags, suggestions) {
  return `<div data-tags-editor class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 shadow-xs focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20">
      <input type="hidden" name="${name}" value="${esc(JSON.stringify(tags || []))}">
      <span data-tag-list class="contents">${(tags || []).map((t) => tagChip(t, true)).join('')}</span>
      <input data-tag-input list="tag-suggestions" placeholder="Add tag + Enter" class="min-w-28 flex-1 border-0 bg-transparent p-1 text-sm focus:outline-none">
    </div>
    <datalist id="tag-suggestions">${[...new Set([TEST_TAG, ...suggestions])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    <span class="mt-1 block text-xs text-slate-500"><b>test</b>: kept out of totals and not counted on the website.</span>`;
}
function editorTags(editor) {
  try {
    return JSON.parse(editor.querySelector('input[type=hidden]').value) || [];
  } catch {
    return [];
  }
}
function setEditorTags(editor, tags) {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].sort();
  editor.querySelector('input[type=hidden]').value = JSON.stringify(clean);
  editor.querySelector('[data-tag-list]').innerHTML = clean.map((t) => tagChip(t, true)).join('');
}
function commitTagInput(input) {
  const editor = input.closest('[data-tags-editor]');
  const value = input.value.replace(/,/g, ' ').trim();
  if (!editor || !value) return;
  setEditorTags(editor, [...editorTags(editor), ...value.split(/\s+/)]);
  input.value = '';
}
const tagFilter = (view) => {
  const tags = derived().allTags;
  if (!tags.length) return '';
  return `<select data-filter-tag="${view}" class="${SELECT} w-full sm:w-40" aria-label="Tag">
    <option value="">All tags</option>
    ${tags.map((t) => `<option value="${esc(t)}" ${state.filters[view].tag === t ? 'selected' : ''}>#${esc(t)}</option>`).join('')}
  </select>`;
};

// ---------- selection + bulk bar ----------
const CHECK = 'size-4 cursor-pointer rounded border-slate-300 accent-brand-600';
const selectAllCell = (view, ids) => {
  const sel = state.selected[view];
  const all = ids.length > 0 && ids.every((id) => sel.has(id));
  const some = !all && ids.some((id) => sel.has(id));
  return `<th class="w-10 px-4 py-2.5"><input type="checkbox" data-select-all="${view}" ${all ? 'checked' : ''} ${some ? 'data-indeterminate' : ''} class="${CHECK}" aria-label="Select all shown"></th>`;
};
const selectCell = (view, id) =>
  `<td class="w-10 px-4 py-3" data-stop><input type="checkbox" data-select="${view}" value="${esc(id)}" ${state.selected[view].has(id) ? 'checked' : ''} class="${CHECK}" aria-label="Select row"></td>`;

const sourceBadge = (source, by) =>
  source === 'panel'
    ? `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-medium bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/20" title="${esc(SOURCES.panel.title + (by ? ' — ' + by : ''))}">${SOURCES.panel.label}</span>`
    : `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-medium bg-slate-50 text-slate-500 ring-1 ring-inset ring-slate-300/70" title="${esc(SOURCES.website.title)}">${SOURCES.website.label}</span>`;
const sendsBadge = (n) =>
  n > 1
    ? `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-4 font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/25" title="Submitted the website form ${n} times">Sent ${n}×</span>`
    : '';
const sourceFilter = (view) => `<select data-filter-source="${view}" class="${SELECT} w-full sm:w-48" aria-label="Source">
    <option value="">All sources</option>
    <option value="website" ${state.filters[view].source === 'website' ? 'selected' : ''}>From the website</option>
    <option value="panel" ${state.filters[view].source === 'panel' ? 'selected' : ''}>Added by the team</option>
  </select>`;

const statusOrder = Object.fromEntries(REQUEST_STATUSES.map((s, i) => [s.value, i]));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortRows = (rows, getters, sort) => {
  const get = getters[sort.key] || (() => 0);
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compare(get(a), get(b)) * dir);
};
const matches = (q, ...values) => {
  const needle = q.trim().toLowerCase();
  return !needle || values.some((v) => String(v ?? '').toLowerCase().includes(needle));
};

// ---------------------------------------------------------------------------
// Auth screens
// ---------------------------------------------------------------------------
function authCard(title, subtitle, body) {
  app.innerHTML = `
    <div class="flex min-h-full items-center justify-center px-4 py-12">
      <div class="w-full max-w-sm">
        <div class="mb-6 flex items-center gap-3">
          <div class="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">EIC</div>
          <div>
            <p class="text-sm font-semibold">EIC Bookings</p>
            <p class="text-xs text-slate-500">Pitching Session · team panel</p>
          </div>
        </div>
        <div class="${CARD} p-6">
          <h1 class="text-lg font-semibold">${esc(title)}</h1>
          <p class="mt-1 text-sm text-slate-500">${subtitle}</p>
          <div class="mt-5">${body}</div>
        </div>
      </div>
    </div>`;
}

const formError = (id) => `<p id="${id}" class="hidden rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"></p>`;
function showFormError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.remove('hidden');
}

function showLogin(notice = '') {
  authCard(
    'Sign in',
    'Use the email and password from your invitation.',
    `
    <form id="login" class="space-y-4">
      ${notice ? `<p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">${esc(notice)}</p>` : ''}
      ${formError('login-error')}
      <label class="block"><span class="mb-1 block text-sm font-medium text-slate-700">Email</span>
        <input name="email" type="email" autocomplete="username" required class="${INPUT}"></label>
      <label class="block"><span class="mb-1 block text-sm font-medium text-slate-700">Password</span>
        <input name="password" type="password" autocomplete="current-password" required class="${INPUT}"></label>
      <button class="${BTN_PRIMARY} w-full">Sign in</button>
      <button type="button" id="forgot" class="w-full text-center text-sm text-slate-500 hover:text-brand-600">Forgot password?</button>
    </form>`,
  );

  const form = document.getElementById('login');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await client.auth.signInWithPassword({
      email: form.email.value.trim(),
      password: form.password.value,
    });
    btn.disabled = false;
    if (error) showFormError('login-error', error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  });

  document.getElementById('forgot').addEventListener('click', async () => {
    const email = form.email.value.trim();
    if (!email) {
      showFormError('login-error', 'Enter your email first, then click “Forgot password?” again.');
      form.email.focus();
      return;
    }
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: PANEL_URL });
    if (error) showFormError('login-error', error.message);
    else showLogin('If this email has an account, a link to set a new password is on its way.');
  });
}

function showSetPassword(kind) {
  authCard(
    kind === 'invite' ? 'Welcome! Choose a password' : 'Set a new password',
    'At least 8 characters. You’ll use it with your email to sign in.',
    `
    <form id="set-password" class="space-y-4">
      ${formError('pw-error')}
      <label class="block"><span class="mb-1 block text-sm font-medium text-slate-700">New password</span>
        <input name="password" type="password" minlength="8" autocomplete="new-password" required class="${INPUT}"></label>
      <label class="block"><span class="mb-1 block text-sm font-medium text-slate-700">Repeat password</span>
        <input name="repeat" type="password" minlength="8" autocomplete="new-password" required class="${INPUT}"></label>
      <button class="${BTN_PRIMARY} w-full">Save password</button>
    </form>`,
  );
  const form = document.getElementById('set-password');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.password.value !== form.repeat.value) return showFormError('pw-error', 'The passwords don’t match.');
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await client.auth.updateUser({ password: form.password.value });
    btn.disabled = false;
    if (error) return showFormError('pw-error', error.message);
    history.replaceState(null, '', location.pathname);
    linkType = null;
    toast('Password saved.');
    const { data } = await client.auth.getSession();
    enter(data.session);
  });
}

function showNoAccess(email) {
  authCard(
    'No access yet',
    `You’re signed in as <strong class="text-slate-700">${esc(email)}</strong>, but this email isn’t on the team list.`,
    `<p class="text-sm text-slate-600">Ask an admin to add your email to the <code class="rounded bg-slate-100 px-1">admins</code> table in Supabase, then reload this page.</p>
     <button id="sign-out" class="${BTN_SECONDARY} mt-5 w-full">Sign out</button>`,
  );
  document.getElementById('sign-out').addEventListener('click', () => client.auth.signOut());
}

// ---------------------------------------------------------------------------
// Shell + navigation
// ---------------------------------------------------------------------------
const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'requests', label: 'Meeting requests' },
  { id: 'investors', label: 'Investors' },
  { id: 'speakers', label: 'Speakers' },
];

// Menu layouts on desktop (saved per browser): 'side' = full sidebar, 'rail' = icon bar, 'top' = bar above
// the content. Below the md breakpoint the menu always slides in from the left (☰ button).
const LAYOUTS = [
  { id: 'side', label: 'Sidebar', icon: 'layoutSide' },
  { id: 'rail', label: 'Collapsed sidebar', icon: 'layoutRail' },
  { id: 'top', label: 'Menu on top', icon: 'layoutTop' },
];
const LAYOUT_KEY = 'eic-panel-layout';
function savedLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return LAYOUTS.some((l) => l.id === v) ? v : 'side';
  } catch {
    return 'side';
  }
}
let layout = savedLayout();

function setLayout(next) {
  layout = next;
  try {
    localStorage.setItem(LAYOUT_KEY, next);
  } catch {
    /* private mode: just not remembered */
  }
  renderShell();
  renderView();
}

const brandMark = (size = 'size-8') =>
  `<div class="flex ${size} shrink-0 items-center justify-center rounded-lg bg-brand-600 text-[11px] font-bold text-white">EIC</div>`;
const brandText = `<div class="leading-tight"><p class="text-sm font-semibold">EIC Bookings</p><p class="text-xs text-slate-500">Pitching Session</p></div>`;

function layoutSwitcher(compact = false) {
  return `<div class="inline-flex rounded-lg bg-slate-100 p-0.5 ${compact ? 'flex-col' : ''}" role="group" aria-label="Menu layout">
    ${LAYOUTS.map(
      (l) => `<button type="button" data-layout-set="${l.id}" title="${esc(l.label)}" aria-label="${esc(l.label)}" aria-pressed="${layout === l.id}"
        class="rounded-md p-1.5 ${layout === l.id ? 'bg-white text-brand-600 shadow-xs' : 'text-slate-400 hover:text-slate-700'}">${icon(l.icon, 'size-4')}</button>`,
    ).join('')}
  </div>`;
}

const signOutButton = (withLabel) =>
  `<button data-action="sign-out" title="Sign out" class="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-900">${icon('logout', withLabel ? 'size-4' : 'size-5')}${withLabel ? ' Sign out' : ''}</button>`;

// full sidebar content, also used by the mobile slide-in menu
const sidebarContent = (variant) => `
  <div class="flex h-16 shrink-0 items-center gap-2.5 border-b border-slate-200 px-5">
    ${brandMark()}${brandText}
    ${variant === 'mobile' ? `<button data-action="mobile-menu-close" class="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close menu">${icon('close')}</button>` : ''}
  </div>
  <nav class="flex-1 space-y-0.5 overflow-y-auto p-3" data-nav="full"></nav>
  <div class="space-y-3 border-t border-slate-200 p-4">
    <div data-live="full" class="flex items-center gap-2 text-xs text-slate-500"></div>
    <div>
      <p class="truncate text-xs font-medium text-slate-700" title="${esc(state.user.email)}">${esc(state.user.email)}</p>
      <div class="mt-2 flex items-center justify-between gap-2">${signOutButton(true)}${variant === 'mobile' ? '' : layoutSwitcher()}</div>
    </div>
  </div>`;

function renderShell() {
  const mobileBar = `
    <header class="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
      <button data-action="mobile-menu-open" class="-ml-1 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Open menu" aria-controls="mobile-menu">${icon('menu', 'size-6')}</button>
      ${brandMark()}
      <p class="min-w-0 flex-1 truncate text-sm font-semibold" data-current-view></p>
      <span data-live="dot"></span>
    </header>
    <div id="mobile-menu" class="fixed inset-0 z-40 hidden md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div class="absolute inset-0 bg-slate-900/30" data-action="mobile-menu-close"></div>
      <aside class="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-2xl">${sidebarContent('mobile')}</aside>
    </div>`;

  let desktop;
  if (layout === 'top') {
    desktop = `
      <header class="hidden shrink-0 items-center gap-6 border-b border-slate-200 bg-white px-6 md:flex">
        <div class="flex items-center gap-2.5 py-3">${brandMark()}<span class="hidden lg:block">${brandText}</span></div>
        <nav class="-mb-px flex flex-1 items-stretch gap-1 self-stretch overflow-x-auto scrollbar-thin" data-nav="top"></nav>
        <div class="flex items-center gap-4">
          <span data-live="dot"></span>
          <span class="hidden max-w-48 truncate text-xs text-slate-500 xl:block" title="${esc(state.user.email)}">${esc(state.user.email)}</span>
          ${layoutSwitcher()}
          ${signOutButton(false)}
        </div>
      </header>`;
  } else if (layout === 'rail') {
    desktop = `
      <aside class="hidden w-16 shrink-0 flex-col items-center border-r border-slate-200 bg-white md:flex">
        <div class="flex h-16 w-full items-center justify-center border-b border-slate-200">${brandMark()}</div>
        <nav class="flex w-full flex-1 flex-col items-center gap-1 p-2" data-nav="rail"></nav>
        <div class="flex w-full flex-col items-center gap-3 border-t border-slate-200 py-4">
          <span data-live="dot"></span>
          ${layoutSwitcher(true)}
          ${signOutButton(false)}
        </div>
      </aside>`;
  } else {
    desktop = `<aside class="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">${sidebarContent('side')}</aside>`;
  }

  app.innerHTML =
    layout === 'top'
      ? `<div class="flex h-full flex-col">${mobileBar}${desktop}<main id="main" class="min-w-0 flex-1 overflow-y-auto scrollbar-thin pb-24"></main></div><div id="bulk-root"></div>`
      : `<div class="flex h-full">${desktop}<div class="flex min-w-0 flex-1 flex-col">${mobileBar}<main id="main" class="min-w-0 flex-1 overflow-y-auto scrollbar-thin pb-24"></main></div></div><div id="bulk-root"></div>`;
  renderNav();
  renderLive();
}

function toggleMobileMenu(open) {
  const menu = document.getElementById('mobile-menu');
  if (!menu) return;
  menu.classList.toggle('hidden', !open);
  if (open) menu.querySelector('a, button')?.focus();
}

function renderNav() {
  const { requests, submissions } = derived().live;
  const counts = {
    requests: requests.filter((r) => r.status === 'new_request' || r.status === 'needs_review').length,
    investors: submissions.filter((s) => s.status === 'todo').length,
  };
  const countTitle = (id) => (id === 'requests' ? 'New or needs review' : 'To do');

  const variants = {
    full: (n, active, count) => `<a href="#${n.id}" ${active ? 'aria-current="page"' : ''} class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}">
        <span class="${active ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-500'}">${icon(n.id)}</span>
        <span class="flex-1">${esc(n.label)}</span>
        ${count ? `<span class="rounded-full ${active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'} px-2 py-0.5 text-xs font-semibold" title="${countTitle(n.id)}">${count}</span>` : ''}
      </a>`,
    rail: (n, active, count) => `<a href="#${n.id}" ${active ? 'aria-current="page"' : ''} title="${esc(n.label)}${count ? ` (${count} ${countTitle(n.id).toLowerCase()})` : ''}" aria-label="${esc(n.label)}"
        class="relative flex size-10 items-center justify-center rounded-lg ${active ? 'bg-brand-50 text-brand-600' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-700'}">
        ${icon(n.id)}
        ${count ? `<span class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-brand-600 px-1 text-center text-[10px] leading-4 font-semibold text-white">${count}</span>` : ''}
      </a>`,
    top: (n, active, count) => `<a href="#${n.id}" ${active ? 'aria-current="page"' : ''} class="flex shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium ${active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900'}">
        <span class="${active ? 'text-brand-600' : 'text-slate-400'}">${icon(n.id, 'size-4')}</span>${esc(n.label)}
        ${count ? `<span class="rounded-full ${active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'} px-1.5 py-0.5 text-[11px] leading-none font-semibold" title="${countTitle(n.id)}">${count}</span>` : ''}
      </a>`,
  };

  document.querySelectorAll('[data-nav]').forEach((nav) => {
    const draw = variants[nav.dataset.nav];
    nav.innerHTML = NAV.map((n) => draw(n, state.view === n.id, counts[n.id])).join('');
  });
  document.querySelectorAll('[data-current-view]').forEach((el) => {
    el.textContent = NAV.find((n) => n.id === state.view)?.label || '';
  });
}

function renderLive() {
  const title = state.live ? `Live updates on${DEMO ? ' (demo data)' : ''}` : 'Connecting…';
  const dotHtml = state.live
    ? `<span class="relative flex size-2"><span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60"></span><span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span></span>`
    : `<span class="flex size-2 rounded-full bg-slate-300"></span>`;
  document.querySelectorAll('[data-live]').forEach((el) => {
    el.title = title;
    el.innerHTML = el.dataset.live === 'full' ? `${dotHtml} ${esc(title)}` : dotHtml;
  });
}

function pageHeader(title, subtitle, actions = '') {
  return `
    <div class="border-b border-slate-200 bg-white px-6 py-5">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-slate-900">${esc(title)}</h1>
          <p class="mt-1 text-sm text-slate-500">${subtitle}</p>
        </div>
        <div class="flex items-center gap-2">${actions}</div>
      </div>
    </div>`;
}

function chips(view, items) {
  const current = state.filters[view].chip;
  return `<div class="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">${items
    .map(
      (c) => `<button data-chip="${view}:${c.id}" class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition ${current === c.id ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}">
        ${c.tone ? dot(c.tone) : ''}${esc(c.label)}
        <span class="${current === c.id ? 'text-brand-100' : 'text-slate-400'}">${c.count}</span>
      </button>`,
    )
    .join('')}</div>`;
}

function searchBox(view, placeholder) {
  return `<label class="relative block w-full sm:w-72">
    <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">${icon('search', 'size-4')}</span>
    <input data-search="${view}" value="${esc(state.filters[view].q)}" placeholder="${esc(placeholder)}" class="${INPUT} pl-9">
  </label>`;
}

function sortHeader(view, key, label, cls = '') {
  const sort = state.filters[view].sort;
  const active = sort.key === key;
  return `<th class="px-4 py-2.5 text-left font-medium ${cls}">
    <button data-sort="${view}:${key}" class="inline-flex items-center gap-1 hover:text-slate-900 ${active ? 'text-slate-900' : ''}">
      ${esc(label)}<span class="text-[10px] ${active ? '' : 'opacity-0'}">${active && sort.dir === 'asc' ? '▲' : '▼'}</span>
    </button>
  </th>`;
}

function statusSelect(kind, id, value, extra = '') {
  const list = { request: REQUEST_STATUSES, submission: SUBMISSION_STATUSES, speaker: SPEAKER_STATES }[kind];
  const current = list.find((s) => s.value === value) || list[0];
  return `<select data-action="${kind}-status" data-id="${esc(id)}" aria-label="Status"
    class="cursor-pointer rounded-full border-0 py-1 pr-7 pl-2.5 text-xs font-medium ring-1 ring-inset focus:ring-2 focus:ring-brand-500 focus:outline-none ${TONES[current.tone]} ${extra}">
    ${list.map((s) => `<option value="${s.value}" ${s.value === value ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
  </select>`;
}

function capacityBar(speaker, avail) {
  const cap = Math.max(speaker.capacity, 1);
  const confirmed = avail?.confirmed || 0;
  const used = avail?.used || 0;
  const pending = Math.max(used - confirmed, 0);
  const w = (n) => `${Math.min((n / cap) * 100, 100)}%`;
  return `<div class="flex h-2 w-full overflow-hidden rounded-full bg-slate-100" title="${confirmed} confirmed · ${pending} pending · capacity ${speaker.capacity}">
    <div class="bg-emerald-500" style="width:${w(confirmed)}"></div>
    <div class="bg-brand-500" style="width:${w(pending)}"></div>
  </div>`;
}

const emptyRow = (cols, text) =>
  `<tr><td colspan="${cols}" class="px-4 py-14 text-center text-sm text-slate-500">${esc(text)}</td></tr>`;

const tableWrap = (head, body) => `
  <div class="${CARD} overflow-hidden">
    <div class="overflow-x-auto scrollbar-thin">
      <table class="min-w-full text-sm">
        <thead class="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">${head}</thead>
        <tbody class="divide-y divide-slate-100">${body}</tbody>
      </table>
    </div>
  </div>`;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function renderOverview() {
  const main = document.getElementById('main');
  const d = derived();
  const { speakers } = d.live;
  const { submissions, requests } = d.real; // not archived, not tagged test
  const realSubs = submissions;
  const today = realSubs.filter((s) => Date.now() - new Date(s.created_at) < 86400000).length;
  const active = requests.filter((r) => TAKES_PLACE.has(r.status)).length;
  const confirmed = requests.filter((r) => CONFIRMED.has(r.status)).length;
  const waitlisted = requests.filter((r) => r.status === 'waitlisted').length;
  const openSpeakers = speakers.filter((s) => s.availability === 'open');
  const capacity = openSpeakers.reduce((n, s) => n + s.capacity, 0);
  const placesLeft = openSpeakers.reduce((n, s) => n + (d.availabilityById.get(s.id)?.available || 0), 0);

  const kpi = (label, value, sub, goto) => `
    <a ${goto ? `href="${goto}"` : ''} class="${CARD} block p-5 ${goto ? 'transition hover:border-brand-300 hover:shadow-sm' : ''}">
      <p class="text-sm text-slate-500">${esc(label)}</p>
      <p class="mt-2 text-3xl font-semibold tracking-tight">${value}</p>
      <p class="mt-1 text-xs text-slate-500">${sub}</p>
    </a>`;

  const byStatus = REQUEST_STATUSES.map((s) => ({ ...s, count: requests.filter((r) => r.status === s.value).length }));
  const total = requests.length || 1;

  const speakerRows = [...speakers]
    .map((s) => ({ s, a: d.availabilityById.get(s.id) }))
    .sort((x, y) => (y.a?.used || 0) / Math.max(y.s.capacity, 1) - (x.a?.used || 0) / Math.max(x.s.capacity, 1) || x.s.name.localeCompare(y.s.name));

  main.innerHTML =
    pageHeader(
      'Overview',
      'Investor bookings and speaker capacity at a glance.',
      `<button data-action="download-backup" class="${BTN_SECONDARY}" title="Everything in one JSON file, including archived items and history">${icon('download', 'size-4')} Download backup</button>`,
    ) +
    `<div class="space-y-6 p-6">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-5">
        ${kpi('Investors', realSubs.length, today ? `+${today} in the last 24 h` : 'no new in the last 24 h', '#investors')}
        ${kpi('Active requests', active, 'take a place', '#requests')}
        ${kpi('Confirmed', confirmed, 'accepted or scheduled')}
        ${kpi('Waitlisted', waitlisted, 'not taking a place')}
        ${kpi('Places left', `${placesLeft}<span class="text-lg font-medium text-slate-400"> / ${capacity}</span>`, `${openSpeakers.length} open speakers`, '#speakers')}
      </div>

      <div class="grid gap-6 lg:grid-cols-3">
        <section class="${CARD} p-5 lg:col-span-2">
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">Requests by status</h2>
            <span class="text-sm text-slate-500">${requests.length} total</span>
          </div>
          <div class="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
            ${byStatus.filter((s) => s.count).map((s) => `<div class="${DOTS[s.tone]}" style="width:${(s.count / total) * 100}%" title="${esc(s.label)}: ${s.count}"></div>`).join('')}
          </div>
          <div class="mt-5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            ${byStatus
              .map(
                (s) => `<button data-goto-status="${s.value}" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50">
                  ${dot(s.tone)}<span class="flex-1 text-slate-700">${esc(s.label)}</span>
                  <span class="font-semibold tabular-nums ${s.count ? '' : 'text-slate-300'}">${s.count}</span>
                </button>`,
              )
              .join('')}
          </div>
        </section>

        <section class="${CARD} p-5">
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">Latest investors</h2>
            <a href="#investors" class="text-sm text-brand-600 hover:text-brand-700">View all</a>
          </div>
          <ul class="mt-3 divide-y divide-slate-100">
            ${
              submissions.slice(0, 6).map((s) => {
                const reqs = d.requestsBySubmission.get(s.id) || [];
                return `<li><button data-open="investor" data-id="${s.id}" class="flex w-full items-center gap-3 py-2.5 text-left">
                  <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">${esc(initials(s))}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">${esc(fullName(s))}</span>
                    <span class="block truncate text-xs text-slate-500">${esc(s.company || s.email)} · ${reqs.length} speaker${reqs.length === 1 ? '' : 's'}</span>
                  </span>
                  <span class="shrink-0 text-xs text-slate-400">${esc(timeAgo(s.created_at))}</span>
                </button></li>`;
              }).join('') || '<li class="py-8 text-center text-sm text-slate-500">No submissions yet.</li>'
            }
          </ul>
        </section>
      </div>

      <section class="${CARD} p-5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold">Speaker capacity</h2>
          <div class="flex items-center gap-4 text-xs text-slate-500">
            <span class="flex items-center gap-1.5">${dot('green')} Confirmed</span>
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-brand-500"></span> Pending</span>
            <span class="flex items-center gap-1.5"><span class="size-2 rounded-full bg-slate-200"></span> Free</span>
          </div>
        </div>
        <div class="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
          ${speakerRows
            .map(({ s, a }) => {
              const st = CAPACITY_STATUSES[a?.status] || CAPACITY_STATUSES.available;
              return `<button data-open="speaker" data-id="${s.id}" class="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50">
                <span class="min-w-0 truncate text-sm"><span class="font-medium">${esc(s.name)}</span> <span class="text-slate-500">· ${esc(s.company)}</span></span>
                <span class="flex items-center gap-2"><span class="text-xs font-semibold tabular-nums text-slate-600">${a?.used || 0}/${s.capacity}</span>${a?.status !== 'available' ? pill(st.label, st.tone) : ''}</span>
                <span class="col-span-2">${capacityBar(s, a)}</span>
              </button>`;
            })
            .join('')}
        </div>
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// Meeting requests
// ---------------------------------------------------------------------------
// every chip except "Archived" shows only requests that aren't archived (themselves or via their investor)
const REQUEST_CHIPS = [
  { id: 'active', label: 'Active', test: (r, d) => !d.requestArchived(r) && TAKES_PLACE.has(r.status) },
  { id: 'all', label: 'All', test: (r, d) => !d.requestArchived(r) },
  ...REQUEST_STATUSES.filter((s) => !CLOSED.has(s.value)).map((s) => ({
    id: s.value,
    label: s.label,
    tone: s.tone,
    test: (r, d) => !d.requestArchived(r) && r.status === s.value,
  })),
  { id: 'closed', label: 'Declined / cancelled / expired', tone: 'gray', test: (r, d) => !d.requestArchived(r) && CLOSED.has(r.status) },
  { id: 'test', label: 'Test', tone: 'yellow', test: (r, d) => !d.requestArchived(r) && d.isTest(r) },
  { id: 'archived', label: 'Archived', tone: 'gray', test: (r, d) => d.requestArchived(r) },
];

const requestChipItems = () => {
  const d = derived();
  return REQUEST_CHIPS.map((c) => ({ ...c, count: state.data.requests.filter((r) => c.test(r, d)).length }));
};

function requestRows() {
  const f = state.filters.requests;
  const d = derived();
  const chip = REQUEST_CHIPS.find((c) => c.id === f.chip) || REQUEST_CHIPS[0];
  const rows = state.data.requests
    .filter((r) => chip.test(r, d))
    .map((r) => ({ r, sub: d.submissionById.get(r.submission_id), sp: d.speakerById.get(r.speaker_id) }))
    .filter(({ r }) => !f.speaker || r.speaker_id === f.speaker)
    .filter(({ r }) => !f.source || r.source === f.source)
    .filter(({ r, sub }) => !f.tag || (r.tags || []).includes(f.tag) || (sub?.tags || []).includes(f.tag))
    .filter(({ r, sub, sp }) =>
      matches(f.q, fullName(sub), sub?.email, sub?.company, sp?.name, sp?.company, r.internal_notes, r.request_number, ...(r.tags || [])),
    );
  return sortRows(
    rows,
    {
      number: ({ r }) => r.request_number,
      investor: ({ sub }) => fullName(sub).toLowerCase(),
      speaker: ({ sp }) => (sp?.name || '').toLowerCase(),
      rank: ({ r }) => r.preference_rank || 99,
      status: ({ r }) => statusOrder[r.status],
      created: ({ r }) => r.created_at,
    },
    f.sort,
  );
}

function renderRequests() {
  const main = document.getElementById('main');
  const { speakers } = derived().live;
  const f = state.filters.requests;
  main.innerHTML =
    pageHeader(
      'Meeting requests',
      'One row per investor × speaker. Change the status right in the table.',
      `<button data-export="requests" class="${BTN_SECONDARY}">${icon('download', 'size-4')} Export CSV</button>
       <button data-action="new-request" class="${BTN_PRIMARY}">${icon('plus', 'size-4')} New meeting request</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('requests', requestChipItems())}</div>
      <div class="flex flex-wrap items-center gap-3">
        ${searchBox('requests', 'Search investor, speaker, notes…')}
        <select data-filter-speaker class="${SELECT} w-full sm:w-64">
          <option value="">All speakers</option>
          ${speakers.map((s) => `<option value="${s.id}" ${f.speaker === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.company)}</option>`).join('')}
        </select>
        ${sourceFilter('requests')}
        ${tagFilter('requests')}
        <span id="count" class="ml-auto text-sm text-slate-500"></span>
      </div>
      <div id="view-body"></div>
    </div>`;
  renderRequestsBody();
}

function renderRequestsBody() {
  const rows = requestRows();
  const d = derived();
  pruneSelection('requests', rows.map(({ r }) => r.id));
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
    ${selectAllCell('requests', rows.map(({ r }) => r.id))}
    ${sortHeader('requests', 'number', '#', 'w-12')}
    ${sortHeader('requests', 'investor', 'Investor')}
    ${sortHeader('requests', 'speaker', 'Speaker')}
    ${sortHeader('requests', 'rank', 'Pref.', 'w-16')}
    ${sortHeader('requests', 'status', 'Status')}
    <th class="px-4 py-2.5 text-left font-medium">Source</th>
    <th class="px-4 py-2.5 text-left font-medium">Tags & notes</th>
    ${sortHeader('requests', 'created', 'Created')}
  </tr>`;
  const body = rows.length
    ? rows
        .map(
          ({ r, sub, sp }) => `<tr data-open="request" data-id="${r.id}" class="cursor-pointer hover:bg-slate-50 ${state.selected.requests.has(r.id) ? 'bg-brand-50/60' : 'bg-white'}">
          ${selectCell('requests', r.id)}
          <td class="px-4 py-3 text-xs tabular-nums text-slate-400">${r.request_number}</td>
          <td class="whitespace-nowrap px-4 py-3"><div class="font-medium">${esc(fullName(sub))}</div><div class="text-xs text-slate-500">${esc(sub?.company || sub?.email || '')}</div></td>
          <td class="whitespace-nowrap px-4 py-3"><div>${esc(sp?.name || '—')}</div><div class="text-xs text-slate-500">${esc(sp?.company || '')}</div></td>
          <td class="px-4 py-3 text-slate-500 tabular-nums">${r.preference_rank ? '#' + r.preference_rank : '—'}</td>
          <td class="px-4 py-3" data-stop>${statusSelect('request', r.id, r.status)}</td>
          <td class="px-4 py-3">${sourceBadge(r.source, r.created_by)}</td>
          <td class="max-w-72 px-4 py-3">
            <div class="flex flex-wrap gap-1">${flagChips(d.flagsOf(r))}${tagChips(r.tags)}</div>
            ${r.internal_notes ? `<p class="mt-1 truncate text-slate-500">${esc(r.internal_notes)}</p>` : ''}
          </td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-500" title="${esc(fmtDate(r.created_at))}">${esc(timeAgo(r.created_at))}</td>
        </tr>`,
        )
        .join('')
    : emptyRow(9, state.data.requests.length ? 'No requests match these filters.' : 'No meeting requests yet. They appear here as soon as an investor books.');
  document.getElementById('view-body').innerHTML = tableWrap(head, body);
}

// ---------------------------------------------------------------------------
// Investors
// ---------------------------------------------------------------------------
// stage chips (automatic, from their requests) + test + archived
const INVESTOR_CHIPS = [
  { id: 'all', label: 'All', test: (s) => !s.archived_at && !hasTestTag(s) },
  ...STAGES.map((st) => ({ id: st.value, label: st.label, tone: st.tone, test: (s, d) => !s.archived_at && !hasTestTag(s) && d.stageOf(s.id) === st.value })),
  { id: 'test', label: 'Test', tone: 'yellow', test: (s) => !s.archived_at && hasTestTag(s) },
  { id: 'archived', label: 'Archived', tone: 'gray', test: (s) => Boolean(s.archived_at) },
];
const investorChipItems = () => {
  const d = derived();
  return INVESTOR_CHIPS.map((c) => ({ ...c, count: state.data.submissions.filter((s) => c.test(s, d)).length }));
};
const stageOrder = Object.fromEntries(STAGES.map((st, i) => [st.value, i]));
const stagePill = (stage) => `<span title="${esc(STAGE[stage].hint)}">${pill(STAGE[stage].label, STAGE[stage].tone)}</span>`;

function investorRows() {
  const f = state.filters.investors;
  const d = derived();
  const chip = INVESTOR_CHIPS.find((c) => c.id === f.chip) || INVESTOR_CHIPS[0];
  const rows = state.data.submissions
    .filter((s) => chip.test(s, d))
    .map((s) => ({ s, reqs: (d.requestsBySubmission.get(s.id) || []).filter((r) => !r.archived_at), stage: d.stageOf(s.id) }))
    .filter(({ s }) => !f.source || s.source === f.source)
    .filter(({ s }) => !f.tag || (s.tags || []).includes(f.tag))
    .filter(({ s, reqs }) =>
      matches(f.q, fullName(s), s.email, s.company, s.linkedin, s.notes, ...(s.tags || []), ...reqs.map((r) => d.speakerById.get(r.speaker_id)?.name)),
    );
  return sortRows(
    rows,
    {
      investor: ({ s }) => fullName(s).toLowerCase(),
      email: ({ s }) => s.email,
      speakers: ({ reqs }) => reqs.length,
      stage: ({ stage }) => stageOrder[stage],
      created: ({ s }) => s.created_at,
    },
    f.sort,
  );
}

function renderInvestors() {
  const main = document.getElementById('main');
  main.innerHTML =
    pageHeader(
      'Investors',
      'Everyone who booked on the website or was added by the team. The stage follows their meeting requests automatically.',
      `<button data-export="investors" class="${BTN_SECONDARY}">${icon('download', 'size-4')} Export CSV</button>
       <button data-action="new-investor" class="${BTN_PRIMARY}">${icon('plus', 'size-4')} New investor</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('investors', investorChipItems())}</div>
      <div class="flex flex-wrap items-center gap-3">
        ${searchBox('investors', 'Search name, email, company, speaker, tag…')}
        ${sourceFilter('investors')}
        ${tagFilter('investors')}
        <span id="count" class="ml-auto text-sm text-slate-500"></span>
      </div>
      <div id="view-body"></div>
    </div>`;
  renderInvestorsBody();
}

function renderInvestorsBody() {
  const rows = investorRows();
  const d = derived();
  pruneSelection('investors', rows.map(({ s }) => s.id));
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
    ${selectAllCell('investors', rows.map(({ s }) => s.id))}
    ${sortHeader('investors', 'investor', 'Investor')}
    ${sortHeader('investors', 'email', 'Contact')}
    ${sortHeader('investors', 'speakers', 'Speakers requested')}
    ${sortHeader('investors', 'stage', 'Stage')}
    ${sortHeader('investors', 'created', 'Created')}
  </tr>`;
  const body = rows.length
    ? rows
        .map(({ s, reqs, stage }) => {
          const linkedin = safeUrl(s.linkedin);
          return `<tr data-open="investor" data-id="${s.id}" class="cursor-pointer hover:bg-slate-50 ${state.selected.investors.has(s.id) ? 'bg-brand-50/60' : 'bg-white'}">
            ${selectCell('investors', s.id)}
            <td class="px-4 py-3">
              <div class="flex items-center gap-3">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">${esc(initials(s))}</span>
                <div class="whitespace-nowrap">
                  <div class="font-medium">${esc(fullName(s))}</div>
                  <div class="text-xs text-slate-500">${esc(s.company || '')}</div>
                  <div class="mt-1 flex flex-wrap gap-1">${sourceBadge(s.source, s.created_by)}${sendsBadge(d.websiteSends(s.id))}${s.archived_at ? pill('Archived', 'gray') : ''}${tagChips(s.tags)}</div>
                </div>
              </div>
            </td>
            <td class="px-4 py-3" data-stop>
              <a href="mailto:${esc(s.email)}" class="text-slate-700 hover:text-brand-600">${esc(s.email)}</a>
              ${linkedin ? `<a href="${esc(linkedin)}" target="_blank" rel="noopener noreferrer" class="block text-xs text-slate-500 hover:text-brand-600">LinkedIn ↗</a>` : ''}
            </td>
            <td class="px-4 py-3">
              <div class="flex max-w-md flex-wrap gap-1.5">
                ${reqs
                  .map((r) => {
                    const st = REQUEST_STATUS[r.status];
                    const sp = d.speakerById.get(r.speaker_id);
                    return `<span class="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-700 ring-1 ring-inset ring-slate-200" title="${esc(st?.label)}">${dot(st?.tone)}${esc(sp?.company || sp?.name || '?')}</span>`;
                  })
                  .join('') || '<span class="text-xs text-slate-400">—</span>'}
              </div>
            </td>
            <td class="px-4 py-3">${stagePill(stage)}</td>
            <td class="whitespace-nowrap px-4 py-3 text-slate-500" title="${esc(fmtDate(s.created_at))}">${esc(timeAgo(s.created_at))}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(6, state.data.submissions.length ? 'No investors match these filters.' : 'No submissions yet.');
  document.getElementById('view-body').innerHTML = tableWrap(head, body);
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------
const speakerStatus = (s, d) => d.availabilityById.get(s.id)?.status || 'available';
const SPEAKER_CHIPS = [
  { id: 'all', label: 'All', test: (s) => !s.archived_at },
  { id: 'available', label: 'Available', tone: 'green', test: (s, d) => !s.archived_at && speakerStatus(s, d) === 'available' },
  { id: 'full', label: 'Full', tone: 'red', test: (s, d) => !s.archived_at && ['full', 'over_capacity'].includes(speakerStatus(s, d)) },
  { id: 'off', label: 'Paused / closed', tone: 'gray', test: (s) => !s.archived_at && s.availability !== 'open' },
  { id: 'archived', label: 'Archived', tone: 'gray', test: (s) => Boolean(s.archived_at) },
];
const speakerChipItems = () => {
  const d = derived();
  return SPEAKER_CHIPS.map((c) => ({ ...c, count: state.data.speakers.filter((s) => c.test(s, d)).length }));
};

function speakerRows() {
  const f = state.filters.speakers;
  const d = derived();
  const chip = SPEAKER_CHIPS.find((c) => c.id === f.chip) || SPEAKER_CHIPS[0];
  const rows = state.data.speakers
    .map((s) => ({ s, a: d.availabilityById.get(s.id) }))
    .filter(({ s }) => chip.test(s, d))
    .filter(({ s }) => matches(f.q, s.name, s.company, s.slug, s.notes));
  return sortRows(
    rows,
    {
      name: ({ s }) => s.name.toLowerCase(),
      capacity: ({ s }) => s.capacity,
      used: ({ s, a }) => (a?.used || 0) / Math.max(s.capacity, 1),
      confirmed: ({ a }) => a?.confirmed || 0,
      waitlisted: ({ a }) => a?.waitlisted || 0,
    },
    f.sort,
  );
}

function renderSpeakers() {
  const main = document.getElementById('main');
  const d = derived();
  main.innerHTML =
    pageHeader(
      'Speakers',
      'Capacity and availability. Changes show on the website within ~10 seconds.',
      `<button data-export="speakers" class="${BTN_SECONDARY}">${icon('download', 'size-4')} Export CSV</button>
       <button data-sync-source="live" class="${BTN_SECONDARY}">${icon('sync', 'size-4')} Compare with website</button>
       <button data-action="new-speaker" class="${BTN_PRIMARY}">${icon('plus', 'size-4')} Add speaker</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('speakers', speakerChipItems())}</div>
      <div class="flex flex-wrap items-center gap-3">
        ${searchBox('speakers', 'Search name, company, slug…')}
        <span id="count" class="ml-auto text-sm text-slate-500"></span>
      </div>
      <div id="view-body"></div>
    </div>`;
  renderSpeakersBody();
}

function renderSpeakersBody() {
  const rows = speakerRows();
  pruneSelection('speakers', rows.map(({ s }) => s.id));
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
    ${selectAllCell('speakers', rows.map(({ s }) => s.id))}
    ${sortHeader('speakers', 'name', 'Speaker')}
    ${sortHeader('speakers', 'capacity', 'Capacity', 'w-28')}
    <th class="px-4 py-2.5 text-left font-medium">Availability</th>
    ${sortHeader('speakers', 'used', 'Booked', 'min-w-44')}
    ${sortHeader('speakers', 'confirmed', 'Confirmed', 'w-24')}
    ${sortHeader('speakers', 'waitlisted', 'Waitlist', 'w-24')}
    <th class="px-4 py-2.5 text-left font-medium">Website shows</th>
  </tr>`;
  const body = rows.length
    ? rows
        .map(({ s, a }) => {
          const st = CAPACITY_STATUSES[a?.status] || CAPACITY_STATUSES.available;
          return `<tr data-open="speaker" data-id="${s.id}" class="cursor-pointer hover:bg-slate-50 ${state.selected.speakers.has(s.id) ? 'bg-brand-50/60' : 'bg-white'}">
            ${selectCell('speakers', s.id)}
            <td class="whitespace-nowrap px-4 py-3"><div class="font-medium">${esc(s.name)}</div><div class="text-xs text-slate-500">${esc(s.company)} · <span class="font-mono">${esc(s.slug)}</span></div></td>
            <td class="px-4 py-3" data-stop>
              <input data-action="speaker-capacity" data-id="${s.id}" type="number" min="0" max="99" value="${s.capacity}" aria-label="Capacity"
                class="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums shadow-xs focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none">
            </td>
            <td class="px-4 py-3" data-stop>${statusSelect('speaker', s.id, s.availability)}</td>
            <td class="px-4 py-3"><div class="flex items-center gap-3"><div class="w-28">${capacityBar(s, a)}</div><span class="text-xs font-semibold tabular-nums text-slate-600">${a?.used || 0}/${s.capacity}</span></div></td>
            <td class="px-4 py-3 tabular-nums text-slate-600">${a?.confirmed || 0}</td>
            <td class="px-4 py-3 tabular-nums text-slate-600">${a?.waitlisted || 0}</td>
            <td class="px-4 py-3">${s.archived_at ? pill('Archived', 'gray') : a?.status === 'available' ? `<span class="text-xs text-slate-500">${a.available} place${a.available === 1 ? '' : 's'} left</span>` : pill(st.label, st.tone)}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(8, state.data.speakers.length ? 'No speakers match these filters.' : 'No speakers yet.');
  document.getElementById('view-body').innerHTML = tableWrap(head, body);
}

// ---------------------------------------------------------------------------
// Drawer (side panel)
// ---------------------------------------------------------------------------
let drawerKeyHandler = null;

function closeDrawer() {
  drawerRoot.innerHTML = '';
  if (drawerKeyHandler) document.removeEventListener('keydown', drawerKeyHandler);
  drawerKeyHandler = null;
}

function openDrawer({ title, subtitle = '', body, footerLeft = '', submitLabel = 'Save changes', onSubmit }) {
  drawerRoot.innerHTML = `
    <div class="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" data-close></div>
      <form id="drawer-form" class="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-2xl">
        <div class="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">${title}</h2>
            ${subtitle ? `<p class="mt-0.5 truncate text-sm text-slate-500">${subtitle}</p>` : ''}
          </div>
          <button type="button" data-close class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="flex-1 space-y-6 overflow-y-auto px-6 py-5 scrollbar-thin">${body}</div>
        <div class="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <div>${footerLeft}</div>
          <div class="flex gap-2">
            <button type="button" data-close class="${BTN_SECONDARY}">Cancel</button>
            ${onSubmit ? `<button class="${BTN_PRIMARY}">${esc(submitLabel)}</button>` : ''}
          </div>
        </div>
      </form>
    </div>`;

  const form = document.getElementById('drawer-form');
  drawerRoot.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDrawer));
  drawerKeyHandler = (e) => e.key === 'Escape' && closeDrawer();
  document.addEventListener('keydown', drawerKeyHandler);

  form.addEventListener('focusout', (e) => {
    if (e.target.matches?.('[data-tag-input]')) commitTagInput(e.target);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    form.querySelectorAll('[data-tag-input]').forEach(commitTagInput);
    const btn = form.querySelector('button:not([type])');
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form));
      closeDrawer();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });
  return form;
}

const field = (label, control, hint = '') => `
  <label class="block">
    <span class="mb-1 block text-sm font-medium text-slate-700">${esc(label)}</span>
    ${control}
    ${hint ? `<span class="mt-1 block text-xs text-slate-500">${hint}</span>` : ''}
  </label>`;
const input = (name, value, attrs = '', cls = '') => `<input name="${name}" value="${esc(value ?? '')}" class="${INPUT} ${cls}" ${attrs}>`;
const textarea = (name, value, rows = 4) => `<textarea name="${name}" rows="${rows}" class="${INPUT}">${esc(value ?? '')}</textarea>`;
const select = (name, options, value, empty = '') =>
  `<select name="${name}" class="${SELECT}">${empty ? `<option value="">${esc(empty)}</option>` : ''}${options
    .map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('')}</select>`;
const assigneeOptions = () => state.data.admins.map((a) => ({ value: a.email, label: a.name ? `${a.name} (${a.email})` : a.email }));
const infoRow = (label, value) =>
  `<div class="grid grid-cols-[8rem_1fr] gap-3 py-1.5 text-sm"><dt class="text-slate-500">${esc(label)}</dt><dd class="min-w-0 break-words text-slate-900">${value}</dd></div>`;
const section = (title, content) => `<section><h3 class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">${esc(title)}</h3>${content}</section>`;

function openRequest(id) {
  const d = derived();
  const r = state.data.requests.find((x) => x.id === id);
  if (!r) return;
  const sub = d.submissionById.get(r.submission_id);
  const sp = d.speakerById.get(r.speaker_id);
  const linkedin = safeUrl(sub?.linkedin);
  openDrawer({
    title: `Request #${r.request_number}`,
    subtitle: `${esc(fullName(sub))} → ${esc(sp?.name || '?')}`,
    body:
      (d.flagsOf(r).length ? `<div class="flex flex-wrap gap-1.5">${d.flagsOf(r).map((f) => `<span title="${esc(f.title)}">${pill(f.label, f.tone)}</span> <span class="text-xs text-slate-500">${esc(f.title)}</span>`).join('<span class="w-full"></span>')}</div>` : '') +
      section(
        'Details',
        `<dl class="divide-y divide-slate-100 rounded-lg border border-slate-200 px-4 py-1">
          ${infoRow('Investor', `<button type="button" data-open="investor" data-id="${sub?.id}" class="font-medium text-brand-600 hover:text-brand-700">${esc(fullName(sub))}</button>`)}
          ${infoRow('Company', esc(sub?.company || '—'))}
          ${infoRow('Email', sub?.email ? `<a href="mailto:${esc(sub.email)}" class="hover:text-brand-600">${esc(sub.email)}</a>` : '—')}
          ${infoRow('LinkedIn', linkedin ? `<a href="${esc(linkedin)}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">Open profile ↗</a>` : esc(sub?.linkedin || '—'))}
          ${infoRow('Speaker', `<button type="button" data-open="speaker" data-id="${sp?.id}" class="font-medium text-brand-600 hover:text-brand-700">${esc(sp?.name || '?')}</button> <span class="text-slate-500">· ${esc(sp?.company || '')}</span>`)}
          ${infoRow('Preference', r.preference_rank ? `#${r.preference_rank} of ${(d.requestsBySubmission.get(r.submission_id) || []).length}` : '—')}
          ${infoRow('Submitted', esc(fmtDate(r.created_at)))}
        </dl>`,
      ) +
      section(
        'Status',
        `<div class="grid gap-4 sm:grid-cols-2">
          ${field('Status', select('status', REQUEST_STATUSES, r.status), 'New, review, hold, accepted and scheduled take a place.')}
          ${field('Closure reason', select('closure_reason', CLOSURE_REASONS, r.closure_reason, '—'), 'For declined, cancelled or expired.')}
          ${field('Hold until', input('hold_until', toLocalInput(r.hold_until), 'type="datetime-local"'))}
          ${field('Assignee', select('assignee', assigneeOptions(), r.assignee, 'Nobody'))}
        </div>`,
      ) +
      section(
        'Meeting',
        `<div class="grid gap-4 sm:grid-cols-2">
          ${field('Starts', input('scheduled_start', toLocalInput(r.scheduled_start), 'type="datetime-local"'))}
          ${field('Ends', input('scheduled_end', toLocalInput(r.scheduled_end), 'type="datetime-local"'))}
        </div>`,
      ) +
      section('Tags', tagsEditor('tags', r.tags, d.allTags)) +
      section('Internal notes', textarea('internal_notes', r.internal_notes, 5)),
    footerLeft: r.archived_at
      ? `<button type="button" data-action="restore-request" data-id="${r.id}" class="${BTN_SECONDARY}">Restore</button>`
      : `<button type="button" data-action="archive-request" data-id="${r.id}" class="${BTN_DANGER}">Archive</button>`,
    onSubmit: async (fd) => {
      await state.store.updateRequest(r.id, {
        tags: JSON.parse(fd.get('tags') || '[]'),
        status: fd.get('status'),
        closure_reason: nullIfEmpty(fd.get('closure_reason')),
        hold_until: fromLocalInput(fd.get('hold_until')),
        assignee: nullIfEmpty(fd.get('assignee')),
        scheduled_start: fromLocalInput(fd.get('scheduled_start')),
        scheduled_end: fromLocalInput(fd.get('scheduled_end')),
        internal_notes: nullIfEmpty(fd.get('internal_notes')),
      });
      toast(`Request #${r.request_number} saved.`);
      reload();
    },
  });
}

const archivedBanner = (row, kind) =>
  row.archived_at
    ? `<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
        <span class="text-slate-600">Archived ${esc(fmtDate(row.archived_at))}${row.archived_by ? ` by ${esc(row.archived_by)}` : ''}. ${kind === 'investor' ? 'Their requests don’t take places.' : 'Can’t be booked on the website.'}</span>
        <button type="button" data-action="restore-${kind}" data-id="${row.id}" class="${BTN_SECONDARY} py-1.5">Restore</button>
      </div>`
    : '';

const availabilityNote = (sp, d) => {
  const a = d.availabilityById.get(sp.id);
  if (!a) return '';
  if (a.status === 'available') return `${a.available} left`;
  return (CAPACITY_STATUSES[a.status] || CAPACITY_STATUSES.closed).label.toLowerCase();
};

function historyList(sub, d) {
  const events = d.eventsBySubmission.get(sub.id) || [];
  if (!events.length) return '<p class="text-sm text-slate-500">No history yet.</p>';
  const names = (slugs) =>
    (slugs || []).map((slug) => {
      const sp = state.data.speakers.find((x) => x.slug === slug);
      return esc(sp ? `${sp.name} (${sp.company})` : slug);
    });
  const RAW_LABELS = { firstName: 'First name', lastName: 'Last name', email: 'Email', company: 'Company', linkedin: 'LinkedIn', speakers: 'Speakers', page: 'Page', userAgent: 'Browser' };
  return `<ol class="space-y-3">${events
    .map((e) => {
      const website = e.source === 'website';
      const action = website
        ? 'Submitted the website form'
        : e.payload?.action === 'create_investor'
          ? 'Investor created by the team'
          : 'Speakers added by the team';
      const raw = website
        ? `<details class="mt-2 text-xs">
            <summary class="cursor-pointer text-slate-500 hover:text-slate-800">Original submission</summary>
            <dl class="mt-2 rounded-md bg-slate-50 px-3 py-1.5">${Object.entries(RAW_LABELS)
              .filter(([k]) => e.payload?.[k] !== undefined && e.payload?.[k] !== null && e.payload?.[k] !== '')
              .map(([k, label]) => infoRow(label, esc(Array.isArray(e.payload[k]) ? e.payload[k].join(', ') : e.payload[k])))
              .join('')}${e.booking_id ? infoRow('Booking ID', `<span class="font-mono">${esc(e.booking_id)}</span>`) : ''}</dl>
          </details>`
        : e.payload?.note
          ? `<p class="mt-1 text-xs text-slate-600">Note: ${esc(e.payload.note)}</p>`
          : '';
      return `<li class="rounded-lg border border-slate-200 px-3 py-2.5">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          ${sourceBadge(e.source, e.created_by)}
          <span class="font-medium">${action}</span>
          <span class="ml-auto text-xs text-slate-500" title="${esc(fmtDate(e.created_at))}">${esc(fmtDate(e.created_at))}</span>
        </div>
        ${e.created_by ? `<p class="mt-0.5 text-xs text-slate-500">by ${esc(e.created_by)}</p>` : ''}
        ${e.added_slugs?.length ? `<p class="mt-1 text-xs text-slate-600"><span class="text-slate-500">Added:</span> ${names(e.added_slugs).join(', ')}</p>` : ''}
        ${e.skipped_slugs?.length ? `<p class="mt-0.5 text-xs text-slate-600"><span class="text-slate-500">Already requested:</span> ${names(e.skipped_slugs).join(', ')}</p>` : ''}
        ${raw}
      </li>`;
    })
    .join('')}</ol>`;
}

function openInvestor(id) {
  const d = derived();
  const s = state.data.submissions.find((x) => x.id === id);
  if (!s) return;
  const reqs = d.requestsBySubmission.get(s.id) || [];
  const have = new Set(reqs.map((r) => r.speaker_id));
  const candidates = d.live.speakers.filter((sp) => !have.has(sp.id));
  const sends = d.websiteSends(s.id);

  const addSpeakerForm = s.archived_at
    ? ''
    : candidates.length
      ? `<div class="mt-3 rounded-lg border border-dashed border-slate-300 p-3" data-add-requests="${s.id}">
          <p class="mb-2 text-xs font-medium text-slate-600">Add a speaker (e.g. asked by email)</p>
          <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
            <select data-add-speaker class="${SELECT}">
              ${candidates.map((sp) => `<option value="${sp.id}">${esc(sp.name)} · ${esc(sp.company)} — ${esc(availabilityNote(sp, d))}</option>`).join('')}
            </select>
            <select data-add-status class="${SELECT}">${REQUEST_STATUSES.filter((x) => !CLOSED.has(x.value)).map((x) => `<option value="${x.value}">${esc(x.label)}</option>`).join('')}</select>
          </div>
          <div class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input data-add-note placeholder="Note (optional), e.g. “asked by email on 21 Oct”" class="${INPUT}">
            <button type="button" data-action="add-requests" class="${BTN_PRIMARY}">${icon('plus', 'size-4')} Add</button>
          </div>
          <p class="mt-2 hidden text-xs text-amber-700" data-add-warning></p>
        </div>`
      : `<p class="mt-3 text-xs text-slate-500">They already have a request for every speaker.</p>`;

  openDrawer({
    title: esc(fullName(s)),
    subtitle: esc([s.company, s.email].filter(Boolean).join(' · ')),
    body:
      archivedBanner(s, 'investor') +
      `<div class="flex flex-wrap gap-1.5">${sourceBadge(s.source, s.created_by)}${sendsBadge(sends)}
        <span class="text-xs text-slate-500">${s.source === 'panel' ? `Added ${esc(fmtDate(s.created_at))}${s.created_by ? ` by ${esc(s.created_by)}` : ''}` : `First submitted ${esc(fmtDate(s.created_at))}`}</span>
      </div>` +
      section(
        `Requested speakers (${reqs.length})`,
        (reqs.length
          ? `<ul class="divide-y divide-slate-100 rounded-lg border border-slate-200">${reqs
              .map((r) => {
                const sp = d.speakerById.get(r.speaker_id);
                return `<li class="flex items-center gap-3 px-3 py-2.5">
                  <span class="w-6 text-xs tabular-nums text-slate-400">#${r.preference_rank || '–'}</span>
                  <button type="button" data-open="request" data-id="${r.id}" class="min-w-0 flex-1 text-left">
                    <span class="flex items-center gap-1.5 text-sm font-medium hover:text-brand-600"><span class="truncate">${esc(sp?.name || '?')}</span>${r.source === 'panel' ? sourceBadge(r.source, r.created_by) : ''}</span>
                    <span class="block truncate text-xs text-slate-500">${esc(sp?.company || '')}</span>
                  </button>
                  ${statusSelect('request', r.id, r.status)}
                </li>`;
              })
              .join('')}</ul>`
          : `<p class="text-sm text-slate-500">No meeting requests.</p>`) + addSpeakerForm,
      ) +
      section(
        'Investor',
        `<div class="grid gap-4 sm:grid-cols-2">
          ${field('First name', input('first_name', s.first_name))}
          ${field('Last name', input('last_name', s.last_name))}
          ${field('Email', input('email', s.email, 'type="email" required'))}
          ${field('Company', input('company', s.company))}
          <div class="sm:col-span-2">${field('LinkedIn', input('linkedin', s.linkedin))}</div>
        </div>`,
      ) +
      section(
        'Follow-up',
        `<div class="grid gap-4 sm:grid-cols-2">
          <div><span class="mb-1 block text-sm font-medium text-slate-700">Stage</span>${stagePill(d.stageOf(s.id))}
            <span class="mt-1 block text-xs text-slate-500">Automatic: ${esc(STAGE[d.stageOf(s.id)].hint.toLowerCase())}.</span></div>
          ${field('Assignee', select('assignee', assigneeOptions(), s.assignee, 'Nobody'))}
          <div class="sm:col-span-2"><span class="mb-1 block text-sm font-medium text-slate-700">Tags</span>${tagsEditor('tags', s.tags, d.allTags)}</div>
          <div class="sm:col-span-2">${field('Notes', textarea('notes', s.notes))}</div>
        </div>`,
      ) +
      section(`History${sends > 1 ? ` · sent the form ${sends}×` : ''}`, historyList(s, d)),
    footerLeft: s.archived_at
      ? `<button type="button" data-action="restore-investor" data-id="${s.id}" class="${BTN_SECONDARY}">Restore</button>`
      : `<button type="button" data-action="archive-investor" data-id="${s.id}" class="${BTN_DANGER}">Archive</button>`,
    onSubmit: async (fd) => {
      await state.store.updateSubmission(s.id, {
        first_name: nullIfEmpty(fd.get('first_name')),
        last_name: nullIfEmpty(fd.get('last_name')),
        email: String(fd.get('email')).trim().toLowerCase(),
        company: nullIfEmpty(fd.get('company')),
        linkedin: nullIfEmpty(fd.get('linkedin')),
        tags: JSON.parse(fd.get('tags') || '[]'),
        assignee: nullIfEmpty(fd.get('assignee')),
        notes: nullIfEmpty(fd.get('notes')),
      });
      toast(`${fullName(s)} saved.`);
      reload();
    },
  });
  updateAddWarning();
}

// warn when the picked speaker can't take another booking (the team may still add it, e.g. as waitlisted)
function updateAddWarning() {
  const box = document.querySelector('[data-add-requests]');
  if (!box) return;
  const a = derived().availabilityById.get(box.querySelector('[data-add-speaker]').value);
  const warn = box.querySelector('[data-add-warning]');
  const blocked = a && a.status !== 'available';
  warn.classList.toggle('hidden', !blocked);
  if (blocked) {
    warn.textContent = `This speaker is ${(CAPACITY_STATUSES[a.status] || CAPACITY_STATUSES.closed).label.toLowerCase()} (${a.used}/${a.used + a.remaining} taken). Consider “Waitlisted”.`;
  }
}

function openNewInvestor() {
  const d = derived();
  openDrawer({
    title: 'New investor',
    subtitle: 'For investors who got in touch outside the website form.',
    submitLabel: 'Create investor',
    body:
      section(
        'Investor',
        `<div class="grid gap-4 sm:grid-cols-2">
          ${field('First name', input('first_name', ''))}
          ${field('Last name', input('last_name', ''))}
          ${field('Email', input('email', '', 'type="email" required'), 'One card per email. If it exists, add speakers on that card instead.')}
          ${field('Company', input('company', ''))}
          <div class="sm:col-span-2">${field('LinkedIn', input('linkedin', ''))}</div>
          <div class="sm:col-span-2">${field('Notes', textarea('notes', '', 3))}</div>
        </div>`,
      ) +
      section(
        'Speakers (optional)',
        `<div class="mb-3 max-w-64">${field('Status for these requests', select('status', REQUEST_STATUSES.filter((x) => !CLOSED.has(x.value)), 'new_request'))}</div>
        <ul class="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">${d.live.speakers
          .map(
            (sp) => `<li><label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
              <input type="checkbox" name="speaker_ids" value="${sp.id}" class="size-4 rounded border-slate-300 accent-brand-600">
              <span class="min-w-0 flex-1 truncate text-sm">${esc(sp.name)} <span class="text-slate-500">· ${esc(sp.company)}</span></span>
              <span class="text-xs text-slate-500">${esc(availabilityNote(sp, d))}</span>
            </label></li>`,
          )
          .join('')}</ul>`,
      ),
    onSubmit: async (fd) => {
      const id = await state.store.createInvestor({
        email: String(fd.get('email')).trim().toLowerCase(),
        first_name: nullIfEmpty(fd.get('first_name')),
        last_name: nullIfEmpty(fd.get('last_name')),
        company: nullIfEmpty(fd.get('company')),
        linkedin: nullIfEmpty(fd.get('linkedin')),
        notes: nullIfEmpty(fd.get('notes')),
        speaker_ids: fd.getAll('speaker_ids'),
        status: fd.get('status'),
      });
      toast('Investor created.');
      await reload();
      setTimeout(() => openInvestor(id), 0);
    },
  });
}

function openNewRequest() {
  const d = derived();
  const investors = [...d.live.submissions].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  openDrawer({
    title: 'New meeting request',
    subtitle: 'Link an existing investor to a speaker.',
    submitLabel: 'Create request',
    body: investors.length
      ? `<div class="grid gap-4">
          ${field(
            'Investor',
            `<select name="submission_id" required class="${SELECT}">${investors
              .map((x) => `<option value="${x.id}">${esc(fullName(x))}${x.company ? ` · ${esc(x.company)}` : ''} — ${esc(x.email)}</option>`)
              .join('')}</select>`,
            'Not in the list? <button type="button" data-action="new-investor" class="font-medium text-brand-600 hover:text-brand-700">Create a new investor</button> first.',
          )}
          ${field(
            'Speaker',
            `<select name="speaker_id" required class="${SELECT}">${d.live.speakers
              .map((sp) => `<option value="${sp.id}">${esc(sp.name)} · ${esc(sp.company)} — ${esc(availabilityNote(sp, d))}</option>`)
              .join('')}</select>`,
          )}
          ${field('Status', select('status', REQUEST_STATUSES.filter((x) => !CLOSED.has(x.value)), 'new_request'))}
          ${field('Note', input('note', '', 'placeholder="e.g. asked by email on 21 Oct"'))}
        </div>`
      : `<p class="text-sm text-slate-500">No investors yet. <button type="button" data-action="new-investor" class="font-medium text-brand-600">Create one</button>.</p>`,
    onSubmit: investors.length
      ? async (fd) => {
          const submissionId = fd.get('submission_id');
          const speakerId = fd.get('speaker_id');
          if (state.data.requests.some((r) => r.submission_id === submissionId && r.speaker_id === speakerId)) {
            throw new Error('This investor already has a request for this speaker.');
          }
          const added = await state.store.addRequests(submissionId, [speakerId], fd.get('status'), nullIfEmpty(fd.get('note')));
          if (!added) throw new Error('Nothing was added (the speaker may be archived).');
          toast('Meeting request created.');
          reload();
        }
      : null,
  });
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...state.data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `eic-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openSpeaker(id) {
  const d = derived();
  const s = id ? state.data.speakers.find((x) => x.id === id) : null;
  if (id && !s) return;
  const a = s && d.availabilityById.get(s.id);
  const reqs = s ? d.requestsBySpeaker.get(s.id) || [] : [];
  const st = a && (CAPACITY_STATUSES[a.status] || CAPACITY_STATUSES.available);
  openDrawer({
    title: s ? esc(s.name) : 'Add speaker',
    subtitle: s ? esc(s.company) : 'The slug must match the speaker’s Webflow CMS slug.',
    submitLabel: s ? 'Save changes' : 'Add speaker',
    body:
      (s ? archivedBanner(s, 'speaker') : '') +
      (s
        ? section(
            'Capacity',
            `<div class="rounded-lg border border-slate-200 p-4">
              <div class="mb-3 flex items-center justify-between text-sm"><span><span class="text-2xl font-semibold">${a?.used || 0}</span><span class="text-slate-500"> / ${s.capacity} places taken</span></span>${pill(st.label, st.tone)}</div>
              ${capacityBar(s, a)}
              <div class="mt-3 flex gap-5 text-xs text-slate-500"><span>${a?.confirmed || 0} confirmed</span><span>${Math.max((a?.used || 0) - (a?.confirmed || 0), 0)} pending</span><span>${a?.waitlisted || 0} waitlisted</span></div>
            </div>`,
          )
        : '') +
      section(
        'Speaker',
        `<div class="grid gap-4 sm:grid-cols-2">
          ${field('Name', input('name', s?.name, 'required'))}
          ${field('Company', input('company', s?.company, 'required'))}
          <div class="sm:col-span-2">${field(
            'Slug',
            input('slug', s?.slug, `required pattern="[a-z0-9]+(-[a-z0-9]+)*" ${s ? 'disabled' : ''}`, 'font-mono'),
            s ? 'Links the website card to this speaker. If it changed in Webflow, use “Compare with website”.' : 'Lowercase, numbers and dashes, exactly as in Webflow (e.g. <span class="font-mono">geniel-srl</span>).',
          )}</div>
          ${field('Capacity', input('capacity', s?.capacity ?? 4, 'type="number" min="0" max="99" required'))}
          ${field('Availability', select('availability', SPEAKER_STATES, s?.availability || 'open'), 'Not “Open” = can’t be booked on the website.')}
          ${field('Assignee', select('assignee', assigneeOptions(), s?.assignee, 'Nobody'))}
          <div class="sm:col-span-2">${field('Notes', textarea('notes', s?.notes, 3))}</div>
        </div>`,
      ) +
      (s
        ? section(
            `Requests (${reqs.length})`,
            reqs.length
              ? `<ul class="divide-y divide-slate-100 rounded-lg border border-slate-200">${reqs
                  .map((r) => {
                    const sub = d.submissionById.get(r.submission_id);
                    return `<li class="flex items-center gap-3 px-3 py-2.5">
                      <button type="button" data-open="request" data-id="${r.id}" class="min-w-0 flex-1 text-left">
                        <span class="block truncate text-sm font-medium hover:text-brand-600">${esc(fullName(sub))}</span>
                        <span class="block truncate text-xs text-slate-500">${esc(sub?.company || sub?.email || '')} · pref. #${r.preference_rank || '–'}</span>
                      </button>
                      ${statusSelect('request', r.id, r.status)}
                    </li>`;
                  })
                  .join('')}</ul>`
              : `<p class="text-sm text-slate-500">No requests yet.</p>`,
          )
        : ''),
    footerLeft: !s
      ? ''
      : s.archived_at
        ? `<button type="button" data-action="restore-speaker" data-id="${s.id}" class="${BTN_SECONDARY}">Restore</button>`
        : `<button type="button" data-action="archive-speaker" data-id="${s.id}" class="${BTN_DANGER}">Archive</button>`,
    onSubmit: async (fd) => {
      const capacity = Number(fd.get('capacity'));
      if (!Number.isInteger(capacity) || capacity < 0) throw new Error('Capacity must be a whole number, 0 or more.');
      const row = {
        name: String(fd.get('name')).trim(),
        company: String(fd.get('company')).trim(),
        capacity,
        availability: fd.get('availability'),
        assignee: nullIfEmpty(fd.get('assignee')),
        notes: nullIfEmpty(fd.get('notes')),
      };
      if (s) {
        await state.store.updateSpeaker(s.id, row);
        toast(`${row.name} saved.`);
      } else {
        await state.store.createSpeaker({ ...row, slug: String(fd.get('slug')).trim().toLowerCase() });
        toast(`${row.name} added.`);
      }
      reload();
    },
  });
}

// ---------------------------------------------------------------------------
// Compare with website (Webflow page = source of truth for slug / name / company)
// ---------------------------------------------------------------------------
const SYNC_GROUPS = [
  { type: 'add', title: 'New on the website', hint: 'Cards that aren’t in the database yet. They’ll be added with capacity 4 and “Open”.', tone: 'green' },
  { type: 'update', title: 'Name or company changed', hint: 'The website shows different text for these speakers.', tone: 'blue' },
  { type: 'slug', title: 'Slug changed on the website', hint: 'Same person, new slug. Updating keeps all their bookings and makes the website badge work again.', tone: 'amber' },
  { type: 'missing', title: 'Not on the website', hint: 'No card found. Maybe removed, maybe hidden on purpose — so not ticked by default. Applying marks them “Closed” (no new bookings; existing requests stay).', tone: 'gray' },
];

let syncRun = 0;

const change = (label, from, to) =>
  `<div class="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs"><span class="w-16 shrink-0 text-slate-500">${esc(label)}</span><span class="text-slate-400 line-through">${esc(from || '—')}</span><span class="text-slate-400">→</span><span class="font-medium text-slate-900">${esc(to)}</span></div>`;

function suggestionBody(sg) {
  if (sg.type === 'add') {
    return `<div class="text-sm font-medium">${esc(sg.site.name || '—')} <span class="font-normal text-slate-500">· ${esc(sg.site.company || '—')}</span></div>
      <div class="mt-0.5 font-mono text-xs text-slate-500">${esc(sg.site.slug)}</div>`;
  }
  if (sg.type === 'missing') {
    return `<div class="text-sm font-medium">${esc(sg.speaker.name)} <span class="font-normal text-slate-500">· ${esc(sg.speaker.company)}</span></div>
      <div class="mt-0.5 text-xs text-slate-500"><span class="font-mono">${esc(sg.speaker.slug)}</span>${sg.requests ? ` · ${sg.requests} request${sg.requests === 1 ? '' : 's'} (kept)` : ''}</div>`;
  }
  const f = sg.fields;
  return `<div class="text-sm font-medium">${esc(sg.speaker.name)} <span class="font-normal text-slate-500">· ${esc(sg.speaker.company)}</span></div>
    ${f.slug ? change('Slug', sg.speaker.slug, f.slug) : ''}
    ${f.name ? change('Name', sg.speaker.name, f.name) : ''}
    ${f.company ? change('Company', sg.speaker.company, f.company) : ''}`;
}

async function openSync(source = 'live') {
  const run = ++syncRun;
  const sourceTabs = `<div class="inline-flex rounded-lg bg-slate-100 p-1 text-sm">
    ${[
      ['live', 'Live site'],
      ['staging', 'Staging (webflow.io)'],
    ]
      .map(([id, label]) => `<button type="button" data-sync-source="${id}" class="rounded-md px-3 py-1.5 font-medium ${id === source ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900'}">${label}</button>`)
      .join('')}
  </div>`;
  const shell = (content, onSubmit, submitLabel) =>
    openDrawer({
      title: 'Compare with website',
      subtitle: 'The Webflow page is the source of truth for speaker names, companies and slugs.',
      body: `<div class="flex flex-wrap items-center justify-between gap-3">${sourceTabs}
        <button type="button" data-sync-source="${source}" class="text-sm text-brand-600 hover:text-brand-700">Check again</button></div>${content}`,
      onSubmit,
      submitLabel,
    });

  shell(`<p class="py-10 text-center text-sm text-slate-500">Reading the ${source === 'staging' ? 'staging' : 'live'} page…</p>`);

  let site;
  try {
    site = await state.store.fetchWebsiteSpeakers(source);
  } catch (err) {
    if (run !== syncRun || !document.getElementById('drawer-form')) return;
    shell(`<p class="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">${esc(errorText(err))}</p>`);
    return;
  }
  if (run !== syncRun || !document.getElementById('drawer-form')) return; // closed or replaced meanwhile

  const counts = new Map();
  state.data.requests.forEach((r) => counts.set(r.speaker_id, (counts.get(r.speaker_id) || 0) + 1));
  const { suggestions, inSync } = diffSpeakers(state.data.speakers, site.speakers, counts);

  const meta = `<p class="text-xs text-slate-500">
      ${site.speakers.length} cards on <a href="${esc(safeUrl(site.url))}" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:text-brand-700">the page ↗</a>
      · read ${esc(timeAgo(site.fetchedAt))} · ${inSync} in sync · ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}
    </p>`;
  const warnings = (site.warnings || []).length
    ? `<ul class="space-y-1 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">${site.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  if (!suggestions.length) {
    shell(`${meta}${warnings}<div class="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-8 text-center">
      <p class="font-medium text-emerald-800">Everything matches the website.</p>
      <p class="mt-1 text-sm text-emerald-700">All ${inSync} speakers have the same slug, name and company.</p></div>`);
    return;
  }

  const groups = SYNC_GROUPS.map((g) => {
    const items = suggestions.map((sg, i) => ({ sg, i })).filter(({ sg }) => sg.type === g.type);
    if (!items.length) return '';
    return `<section>
      <div class="mb-2 flex items-center gap-2">${dot(g.tone)}<h3 class="text-sm font-semibold">${esc(g.title)}</h3><span class="text-xs text-slate-400">${items.length}</span></div>
      <p class="mb-2 text-xs text-slate-500">${esc(g.hint)}</p>
      <ul class="divide-y divide-slate-100 rounded-lg border border-slate-200">
        ${items
          .map(
            ({ sg, i }) => `<li><label class="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-slate-50">
              <input type="checkbox" name="apply" value="${i}" ${sg.type === 'missing' ? '' : 'checked'} class="mt-1 size-4 rounded border-slate-300 accent-brand-600">
              <span class="min-w-0 flex-1">${suggestionBody(sg)}</span>
            </label></li>`,
          )
          .join('')}
      </ul>
    </section>`;
  }).join('');

  shell(
    `${meta}${warnings}${groups}`,
    async (fd) => {
      const picked = fd.getAll('apply').map((i) => suggestions[Number(i)]);
      if (!picked.length) throw new Error('Nothing selected.');
      let done = 0;
      const failed = [];
      for (const sg of picked) {
        const ch = changeFor(sg);
        try {
          if (ch.create) await state.store.createSpeaker(ch.create);
          else await state.store.updateSpeaker(ch.id, ch.update);
          done++;
        } catch (err) {
          failed.push(`${sg.site?.slug || sg.speaker?.slug}: ${errorText(err)}`);
        }
      }
      await reload();
      if (failed.length) {
        toast(`${done} applied, ${failed.length} failed — ${failed.join('; ')}`, 'error');
      } else {
        toast(`${done} change${done === 1 ? '' : 's'} applied.`);
      }
    },
    'Apply selected',
  );
}

// ---------------------------------------------------------------------------
// Bulk editing
// ---------------------------------------------------------------------------
// keep only ticked rows that are still visible (filters, chips, search)
function pruneSelection(view, visibleIds) {
  const visible = new Set(visibleIds);
  for (const id of state.selected[view]) if (!visible.has(id)) state.selected[view].delete(id);
  setTimeout(() => {
    document.querySelectorAll('[data-indeterminate]').forEach((el) => (el.indeterminate = true));
    renderBulkBar();
  }, 0);
}

const rowsOf = (view) => ({ requests: state.data.requests, investors: state.data.submissions, speakers: state.data.speakers })[view];
const NOUN = { requests: ['request', 'requests'], investors: ['investor', 'investors'], speakers: ['speaker', 'speakers'] };
const noun = (view, n) => `${n} ${NOUN[view][n === 1 ? 0 : 1]}`;

function renderBulkBar() {
  const root = document.getElementById('bulk-root');
  if (!root) return;
  const view = state.view;
  const sel = state.selected[view];
  if (!sel || !sel.size) {
    root.innerHTML = '';
    return;
  }
  const d = derived();
  const picked = rowsOf(view).filter((r) => sel.has(r.id));
  const anyArchived = picked.some((r) => (view === 'requests' ? d.requestArchived(r) : r.archived_at));
  const anyActive = picked.some((r) => (view === 'requests' ? !r.archived_at : !r.archived_at));
  const tagsInSelection = [...new Set(picked.flatMap((r) => r.tags || []))].sort();
  const mini = 'rounded-lg border border-slate-300 bg-white py-1.5 pr-7 pl-2.5 text-sm shadow-xs focus:border-brand-500 focus:outline-none';
  const btn = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium';
  const assign = `<select data-bulk="assignee" class="${mini}"><option value="">Assign…</option><option value="__none">Nobody</option>${state.data.admins
    .map((a) => `<option value="${esc(a.email)}">${esc(a.name || a.email)}</option>`)
    .join('')}</select>`;
  const tagControls =
    view === 'speakers'
      ? ''
      : `<span class="inline-flex items-center gap-1"><input data-bulk-tag-input list="tag-suggestions-bulk" placeholder="Add tag" class="w-28 ${mini} pr-2.5">
          <button data-bulk="add-tag" class="${btn} bg-slate-100 text-slate-700 hover:bg-slate-200">${icon('plus', 'size-4')}</button></span>
         <datalist id="tag-suggestions-bulk">${[...new Set([TEST_TAG, ...d.allTags])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
         ${tagsInSelection.length ? `<select data-bulk="remove-tag" class="${mini}"><option value="">Remove tag…</option>${tagsInSelection.map((t) => `<option value="${esc(t)}">#${esc(t)}</option>`).join('')}</select>` : ''}`;
  const specific = {
    requests: `<select data-bulk="status" class="${mini}"><option value="">Set status…</option>${REQUEST_STATUSES.map((x) => `<option value="${x.value}">${esc(x.label)}</option>`).join('')}</select>${assign}`,
    investors: assign,
    speakers: `<select data-bulk="availability" class="${mini}"><option value="">Availability…</option>${SPEAKER_STATES.map((x) => `<option value="${x.value}">${esc(x.label)}</option>`).join('')}</select>
      <span class="inline-flex items-center gap-1"><input data-bulk-capacity type="number" min="0" max="99" placeholder="Capacity" class="w-24 ${mini} pr-2.5">
      <button data-bulk="capacity" class="${btn} bg-slate-100 text-slate-700 hover:bg-slate-200">Set</button></span>`,
  }[view];

  root.innerHTML = `<div class="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
    <div class="flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-xl" role="toolbar" aria-label="Bulk actions">
      <span class="px-1 text-sm font-semibold text-slate-900">${noun(view, sel.size)} selected</span>
      <span class="h-5 w-px bg-slate-200"></span>
      ${specific}
      ${tagControls}
      ${anyActive ? `<button data-bulk="archive" class="${btn} text-rose-600 hover:bg-rose-50">Archive</button>` : ''}
      ${anyArchived ? `<button data-bulk="restore" class="${btn} text-slate-700 hover:bg-slate-100">Restore</button>` : ''}
      <button data-bulk="export" class="${btn} text-slate-700 hover:bg-slate-100">${icon('download', 'size-4')} Export</button>
      <button data-bulk="clear" class="${btn} text-slate-500 hover:bg-slate-100">Clear</button>
    </div>
  </div>`;
}

// apply one change to all ticked rows, with Undo
async function bulkChange(view, patch, message) {
  const ids = [...state.selected[view]];
  const fields = Object.keys(patch);
  const before = rowsOf(view)
    .filter((r) => ids.includes(r.id))
    .map((r) => Object.fromEntries([['id', r.id], ...fields.map((f) => [f, r[f] ?? null])]));
  await state.store.bulkUpdate(view, ids, patch);
  await reload();
  toast(message, 'success', {
    label: 'Undo',
    onClick: async () => {
      try {
        await state.store.restoreRows(view, before);
        await reload();
        toast('Undone.');
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}

async function bulkTags(view, add, remove, message) {
  const ids = [...state.selected[view]];
  const before = rowsOf(view)
    .filter((r) => ids.includes(r.id))
    .map((r) => ({ id: r.id, tags: r.tags || [] }));
  await state.store.setTags(view, ids, add, remove);
  await reload();
  toast(message, 'success', {
    label: 'Undo',
    onClick: async () => {
      await state.store.restoreRows(view, before);
      await reload();
      toast('Undone.');
    },
  });
}

async function runBulk(action, el) {
  const view = state.view;
  const n = state.selected[view].size;
  if (!n) return;
  const what = noun(view, n);
  try {
    if (action === 'clear') {
      state.selected[view].clear();
      return BODIES[view]();
    }
    if (action === 'export') return exportView(view, true);
    if (action === 'status' && el.value) {
      return await bulkChange(view, { status: el.value }, `${what} set to “${REQUEST_STATUS[el.value].label}”.`);
    }
    if (action === 'assignee' && el.value) {
      const who = el.value === '__none' ? null : el.value;
      return await bulkChange(view, { assignee: who }, `${what} assigned to ${who || 'nobody'}.`);
    }
    if (action === 'availability' && el.value) {
      return await bulkChange(view, { availability: el.value }, `${what} set to “${SPEAKER_STATE[el.value].label}”.`);
    }
    if (action === 'capacity') {
      const capacity = Number(document.querySelector('[data-bulk-capacity]').value);
      if (!Number.isInteger(capacity) || capacity < 0) throw new Error('Capacity must be a whole number, 0 or more.');
      return await bulkChange(view, { capacity }, `Capacity of ${what} set to ${capacity}.`);
    }
    if (action === 'add-tag') {
      const tag = document.querySelector('[data-bulk-tag-input]').value.trim().toLowerCase().replace(/^#/, '');
      if (!tag) throw new Error('Type a tag first.');
      return await bulkTags(view, [tag], [], `#${tag} added to ${what}.`);
    }
    if (action === 'remove-tag' && el.value) {
      return await bulkTags(view, [], [el.value], `#${el.value} removed from ${what}.`);
    }
    if (action === 'archive') {
      const extra = view === 'investors' ? ' Their requests are archived with them and stop taking places.' : view === 'requests' ? ' Archived requests stop taking places.' : ' They can’t be booked on the website anymore.';
      if (!confirm(`Archive ${what}?${extra} You can restore them from the Archived filter.`)) return;
      return await bulkChange(view, { archived_at: new Date().toISOString() }, `${what} archived.`);
    }
    if (action === 'restore') {
      return await bulkChange(view, { archived_at: null }, `${what} restored.`);
    }
  } catch (err) {
    toast(errorText(err), 'error');
    reload();
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running formulas
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name, header, rows) {
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `eic-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportView(view, selectedOnly = false) {
  const d = derived();
  // bulk bar → export only the ticked rows
  const only = (rows, idOf) => (selectedOnly ? rows.filter((x) => state.selected[view].has(idOf(x))) : rows);
  if (view === 'requests') {
    download(
      'meeting-requests',
      ['Request #', 'Status', 'Source', 'First name', 'Last name', 'Email', 'Company', 'LinkedIn', 'Speaker', 'Speaker company', 'Preference', 'Submitted', 'Hold until', 'Starts', 'Ends', 'Closure reason', 'Assignee', 'Tags', 'Flags', 'Notes'],
      only(requestRows(), ({ r }) => r.id).map(({ r, sub, sp }) => [
        r.request_number,
        REQUEST_STATUS[r.status]?.label,
        SOURCES[r.source]?.label,
        sub?.first_name,
        sub?.last_name,
        sub?.email,
        sub?.company,
        sub?.linkedin,
        sp?.name,
        sp?.company,
        r.preference_rank,
        fmtDate(r.created_at),
        r.hold_until ? fmtDate(r.hold_until) : '',
        r.scheduled_start ? fmtDate(r.scheduled_start) : '',
        r.scheduled_end ? fmtDate(r.scheduled_end) : '',
        CLOSURE_REASONS.find((c) => c.value === r.closure_reason)?.label,
        r.assignee,
        (r.tags || []).join(' '),
        d.flagsOf(r).map((f) => f.label).join('; '),
        r.internal_notes,
      ]),
    );
  } else if (view === 'investors') {
    download(
      'investors',
      ['First name', 'Last name', 'Email', 'Company', 'LinkedIn', 'Stage', 'Source', 'Website submissions', 'Speakers (status)', 'Created', 'Assignee', 'Tags', 'Notes', 'Archived', 'Booking ID'],
      only(investorRows(), ({ s }) => s.id).map(({ s, reqs, stage }) => [
        s.first_name,
        s.last_name,
        s.email,
        s.company,
        s.linkedin,
        STAGE[stage]?.label,
        SOURCES[s.source]?.label,
        d.websiteSends(s.id),
        reqs.map((r) => `${d.speakerById.get(r.speaker_id)?.name} (${REQUEST_STATUS[r.status]?.label})`).join('; '),
        fmtDate(s.created_at),
        s.assignee,
        (s.tags || []).join(' '),
        s.notes,
        s.archived_at ? fmtDate(s.archived_at) : '',
        s.booking_id,
      ]),
    );
  } else {
    download(
      'speakers',
      ['Name', 'Company', 'Slug', 'Capacity', 'Availability', 'Taken', 'Confirmed', 'Waitlisted', 'Places left', 'Website status'],
      only(speakerRows(), ({ s }) => s.id).map(({ s, a }) => [
        s.name,
        s.company,
        s.slug,
        s.capacity,
        SPEAKER_STATE[s.availability]?.label,
        a?.used || 0,
        a?.confirmed || 0,
        a?.waitlisted || 0,
        a?.available || 0,
        (CAPACITY_STATUSES[a?.status] || CAPACITY_STATUSES.available).label,
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering + events
// ---------------------------------------------------------------------------
const VIEWS = { overview: renderOverview, requests: renderRequests, investors: renderInvestors, speakers: renderSpeakers };
const BODIES = { requests: renderRequestsBody, investors: renderInvestorsBody, speakers: renderSpeakersBody };

function renderView() {
  const main = document.getElementById('main');
  if (!main) return;
  if (!state.loaded) {
    main.innerHTML = `<div class="flex h-full items-center justify-center text-sm text-slate-400">Loading data…</div>`;
    return;
  }
  VIEWS[state.view]();
  renderNav();
  renderBulkBar();
}

// after data changes: keep the toolbar (and search focus), redraw counts + table
function refreshView() {
  if (!document.getElementById('main')) return;
  renderNav();
  if (state.view === 'overview' || !document.getElementById('view-body')) return renderView();
  const chipsEl = document.getElementById('chips');
  if (chipsEl) {
    const chipLists = {
      requests: () => chips('requests', requestChipItems()),
      investors: () => chips('investors', investorChipItems()),
      speakers: () => chips('speakers', speakerChipItems()),
    };
    chipsEl.innerHTML = chipLists[state.view]();
  }
  BODIES[state.view]();
}

let reloadTimer = null;
async function reload() {
  try {
    state.data = await state.store.load();
    state.loaded = true;
    refreshView();
  } catch (err) {
    console.error(err);
    toast('Couldn’t load data: ' + errorText(err), 'error');
  }
}
const scheduleReload = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, 400);
};

function bindEvents() {
  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1);
    state.view = VIEWS[view] ? view : 'overview';
    toggleMobileMenu(false);
    renderView();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleMobileMenu(false);
    // tag editor: Enter or comma adds the typed tag (and doesn't submit the side panel)
    if ((e.key === 'Enter' || e.key === ',') && e.target.matches?.('[data-tag-input]')) {
      e.preventDefault();
      commitTagInput(e.target);
    }
    if (e.key === 'Backspace' && e.target.matches?.('[data-tag-input]') && !e.target.value) {
      const editor = e.target.closest('[data-tags-editor]');
      setEditorTags(editor, editorTags(editor).slice(0, -1));
    }
    if (e.key === 'Enter' && e.target.matches?.('[data-bulk-tag-input]')) {
      e.preventDefault();
      runBulk('add-tag', e.target);
    }
    // Enter in the "add a speaker" note adds the speaker instead of saving the whole investor form
    if (e.key === 'Enter' && e.target.matches?.('[data-add-note]')) {
      e.preventDefault();
      e.target.closest('[data-add-requests]')?.querySelector('[data-action="add-requests"]')?.click();
    }
  });

  document.addEventListener('click', async (e) => {
    const t = e.target;
    const layoutBtn = t.closest('[data-layout-set]');
    if (layoutBtn) return setLayout(layoutBtn.dataset.layoutSet);
    if (t.closest('[data-action="mobile-menu-open"]')) return toggleMobileMenu(true);
    if (t.closest('[data-action="mobile-menu-close"]')) return toggleMobileMenu(false);
    if (t.closest('#mobile-menu a')) toggleMobileMenu(false); // also when tapping the page you're already on

    const signOut = t.closest('[data-action="sign-out"]');
    if (signOut) return DEMO ? toast('Demo mode: nothing to sign out of.') : client.auth.signOut();

    const chip = t.closest('[data-chip]');
    if (chip) {
      const [view, id] = chip.dataset.chip.split(':');
      state.filters[view].chip = id;
      return refreshView();
    }

    const sort = t.closest('[data-sort]');
    if (sort) {
      const [view, key] = sort.dataset.sort.split(':');
      const s = state.filters[view].sort;
      state.filters[view].sort = { key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' };
      return BODIES[view]();
    }

    const gotoStatus = t.closest('[data-goto-status]');
    if (gotoStatus) {
      state.filters.requests.chip = gotoStatus.dataset.gotoStatus;
      if (CLOSED.has(gotoStatus.dataset.gotoStatus)) state.filters.requests.chip = 'closed';
      location.hash = 'requests';
      return;
    }

    const exp = t.closest('[data-export]');
    if (exp) return exportView(exp.dataset.export);

    if (t.closest('[data-action="new-speaker"]')) return openSpeaker(null);

    const syncSource = t.closest('[data-sync-source]');
    if (syncSource) return openSync(syncSource.dataset.syncSource);

    if (t.closest('[data-action="new-request"]')) return openNewRequest();
    if (t.closest('[data-action="new-investor"]')) return openNewInvestor();
    if (t.closest('[data-action="download-backup"]')) return downloadBackup();

    const addBtn = t.closest('[data-action="add-requests"]');
    if (addBtn) {
      const box = addBtn.closest('[data-add-requests]');
      const submissionId = box.dataset.addRequests;
      addBtn.disabled = true;
      try {
        const added = await state.store.addRequests(
          submissionId,
          [box.querySelector('[data-add-speaker]').value],
          box.querySelector('[data-add-status]').value,
          nullIfEmpty(box.querySelector('[data-add-note]').value),
        );
        toast(added ? 'Speaker added.' : 'Nothing added — they already have this speaker.');
        await reload();
        openInvestor(submissionId);
      } catch (err) {
        toast(errorText(err), 'error');
        addBtn.disabled = false;
      }
      return;
    }

    // bulk bar buttons
    const bulkBtn = t.closest('button[data-bulk]');
    if (bulkBtn) return runBulk(bulkBtn.dataset.bulk, bulkBtn);

    // tag editor: remove a chip
    const tagRemove = t.closest('[data-tag-remove]');
    if (tagRemove) {
      const editor = tagRemove.closest('[data-tags-editor]');
      setEditorTags(editor, editorTags(editor).filter((x) => x !== tagRemove.dataset.tagRemove));
      return;
    }

    // archive / restore a single request
    const requestArchive = t.closest('[data-action="archive-request"], [data-action="restore-request"]');
    if (requestArchive) {
      const archive = requestArchive.dataset.action === 'archive-request';
      const r = state.data.requests.find((x) => x.id === requestArchive.dataset.id);
      if (!r) return;
      if (archive && !confirm(`Archive request #${r.request_number}? It stops taking a place. You can restore it from the Archived filter.`)) return;
      try {
        await state.store.updateRequest(r.id, { archived_at: archive ? new Date().toISOString() : null });
        closeDrawer();
        await reload();
        const sub = state.data.submissions.find((x) => x.id === r.submission_id);
        toast(!archive && sub?.archived_at ? `Request #${r.request_number} restored, but its investor is still archived.` : `Request #${r.request_number} ${archive ? 'archived' : 'restored'}.`);
      } catch (err) {
        toast(errorText(err), 'error');
      }
      return;
    }

    const archiveAction = t.closest('[data-action$="-investor"], [data-action$="-speaker"]');
    if (archiveAction && /^(archive|restore)-(investor|speaker)$/.test(archiveAction.dataset.action)) {
      const [verb, kind] = archiveAction.dataset.action.split('-');
      const id = archiveAction.dataset.id;
      const row = kind === 'investor' ? state.data.submissions.find((x) => x.id === id) : state.data.speakers.find((x) => x.id === id);
      if (!row) return;
      const name = kind === 'investor' ? fullName(row) : row.name;
      if (verb === 'archive') {
        const msg =
          kind === 'investor'
            ? `Archive ${name}? Their requests stop taking places. You can restore them later from the Archived filter.`
            : `Archive ${name}? They can’t be booked on the website anymore; requests and history stay. You can restore them later.`;
        if (!confirm(msg)) return;
      }
      try {
        await (kind === 'investor' ? state.store.archiveSubmission(id, verb === 'archive') : state.store.archiveSpeaker(id, verb === 'archive'));
        closeDrawer();
        await reload();
        if (verb === 'restore' && kind === 'investor') {
          const over = (derived().requestsBySubmission.get(id) || [])
            .map((r) => derived().availabilityById.get(r.speaker_id))
            .filter((a) => a?.status === 'over_capacity');
          if (over.length) toast(`${name} restored — ${over.length} speaker${over.length === 1 ? ' is' : 's are'} now over capacity. Check their requests.`, 'error');
          else toast(`${name} restored.`);
        } else {
          toast(`${name} ${verb === 'archive' ? 'archived' : 'restored'}.`);
        }
      } catch (err) {
        toast(errorText(err), 'error');
      }
      return;
    }

    // row / link → side panel (but not when clicking a control inside the row)
    const open = t.closest('[data-open]');
    if (open && !t.closest('[data-stop], select, input, a')) {
      const openers = { request: openRequest, investor: openInvestor, speaker: openSpeaker };
      return openers[open.dataset.open](open.dataset.id);
    }
  });

  // inline edits in tables and panels
  document.addEventListener('change', async (e) => {
    const el = e.target;

    // row selection
    if (el.matches('[data-select]')) {
      const set = state.selected[el.dataset.select];
      if (el.checked) set.add(el.value);
      else set.delete(el.value);
      return BODIES[el.dataset.select]();
    }
    if (el.matches('[data-select-all]')) {
      const view = el.dataset.selectAll;
      const ids = [...document.querySelectorAll(`[data-select="${view}"]`)].map((c) => c.value);
      if (el.checked) ids.forEach((id) => state.selected[view].add(id));
      else ids.forEach((id) => state.selected[view].delete(id));
      return BODIES[view]();
    }
    // bulk bar dropdowns
    if (el.matches('select[data-bulk]')) {
      if (!el.value) return;
      await runBulk(el.dataset.bulk, el);
      if (document.body.contains(el)) el.value = '';
      return;
    }
    if (el.matches('[data-filter-tag]')) {
      state.filters[el.dataset.filterTag].tag = el.value;
      return BODIES[el.dataset.filterTag]();
    }
    const id = el.dataset.id;
    const action = el.dataset.action;
    if (!action || !id) {
      if (el.matches('[data-filter-speaker]')) {
        state.filters.requests.speaker = el.value;
        renderRequestsBody();
      }
      if (el.matches('[data-filter-source]')) {
        state.filters[el.dataset.filterSource].source = el.value;
        BODIES[el.dataset.filterSource]();
      }
      if (el.matches('[data-add-speaker]')) updateAddWarning();
      return;
    }
    const writes = {
      'request-status': () => state.store.updateRequest(id, { status: el.value }),
      'submission-status': () => state.store.updateSubmission(id, { status: el.value }),
      'speaker-status': () => state.store.updateSpeaker(id, { availability: el.value }),
      'speaker-capacity': () => {
        const capacity = Number(el.value);
        if (!Number.isInteger(capacity) || capacity < 0) throw new Error('Capacity must be a whole number, 0 or more.');
        return state.store.updateSpeaker(id, { capacity });
      },
    };
    if (!writes[action]) return;

    // recolour a status pill right away
    if (el.tagName === 'SELECT' && action.endsWith('-status')) {
      const list = { 'request-status': REQUEST_STATUSES, 'submission-status': SUBMISSION_STATUSES, 'speaker-status': SPEAKER_STATES }[action];
      Object.values(TONES).forEach((cls) => el.classList.remove(...cls.split(' ')));
      el.classList.add(...TONES[list.find((s) => s.value === el.value)?.tone || 'gray'].split(' '));
    }
    el.disabled = true;
    try {
      await writes[action]();
      toast('Saved.');
      await reload();
    } catch (err) {
      toast(errorText(err), 'error');
      await reload();
    } finally {
      el.disabled = false;
    }
  });

  document.addEventListener('input', (e) => {
    const view = e.target.dataset?.search;
    if (!view) return;
    state.filters[view].q = e.target.value;
    BODIES[view]();
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let unsubscribe = null;
let entered = false;

async function enter(session) {
  if (DEMO) {
    state.user = { email: 'demo@localhost' };
  } else {
    state.user = session.user;
    const { data: isAdmin, error } = await client.rpc('is_admin');
    if (error || !isAdmin) return showNoAccess(session.user.email);
  }
  if (entered) return;
  entered = true;

  state.store = DEMO ? createDemoStore() : createSupabaseStore(client);
  const view = location.hash.slice(1);
  state.view = VIEWS[view] ? view : 'overview';
  renderShell();
  renderView();
  unsubscribe = state.store.subscribe(scheduleReload, (live) => {
    state.live = live;
    renderLive();
  });
  await reload();
}

function leave() {
  entered = false;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  state.loaded = false;
  state.data = { speakers: [], availability: [], submissions: [], requests: [], events: [], admins: [] };
  closeDrawer();
}

async function start() {
  bindEvents();
  if (DEMO) return enter(null);

  if (linkError) {
    history.replaceState(null, '', location.pathname);
    return showLogin(`That link didn’t work (${linkError}). Ask for a new invitation or use “Forgot password?”.`);
  }

  client.auth.onAuthStateChange((event, session) => {
    // run outside the callback (supabase-js recommendation)
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') return showSetPassword('recovery');
      if (event === 'SIGNED_OUT') {
        leave();
        return showLogin();
      }
      if (event === 'SIGNED_IN' && session && !['invite', 'recovery'].includes(linkType)) enter(session);
    }, 0);
  });

  const { data } = await client.auth.getSession();
  if (data.session && ['invite', 'recovery'].includes(linkType)) return showSetPassword(linkType);
  if (data.session) return enter(data.session);
  showLogin();
}

start();
