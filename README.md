# Venture Connections — EIC Pitching Session

Speaker booking for the EIC Pitching Session page on Webflow.
Visitors pick up to 4 speakers; each speaker can be booked a limited number of times (capacity in Supabase).

```
Webflow page (CMS cards + form)
  ├─ loads  /speakers.css, /speakers.js     ← served by this Vercel project
  ├─ JS     GET  /api/availability          ← Supabase view speaker_availability (CDN cache 10 s)
  └─ JS     POST /api/book                  ← Supabase function book_meetings() (one transaction)
```

The form is submitted by `speakers.js` to `/api/book` first. Then the same form is handed to Webflow's
own handler as a raw backup copy (Webflow Forms + notification email) with a `Booking status` field:

| API result | Webflow copy | Visitor sees |
|---|---|---|
| booked | `booked` | success (also if the Webflow copy fails) |
| duplicate (double submit) | none, sent the first time | success |
| speaker taken meanwhile (409) | none, nothing saved | toast, adjust and resubmit |
| invalid email / selection | none | toast |
| API down / error | `NOT SAVED: booking API error, enter manually` | Webflow's success/error message |

`data-webflow-backup="false"` on the script tag turns the copy off.

## Structure

| Path | What |
|---|---|
| `api/availability.js` | `GET` → `{ availability: { <slug>: { recordId, capacity, used, available, status } } }`. `?fresh=…` bypasses the CDN cache. |
| `api/website-speakers.js` | `GET ?source=live\|staging` → speaker cards on the Webflow page (for the panel's website comparison). |
| `api/register-speakers.js` | `POST { speakers: [{ slug }] }` → adds speakers whose card is on the published page. |
| `api/book.js` | `POST { bookingId, email, firstName, lastName, company, linkedin, speakers[] }` → 200 booked · 409 `unavailable[]` · 422 invalid · 403 wrong origin. |
| `lib/` | Supabase REST client (secret key, server only) and CORS helper. |
| `supabase/migrations/` | Database schema: `speakers`, `submissions`, `meeting_requests`, view `speaker_availability`, function `book_meetings`. |
| `supabase/seed.sql` | Current speakers (slugs = Webflow CMS slugs). |
| `public/speakers.js` | Front-end: card ⇄ form checkbox sync, max 4, availability badges, sorting, booking submit. |
| `public/speakers.css` | Styles for checkboxes, badges, form list, toast. |
| `webflow/embeds.html` | Snippets to paste into Webflow. |
| `public/eic-team-4k9p/`, `admin/` | Team admin panel (see below). |
| `dev/` | Local demo page with fake availability (not deployed). |
| `test/` | Endpoint tests with a mocked Supabase. |

## Speaker keys and new cards

The speaker cards are static Webflow elements, so `data-speaker` is typed by hand. `speakers.js` and the server
apply the same rules (`lib/speaker-keys.js`, copied into `speakers.js` between `<speaker-keys>` markers; a test
keeps them identical):

- **Clean-up**: lowercase, accents removed, other characters → dashes (`"SageWrite "` → `sagewrite`).
  Empty → built from the company (or name).
- **Copied cards**: a card reusing another card's key for a different person gets its own key (from its company).
  The same person repeated (e.g. desktop + mobile) keeps one key.
- **New cards**: a card the database doesn't know is registered automatically (`POST /api/register-speakers`,
  also done before every booking). The server only adds speakers whose card is on the published page
  (live page for the live domain, webflow.io page for webflow.io), with name/company from the page.
  Start state: `AUTO_SPEAKER_AVAILABILITY` (default `open`), `AUTO_SPEAKER_CAPACITY` (default 4).
- `?speakers-debug` on the page outlines cards whose `data-speaker` was fixed.

## Workflow: branch → preview + staging → production

The site is live, so changes go through a branch first:

1. Work on a branch (`feature/…`) and push it. Vercel builds a **preview deployment** for it.
2. Database changes go to the **staging** Supabase project first (`EIC-staging`, ref `ordkpipvkpumdgpgmoxx`).
   Migrations are additive, so production keeps working whichever side goes live first.
3. Test on the preview URL: the panel there (and on localhost) uses **staging** and shows a yellow badge.
4. When approved: apply the migration to **production** (`pxlfskkmakgmfgcwrqay`), then merge the pull request
   into `main` → production deploy.

