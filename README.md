# Fit Jump loyalty wallet

## What it is

* A loyalty stamp card in Google Wallet for a trampoline gym in Guadalajara, Jalisco, Mexico.
* In production since October 2026, with real members.
* Reception registers a payment or a redemption in a web panel, and the member's pass updates itself in her phone.

## Architecture

* Cloudflare Workers with Hono: one Worker serves the API, the public sign up pages and the reception panel.
* Neon PostgreSQL, queried over HTTP with `@neondatabase/serverless`.
* Google Wallet REST API. Requests are authorized with a JWT signed RS256 on WebCrypto (`jose`), so no Node crypto is needed inside the Worker.
* Reception panel in Vue 3, built to static files and served by the same Worker.
* Progress images (16 of them, one per stamp state) are generated with Pillow outside the Worker and published as static files.
* Weekly encrypted backup with GnuPG in GitHub Actions. The workflow is kept as an example in `docs/ejemplos/respaldo.yml.example`, so it does not run here.

## Design decisions

* `mecanica.ts` is the authority on the stamp rules. It is pure: no imports, no I/O, no clock.
* plpgsql is used only for audit. A cross check test with `fast-check` runs random ledgers through both implementations and requires the same answer.
* The database first, Google second. Every change is written to Postgres, and `sync_wallet` records what Google still has to receive. A failed call is retried by the cron job.
* PATCH and never PUT on Google Wallet objects, so a partial update cannot erase fields.
* The ledger is ordered by a sequence number, not by timestamp.
* The cron runs every 30 minutes so that Neon can suspend its compute. Measured: about 38 of the 100 CU hours available per month. A cron every minute would keep the database awake all day and exhaust the quota.
* Measured CPU time per request is 2.98 ms, against a limit of 10 ms.
* A published image is never overwritten. Google caches images by URL, so passes already saved would keep showing the old one. New artwork goes in a new versioned folder (`v1`, then `v2`).

## Tests

* 151 tests run in CI without a database; 14 more (cross check against the plpgsql audit functions and multi tenant isolation) need a real PostgreSQL and are skipped here. Against the production database: 164 pass and 1 is skipped on purpose (October 27, 2026).
* Those 14 read `DATABASE_URL` from `backend/.dev.vars`, which is not versioned. Without it they skip themselves. `backend/.dev.vars.example` lists every variable the code uses, with placeholder values.
* To run the suite: `cd backend`, then `npm ci`, `npx tsc --noEmit` and `npx vitest run`.

## Known gaps

* Backups run every week, but none containing real data has been restored yet.
* The text of the `/lealtad/` page in production has no accent marks.
* Two of the three test credentials from the original deployment have not been reissued, and three old passes are still alive.
* Nobody has tested it on an iPhone.
* In the worst case, retrying a call to Google can exceed the time that `waitUntil` allows. The cron job picks up whatever was left pending.
* A URL that does not exist answers 401, not 404.

## This repository

* A public mirror of a private production repository, published as a work sample.
* It has no history, no member data and no secrets. A few personal names and identifiers in comments, seeds and fixtures were replaced with placeholders.
* The public pages of the business (the site root and the loyalty program page) are a separate project and are not included, so `/` and `/lealtad/` serve nothing in this mirror.
* All rights reserved.
