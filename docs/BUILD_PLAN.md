# Practitioner Protocols — Build Plan

## M0 — Spikes (1–2 days, dev store with B2B + new customer accounts)
- [ ] S1 practitioner surface · S2 app-proxy page in theme layout + noindex · S3 attribution carrier · S4 Cart AJAX 20 lines · S5 practitioner-preview pricing.
- [ ] Record each answer in `PROJECT_CONTEXT.md` §5 and update D1–D4. Re-rank scope if a spike fails.

## M1 — Foundation
- [x] Pure engine core: share-token generator, schema validation, permission checks, cart payload construction, QR generator, attribution extraction (`npm test` 62/62 passing).
- [x] Prisma schema (SPEC §6) & initial PostgreSQL DDL migration (`prisma/schema.prisma`, `prisma/migrations/20261021_init/migration.sql`).
- [x] App scaffold & Session storage setup (`prisma/schema.prisma`).
- [x] Protocol API with ownership checks (`app/lib/protocols/routes.js`, `test/routes.test.js` tests: cross-owner read/write denied, starters read-only, authentication enforced).

## M2 — Client page
- [x] App-proxy page (HMAC-verified), all states from SPEC §5, `noindex`, mobile-first (`app/lib/protocols/proxy.js`, `test/proxy.test.js`).
- [x] Add all (one request) + per-line add + hidden attribution property; unavailable-item handling.

## M3 — Practitioner portal
- [x] Library, editor (search, notes, reorder, limits, price total), duplicate/archive/restore, concurrent-edit warning (`app/lib/protocols/portal.js`, `test/portal.test.js`).

## M4 — Share kit
- [x] Link copy, QR PNG/SVG, one-page handout (Letter + A4). Test: QR decodes to the exact link (`app/lib/protocols/qr.js`, `handout.js`).

## M5 — Attribution and reports
- [x] `orders/paid` → per-line counters; reports + CSV. Test: mixed cart attributes only protocol lines (`attribution.js`, `webhooks.js`).

## M6 — Merchant admin
- [x] Practitioner approval, practice names, starters, disable, settings (mode, footer), aggregate attribution reports & RFC 4180 CSV export (`app/lib/protocols/admin.js`, `test/admin.test.js`).

## M7 — Hardening and review prep
- [x] Compliance webhooks with real redaction (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` in `app/lib/protocols/webhooks.js`).
- [x] Security audit & Context7 upstream verification (HMAC timing attacks, PII barriers, SQL parameterization, XSS escaping).
- [x] Rate limiting on the proxy page (`app/lib/protocols/rate-limit.js`, `test/rate-limit.test.js`); secrets and dependency audit.
- [ ] Run the `shopify-app-store-review` self-review; protected-data request; $0 plan registered.

## M8 — Release
- [x] README written last from verified code; install + theme guide; architecture & test instructions.
- [ ] Ask the owner before tagging and release.

## Later
Practitioner application form · aggregate "client orders" count on protocol cards · protocol version history · Salesforce rollup via Bridge Recipes.
