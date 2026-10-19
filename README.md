# Venture Connections — EIC Pitching Session

Speaker booking for the EIC Pitching Session page on Webflow.
Visitors pick up to 4 speakers; each speaker can be booked a limited number of times (capacity in Supabase).

```
Webflow page (CMS cards + form)
  ├─ loads  /speakers.css, /speakers.js     ← served by this Vercel project
  ├─ JS     GET  /api/availability          ← Supabase view speaker_availability (CDN cache 10 s)
  └─ JS     POST /api/book                  ← Supabase function book_meetings() (one transaction)
```

The form is submitted by `speakers.js` to `/api/book`, not by Webflow. On success the page shows
Webflow's own success message; if a speaker was taken in the meantime, nothing is saved and the
visitor is asked to adjust the selection.

## Structure

| Path | What |
|---|---|
| `api/availability.js` | `GET` → `{ availability: { <slug>: { recordId, capacity, used, available, status } } }`. `?fresh=…` bypasses the CDN cache. |
| `api/book.js` | `POST { bookingId, email, firstName, lastName, company, linkedin, speakers[] }` → 200 booked · 409 `unavailable[]` · 422 invalid · 403 wrong origin. |
| `lib/` | Supabase REST client (secret key, server only) and CORS helper. |
| `supabase/migrations/` | Database schema: `speakers`, `submissions`, `meeting_requests`, view `speaker_availability`, function `book_meetings`. |
| `supabase/seed.sql` | Current speakers (slugs = Webflow CMS slugs). |
| `public/speakers.js` | Front-end: card ⇄ form checkbox sync, max 4, availability badges, sorting, booking submit. |
| `public/speakers.css` | Styles for checkboxes, badges, form list, toast. |
| `webflow/embeds.html` | Snippets to paste into Webflow. |
| `dev/` | Local demo page with fake availability (not deployed). |
| `test/` | Endpoint tests with a mocked Supabase. |

## Environment variables (Vercel)

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase secret key (`sb_secret_…`), sensitive. Bypasses RLS, server only. |
| `ALLOWED_ORIGINS` | Comma-separated Webflow origins; only these may read availability and book. |
| `AVAILABILITY_CACHE_SECONDS` | Optional, CDN cache for `/api/availability` (default 10). |

## Capacity rules (database)

A meeting request takes one of the speaker's places while its status is `new_request`, `needs_review`,
`hold_awaiting_speaker`, `accepted_scheduling` or `scheduled_confirmed` (function `request_takes_place`).
`waitlisted`, `declined`, `cancelled` and `expired` free the place. A speaker whose `availability` is not
`open` can't be booked. `book_meetings` locks the chosen speakers, so two visitors can't take the last place.

## Webflow

See `webflow/embeds.html`. In short:

- Page `<head>`: `<link rel="stylesheet" href="https://venture-connections-eic-pitching-se.vercel.app/speakers.css">`
- Before `</body>`: `<script src="https://venture-connections-eic-pitching-se.vercel.app/speakers.js" defer></script>`
  - Options on the script tag:
    - `data-sort="true|false"`: move unavailable speakers (full, paused, unavailable) to the end of the cards and the form list. Default `true`.
    - `data-max="4"`: how many speakers can be selected.
    - `data-api="…"` / `data-book-api="…"`: API URLs (default: derived from the script URL).
- Add `?speakers-debug` to the page URL to log slugs that don't match the database.

## Develop

```bash
npm test                                   # endpoint tests (mocked Supabase)
python3 -m http.server 4321                # then open http://localhost:4321/dev/index.html?speakers-debug
```
