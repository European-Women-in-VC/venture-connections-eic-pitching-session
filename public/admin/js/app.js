// EIC Bookings admin panel — /admin
// Login: Supabase Auth (email + password, invite only). Data: Supabase with the user's session;
// only emails on public.admins can read or edit (row-level security).
// Local demo with fake data: http://localhost:4321/public/admin/?demo

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { createSupabaseStore } from './store.js';
import { createDemoStore } from './demo.js';
import {
  CAPACITY_STATUSES,
  CLOSED,
  CLOSURE_REASONS,
  CONFIRMED,
  DOTS,
  REQUEST_STATUS,
  REQUEST_STATUSES,
  SPEAKER_STATE,
  SPEAKER_STATES,
  SUBMISSION_STATUS,
  SUBMISSION_STATUSES,
  TAKES_PLACE,
  TONES,
} from './labels.js';

const SUPABASE_URL = 'https://pxlfskkmakgmfgcwrqay.supabase.co';
// Publishable key: safe in the browser, it can't read anything without a logged-in admin.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_DToIGOE5HyUELkgj4XLfIg_6nuRftcx';
const DEMO = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('demo');

const app = document.getElementById('app');
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
  data: { speakers: [], availability: [], submissions: [], requests: [], admins: [] },
  view: 'overview',
  filters: {
    requests: { q: '', chip: 'active', speaker: '', sort: { key: 'created', dir: 'desc' } },
    investors: { q: '', chip: 'all', sort: { key: 'created', dir: 'desc' } },
    speakers: { q: '', chip: 'all', sort: { key: 'name', dir: 'asc' } },
  },
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
};
const icon = (name, cls = 'size-5') =>
  `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>`;

function toast(message, tone = 'success') {
  const el = document.createElement('div');
  const tones = {
    success: 'border-emerald-200 bg-white text-slate-800 [&_i]:bg-emerald-500',
    error: 'border-rose-200 bg-rose-50 text-rose-800 [&_i]:bg-rose-500',
  };
  el.className = `pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm shadow-lg transition duration-300 ${tones[tone]}`;
  el.innerHTML = `<i class="mt-1.5 size-2 shrink-0 rounded-full"></i><span></span>`;
  el.querySelector('span').textContent = message;
  toasts.append(el);
  setTimeout(() => {
    el.classList.add('opacity-0', 'translate-y-1');
    setTimeout(() => el.remove(), 300);
  }, tone === 'error' ? 6000 : 2800);
}

const errorText = (err) => {
  const msg = String(err?.message || err || 'Something went wrong');
  if (/speakers_slug_key|duplicate key.*slug/i.test(msg)) return 'A speaker with this slug already exists.';
  if (/foreign key/i.test(msg)) return 'This speaker still has meeting requests, so it can’t be deleted.';
  if (/speakers_slug_check|check constraint.*slug/i.test(msg)) return 'Slug may only contain lowercase letters, numbers and single dashes.';
  if (/JWT|not authorized|permission|row-level security|PGRST116/i.test(msg)) return 'You don’t have permission for this change. Try signing in again.';
  return msg;
};

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
function derived() {
  const { speakers, availability, submissions, requests } = state.data;
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
  return { speakerById, submissionById, availabilityById, requestsBySubmission, requestsBySpeaker };
}

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
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/admin/' });
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

