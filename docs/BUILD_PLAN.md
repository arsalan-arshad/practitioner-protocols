# Practitioner Protocols — Build Plan

## M0 — Spikes (1–2 days, dev store with B2B + new customer accounts)
- [ ] S1 practitioner surface · S2 app-proxy page in theme layout + noindex · S3 attribution carrier · S4 Cart AJAX 20 lines · S5 practitioner-preview pricing.
- [ ] Record each answer in `PROJECT_CONTEXT.md` §5 and update D1–D4. Re-rank scope if a spike fails.

## M1 — Foundation
- [x] Pure engine core: share-token generator, schema validation, permission checks, cart payload construction, QR generator, attribution extraction (`npm test` 238/238 pure unit tests passing).
- [x] Prisma schema (SPEC §6) & versioned PostgreSQL DDL migrations (`prisma/schema.prisma`, `prisma/migrations/**`; Note: DB integration tests and migrations NOT yet verified against a real Postgres).
- [ ] App scaffold (Remix/server entry, `shopify.app.toml`, Polaris UI harness) — pending dev store setup.
- [x] Protocol API route handlers with ownership checks (`app/lib/protocols/routes.js`, `test/routes.test.js`: cross-owner read/write denied, starters read-only, authentication enforced, fail-closed HMAC).

## M2 — Client page
- [x] App-proxy pure Liquid renderer (HMAC-verified, Liquid delimiter neutralization, all states from SPEC §5, `noindex`, mobile-first in `app/lib/protocols/proxy.js`, `test/proxy.test.js`).
- [x] Add all (one request) + per-line add + hidden attribution property logic (`app/lib/protocols/attribution.js`).
- [ ] Live client page storefront integration and theme testing (blocked on dev store + Spike S2). Catalog resolver proposed in `docs/PROPOSAL_CATALOG_RESOLVER.md`.

## M3 — Practitioner portal
- [x] Portal logic: Library data models, editor validation (limits, price total), duplicate/archive/restore, concurrent-edit warning (`app/lib/protocols/portal.js`, `test/portal.test.js`).
- [ ] Interactive portal UI screens (extension/proxy page) — blocked on dev store + Spike S1.

## M4 — Share kit
- [x] Pure vector QR SVG generator (ISO/IEC 18004, GF(256) Reed-Solomon) and printable one-page HTML/CSS handout (`app/lib/protocols/qr.js`, `handout.js`, `test/handout.test.js`).

## M5 — Attribution and reports
- [x] `orders/paid` idempotent attribution processing (`_protocol_token` extractor, discount-subtracted line totals, multi-currency partitioning in `app/lib/protocols/attribution.js`, `webhooks.js`, `service.js`).

## M6 — Merchant admin
- [x] Pure merchant admin business logic: practitioner approvals, practice names, starters, emergency disable, settings, aggregate monthly reports, and RFC 4180 CSV export (`app/lib/protocols/admin.js`, `test/admin.test.js`).
- [ ] Embedded Polaris admin UI screens — blocked on dev store + app scaffold.

## M7 — Hardening and review prep
- [x] Compliance webhooks with error propagation and honest data request handling (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` in `app/lib/protocols/webhooks.js`).
- [x] Security audit & bug remediation: resolved defects 1–11 and re-verification fixes 1–7 (fail-closed HMAC, Liquid delimiter neutralization, complete permission status mapping, connection pool transaction checkout, atomic webhook idempotency rollback, zero order ID persistence, nested PII rejection, anti-spoofing rate limiting, currency exponents).
- [x] Sliding-window rate limiting on the proxy page (`app/lib/protocols/rate-limit.js`, `test/rate-limit.test.js`).
- [ ] Run the `shopify-app-store-review` self-review; protected-data request; $0 plan registered (pending app harness and store review prep).

## M8 — Release
- [x] README written from verified code; architecture, schema, security guarantees, and test instructions documented.
- [ ] Final owner review, dev store end-to-end verification, tagging, and release.

## Later
Practitioner application form · aggregate "client orders" count on protocol cards · protocol version history · Salesforce rollup via Bridge Recipes.