The panel chooses the database by address: only the production domains
(`venture-connections-eic-pitching-se.vercel.app`, `…-session-oboilos-projects.vercel.app`) use production.
Vercel env vars: Production → production project, Preview → staging project.

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

## Admin panel (`/eic-team-4k9p`)

Team panel for the bookings: overview, meeting requests (status inline), investors, speakers
(capacity / availability inline), side panel per row, CSV export, live updates.

- Login: Supabase Auth, email + password, invite only. Access: emails in `public.admins`
  (row-level security, migration `20261020090000_admin_access.sql`).
- Code: `public/eic-team-4k9p/` (plain JS modules, supabase-js from jsDelivr). Styles: Tailwind v4,
  source `admin/admin.css` → built to `public/eic-team-4k9p/admin.css` by `npm run build` (Vercel runs it).
- Local demo with fake data: `npm run build && python3 -m http.server 4322 --directory public`,
  then open http://localhost:4322/eic-team-4k9p/?demo

**Archive, not delete.** The panel archives investors and speakers (`archived_at`, `archived_by`) and can
restore them; archived investors' requests stop taking places, archived speakers are closed. Panel users have
no DELETE permission: permanent deletes only in Supabase (Table Editor / SQL).

**Sources and history.** Investors and requests have `source` = `website` or `panel` (team) and `created_by`.
`submission_events` logs every website submission exactly as sent (raw form) and every team addition.
A repeat submission with the same email joins the existing (non-archived) investor: new speakers are added,
existing ones are skipped. Team additions go through `panel_add_requests()` / `panel_create_investor()`.

**Backups.** `pg_cron` runs `backup.take_snapshot()` daily at 02:15 UTC: all tables as JSON in
`backup.snapshots` (kept 30 days, not exposed to the API). Restore a table from the latest snapshot, e.g.
`select jsonb_array_elements(data->'submissions') from backup.snapshots order by taken_at desc limit 1`.
The panel's Overview → *Download backup* gives an offsite JSON copy of everything.

**Archived requests, tags, stages, bulk edits.** Single meeting requests can be archived too; requests of an
archived investor count as archived with them (chip "Investor archived"). Investors and requests have free
`tags`; `test` is special: not counted in totals or in speaker capacity on the website. Investor status is
replaced by an automatic **stage** from their requests (Needs action / In progress / Confirmed / Waitlisted /
Closed; `investorStage()` in `labels.js`). All tables have checkboxes and a bulk bar (status, assignee,
availability, capacity, tags, archive/restore, export) with Undo. Migration `20261026090000_request_archive_tags.sql`.

**Compare with website** (Speakers page): reads the speaker cards on the published Webflow page
(`GET /api/website-speakers?source=live|staging`, from the card embed's `data-speaker*` attributes) and
suggests: add new cards, update changed names/companies, follow slug changes (same name → bookings kept),
and close speakers whose card is gone (unticked by default). Logic: `public/eic-team-4k9p/js/sync.js`.
Page URLs can be overridden with `WEBSITE_URL_LIVE` / `WEBSITE_URL_STAGING`.

Add a team member: Supabase → Authentication → Users → *Invite user*, and add the same email
(lowercase) to the `admins` table. Supabase → Authentication → URL Configuration must have
`https://venture-connections-eic-pitching-se.vercel.app/eic-team-4k9p/` as Site URL / redirect URL.

## Webflow

See `webflow/embeds.html`. In short:

- Page `<head>`: `<link rel="stylesheet" href="https://venture-connections-eic-pitching-se.vercel.app/speakers.css">`
- Before `</body>`: `<script src="https://venture-connections-eic-pitching-se.vercel.app/speakers.js" defer></script>`
  - Options on the script tag:
    - `data-sort="true|false"`: move unavailable speakers (full, paused, unavailable) to the end of the cards and the form list. Default `true`.
    - `data-max="4"`: how many speakers can be selected.
    - `data-webflow-backup="true|false"`: also send each booking to Webflow Forms as a raw backup. Default `true`.
    - `data-api="…"` / `data-book-api="…"`: API URLs (default: derived from the script URL).
- Add `?speakers-debug` to the page URL to log slugs that don't match the database.

## Develop

```bash
npm test                                   # endpoint tests (mocked Supabase)
python3 -m http.server 4321                # then open http://localhost:4321/dev/index.html?speakers-debug
```