function renderShell() {
  app.innerHTML = `
    <div class="flex h-full">
      <aside class="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div class="flex h-16 items-center gap-2.5 border-b border-slate-200 px-5">
          <div class="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-[11px] font-bold text-white">EIC</div>
          <div class="leading-tight">
            <p class="text-sm font-semibold">EIC Bookings</p>
            <p class="text-xs text-slate-500">Pitching Session</p>
          </div>
        </div>
        <nav class="flex-1 space-y-0.5 p-3" id="nav"></nav>
        <div class="border-t border-slate-200 p-4">
          <div id="live" class="mb-3 flex items-center gap-2 text-xs text-slate-500"></div>
          <p class="truncate text-xs font-medium text-slate-700" title="${esc(state.user.email)}">${esc(state.user.email)}</p>
          <button data-action="sign-out" class="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-900">${icon('logout', 'size-4')} Sign out</button>
        </div>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <div class="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-[11px] font-bold text-white">EIC</div>
          <select id="mobile-nav" class="${SELECT} flex-1">${NAV.map((n) => `<option value="${n.id}">${esc(n.label)}</option>`).join('')}</select>
          <button data-action="sign-out" class="text-slate-500" title="Sign out">${icon('logout')}</button>
        </header>
        <main id="main" class="min-w-0 flex-1 overflow-y-auto scrollbar-thin"></main>
      </div>
    </div>`;
  document.getElementById('mobile-nav').addEventListener('change', (e) => (location.hash = e.target.value));
  renderNav();
  renderLive();
}

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const { requests, submissions } = state.data;
  const counts = {
    requests: requests.filter((r) => r.status === 'new_request' || r.status === 'needs_review').length,
    investors: submissions.filter((s) => s.status === 'todo').length,
  };
  nav.innerHTML = NAV.map((n) => {
    const active = state.view === n.id;
    const count = counts[n.id];
    return `<a href="#${n.id}" class="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}">
      <span class="${active ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-500'}">${icon(n.id)}</span>
      <span class="flex-1">${esc(n.label)}</span>
      ${count ? `<span class="rounded-full ${active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'} px-2 py-0.5 text-xs font-semibold" title="${n.id === 'requests' ? 'New or needs review' : 'To do'}">${count}</span>` : ''}
    </a>`;
  }).join('');
  const mobile = document.getElementById('mobile-nav');
  if (mobile) mobile.value = state.view;
}

