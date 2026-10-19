// Labels, colours and capacity rules shared by the panel and its demo data.
// Keep REQUEST_STATUSES[].takesPlace in sync with public.request_takes_place() in the database.

export const REQUEST_STATUSES = [
  { value: 'new_request', label: 'New request', tone: 'blue', takesPlace: true },
  { value: 'needs_review', label: 'Needs review', tone: 'amber', takesPlace: true },
  { value: 'hold_awaiting_speaker', label: 'Hold — awaiting speaker', tone: 'yellow', takesPlace: true },
  { value: 'accepted_scheduling', label: 'Accepted — scheduling', tone: 'teal', takesPlace: true },
  { value: 'scheduled_confirmed', label: 'Scheduled / confirmed', tone: 'green', takesPlace: true },
  { value: 'waitlisted', label: 'Waitlisted', tone: 'violet', takesPlace: false },
  { value: 'declined', label: 'Declined', tone: 'red', takesPlace: false },
  { value: 'cancelled', label: 'Cancelled', tone: 'gray', takesPlace: false },
  { value: 'expired', label: 'Expired', tone: 'gray', takesPlace: false },
];

export const SUBMISSION_STATUSES = [
  { value: 'todo', label: 'To do', tone: 'amber' },
  { value: 'in_progress', label: 'In progress', tone: 'blue' },
  { value: 'confirmed', label: 'Confirmed', tone: 'green' },
  { value: 'done', label: 'Done', tone: 'gray' },
  { value: 'test', label: 'Test', tone: 'violet' },
];

export const SPEAKER_STATES = [
  { value: 'open', label: 'Open', tone: 'green' },
  { value: 'paused', label: 'Paused', tone: 'amber' },
  { value: 'unavailable', label: 'Unavailable', tone: 'gray' },
  { value: 'closed', label: 'Closed', tone: 'gray' },
];

// speaker_availability.status
export const CAPACITY_STATUSES = {
  available: { label: 'Available', tone: 'green' },
  full: { label: 'Full', tone: 'red' },
  over_capacity: { label: 'Over capacity', tone: 'red' },
  paused: { label: 'Paused', tone: 'amber' },
  unavailable: { label: 'Unavailable', tone: 'gray' },
  closed: { label: 'Closed', tone: 'gray' },
};

export const CLOSURE_REASONS = [
  { value: 'speaker_declined', label: 'Speaker declined' },
  { value: 'speaker_unavailable', label: 'Speaker unavailable' },
  { value: 'investor_cancelled', label: 'Investor cancelled' },
  { value: 'organizer_cancelled', label: 'Organizer cancelled' },
  { value: 'no_response_expired', label: 'No response — expired' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'other', label: 'Other' },
];

// pill / select colours (full class strings so Tailwind keeps them)
export const TONES = {
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  yellow: 'bg-yellow-50 text-yellow-800 ring-yellow-600/25',
  teal: 'bg-teal-50 text-teal-700 ring-teal-600/20',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  gray: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

export const DOTS = {
  blue: 'bg-blue-500',
  amber: 'bg-amber-500',
  yellow: 'bg-yellow-400',
  teal: 'bg-teal-500',
  green: 'bg-emerald-500',
  violet: 'bg-violet-500',
  red: 'bg-rose-500',
  gray: 'bg-slate-400',
};

export const byValue = (list) => Object.fromEntries(list.map((item) => [item.value, item]));
export const REQUEST_STATUS = byValue(REQUEST_STATUSES);
export const SUBMISSION_STATUS = byValue(SUBMISSION_STATUSES);
export const SPEAKER_STATE = byValue(SPEAKER_STATES);
export const TAKES_PLACE = new Set(REQUEST_STATUSES.filter((s) => s.takesPlace).map((s) => s.value));
export const CONFIRMED = new Set(['accepted_scheduling', 'scheduled_confirmed']);
export const CLOSED = new Set(['declined', 'cancelled', 'expired']);

// Same rules as the public.speaker_availability view (used by the demo data)
export function computeAvailability(speaker, requests) {
  const mine = requests.filter((r) => r.speaker_id === speaker.id);
  const used = mine.filter((r) => TAKES_PLACE.has(r.status)).length;
  const confirmed = mine.filter((r) => CONFIRMED.has(r.status)).length;
  const waitlisted = mine.filter((r) => r.status === 'waitlisted').length;
  const remaining = Math.max(speaker.capacity - used, 0);
  const available = speaker.availability === 'open' ? remaining : 0;
  let status = 'available';
  if (used > speaker.capacity) status = 'over_capacity';
  else if (speaker.availability !== 'open') status = speaker.availability;
  else if (speaker.capacity - used <= 0) status = 'full';
  return { id: speaker.id, used, confirmed, waitlisted, remaining, available, status };
}
