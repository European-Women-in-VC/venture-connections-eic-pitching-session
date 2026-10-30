# Changelog

Versions follow `package.json` (shown in the panel sidebar). Each release is tagged `vX.Y.Z` on `main`.
Database migrations a release needs are listed with it; apply them to production before merging.

## 1.2.0 — 2026-10-30

- Team page (owners): members, owner / editor / viewer access per product, disable / enable, history,
  login links to copy and send (no email needed).
- Viewers get a read-only panel; the database enforces it (`core.can_read` / `core.can_edit`).
- Team data in the new `core` schema, shared by future products; `public.admins` is now a view of it.
- Migration: `20261031090000_team_members_roles.sql` (existing admins become owners).

## 1.1.0 — 2026-10-30

- Panel shows the app version, commit and database (sidebar); warns when the database lacks the latest
  migration of the deployed code.
- `npm run smoke`: checks both hosts after a deploy (panel, speakers.js, version, availability).
- Migration: `20261030150000_applied_migrations.sql`.

## 1.0.0 — 2026-10-30

First tagged version: everything live on this date.

- Website: speaker cards ⇄ form sync, max 4, live availability, booking through `/api/book`, Webflow backup copy,
  speaker key clean-up and automatic registration of new cards.
- Hosting: Vercel and Cloudflare Workers (same `/api` handlers).
- Panel: overview, requests, investors, speakers; archive instead of delete, tags (`test`), automatic investor
  stage, bulk editing, compare with website, import of the Webflow form export, daily backup.