function renderLive() {
  const el = document.getElementById('live');
  if (!el) return;
  el.innerHTML = state.live
    ? `<span class="relative flex size-2"><span class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60"></span><span class="relative inline-flex size-2 rounded-full bg-emerald-500"></span></span> Live updates on${DEMO ? ' (demo data)' : ''}`
    : `<span class="size-2 rounded-full bg-slate-300"></span> Connecting…`;
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
  const { speakers, submissions, requests } = state.data;
  const d = derived();
  const realSubs = submissions.filter((s) => s.status !== 'test');
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
    pageHeader('Overview', 'Investor bookings and speaker capacity at a glance.') +
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
const REQUEST_CHIPS = [
  { id: 'active', label: 'Active', test: (r) => TAKES_PLACE.has(r.status) },
  { id: 'all', label: 'All', test: () => true },
  ...REQUEST_STATUSES.filter((s) => !CLOSED.has(s.value)).map((s) => ({ id: s.value, label: s.label, tone: s.tone, test: (r) => r.status === s.value })),
  { id: 'closed', label: 'Declined / cancelled / expired', tone: 'gray', test: (r) => CLOSED.has(r.status) },
];

function requestRows() {
  const f = state.filters.requests;
  const d = derived();
  const chip = REQUEST_CHIPS.find((c) => c.id === f.chip) || REQUEST_CHIPS[0];
  const rows = state.data.requests
    .map((r) => ({ r, sub: d.submissionById.get(r.submission_id), sp: d.speakerById.get(r.speaker_id) }))
    .filter(({ r }) => chip.test(r))
    .filter(({ r }) => !f.speaker || r.speaker_id === f.speaker)
    .filter(({ r, sub, sp }) => matches(f.q, fullName(sub), sub?.email, sub?.company, sp?.name, sp?.company, r.internal_notes, r.request_number));
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
  const { requests, speakers } = state.data;
  const f = state.filters.requests;
  main.innerHTML =
    pageHeader(
      'Meeting requests',
      'One row per investor × speaker. Change the status right in the table.',
      `<button data-export="requests" class="${BTN_SECONDARY}">${icon('download', 'size-4')} Export CSV</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('requests', REQUEST_CHIPS.map((c) => ({ ...c, count: requests.filter(c.test).length })))}</div>
      <div class="flex flex-wrap items-center gap-3">
        ${searchBox('requests', 'Search investor, speaker, notes…')}
        <select data-filter-speaker class="${SELECT} w-full sm:w-64">
          <option value="">All speakers</option>
          ${speakers.map((s) => `<option value="${s.id}" ${f.speaker === s.id ? 'selected' : ''}>${esc(s.name)} · ${esc(s.company)}</option>`).join('')}
        </select>
        <span id="count" class="ml-auto text-sm text-slate-500"></span>
      </div>
      <div id="view-body"></div>
    </div>`;
  renderRequestsBody();
}

function renderRequestsBody() {
  const rows = requestRows();
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
    ${sortHeader('requests', 'number', '#', 'w-12')}
    ${sortHeader('requests', 'investor', 'Investor')}
    ${sortHeader('requests', 'speaker', 'Speaker')}
    ${sortHeader('requests', 'rank', 'Pref.', 'w-16')}
    ${sortHeader('requests', 'status', 'Status')}
    <th class="px-4 py-2.5 text-left font-medium">Notes</th>
    ${sortHeader('requests', 'created', 'Submitted')}
  </tr>`;
  const body = rows.length
    ? rows
        .map(
          ({ r, sub, sp }) => `<tr data-open="request" data-id="${r.id}" class="cursor-pointer bg-white hover:bg-slate-50">
          <td class="px-4 py-3 text-xs tabular-nums text-slate-400">${r.request_number}</td>
          <td class="whitespace-nowrap px-4 py-3"><div class="font-medium">${esc(fullName(sub))}</div><div class="text-xs text-slate-500">${esc(sub?.company || sub?.email || '')}</div></td>
          <td class="whitespace-nowrap px-4 py-3"><div>${esc(sp?.name || '—')}</div><div class="text-xs text-slate-500">${esc(sp?.company || '')}</div></td>
          <td class="px-4 py-3 text-slate-500 tabular-nums">${r.preference_rank ? '#' + r.preference_rank : '—'}</td>
          <td class="px-4 py-3" data-stop>${statusSelect('request', r.id, r.status)}</td>
          <td class="max-w-64 px-4 py-3"><p class="truncate text-slate-500">${esc(r.internal_notes || '')}</p></td>
          <td class="whitespace-nowrap px-4 py-3 text-slate-500" title="${esc(fmtDate(r.created_at))}">${esc(timeAgo(r.created_at))}</td>
        </tr>`,
        )
        .join('')
    : emptyRow(7, state.data.requests.length ? 'No requests match these filters.' : 'No meeting requests yet. They appear here as soon as an investor books.');
  document.getElementById('view-body').innerHTML = tableWrap(head, body);
}

// ---------------------------------------------------------------------------
// Investors
// ---------------------------------------------------------------------------
const INVESTOR_CHIPS = [
  { id: 'all', label: 'All', test: (s) => s.status !== 'test' },
  ...SUBMISSION_STATUSES.map((s) => ({ id: s.value, label: s.label, tone: s.tone, test: (x) => x.status === s.value })),
];

function investorRows() {
  const f = state.filters.investors;
  const d = derived();
  const chip = INVESTOR_CHIPS.find((c) => c.id === f.chip) || INVESTOR_CHIPS[0];
  const rows = state.data.submissions
    .map((s) => ({ s, reqs: d.requestsBySubmission.get(s.id) || [] }))
    .filter(({ s }) => chip.test(s))
    .filter(({ s, reqs }) =>
      matches(f.q, fullName(s), s.email, s.company, s.linkedin, s.notes, ...reqs.map((r) => d.speakerById.get(r.speaker_id)?.name)),
    );
  return sortRows(
    rows,
    {
      investor: ({ s }) => fullName(s).toLowerCase(),
      email: ({ s }) => s.email,
      speakers: ({ reqs }) => reqs.length,
      status: ({ s }) => SUBMISSION_STATUSES.findIndex((x) => x.value === s.status),
      created: ({ s }) => s.created_at,
    },
    f.sort,
  );
}

function renderInvestors() {
  const main = document.getElementById('main');
  const { submissions } = state.data;
  main.innerHTML =
    pageHeader(
      'Investors',
      'Everyone who submitted the booking form, with the speakers they picked.',
      `<button data-export="investors" class="${BTN_SECONDARY}">${icon('download', 'size-4')} Export CSV</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('investors', INVESTOR_CHIPS.map((c) => ({ ...c, count: submissions.filter(c.test).length })))}</div>
      <div class="flex flex-wrap items-center gap-3">
        ${searchBox('investors', 'Search name, email, company, speaker…')}
        <span id="count" class="ml-auto text-sm text-slate-500"></span>
      </div>
      <div id="view-body"></div>
    </div>`;
  renderInvestorsBody();
}

function renderInvestorsBody() {
  const rows = investorRows();
  const d = derived();
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
    ${sortHeader('investors', 'investor', 'Investor')}
    ${sortHeader('investors', 'email', 'Contact')}
    ${sortHeader('investors', 'speakers', 'Speakers requested')}
    ${sortHeader('investors', 'status', 'Status')}
    ${sortHeader('investors', 'created', 'Submitted')}
  </tr>`;
  const body = rows.length
    ? rows
        .map(({ s, reqs }) => {
          const linkedin = safeUrl(s.linkedin);
          return `<tr data-open="investor" data-id="${s.id}" class="cursor-pointer bg-white hover:bg-slate-50">
            <td class="px-4 py-3">
              <div class="flex items-center gap-3">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">${esc(initials(s))}</span>
                <div class="whitespace-nowrap"><div class="font-medium">${esc(fullName(s))}</div><div class="text-xs text-slate-500">${esc(s.company || '')}</div></div>
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
            <td class="px-4 py-3" data-stop>${statusSelect('submission', s.id, s.status)}</td>
            <td class="whitespace-nowrap px-4 py-3 text-slate-500" title="${esc(fmtDate(s.created_at))}">${esc(timeAgo(s.created_at))}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(5, state.data.submissions.length ? 'No investors match these filters.' : 'No submissions yet.');
  document.getElementById('view-body').innerHTML = tableWrap(head, body);
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------
const speakerStatus = (s, d) => d.availabilityById.get(s.id)?.status || 'available';
const SPEAKER_CHIPS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'available', label: 'Available', tone: 'green', test: (s, d) => speakerStatus(s, d) === 'available' },
  { id: 'full', label: 'Full', tone: 'red', test: (s, d) => ['full', 'over_capacity'].includes(speakerStatus(s, d)) },
  { id: 'off', label: 'Paused / closed', tone: 'gray', test: (s) => s.availability !== 'open' },
];

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
       <button data-action="new-speaker" class="${BTN_PRIMARY}">${icon('plus', 'size-4')} Add speaker</button>`,
    ) +
    `<div class="space-y-4 p-6">
      <div id="chips">${chips('speakers', SPEAKER_CHIPS.map((c) => ({ ...c, count: state.data.speakers.filter((s) => c.test(s, d)).length })))}</div>
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
  document.getElementById('count').textContent = `${rows.length} shown`;
  const head = `<tr>
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
          return `<tr data-open="speaker" data-id="${s.id}" class="cursor-pointer bg-white hover:bg-slate-50">
            <td class="whitespace-nowrap px-4 py-3"><div class="font-medium">${esc(s.name)}</div><div class="text-xs text-slate-500">${esc(s.company)} · <span class="font-mono">${esc(s.slug)}</span></div></td>
            <td class="px-4 py-3" data-stop>
              <input data-action="speaker-capacity" data-id="${s.id}" type="number" min="0" max="99" value="${s.capacity}" aria-label="Capacity"
                class="w-20 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums shadow-xs focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none">
            </td>
            <td class="px-4 py-3" data-stop>${statusSelect('speaker', s.id, s.availability)}</td>
            <td class="px-4 py-3"><div class="flex items-center gap-3"><div class="w-28">${capacityBar(s, a)}</div><span class="text-xs font-semibold tabular-nums text-slate-600">${a?.used || 0}/${s.capacity}</span></div></td>
            <td class="px-4 py-3 tabular-nums text-slate-600">${a?.confirmed || 0}</td>
            <td class="px-4 py-3 tabular-nums text-slate-600">${a?.waitlisted || 0}</td>
            <td class="px-4 py-3">${a?.status === 'available' ? `<span class="text-xs text-slate-500">${a.available} place${a.available === 1 ? '' : 's'} left</span>` : pill(st.label, st.tone)}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(7, state.data.speakers.length ? 'No speakers match these filters.' : 'No speakers yet.');
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
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
  form.querySelector('input:not([type=hidden]):not([disabled]), textarea, select')?.focus({ preventScroll: true });
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
      section('Internal notes', textarea('internal_notes', r.internal_notes, 5)),
    onSubmit: async (fd) => {
      await state.store.updateRequest(r.id, {
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

function openInvestor(id) {
  const d = derived();
  const s = state.data.submissions.find((x) => x.id === id);
  if (!s) return;
  const reqs = d.requestsBySubmission.get(s.id) || [];
  const meta = s.meta || {};
  openDrawer({
    title: esc(fullName(s)),
    subtitle: esc([s.company, `submitted ${fmtDate(s.created_at)}`].filter(Boolean).join(' · ')),
    body:
      section(
        'Requested speakers',
        reqs.length
          ? `<ul class="divide-y divide-slate-100 rounded-lg border border-slate-200">${reqs
              .map((r) => {
                const sp = d.speakerById.get(r.speaker_id);
                return `<li class="flex items-center gap-3 px-3 py-2.5">
                  <span class="w-6 text-xs tabular-nums text-slate-400">#${r.preference_rank || '–'}</span>
                  <button type="button" data-open="request" data-id="${r.id}" class="min-w-0 flex-1 text-left">
                    <span class="block truncate text-sm font-medium hover:text-brand-600">${esc(sp?.name || '?')}</span>
                    <span class="block truncate text-xs text-slate-500">${esc(sp?.company || '')}</span>
                  </button>
                  ${statusSelect('request', r.id, r.status)}
                </li>`;
              })
              .join('')}</ul>`
          : `<p class="text-sm text-slate-500">No meeting requests.</p>`,
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
          ${field('Status', select('status', SUBMISSION_STATUSES, s.status))}
          ${field('Assignee', select('assignee', assigneeOptions(), s.assignee, 'Nobody'))}
          <div class="sm:col-span-2">${field('Notes', textarea('notes', s.notes))}</div>
        </div>`,
      ) +
      section(
        'Technical',
        `<dl class="rounded-lg bg-slate-50 px-4 py-2 text-xs">
          ${infoRow('Booking ID', `<span class="font-mono">${esc(s.booking_id || '—')}</span>`)}
          ${infoRow('Picked (order)', esc((s.speaker_slugs || []).join(', ') || '—'))}
          ${infoRow('Page', esc(meta.page || '—'))}
        </dl>`,
      ),
    footerLeft: `<button type="button" data-action="delete-investor" data-id="${s.id}" class="${BTN_DANGER}">Delete</button>`,
    onSubmit: async (fd) => {
      await state.store.updateSubmission(s.id, {
        first_name: nullIfEmpty(fd.get('first_name')),
        last_name: nullIfEmpty(fd.get('last_name')),
        email: String(fd.get('email')).trim().toLowerCase(),
        company: nullIfEmpty(fd.get('company')),
        linkedin: nullIfEmpty(fd.get('linkedin')),
        status: fd.get('status'),
        assignee: nullIfEmpty(fd.get('assignee')),
        notes: nullIfEmpty(fd.get('notes')),
      });
      toast(`${fullName(s)} saved.`);
      reload();
    },
  });
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
            s ? 'Fixed: it links the website card to this speaker.' : 'Lowercase, numbers and dashes, exactly as in Webflow (e.g. <span class="font-mono">geniel-srl</span>).',
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
    footerLeft: s && !reqs.length ? `<button type="button" data-action="delete-speaker" data-id="${s.id}" class="${BTN_DANGER}">Delete</button>` : '',
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

