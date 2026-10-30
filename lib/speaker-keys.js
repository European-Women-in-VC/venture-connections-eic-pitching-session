// Speaker keys for the static Webflow cards. The cards' data-speaker values are typed by hand, so:
//   A) clean up: lowercase, accents removed, anything else → dashes; empty → built from company / name
//   B) duplicates: a card that reuses another card's key for a different person gets its own key
// The same rules run in the browser (public/speakers.js, between the <speaker-keys> markers) and on the
// server (website comparison, auto-registration). test/speaker-keys.test.js checks both copies match.

// <speaker-keys>
function slugify(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accents (é → e, İ → i)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// cards: [{ slug, name, company }] in page order → keys: [{ key, original, changed, reason }]
function assignSpeakerKeys(cards) {
  const owner = new Map(); // key → fingerprint of the person using it
  return cards.map(function (card) {
    const fingerprint = slugify(card.name) + '|' + slugify(card.company);
    const fromText = slugify(card.company) || slugify(card.name);
    let key = slugify(card.slug) || fromText || 'speaker';
    let reason = '';
    if (!slugify(card.slug)) reason = 'empty data-speaker';
    else if (key !== card.slug) reason = 'cleaned up';

    if (owner.has(key) && owner.get(key) !== fingerprint) {
      // same key as a different person (e.g. a copied card that wasn't edited)
      reason = 'duplicate of another card';
      let alt = fromText && fromText !== key ? fromText : key + '-' + (slugify(card.name) || 'speaker');
      let n = 2;
      const base = alt;
      while (owner.has(alt) && owner.get(alt) !== fingerprint) alt = base + '-' + n++;
      key = alt;
    }
    owner.set(key, fingerprint);
    return { key: key, original: card.slug == null ? '' : String(card.slug), changed: key !== card.slug, reason: reason };
  });
}
// </speaker-keys>

export { slugify, assignSpeakerKeys };
