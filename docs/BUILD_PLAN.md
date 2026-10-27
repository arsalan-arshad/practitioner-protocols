# Practitioner Protocols — Build Plan

## M0 — Spikes (1–2 days, dev store with B2B + new customer accounts)
- [ ] S1 practitioner surface (customer account UI extension vs app-proxy portal).
- [ ] S2 app-proxy page in theme layout + verify `noindex` and `sitemap.xml` exclusion (Liquid evaluation confirmed in Session 12; reverse-proxy hop count for rate limiting needs re-measuring on real host).
- [ ] S3 attribution carrier (verify hidden line property `_protocol_token` survives Cart AJAX through to completed `orders/paid` order).
- [ ] S4 Cart AJAX 20 lines (verify adding 20 distinct variant lines in a single `/cart/add.js` POST request).
- [ ] S5 practitioner-preview pricing (verify practitioner view vs client retail view).
- [ ] Record empirical findings for S1–S5 in `PROJECT_CONTEXT.md` §5 and update decisions D1–D4. Re-rank scope if a spike fails. Detailed execution plan in [`docs/SPIKES_CHECKLIST.md`](SPIKES_CHECKLIST.md).

## M1 — Foundation
- [x] Pure engine core: share-token generator, schema validation, permission checks, cart payload construction, QR generator, attribution extraction (`npm test` 289 pure unit tests passing).
- [x] Prisma schema (SPEC §6) & versioned PostgreSQL DDL migrations (`prisma/schema.prisma`, `prisma/migrations/**`; verified on PostgreSQL 17.11; `test:db` skips with a notice when no DB is reachable).
- [ ] App scaffold and authentication (`shopify.app.toml` scopes and subscriptions corrected; real OAuth/token exchange and session token verification pending).
- [x] Protocol API route handlers with ownership checks (`app/lib/protocols/routes.js`, `test/routes.test.js`: cross-owner read/write denied, starters read-only, authentication enforced, fail-closed HMAC, catalog resolution).

## M2 — Client page
- [x] App-proxy pure Liquid renderer (HMAC-verified, Liquid delimiter neutralization, all states from SPEC §5, mobile-first in `app/lib/protocols/proxy.js`, `test/proxy.test.js`).
- [x] Add all (one request) + per-line add + hidden attribution property logic (`app/lib/protocols/attribution.js`).
- [x] Catalog Resolver (`app/lib/protocols/catalog.js`, `test/catalog.test.js`): batch variant GraphQL resolution, fallback for missing/unpublished items, multi-currency minor units, line enrichment; `product.status` removed from Storefront query.
- [ ] Live client page storefront integration and theme testing (blocked on dev store + Spikes S2–S4).

## M3 — Practitioner portal
- [x] Portal logic: Library data models, editor validation (limits, price total), duplicate/archive/restore, concurrent-edit warning (`app/lib/protocols/portal.js`, `test/portal.test.js`).
- [x] Interactive portal UI: Interactive protocol editor modal with product search, variant line curation, quantity controls, usage notes, and App Proxy persistence (`renderPortalLiquid` in `app/lib/protocols/portal.js`, `routes.js`, `catalog.js`).

## M4 — Share kit
- [x] Pure vector QR SVG generator (ISO/IEC 18004, GF(256) Reed-Solomon) and printable one-page HTML/CSS handout (`app/lib/protocols/qr.js`, `handout.js`, `test/handout.test.js`).

## M5 — Attribution and reports
- [x] `orders/paid` idempotent attribution processing (`_protocol_token` extractor, discount-subtracted line totals, multi-currency partitioning in `app/lib/protocols/attribution.js`, `webhooks.js`, `service.js`).

## M6 — Merchant admin
- [x] Pure merchant admin business logic: practitioner approvals, practice names, starters, emergency disable, settings, aggregate monthly reports, and RFC 4180 CSV export (`app/lib/protocols/admin.js`, `test/admin.test.js`).
- [x] Embedded Polaris admin UI & session tokens: Embedded Polaris UI with tab navigation, practice name editor, starter template builder modal, month-filtered RFC 4180 CSV export, emergency kill switch, HS256 App Bridge session-token verification, and live Web route handlers (`renderAdminHtml`, `verifyAdminSessionToken`, `routes.js`, `server.js`).

## M7 — Hardening and review prep
- [x] Compliance webhooks with error propagation and honest data request handling (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` in `app/lib/protocols/webhooks.js`).
- [x] Security audit & bug remediation: resolved defects 1–11 and re-verification fixes 1–7 (fail-closed HMAC, Liquid delimiter neutralization, complete permission status mapping, connection pool transaction checkout, atomic webhook idempotency rollback, zero order ID persistence, nested PII rejection, anti-spoofing rate limiting, currency exponents).
- [x] Sliding-window rate limiting on the proxy page (`app/lib/protocols/rate-limit.js`, `test/rate-limit.test.js`).
- [x] Run the `shopify-app-store-review` self-review; protected-data request justification; $0 plan registered (documented in `docs/SHOPIFY_APP_STORE_AUDIT.md`; OAuth 2.0 flow, CSP frame-ancestors headers, and Session table integration in `server.js`, `test/server.test.js`).

## M8 — Release
- [x] README written from verified code; architecture, schema, security guarantees, and test instructions documented.
- [ ] Final owner review, dev store end-to-end verification, tagging, and release.

## Later
Practitioner application form · aggregate "client orders" count on protocol cards · protocol version history · Salesforce rollup via Bridge Recipes.
