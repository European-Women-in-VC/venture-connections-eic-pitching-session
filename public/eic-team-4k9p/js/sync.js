// Compare speakers in the database with the speaker cards on the website (the source of truth
// for slug, name and company). Pure functions: used by the panel and by the tests.

export const norm = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const key = (v) => norm(v).toLowerCase();

// Returns { suggestions, inSync } where each suggestion is one of:
//   { type: 'add',     site }                         card on the website, not in the database
//   { type: 'update',  speaker, site, fields }         same slug, name/company differ
//   { type: 'slug',    speaker, site, fields }         same person (name), slug changed on the website
//   { type: 'missing', speaker, requests }             in the database, no card on the website
// `fields` holds only what changes: { slug?, name?, company? }.
export function diffSpeakers(dbSpeakers, siteSpeakers, requestCounts = new Map()) {
  const bySlug = new Map(dbSpeakers.map((s) => [s.slug, s]));
  const siteSlugs = new Set(siteSpeakers.map((s) => s.slug));
  const suggestions = [];
  let inSync = 0;

  const changedFields = (speaker, site) => {
    const fields = {};
    if (norm(speaker.name) !== norm(site.name) && norm(site.name)) fields.name = norm(site.name);
    if (norm(speaker.company) !== norm(site.company) && norm(site.company)) fields.company = norm(site.company);
    return fields;
  };

  // same slug on both sides
  for (const site of siteSpeakers) {
    const speaker = bySlug.get(site.slug);
    if (!speaker) continue;
    const fields = changedFields(speaker, site);
    if (Object.keys(fields).length) suggestions.push({ type: 'update', speaker, site, fields });
    else inSync++;
  }

  // website-only cards: a renamed slug (same person) or a new speaker
  let dbOnly = dbSpeakers.filter((s) => !siteSlugs.has(s.slug));
  for (const site of siteSpeakers.filter((s) => !bySlug.has(s.slug))) {
    const renamed = dbOnly.find((s) => key(s.name) && key(s.name) === key(site.name));
    if (renamed) {
      dbOnly = dbOnly.filter((s) => s !== renamed);
      suggestions.push({ type: 'slug', speaker: renamed, site, fields: { slug: site.slug, ...changedFields(renamed, site) } });
    } else {
      suggestions.push({ type: 'add', site });
    }
  }

  // database-only speakers that can still be booked
  for (const speaker of dbOnly) {
    if (speaker.availability === 'closed' || speaker.availability === 'unavailable') continue;
    suggestions.push({ type: 'missing', speaker, requests: requestCounts.get(speaker.id) || 0 });
  }

  return { suggestions, inSync };
}

// What applying a suggestion does in the database
export function changeFor(suggestion, defaultCapacity = 4) {
  switch (suggestion.type) {
    case 'add':
      return {
        create: {
          slug: suggestion.site.slug,
          name: norm(suggestion.site.name) || suggestion.site.slug,
          company: norm(suggestion.site.company) || '—',
          capacity: defaultCapacity,
          availability: 'open',
        },
      };
    case 'update':
    case 'slug':
      return { id: suggestion.speaker.id, update: suggestion.fields };
    case 'missing':
      return { id: suggestion.speaker.id, update: { availability: 'closed' } };
    default:
      throw new Error('Unknown suggestion type ' + suggestion.type);
  }
}
