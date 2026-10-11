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
| `api/availability.js` | `GET /api/availability` → `{ availability: { <slug>: { recordId, capacity, used, available, status } } }`. Cached 10 s on the CDN; `?fresh=…` bypasses the cache. |
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

The endpoint reads these fields from "EIC - Speakers": `Slug` (must equal the Webflow CMS slug),
`Capacity`, `Capacity Used` (rollup of 1:1 Meetings' Capacity Units), `Available Places` and
`Capacity Status` (Available / Full / Over Capacity / Paused / Unavailable / Closed).
All capacity logic lives in those Airtable formulas; the site only displays it.

## Webflow

See `webflow/embeds.html`. In short:

- Page `<head>`: `<link rel="stylesheet" href="https://venture-connections-eic-pitching-se.vercel.app/speakers.css">`
- Before `</body>`: `<script src="https://venture-connections-eic-pitching-se.vercel.app/speakers.js" defer></script>`
  - Options on the script tag:
    - `data-sort="true|false"`: move unavailable speakers (full, paused, unavailable) to the end of the cards and the form list. Default `true`.
    - `data-max="4"`: how many speakers can be selected.
    - `data-api="…"`: availability API URL (default: derived from the script URL).
- Add `?speakers-debug` to the page URL to log slugs that don't match Airtable.

## Develop

```bash
npm test                                   # endpoint tests
python3 -m http.server 4321                # then open http://localhost:4321/dev/index.html?speakers-debug
```
