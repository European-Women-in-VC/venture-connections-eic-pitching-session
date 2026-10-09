/*
 * EIC Pitching Session — speaker selection + live availability
 *
 * Load in Webflow (Page settings → Before </body>):
 *   <script src="https://venture-connections-eic-pitching-se.vercel.app/speakers.js" defer></script>
 *
 * The availability API is resolved relative to this file's URL,
 * override with data-api="https://…/api/availability" on the <script> tag.
 * Add ?speakers-debug to the page URL to log slug mismatches.
 */
(() => {
  const script = document.currentScript;
  const API_URL =
    (script && script.dataset.api) ||
    (script && script.src ? new URL('/api/availability', script.src).href : '/api/availability');
  const MAX = Number((script && script.dataset.max) || 4);
  const SEP = ';';
  const REFRESH_MS = 60000;
  const DEBUG = new URLSearchParams(location.search).has('speakers-debug');

  function init() {
    const list = document.querySelector('[data-speakers-list]');
    const hidden = document.querySelector('[data-speakers-hidden]');
    const bookingIdField = document.querySelector('[data-booking-id]');
    const selectedField = document.querySelector('[data-speakers-selected]');
    const unselectedField = document.querySelector('[data-speakers-unselected]');
    const recordIdsField = document.querySelector('[data-speakers-record-ids]');
    const counters = document.querySelectorAll('[data-speakers-counter]');
    const cardToggles = [...document.querySelectorAll('[data-speaker-toggle]')];
    if (!list || !cardToggles.length) return;

    // list may sit inside or outside the <form>
    const form = (hidden || bookingIdField || list).closest('form');

    const selected = []; // ordered slugs — single source of truth
    let availability = {}; // slug -> { booked, capacity }; missing = unknown (no limit)
    let reported = false;

    const known = (id) => Object.prototype.hasOwnProperty.call(availability, id);
    const isFull = (id) => known(id) && availability[id].booked >= availability[id].capacity;

    if (bookingIdField && !bookingIdField.value) {
      bookingIdField.value = crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    // ---------- Collect speakers from cards ----------
    const speakers = new Map();
    cardToggles.forEach((t) => {
      const id = (t.dataset.speaker || '').trim();
      if (!id) return;
      t.querySelector('input').dataset.speakerInput = id;

      const card = t.closest('.comps_card');
      if (card) {
        card.dataset.speakerCard = id;
        const badge = card.querySelector('[data-availability]');
        if (badge) badge.dataset.availability = id;
      }

      if (!speakers.has(id)) {
        speakers.set(id, {
          id,
          name: (t.dataset.speakerName || id).trim(),
          company: (t.dataset.speakerCompany || '').trim(),
        });
      }
    });

    const labelOf = (s) => s.name + (s.company ? ' (' + s.company + ')' : '');
    const shortOf = (id) => {
      const s = speakers.get(id);
      return s ? s.company || s.name : id;
    };

    // ---------- Form checkboxes ----------
    list.innerHTML = '';
    speakers.forEach((s) => {
      const label = document.createElement('label');
      label.className = 'speakers-form_item';
      label.innerHTML =
        '<input type="checkbox" class="speakers-form_input">' +
        '<span class="speakers-form_box" aria-hidden="true"></span>' +
        '<span class="speakers-form_text">' +
        '<span class="speakers-form_name"></span>' +
        '<span class="speakers-form_company"></span>' +
        '</span>' +
        '<span class="speakers-form_avail"></span>';

      const input = label.querySelector('input');
      input.value = s.id;
      input.name = 'speaker-' + s.id; // only submitted when the list is inside the <form>
      input.dataset.name = 'Speaker: ' + labelOf(s);
      input.dataset.speakerInput = s.id;

      label.querySelector('.speakers-form_name').textContent = s.name;
      label.querySelector('.speakers-form_company').textContent = s.company;
      label.querySelector('.speakers-form_avail').dataset.availability = s.id;

      label.addEventListener('click', () => warnIfFull(input));
      list.appendChild(label);
    });

    const allInputs = () => document.querySelectorAll('[data-speaker-input]');

    // ---------- Toast ----------
    const toast = document.createElement('div');
    toast.className = 'speakers-toast';
    toast.setAttribute('role', 'alert');
    document.body.appendChild(toast);
    let toastTimer;

    function warn(msg) {
      toast.textContent = msg;
      toast.classList.add('is-visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500);
      counters.forEach((c) => {
        c.classList.remove('is-shake');
        void c.offsetWidth; // restart animation
        c.classList.add('is-shake');
      });
    }

    function warnIfFull(input) {
      if (input.disabled) warn(shortOf(input.dataset.speakerInput) + ' is fully booked.');
    }

    // ---------- Render ----------
    function render() {
      const n = selected.length;
      const atMax = n >= MAX;

      allInputs().forEach((input) => {
        const id = input.dataset.speakerInput;
        const on = selected.includes(id);
        const full = isFull(id);
        input.checked = on;
        input.disabled = full && !on;
        const label = input.closest('label');
        if (label) {
          label.classList.toggle('is-full', full);
          label.classList.toggle('is-limit', atMax && !on && !full);
        }
      });

      document.querySelectorAll('[data-speaker-card]').forEach((card) => {
        const id = card.dataset.speakerCard;
        card.classList.toggle('is-selected', selected.includes(id));
        card.classList.toggle('is-full', isFull(id));
      });

      document.querySelectorAll('[data-availability]').forEach((el) => {
        const id = el.dataset.availability;
        if (!id || !known(id)) {
          el.textContent = ''; // not in Airtable → hidden via :empty
          el.classList.remove('is-full');
          return;
        }
        const a = availability[id];
        const full = isFull(id);
        el.textContent = full ? 'Fully booked' : a.booked + '/' + a.capacity + ' booked';
        el.classList.toggle('is-full', full);
      });

      if (hidden) hidden.value = selected.join(SEP);
      // Airtable record IDs of selected speakers; speakers not in Airtable are skipped
      if (recordIdsField) {
        recordIdsField.value = selected
          .map((id) => known(id) && availability[id].recordId)
          .filter(Boolean)
          .join(SEP);
      }
      if (selectedField) selectedField.value = selected.map((id) => labelOf(speakers.get(id))).join('; ');
      if (unselectedField) {
        unselectedField.value = [...speakers.values()]
          .filter((s) => !selected.includes(s.id))
          .map(labelOf)
          .join('; ');
      }

      counters.forEach((c) => {
        c.textContent =
          n === 0 ? 'None selected (max ' + MAX + ')' : n + ' of ' + MAX + ' selected' + (atMax ? ' · maximum reached' : '');
        c.classList.toggle('is-full', atMax);
      });
    }

    // ---------- Selection ----------
    function onChange(e) {
      const input = e.target;
      const id = input.dataset.speakerInput;
      if (!id) return;

      if (input.checked) {
        if (isFull(id)) {
          input.checked = false;
          warn(shortOf(id) + ' is fully booked.');
        } else if (!selected.includes(id)) {
          if (selected.length >= MAX) {
            input.checked = false;
            warn('You can select up to ' + MAX + ' speakers. Unselect one to choose another.');
          } else {
            selected.push(id);
          }
        }
      } else {
        const i = selected.indexOf(id);
        if (i > -1) selected.splice(i, 1);
      }
      render();
    }
    allInputs().forEach((input) => input.addEventListener('change', onChange));

    // card checkbox must not open/close the Finsweet accordion
    cardToggles.forEach((t) => {
      ['click', 'keydown', 'keyup', 'mousedown', 'pointerdown', 'touchstart'].forEach((type) =>
        t.addEventListener(type, (e) => e.stopPropagation(), { passive: true }),
      );
      t.addEventListener('click', () => warnIfFull(t.querySelector('input')));
    });

    // ---------- Availability ----------
    function debugReport() {
      const page = [...speakers.keys()];
      const air = Object.keys(availability);
      console.group('[speakers] slug check — ' + API_URL);
      console.log('Matched:', page.filter((s) => air.includes(s)));
      console.warn('On page, NOT in Airtable (no limit applied):', page.filter((s) => !air.includes(s)));
      console.warn('In Airtable, NOT on page:', air.filter((s) => !page.includes(s)));
      console.groupEnd();
    }

    async function refresh(fresh) {
      const url = fresh ? API_URL + (API_URL.includes('?') ? '&' : '?') + 'fresh=' + Date.now() : API_URL;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Availability API ' + res.status);
      const data = await res.json();
      availability = data.availability || {};

      if (DEBUG && !reported) debugReport();
      reported = true;

      const lost = selected.filter(isFull);
      lost.forEach((id) => selected.splice(selected.indexOf(id), 1));
      if (lost.length) {
        warn(
          lost.map(shortOf).join(', ') +
            (lost.length > 1 ? ' were' : ' was') +
            ' just fully booked and removed from your selection.',
        );
      }
      render();
      return lost;
    }

    setInterval(() => {
      if (!document.hidden) refresh().catch(console.warn);
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh().catch(console.warn);
    });

    // ---------- Submit: re-check availability, then let Webflow submit ----------
    if (form) {
      let passThrough = false;

      form.addEventListener(
        'submit',
        async (e) => {
          if (passThrough) {
            passThrough = false;
            return; // second pass → Webflow handles it
          }
          e.preventDefault();
          e.stopImmediatePropagation();

          if (!selected.length) {
            warn('Please select at least one speaker.');
            list.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }

          const btn = form.querySelector('[type="submit"]');
          const original = btn ? btn.value : '';
          if (btn) {
            btn.disabled = true;
            btn.value = 'Checking availability…';
          }

          let lost = [];
          try {
            lost = await refresh(true);
          } catch (err) {
            console.warn(err); // API down → don't block, Make still checks
          }

          if (btn) {
            btn.disabled = false;
            btn.value = original;
          }
          if (lost.length) {
            list.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }

          passThrough = true;
          form.requestSubmit(btn || undefined);
        },
        true,
      );
    }

    render(); // works immediately, without availability
    refresh().catch(console.warn); // then badges + limits
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