function exportView(view) {
  const d = derived();
  if (view === 'requests') {
    download(
      'meeting-requests',
      ['Request #', 'Status', 'First name', 'Last name', 'Email', 'Company', 'LinkedIn', 'Speaker', 'Speaker company', 'Preference', 'Submitted', 'Hold until', 'Starts', 'Ends', 'Closure reason', 'Assignee', 'Notes'],
      requestRows().map(({ r, sub, sp }) => [
        r.request_number,
        REQUEST_STATUS[r.status]?.label,
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
        r.internal_notes,
      ]),
    );
  } else if (view === 'investors') {
    download(
      'investors',
      ['First name', 'Last name', 'Email', 'Company', 'LinkedIn', 'Status', 'Speakers (status)', 'Submitted', 'Assignee', 'Notes', 'Booking ID'],
      investorRows().map(({ s, reqs }) => [
        s.first_name,
        s.last_name,
        s.email,
        s.company,
        s.linkedin,
        SUBMISSION_STATUS[s.status]?.label,
        reqs.map((r) => `${d.speakerById.get(r.speaker_id)?.name} (${REQUEST_STATUS[r.status]?.label})`).join('; '),
        fmtDate(s.created_at),
        s.assignee,
        s.notes,
        s.booking_id,
      ]),
    );
  } else {
    download(
      'speakers',
      ['Name', 'Company', 'Slug', 'Capacity', 'Availability', 'Taken', 'Confirmed', 'Waitlisted', 'Places left', 'Website status'],
      speakerRows().map(({ s, a }) => [
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
}

// after data changes: keep the toolbar (and search focus), redraw counts + table
function refreshView() {
  if (!document.getElementById('main')) return;
  renderNav();
  if (state.view === 'overview' || !document.getElementById('view-body')) return renderView();
  const chipsEl = document.getElementById('chips');
  if (chipsEl) {
    const d = derived();
    const chipLists = {
      requests: () => chips('requests', REQUEST_CHIPS.map((c) => ({ ...c, count: state.data.requests.filter(c.test).length }))),
      investors: () => chips('investors', INVESTOR_CHIPS.map((c) => ({ ...c, count: state.data.submissions.filter(c.test).length }))),
      speakers: () => chips('speakers', SPEAKER_CHIPS.map((c) => ({ ...c, count: state.data.speakers.filter((s) => c.test(s, d)).length }))),
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
    renderView();
  });

  document.addEventListener('click', async (e) => {
    const t = e.target;
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

    const delInvestor = t.closest('[data-action="delete-investor"]');
    if (delInvestor) {
      const s = state.data.submissions.find((x) => x.id === delInvestor.dataset.id);
      const n = state.data.requests.filter((r) => r.submission_id === s?.id).length;
      if (!s || !confirm(`Delete ${fullName(s)} and their ${n} meeting request${n === 1 ? '' : 's'}? This frees their places and can’t be undone.`)) return;
      try {
        await state.store.deleteSubmission(s.id);
        closeDrawer();
        toast(`${fullName(s)} deleted.`);
        reload();
      } catch (err) {
        toast(errorText(err), 'error');
      }
      return;
    }

    const delSpeaker = t.closest('[data-action="delete-speaker"]');
    if (delSpeaker) {
      const s = state.data.speakers.find((x) => x.id === delSpeaker.dataset.id);
      if (!s || !confirm(`Delete speaker ${s.name}? The website card stays in Webflow but won’t have availability anymore.`)) return;
      try {
        await state.store.deleteSpeaker(s.id);
        closeDrawer();
        toast(`${s.name} deleted.`);
        reload();
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
    const id = el.dataset.id;
    const action = el.dataset.action;
    if (!action || !id) {
      if (el.matches('[data-filter-speaker]')) {
        state.filters.requests.speaker = el.value;
        renderRequestsBody();
      }
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
  state.data = { speakers: [], availability: [], submissions: [], requests: [], admins: [] };
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
