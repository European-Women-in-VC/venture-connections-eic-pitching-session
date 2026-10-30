// C) New cards on the website are added to the database automatically — but only after checking that the
// card really is on the published page (so nobody can create speakers through the public API).
// Name and company always come from the page, never from the visitor's request.

import { readWebsiteSpeakers } from '../api/website-speakers.js';
import { supabase } from './supabase.js';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX = 30;

const settings = () => ({
  capacity: Number(process.env.AUTO_SPEAKER_CAPACITY ?? 4),
  availability: process.env.AUTO_SPEAKER_AVAILABILITY || 'open', // or 'paused': badge shows, booking blocked
});

// webflow.io staging site → staging page, everything else → live page
export function pageSourceFor(origin) {
  try {
    return /\.webflow\.io$/i.test(new URL(origin).hostname) ? 'staging' : 'live';
  } catch {
    return 'live';
  }
}

// Returns { added: [slugs], notOnPage: [slugs] }. Slugs already in the database (also archived) are left alone.
export async function registerFromWebsite(slugs, origin) {
  const wanted = [...new Set((slugs || []).map((s) => String(s || '').trim()).filter((s) => SLUG.test(s)))].slice(0, MAX);
  if (!wanted.length) return { added: [], notOnPage: [] };

  const existing = await supabase(`speakers?select=slug&slug=in.(${wanted.join(',')})`);
  const known = new Set(existing.map((r) => r.slug));
  const missing = wanted.filter((s) => !known.has(s));
  if (!missing.length) return { added: [], notOnPage: [] };

  // a recent copy of the page is enough; if a card isn't in it, re-read (it may have just been published)
  const source = pageSourceFor(origin);
  let site = await readWebsiteSpeakers(source, 60_000);
  if (missing.some((s) => !site.speakers.some((c) => c.slug === s))) site = await readWebsiteSpeakers(source, 10_000);
  const cards = new Map(site.speakers.map((c) => [c.slug, c]));

  const { capacity, availability } = settings();
  const today = new Date().toISOString().slice(0, 10);
  const rows = missing
    .filter((s) => cards.has(s))
    .map((s) => ({
      slug: s,
      name: cards.get(s).name || cards.get(s).company || s,
      company: cards.get(s).company || '—',
      capacity,
      availability,
      notes: `Added automatically from the ${source} website card on ${today}.`,
    }));

  const added = rows.length
    ? await supabase('speakers?on_conflict=slug&select=slug', {
        method: 'POST',
        body: rows,
        prefer: 'resolution=ignore-duplicates,return=representation',
      })
    : [];
  return { added: added.map((r) => r.slug), notOnPage: missing.filter((s) => !cards.has(s)) };
}
