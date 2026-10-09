# Venture Connections — EIC Pitching Session

Speaker booking for the EIC Pitching Session page on Webflow.
Visitors pick up to 4 speakers; each speaker can be booked a limited number of times (capacity in Airtable).

```
Webflow page (CMS cards + form)
  ├─ loads  /speakers.css, /speakers.js        ← served by this Vercel project
  └─ JS     GET /api/availability              ← this project, reads Airtable
Webflow form → Make (sequential) → Airtable Bookings → HubSpot / emails
```

## Structure

| Path | What |
|---|---|
| `api/availability.js` | `GET /api/availability` → `{ availability: { <slug>: { booked, capacity } } }`. Cached 15 s on the CDN; `?fresh=…` bypasses the cache. |
| `public/speakers.js` | Front-end: card ⇄ form checkbox sync, max 4, availability badges, pre-submit check. |
| `public/speakers.css` | Styles for checkboxes, badges, form list, toast. |
| `webflow/embeds.html` | Snippets to paste into Webflow (script/link tags, card checkbox, badge, hidden fields). |
| `dev/` | Local demo page with fake availability (not deployed). |
| `test/` | Endpoint tests with a mocked Airtable. |

## Environment variables (Vercel)

| Name | Value |
|---|---|
| `AIRTABLE_TOKEN` | Personal access token, scope `data.records:read`, access to the EIC base only |
| `AIRTABLE_BASE_ID` | `app…` |
| `AIRTABLE_TABLE` | Speakers table ID `tbl…` (survives renames) |
| `ALLOWED_ORIGINS` | Comma-separated, e.g. `https://example.com,https://example.webflow.io` |

The Speakers table must have the fields `Slug`, `Capacity` (empty = 4) and `Booked`
(rollup of Bookings with `Status = Confirmed`). `Slug` must equal the Webflow CMS slug.

## Webflow

See `webflow/embeds.html`. In short:

- Page `<head>`: `<link rel="stylesheet" href="https://venture-connections-eic-pitching-se.vercel.app/speakers.css">`
- Before `</body>`: `<script src="https://venture-connections-eic-pitching-se.vercel.app/speakers.js" defer></script>`
  - API URL is derived from the script URL; override with `data-api="…"`, max with `data-max="4"`.
- Add `?speakers-debug` to the page URL to log slugs that don't match Airtable.

## Develop

```bash
npm test                                   # endpoint tests
python3 -m http.server 4321                # then open http://localhost:4321/dev/index.html?speakers-debug
```
