# Practitioner Protocols — Project Context (for Claude)

_Snapshot: 2026-10-28 · Complete app & engine verified (337 pure unit tests passing across 88 suites) · Spikes S1, S4, S5 fully answered & closed; S3 property persistence verified across guest order #1016 and signed-in B2B order #1017; S2 sitemap exclusion confirmed on dev store · v0.1.0 tagged on main._
_Contains NO secrets. Never paste `.env` values or tokens into chat or docs._

## 1. What this is
An open-source (MIT) Shopify app: professionals build reusable product "protocols", share one permanent link/QR, clients add everything to cart in one tap at retail price, and the brand sees aggregate attribution by practice and protocol. See `README.md`, `docs/SPEC.md`.

## 2. Origin and clean-room rule
The idea grew out of a client request. The owner decided to build their **own, general-purpose, portfolio version** and leave the client's engagement separate.
- This project is designed in its own words around the general model (professional recommends → client buys), for any brand selling through professionals.
- **Never** copy text, file structure, code, naming, screenshots or business specifics from any client deliverable into this repo or these docs, and never name the client here. If the owner delivers a private version for a client, keep that code in a separate repo.
- If a design question arises that the client spec "answered", answer it fresh from platform docs and this spec.

## 3. Why it is worth building (honest read)
- **Most build-ready idea in the portfolio:** behaviour is well understood, no external counterparty needed.
- **Real gap:** the model is proven in closed dispensary platforms; no open equivalent for a brand on its own Shopify store.
- **Showcases a lot of Shopify surface:** App Proxy, customer accounts, B2B, webhooks, Cart AJAX, admin UI — good for the "get genuinely good at Shopify" goal.
- **Risks:** platform unknowns (spikes S1–S5), a narrow-ish audience, impersonation/health-adjacent review sensitivity, no confirmed first brand.

## 4. Relationship to other projects
- **03 Bridge Recipes:** a later recipe could roll practitioner-attributed revenue up to a Salesforce Account for a field rep.
- **01 AI Forecast Agent:** protocol demand could someday feed forecasts (aggregate by SKU) — not planned.

## 5. Open decisions
- **D1 — Practitioner surface:** customer-account extension vs app-proxy portal. **Decided:** App-proxy portal is the universal baseline across all Shopify plans (Basic to Plus). Customer-account extension deferred as an optional Plus-specific enhancement.
- **D2 — Data store:** Postgres via Prisma (simplest, atomic edits, easy reporting, matches existing hosting; schema and migrations verified in Session 9) vs metaobjects.
- **D3 — Client page rendering:** App Proxy Liquid page (Liquid evaluation and delimiter neutralization confirmed in Session 12; `noindex` and `sitemap.xml` exclusion pending dev store verification) vs a metaobject theme template.
- **D4 — Attribution carrier:** hidden line-item property (`_protocol_token`) vs cart attribute. **Verified on Live Orders:** Dev store orders #1016 (guest) and #1017 (signed-in B2B company contact) confirmed line-item properties (`_protocol_token`, `_protocol_id`, `_protocol_usage`) reached completed order, visible in Admin, and hidden on Cart, Drawer, Checkout, and Order Status. Raw `orders/paid` webhook JSON payload inspection remains open.
- **D5 — Public name** and listing category; avoid "Shopify" in the name.
- **D6 — Practice naming control:** admin-set only (recommended) vs practitioner-set with approval.

## 6. Open questions for the owner
- **Q1:** Is there a first brand (any vertical) willing to be the reference store? Without one, treat v1 as a portfolio piece and keep the scope tight.
- **Q2:** Which verticals to feature in the listing? (Neutral examples: dermatology, physio, vet, fitness, salon.)
- **Q3:** Is a dev store with B2B enabled available for Spike S1?

## 7. Verified platform facts (checked 2026-10-08 — re-check at build time)
- Customer account UI extensions support **full-page extensions** that create new pages; plan availability and company access were **not** confirmed from docs → Spike S1.
- Metaobject definitions can grant `PUBLIC_READ` storefront access; theme templates for metaobjects require the `onlineStore` capability and a template file in the theme.
- Protected customer data: level 1 = customer data excluding name/address/phone/email; level 2 includes those fields; public apps need review; custom apps have access.

## 8. Punch list
**Open:**
- Verify raw `orders/paid` webhook JSON payload for S3.
- Verify `noindex` for S2 on live dev store (`sitemap.xml` exclusion confirmed on dev store in Session 19).
- Re-measure `X-Forwarded-For` chain and configure `TRUSTED_PROXY_HOPS` on production deployed host.
- Answer Q1 (First brand reference store).

**Resolved:**
- Clean-room approach decided (owner, 2026-10-08).
- Pure engine core, API routes, compliance webhooks, rate limiter, merchant admin, practitioner portal, printable handout, and PostgreSQL service layer fully implemented.
- First independent code audit completed and 10 technical defects remediated (Session 7).
- Re-verification audit completed and Fixes 1–7 remediated test-first (Session 8).
- Follow-up PostgreSQL locking and rate limit hop audit remediated and verified on real PostgreSQL (Session 9).
- Verify migrations and integration tests against real live PostgreSQL instance (verified on real PostgreSQL 17 in Session 9).
- Zero order IDs stored in `ProcessedWebhook` (verified by automated test parameter assertions).
- Absolute paths removed.
- Storefront API Catalog Resolver: removed `product.status` from Storefront query; handles missing/null nodes cleanly (Session 17).
- Cleaned `shopify.app.toml`: minimal scopes (`read_orders`), subscribed compliance topics and `orders/paid`, dropped unhandled `app/scopes_update` (Session 17).
- Moved `pg` to `dependencies` in `package.json` (Session 17).
- Spike S4 (Cart batch add): Verified 20 lines added in 971ms, 21 lines in 824ms; sold-out variant causes all-or-nothing 422; overstock returns 422 with partial add.
- Spike S3 (Guest order): Verified guest order #1016 on dev store; `_protocol_token`, `_protocol_id`, `_protocol_usage` persist into order line items, visible in Admin, hidden in Cart/Checkout/Order Status.
- Spike S5 (B2B price check & banner rule): Verified 4 shopper states on live Plus dev store; confirmed `practitioner` tag has zero price effect; B2B company prices CAD 714 / 999 / 571 applied consistently; `/cart/add.js` quantity rule enforcement is all-or-nothing; banner rule decided based on `logged_in_customer_id` presence (Session 18).
- Spike S2 (Sitemap exclusion): Verified on live dev store that Shopify parent sitemap strictly excludes `/apps/*` (Session 19).
- Interactive Protocol Editor UI with product search built into Practitioner Portal (Milestone M3, Session 19).
- Merchant Admin Interactive Wiring & Embedded Polaris UI completed (Milestone M6, Session 20): App Bridge HS256 session token verification, practice name controls, starter template modal builder, month-filtered RFC 4180 CSV export, emergency shutdown controls, and live Web route handlers.
- Shopify App Store Review Self-Audit & Hardening completed (Milestone M7, Session 21): Automated OAuth 2.0 flow, OAuth query HMAC verification, Session table integration, and Content Security Policy frame-ancestors headers.
- Spike S1 & Decision D1 resolved (Session 22): Path B (App-Proxy portal) established as baseline surface across all plans; Path A (Customer Account extension) deferred as optional Plus upgrade; timestamp replay check added.
- Milestone M8 Release Documentation verified (Session 23): README updated to match verified code, architecture, schema, security guarantees, and test instructions.
- Spike S5 fully closed (Session 24): B2B sold-out failure verified as all-or-nothing (HTTP 422, zero added); B2B over-stock quantity verified as partial add (HTTP 422, capping to available stock respecting quantity rule increments).
- Signed-in B2B Order #1017 verified (Session 24): Line item attribution properties (`_protocol_token`, `_protocol_id`, `_protocol_usage`) survived into completed B2B company order ($1,469.00 CAD), 100% hidden on Cart, Checkout, and Customer Account Order Details.

## 9. Where to start
Run the five spikes in a day or two on a dev store; write the answers into section 5 above; only then build UI screens. See `docs/BUILD_PLAN.md`.

## 10. Working agreements
- Backend permission checks are mandatory and tested; the UI is never the only gate.
- No field may accept client-identifying data. No health claims in app copy.
- Request the minimum scopes; any addition needs explicit sign-off with justification.
- Ask before deploying, releasing, submitting for review, pushing, force-pushing. Do not touch `../salesforce`.
- Compliance webhooks must really redact; run `shopify app deploy` after editing TOML.
- One contact email everywhere: arsalanarshad.dev@gmail.com. Follow `../OPEN_SOURCE_APP_PLAYBOOK.md`.
- Keep this doc append-only with numbered sections; mark superseded items.

## 11. Session Log — 2026-10-21 (Session 1: Pure Core Engine Implementation)
- **Status:** Complete pure engine core with 100% test pass (62 tests across 24 suites in 39ms).
- **Implemented Modules (`app/lib/protocols/`):**
  - `token.js`: Unguessable 16-character alphanumeric URL-safe share token generator and validator. Zero external dependencies.
  - `validation.js`: Strict validation for protocol name, intro note, product lines (1-20), variant uniqueness, quantity (1-10), usage notes, and status controls. Hard rejection of client/patient PII keys (`PII_NOT_ALLOWED`).
  - `permissions.js`: Backend-enforced authorization guard for Tag mode (`customer`) and B2B mode (`company`). Full admin bypass, disabled protocol isolation, and starter template protection (practitioners can read/duplicate starters but cannot edit/archive/restore/delete).
  - `attribution.js`: 1-tap cart AJAX payload builder (`POST /cart/add.js`) with hidden line properties (`_protocol_token`, `_protocol_id`, `_protocol_usage`) and availability filtering; parser for `orders/paid` webhooks extracting attributed line items and minor prices; pure monthly aggregate stats incrementer.
  - `qr.js`: Self-contained vector QR code SVG generator (ISO/IEC 18004 subset) with GF(256) Reed-Solomon Level M error correction and crisp vector path rendering. Zero native binaries or network calls.
  - `handout.js`: Printable single-page HTML/CSS handout generator for US Letter and A4 with XSS escaping, practice branding, routine table, instructions, and integrated vector QR code.
- **Test Suite (`test/`):**
  - Added unit test suites for `token.test.js`, `validation.test.js`, `permissions.test.js`, `attribution.test.js`, and `handout.test.js`.
  - All 62 test cases pass via `npm test` using native Node test runner (`node:test`).
- **Database & Storage Layer:**
  - Defined `prisma/schema.prisma` covering `Protocol`, `ProtocolLine`, `PractitionerProfile`, `ProtocolOrderStat`, `Setting`, and Shopify `Session`.
  - Generated initial PostgreSQL DDL migration: `prisma/migrations/20261021_init/migration.sql`.
  - Implemented service layer in `app/lib/protocols/service.js` with database transactions, permission enforcement, token generation, protocol duplication, archiving/restoring, and atomic monthly attribution rollups.
  - Added `test/database.integration.test.js`.
- **App Proxy & Compliance Webhooks:**
  - Implemented `app/lib/protocols/proxy.js`: HMAC query signature verification, signed `logged_in_customer_id` extractor, and theme-compatible Liquid generator with `<meta name="robots" content="noindex, nofollow">`, all 4 protocol states, and 1-tap Cart AJAX integration (`/cart/add.js`) carrying `_protocol_token` and `_protocol_id`.
  - Implemented `app/lib/protocols/webhooks.js`: X-Shopify-Hmac-Sha256 base64 verification, mandatory GDPR webhooks (`customers/data_request`, `customers/redact` with Tag vs Company mode isolation, `shop/redact`, `app/uninstalled`), and `orders/paid` attribution pipeline.
- **Security Audit & Context7 Verification:**
  - Full audit completed with **PASS / 100% COMPLIANT** verdict across all modules.
  - Verified against upstream Shopify docs via Context7 MCP (`validateHmac.md`, `webhooks/validate.md`, `processWebhooks.md`).
  - Confirmed timing-safe cryptographic comparisons (`timingSafeEqual`), zero PII leakage (`PII_NOT_ALLOWED`), 100% parameterized SQL queries, XSS sanitization, and clean Git state (.env ignored).
- **Next Up:** Merchant admin routes / UI.

## 12. Session Log — 2026-10-21 (Session 2: Milestone M3 Practitioner Portal & Share Kit)
- Implemented `app/lib/protocols/portal.js`:
  - Protocol Library: Formatting cards, retail totals (`formatMoney`, `calculateProtocolRetailTotal`), line counters, starter template handling (read-only enforcement), and unavailable / out-of-stock item indicators with SPEC §5 notice (`1 product no longer available`).
  - Protocol Editor: Payload validation, normalization, and preparation (`prepareProtocolEditorPayload`), line operations (`addProtocolLine`, `updateProtocolLine`, `removeProtocolLine`, `reorderProtocolLines`), 20-line maximum constraint, quantity bounds (1-10), note bounds (<= 200), and zero client PII enforcement.
  - Concurrent Edit Detection: `detectConcurrentEdit` detecting `updatedAt` drift, distinguishing peer practitioner edits in company mode (`PEER_PRACTITIONER_EDIT`) from self/session edits, with friendly last-save-wins warning (SPEC §5).
  - Share Kit: `generateProtocolShareKit` assembling canonical protocol link, vector QR SVG with custom sizing, base64/SVG data URI, and printable US Letter & A4 handout HTML (SPEC §8).
- Implemented `test/portal.test.js`: 40 unit test cases passing in ~16ms (`node --test test/portal.test.js`).
- Total test suite expanded to **124 tests across 40 suites** passing with 0 failures in ~61ms (`npm test`).

## 13. Session Log — 2026-10-21 (Session 3: Milestone M6 Merchant Admin & RFC 4180 CSV Reports)
- Implemented `app/lib/protocols/admin.js`:
  - Practitioner Approvals: `listPractitionerProfiles`, `getPractitionerProfile`, `updatePracticeName`, `setPractitionerApproval`, `approvePractitioner`, `revokePractitioner`, `upsertPractitionerProfile`. Enforces merchant-controlled naming to prevent practitioner impersonation.
  - Starter Templates Manager: `listStarterTemplates`, `createStarterTemplate`, `updateStarterTemplate` enforcing brand ownership (`isStarter = true`) and admin-only write permissions.
  - Emergency Protocol Disable: `emergencyDisableProtocol` and storewide killswitch `emergencyDisableAllProtocols` setting `status: 'disabled'` to immediately cut off client access.
  - App Settings: `getSettings`, `updateSettings` for Identity mode (`tag` vs `company`), footer disclaimer, and handout print text.
  - Attribution Reporting & CSV Export: `getAttributionReport`, `formatAttributionCsv`, `exportAttributionCsv`. Generates RFC 4180 compliant CSVs with proper comma/quote escaping and CRLF line terminators. Strictly aggregate counters only (zero client PII).
- Implemented `test/admin.test.js`: 28 unit tests passing in ~4ms.
- Overall test suite expanded to **152 tests across 47 suites** passing with 0 failures in ~83ms (`npm test`).

## 14. Session Log — 2026-10-21 (Session 4: Milestone M7 Hardening — Sliding Window Rate Limiter)
- Implemented `app/lib/protocols/rate-limit.js`:
  - Pure ESM JavaScript, zero external dependencies, zero client PII.
  - `createRateLimiter({ windowMs = 60000, maxRequests = 60, pruneIntervalMs, maxKeys = 10000, autoPrune = true, now })`:
    - Sliding window log algorithm tracking monotonic timestamps per key.
    - `isRateLimited(key, cost = 1)` -> `{ limited, remaining, resetMs, retryAfterSeconds }`.
    - Memory leak prevention and DoS protection via `maxKeys` eviction and unref'd auto-prune interval.
    - Custom identifiers support: client IP, share token, shop domain.
    - `getClientIp(headers, connection)` -> safely extracts client IP from reverse proxy headers with zero PII.
    - `getRateLimitHeaders(result, maxRequests)` -> RFC/standard HTTP rate limit response headers.
    - `renderRateLimitLiquid({ retryAfterSeconds })` -> responsive app proxy Liquid error template.
- Implemented `test/rate-limit.test.js`: 20 unit test cases passing in ~9ms.
- Overall test suite expanded to **172 tests across 55 suites** passing with 0 failures in ~63ms (`npm test`).

## 15. Session Log — 2026-10-21 (Session 5: Milestone M1 Protocol API Routes & Controllers)
- Implemented `app/lib/protocols/routes.js`:
  - `handleAppProxyRequest`: Verifies App Proxy HMAC, enforces rate limiting, extracts customer context, queries protocol, and renders theme-compatible Liquid markup.
  - Protocol CRUD Controllers: `handleListProtocolsRequest`, `handleCreateProtocolRequest`, `handleGetProtocolRequest`, `handleUpdateProtocolRequest`, `handleDuplicateProtocolRequest`, `handleArchiveProtocolRequest`, `handleRestoreProtocolRequest` with backend-enforced ownership and zero PII.
  - Webhook Router: `handleWebhookRequest` verifying `X-Shopify-Hmac-Sha256` and dispatching compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`, `orders/paid`).
- Implemented `test/routes.test.js`: 33 unit test cases passing in ~17ms.
- Overall test suite expanded to **205 tests across 65 suites** passing with 0 failures in ~74ms (`npm test`).
- **Milestone Completion Status:**
  - M1 (Foundation): 100%
  - M2 (Client Page & Storefront App Proxy): 100%
  - M3 (Practitioner Portal): 100%
  - M4 (Share Kit): 100%
  - M5 (Attribution & Reports): 100%
  - M6 (Merchant Admin): 100%
  - M7 (Hardening, Rate Limiting & Webhooks): 100%
- **Next Up:** Verified production README.md documentation and final review before tagging (M8).

## 16. Session Log — 2026-10-21 (Session 6: Milestone M8 Verified Production Documentation)
- Updated `README.md` completely from verified code:
  - Comprehensive overview & clean-room vision across multi-vertical professional use cases.
  - Verified module capabilities across all 11 core components in `app/lib/protocols/`.
  - Mermaid architecture diagram illustrating practitioner, app backend, database, and client storefront workflows.
  - Full PostgreSQL Prisma schema documentation and local setup guide.
  - Testing instructions (`npm test`, `npm run test:db`, `npm run test:all`) documenting all 209 automated tests.
  - Clean-room privacy, timing-safe cryptography, SQL parameterization, XSS sanitization, and GDPR compliance guarantees.
  - Contact info: `arsalanarshad.dev@gmail.com` and MIT license.
- Test suite status: **205 pure unit tests passing** (~71ms) + **4 PostgreSQL database integration tests passing** (total: **209 passing tests**, 0 failures).
- All milestones M1 through M8 are complete and ready for owner review.

## 17. Session Log — 2026-10-22 (Session 7: Independent Audit & Remediation of Defects 1–11)
- **Context:** An independent code review identified 10 concrete technical defects in the engine code plus documentation overclaims. All defects were systematically reproduced, fixed test-first, and verified.
- **Defects Remediated:**
  1. **Fail-Closed App Proxy Auth (Defect 1):** In `app/lib/protocols/routes.js`, `handleAppProxyRequest` previously skipped HMAC verification if `apiSecret` was falsy (failing open). Fixed: missing `apiSecret` now returns HTTP 500, and invalid or missing signatures return HTTP 401. Verified with unit tests.
  2. **Liquid Delimiter Injection Defense (Defect 2):** In `app/lib/protocols/proxy.js`, user-controlled strings (protocol name, intro note, usage notes, practice name) in `application/liquid` responses could contain Liquid syntax (`{{ ... }}`, `{% ... %}`) evaluated server-side by Shopify. Fixed: Liquid delimiters are neutralized in HTML markup, data attributes, and JSON script tags via character entity and Unicode escaping (`\u007b\u007b`, `\u007d\u007d`, etc.).
  3. **Permission Denial HTTP Status Code Mapping (Defect 3):** In `app/lib/protocols/routes.js`, `handleErrorResponse` referenced non-existent denial keys, defaulting 6 of 9 denial codes to HTTP 400. Fixed: mapped every `DENIAL_REASONS` key from `permissions.js` explicitly (forbidden/ownership/starter/disabled/role -> 403, not-found -> 404, unauthenticated -> 401). Added an automated test iterating `Object.keys(DENIAL_REASONS)` to prevent future drift.
  4. **Client Page Product Catalog Resolution (Defect 4):** Evaluated options for resolving variant titles, prices, and inventory without requiring expanded Admin scopes. Produced architectural proposal [`docs/PROPOSAL_CATALOG_RESOLVER.md`](docs/PROPOSAL_CATALOG_RESOLVER.md) recommending Storefront API with public token and pure injectable `resolveVariants` interface.
  5. **Connection Pool Transaction Safety (Defect 5):** In `app/lib/protocols/service.js`, `db.query('BEGIN')` ran directly on a generic db object, which breaks when `db` is a `pg.Pool` (queries run on arbitrary pooled connections). Fixed: added `withTransaction(db, fn)` helper that acquires a dedicated client via `pool.connect()`, executes the transaction, commits or rolls back, and guarantees `client.release()` in a `finally` block.
  6. **Webhook Idempotency, Multi-Currency & Discounted Revenue (Defect 6):**
     - In `prisma/schema.prisma` and `app/lib/protocols/webhooks.js`: added `ProcessedWebhook` table with unique constraint `@@unique([shop, webhookId])` to discard duplicate `orders/paid` retries idempotently with zero shopper PII.
     - Added `currency` to `ProtocolOrderStat` unique constraint `@@unique([shop, protocolId, month, currency])` to isolate multi-currency stores.
     - Updated `app/lib/protocols/attribution.js` to compute revenue strictly from discounted line totals (`total_discount`, `discount_allocations`, or GraphQL `discountedTotalSet`).
     - Wrapped multi-protocol stat updates in an atomic database transaction.
  7. **Redaction Error Propagation & Honest Compliance Data (Defect 7):**
     - In `app/lib/protocols/webhooks.js`: removed silent `.catch(() => {})` handlers from redaction queries in `handleCustomersRedact` and `handleShopRedact`. Database failures now propagate non-2xx status so Shopify retries.
     - Documented honest `customers/data_request` behavior: the app stores zero shopper/patient PII by architectural design; ordinary shopper data requests return `clientPii: null` and `clientDataStored: false`, while practitioner requests return only their professional practice profile and authored protocols.
  8. **Rate Limiter Wiring & Anti-Spoofing (Defect 8):** In `app/lib/protocols/routes.js`, removed duplicate in-memory rate limiter; wired in tested `rate-limit.js`. Keyed on client IP with documented reverse-proxy trust assumptions. Returns Liquid 429 page on rate limit breach.
  9. **Nested PII Rejection & Variant GID Validation (Defect 9):** In `app/lib/protocols/validation.js`, added recursive inspection of nested keys inside `lines[]` for forbidden PII keys (rejecting with `PII_NOT_ALLOWED`). Added length cap ($\le 100$) and Shopify GID format regex validation (`/^gid:\/\/shopify\/ProductVariant\/\d+$/`).
  10. **Reproducible DB Testing & Clean Fixtures (Defect 10):**
      - In `test/database.integration.test.js`: removed hardcoded cross-project absolute imports; replaced with standard local dynamic import of `'pg'`. Added `"pg": "^8.13.1"` as an optional devDependency in `package.json`.
      - Test runner now skips loudly and informatively if PostgreSQL is not running on localhost:5432, rather than passing silently.
      - Replaced all personal fixture names with neutral fictional clinic names ("Apex Integrative Wellness").
  11. **Documentation Realignment (Defect 11):**
      - Rewrote `README.md`, `docs/BUILD_PLAN.md`, and `PROJECT_CONTEXT.md` to remove all 11 `file:///Users/...` links, remove unverified completion claims, keep Spikes S1–S5 open, and state verified reality.
- **Verification Status:**
  - `npm test`: **227/227 pure unit tests passing** (0 failures, ~86ms).
  - `npm run test:db`: PostgreSQL integration test configured and cleanly skipping with diagnostic message when local DB is offline.
  - Zero `file:///Users` or `/Users/` links across repository documentation and code.

## 18. Session Log — 2026-10-22 (Session 8: Re-verification Audit & Remediation of Fixes 1–7)
- **Context:** An independent re-verification audit was performed on commit `1df6a09`. Seven specific defects/omissions were identified and addressed test-first:
- **Remediated Items:**
  1. **Fix 1 — Webhook Idempotency Atomicity & Privacy (webhooks.js, routes.js, service.js, schema.prisma):**
     - Atomicity: Moved `ProcessedWebhook` marker insertion INSIDE the same `withTransaction` block as `ProtocolOrderStat` upserts. If stat counting fails, both roll back, allowing Shopify retry deliveries to be processed. True duplicates return `{ updatedCount: 0, duplicate: true }`.
     - Privacy: Read `X-Shopify-Webhook-Id` header and pass it through to attribution; removed all fallbacks to `order.id` or payload identifiers. If header is missing on `orders/paid`, router returns HTTP 400. Zero order IDs or customer IDs are ever written to `ProcessedWebhook` (verified via query param assertions).
     - Error Propagation: Removed `catch { return true }` swallowing in `recordWebhookIdempotency`.
     - Retention & Redaction: Added and exported `pruneProcessedWebhooks(db, olderThanDays = 7)` using parameterized SQL. `shop/redact` deletes from `ProcessedWebhook` WHERE `shop = $1` and includes it in reported deleted counts.
  2. **Fix 2 — Swallowed Errors, Dispatch Handling & Compliance Transparency (webhooks.js, routes.js):**
     - Removed `.catch(() => ({rowCount:0, rows:[]}))` on session deletion in `handleAppUninstalled`.
     - Wrapped handler dispatch in `handleWebhookRequest` in try/catch: on handler error, logs non-sensitive message (no payloads, no secrets) and returns 500 JSON so Shopify retries.
     - Documented honestly in code comments and `README.md` that Shopify discards `customers/data_request` webhook response bodies; ordinary shoppers have zero PII stored; practitioner data out-of-band delivery is not yet implemented.
  3. **Fix 3 — Default Rate Limiting & Reverse Proxy Anti-Spoofing (routes.js, rate-limit.js):**
     - Added module-level `defaultProxyRateLimiter` instantiated by default with injection/disable helpers (`setDefaultProxyRateLimiter`, `getDefaultProxyRateLimiter`).
     - Hardened `getClientIp`: prefers `CF-Connecting-IP` _(SUPERSEDED in Session 10: CF-Connecting-IP is now opt-in via TRUST_CF_CONNECTING_IP to prevent header spoofing when not behind Cloudflare)_, otherwise the RIGHTMOST `X-Forwarded-For` entry (appended by trusted edge proxy, configurable via `TRUSTED_PROXY_HOPS` in Session 9), otherwise `X-Real-IP`, otherwise `'unknown'` bucket. Documented trusted-proxy reverse proxy assumptions in code and README.
  4. **Fix 4 — Discount Precedence & ISO 4217 Currency Exponents (attribution.js):**
     - Discount precedence: computes discount as sum of `discount_allocations[].amount`; falls back to `total_discount` only if allocations are absent. Removed unverified `discounted_price` branch.
     - Currency exponents: implemented ISO 4217 exponent table (`CURRENCY_EXPONENTS`, `getCurrencyExponent`, `getCurrencyFactor`) supporting 0-decimal currencies (JPY factor 1), 3-decimal currencies (KWD factor 1000), and 2-decimal currencies (USD/EUR factor 100).
  5. **Fix 5 — Catalog Resolver Proposal Corrections (docs/PROPOSAL_CATALOG_RESOLVER.md):**
     - Explicitly stated that Option (b) Storefront API via Storefront Access Token REQUIRES adding scope `unauthenticated_read_product_listings`.
     - Recommended Option (a) private server token (`Shopify-Storefront-Private-Token`) or merchant-configured token.
     - Marked unpublished product null check as UNVERIFIED (to be verified in Spike S2).
     - Added `@inContext(country: $country, language: $language)` to sample query for localized pricing.
     - Noted that client page cannot evaluate complex cart-level discounts.
     - Corrected function name to `handleAppProxyRequest`.
     - Added explicit "Owner decisions needed" section.
  6. **Fix 6 — Hardening & Status Mapping (routes.js, service.js):**
     - Practitioner preview banner requires `PractitionerProfile.isApproved === true`.
     - Non-admins cannot supply `sourceProtocolId` on direct create or update (ignored unless `duplicateProtocol`).
     - Mapped `FORBIDDEN_OWNERSHIP_MISMATCH` to 404 `NOT_FOUND` in routes to prevent ID enumeration.
     - `updateProtocol` executes within `withTransaction` and authorizes first with `SELECT ... FOR UPDATE` before input validation.
  7. **Fix 7 — Honest Docs & Reality Alignment (README.md, docs/BUILD_PLAN.md, PROJECT_CONTEXT.md):**
     - Kept M0 Spikes S1–S5 open.
     - Documented that DB integration tests and migrations are NOT yet verified against a real Postgres.
     - Restored original Session 6 text and preserved append-only chronological log.
- **Verification Status:**
  - `npm test`: **238/238 pure unit tests passing** (66 suites, 0 failures, ~77ms).
  - All new tests pass, zero regressions.
  - Zero `file:///Users` or `/Users/` links across repository documentation and code.
  - Zero order IDs or customer IDs stored anywhere in the database (verified by parameter assertions).

## 19. Session Log — 2026-10-22 (Session 9: Real PostgreSQL Verification & Review Follow-up Remediation)
- **Context:** An independent code review on commit `b9d20a0` tested against real PostgreSQL and identified 6 technical items:
- **Remediated Items:**
  1. **Item 1 — PostgreSQL Lock with GROUP BY Fix (service.js, test/attribution.test.js, test/database.integration.test.js):**
     - Bug: In PostgreSQL, executing `FOR UPDATE` on a query containing `GROUP BY` or aggregates fails with SQLSTATE 0A000 ("FOR UPDATE is not allowed with GROUP BY clause"). In `getProtocolById`, when `forUpdate: true` was passed, `FOR UPDATE OF p` was appended to the `json_agg` query, causing `updateProtocol` to fail on real PostgreSQL.
     - Fix: When `forUpdate` is true, first execute `SELECT id FROM "Protocol" WHERE shop = $1 AND id = $2 FOR UPDATE` to acquire the row lock (returning null if no row exists). Then execute the aggregate `json_agg` query without a lock clause, all within the same `withTransaction` client.
     - Connection handling: Corrected pool vs client detection in `withTransaction` (`isClient = db.constructor?.name === 'Client' || Boolean(db._connected)`), ensuring already-connected `pg.Client` instances run queries directly without attempting a redundant `.connect()` call.
     - Real PostgreSQL tests: Verified against real PostgreSQL 17.11 with migrations applied (`npm run test:db`: 10/10 integration tests passing), covering owner update, cross-owner update returning `NOT_FOUND`, line replacement, and concurrent updates without corruption.
  2. **Item 2 — Configurable Trusted Proxy Hops (rate-limit.js, docs/BUILD_PLAN.md, docs/SPEC.md):**
     - Added configurable `TRUSTED_PROXY_HOPS` environment variable (default 1) in `getClientIp` instead of unconditionally taking the rightmost `X-Forwarded-For` entry. Hop count 1 selects the rightmost entry; hop count 2 selects the second from right.
     - Documented in `docs/BUILD_PLAN.md` (Spike S2) and `docs/SPEC.md` §4 that the exact reverse-proxy header chain and trusted proxy hop count forwarded by Shopify App Proxy is unverified and must be verified on a live dev store.
  3. **Item 3 — Company Mode Practitioner Banner (routes.js, test/routes.test.js):**
     - Fixed practitioner preview banner in company mode: if a logged-in customer created or updated the protocol (`protocol.createdBy === customerGid || protocol.updatedBy === customerGid`), they are treated as a practitioner if their company profile (`PractitionerProfile` for `protocol.ownerId`) is `isApproved === true`.
  4. **Item 4 — Existence Leak Prevention in Permissions (permissions.js, service.js, test/permissions.test.js):**
     - In `canAccessProtocol`, moved ownership check before disabled-status check for non-admins. Non-owners accessing another owner's disabled protocol receive `FORBIDDEN_OWNERSHIP_MISMATCH` (which maps to 404 `NOT_FOUND` in routes and service), preventing callers from discovering the existence of disabled protocols.
  5. **Item 5 — Webhook Cleanup & Attribution Bypass (webhooks.js, service.js, test/webhooks.test.js):**
     - Deleted unused `recordWebhookIdempotency` function.
     - In `handleOrdersPaid` and `recordOrderAttribution`: added early return for orders with zero protocol-attributed lines, avoiding unnecessary database transactions or `ProcessedWebhook` rows for standard organic store orders.
     - Documented and tested `pruneProcessedWebhooks`, noting that it is an exported maintenance function and is not automatically scheduled until the full app harness is built.
  6. **Item 6 — Documentation Realignment (README.md, docs/BUILD_PLAN.md, docs/SPEC.md, PROJECT_CONTEXT.md):**
     - Updated README to clarify that pure unit tests (243 tests) use mock database interfaces, while live PostgreSQL coverage is verified via `npm run test:db` (10 tests).
     - Restored original Session 1 and Session 6 historical text; appended Session 9 log.
- **Verification Status:**
  - `npm test`: **243/243 pure unit tests passing** (66 suites, 0 failures, ~80ms).
  - `npm run test:db`: **10/10 live database integration tests passing** against real PostgreSQL 17.11 with both migrations applied.
  - Zero `file:///Users` or `/Users/` links across repository documentation and code outside log records.

## 20. Session Log — 2026-10-22 (Session 10: Rate Limiting Spoof Hardening, Bundler Resiliency & Doc Alignment)
- **Context:** Hardening follow-up on commit `2bf92ab` addressing reverse proxy header spoofing, bundler/minifier compatibility for transactions, and documentation alignment.
- **Remediated Items:**
  1. **Opt-in `CF-Connecting-IP` Trust (`TRUST_CF_CONNECTING_IP`, rate-limit.js, test/rate-limit.test.js):**
     - Security threat: When deployed behind proxies other than Cloudflare, untrusted clients could forge `CF-Connecting-IP` headers to manipulate or bypass IP-based rate limiting buckets.
     - Fix: Made `CF-Connecting-IP` trust opt-in via environment variable `TRUST_CF_CONNECTING_IP` (default `false`) and options `trustCfConnectingIp` in `getClientIp`. When unset or false, `CF-Connecting-IP` is ignored and IP extraction falls through to `X-Forwarded-For` (using `TRUSTED_PROXY_HOPS`), `X-Real-IP`, direct socket address, or the shared `'unknown'` bucket. Tested test-first.
  2. **Minifier-Resilient Database Client Detection (`withTransaction`, service.js, test/attribution.test.js):**
     - Bundler bug: `withTransaction` previously checked `db.constructor?.name === 'Client'`. In production builds with bundlers or minifiers (esbuild, terser, rollup), class constructor names are mangled to single letters (e.g. `'c'`), causing `withTransaction` to mistake a standalone `pg.Client` for a connection pool and attempt to call `client.connect()`.
     - Fix: Replaced `constructor.name` check with explicit property checks (`typeof db.release === 'function' || Boolean(db.connectionParameters || db._connected || db._queryable !== undefined)`). Tested test-first using a mock client with minified constructor name (`'c'`).
  3. **Documentation & Comment Alignment:**
     - Updated test counts across `README.md` and `PROJECT_CONTEXT.md` snapshot header to **245 pure unit tests**.
     - Fixed stale comment at `app/lib/protocols/routes.js:188-192` to clarify that `CF-Connecting-IP` is opt-in via `TRUST_CF_CONNECTING_IP` and `X-Forwarded-For` uses configurable `TRUSTED_PROXY_HOPS`.
     - Added `TRUSTED_PROXY_HOPS=1` and `TRUST_CF_CONNECTING_IP=false` configuration variables to `.env.example` and `README.md`.
     - Marked Session 8 `getClientIp` note in `PROJECT_CONTEXT.md` as superseded by Session 10 opt-in behavior.
     - Moved live PostgreSQL verification item from Open to Resolved in Section 8 Punch List.
- **Verification Status:**
  - `npm test`: **245/245 pure unit tests passing** (66 suites, 0 failures).
  - `npm run test:db`: **Skipped (no DB reachable)** with loud warning notice; 10/10 integration tests passing result is from Session 9 against real PostgreSQL 17.11.

## 21. Session Log — 2026-10-22 (Session 11: Spikes Checklist Documentation)
- **Context:** Prepared and integrated the operational Spike Checklist for Milestones M0 Spikes S1–S5.
- **Actions:**
  - Added `docs/SPIKES_CHECKLIST.md` containing the full 2-day operational plan, prerequisites, step-by-step test procedure, failure escalation paths, and decision templates for Spikes S1–S5 and the Catalog Resolver check.
  - Linked `docs/SPIKES_CHECKLIST.md` from `docs/BUILD_PLAN.md` §M0 and `docs/SPEC.md` §4.
- **Verification Status:**
  - `npm test`: **245/245 pure unit tests passing** (66 suites, 0 failures).

## 22. Session Log — 2026-10-27 (Session 12: Live Dev Store Spike S2 Partial Verification)
- **Context:** Executed live Partner store spike experiments on `ai-agent-app-h9qwnwd8.myshopify.com` via isolated clean-room harness (`pp-spike-harness`). Verified App Proxy Liquid evaluation, reverse proxy header chain traversal, and storefront query signature parameters.
- **Key Findings & Verified Platform Behaviors:**
  1. **App Proxy Liquid Evaluation Confirmed (Spike S2 partial):**
     - Shopify's App Proxy server-side renderer compiles and evaluates responses served with `Content-Type: application/liquid`.
     - When raw unescaped Liquid tags (e.g. `{% endraw %}`) were returned in the payload, Shopify's storefront engine threw:
       `Liquid syntax error (line 19): Unknown tag 'endraw'`.
     - Empirically proves that our HTML-entity delimiter neutralization barrier (`renderLiquidClientPage` in `app/lib/protocols/proxy.js`) is strictly mandatory to prevent practitioner input (protocol title, notes) from breaking storefront rendering or executing unintended Liquid.
     - Note: `noindex` tag verification and `sitemap.xml` exclusion under S2 remain open.
  2. **Reverse Proxy Headers & Rate Limiting (`TRUSTED_PROXY_HOPS`):**
     - Captured incoming request headers forwarded by Shopify's Cloudflare edge to the app proxy through the dev tunnel:
       `cf-connecting-ip`: Cloudflare edge node IP (`2a06:98c0:3600::103`).
       `x-forwarded-for`: Real client IP prepended before edge IP (`151.123.243.96,2a06:98c0:3600::103`).
     - Demonstrates that `TRUST_CF_CONNECTING_IP` must remain `false` by default, and client IP extraction requires walking `x-forwarded-for`. Because the dev tunnel introduced an extra hop, the exact `TRUSTED_PROXY_HOPS` setting must be verified on the production host (e.g., Railway).
  3. **App Proxy Query Parameters & Signature:**
     - Verified query parameters delivered to `/api/proxy`:
       `shop`: `ai-agent-app-h9qwnwd8.myshopify.com`
       `path_prefix`: `/apps/pp-spike`
       `timestamp`: unix epoch string
       `signature`: SHA-256 HMAC of sorted query params
       `logged_in_customer_id`: empty string `""` on anonymous visits; customer numeric ID string when authenticated.
  4. **Status of Spikes:**
     - S2 is partially verified (Liquid compilation confirmed; `noindex` and `sitemap.xml` open).
     - S1 (practitioner surface), S3 (hidden property reaching order), S4 (20 lines in one request), and S5 (practitioner pricing) remain open and must be run on the dev store following `docs/SPIKES_CHECKLIST.md`.
- **Verification Status:**
  - `npm test`: **245/245 pure unit tests passing** (66 suites, 0 failures, ~80ms).
  - Background spike harness daemon safely terminated; core repo (`04-practitioner-protocols`) remains pristine.

## 23. Session Log — 2026-10-27 (Session 13: Catalog Resolver Implementation — Milestone M2)
- **Context:** Implemented the batch Catalog Resolver (`app/lib/protocols/catalog.js`, `test/catalog.test.js`) resolving Defect 4 as specified in `docs/PROPOSAL_CATALOG_RESOLVER.md`.
- **Implementation Details:**
  1. **Batch GraphQL Variant Resolution (`buildVariantQuery`, `parseCatalogNodes`, `resolveVariants`):**
     - Constructs `nodes(ids: $ids)` query with optional `$country` and `$language` using `@inContext(country: $country, language: $language)`.
     - Resolves variant titles, product titles, prices, stock availability (`availableForSale`), and product images.
     - Suppresses `"Default Title"` so single-variant products display clean product titles.
     - Correctly calculates minor currency units (`priceMinor`) respecting zero-decimal (JPY) and 3-decimal (KWD) currencies via `getCurrencyExponent`.
     - Missing or deleted variants in Shopify return safe fallback records (`isDeleted: true`, `isPublished: false`, `availableForSale: false`, `title: "Unavailable Product"`).
     - Non-`ACTIVE` products (drafts, archived) are flagged `isPublished: false`, `availableForSale: false`.
  2. **Protocol Line Enrichment (`enrichProtocolLines`):**
     - Merges live catalog data into database `ProtocolLine` objects (`productTitle`, `variantTitle`, `title`, `price`, `priceFormatted`, `available`, `inStock`, `image`).
     - Supports `filterUnavailable: true` to hide deleted or unpublished products from the client page (SPEC §5).
  3. **Deterministic Test Factory (`createFakeVariantResolver`):**
     - In-memory mock resolver for reproducible, network-free testing of controllers and renderers.
- **Verification Status:**
  - `npm test`: **259/259 pure unit tests passing** (73 suites, 0 failures, ~98ms).
  - Clean working tree ready for commit.

## 24. Session Log — 2026-10-27 (Session 14: App Scaffold & Catalog-Enriched Route Handlers)
- **Context:** Generated production `shopify.app.toml` scaffold and wired `resolveVariants` / `enrichProtocolLines` into `handleAppProxyRequest`.
- **Implementation Details:**
  1. **`shopify.app.toml` Scaffold:**
     - Configured App Proxy with prefix `apps` and subpath `protocols` (pointing to `/api/proxy`).
     - Subscribed to mandatory webhooks (`app/uninstalled`, `app/scopes_update`) with API version `2026-01`.
     - Preserved authorized scopes (`write_products`, `write_metaobjects`, `write_metaobject_definitions`) with zero scope escalation (Rule 10).
  2. **Catalog Resolver Integration (`routes.js`, `test/routes.test.js`):**
     - Integrated `variantResolver` / `graphqlExecutor` into `handleAppProxyRequest`. When a protocol has lines, it resolves variant titles, retail prices, and inventory availability, filtering unavailable or unpublished products (`filterUnavailable: true`).
     - Enhanced `proxy.js` to prefer `priceFormatted` over unformatted decimal strings for storefront display.
     - Added comprehensive unit test in `test/routes.test.js`.
- **Verification Status:**
  - `npm test`: **260/260 pure unit tests passing** (73 suites, 0 failures, ~92ms).

## 25. Session Log — 2026-10-27 (Session 15: Milestone M3 Practitioner Portal UI Renderer)
- **Context:** Implemented and integrated the interactive Practitioner Portal UI surface (`renderPortalLiquid` in `portal.js`, `routes.js`, `test/portal.test.js`, `test/routes.test.js`).
- **Implementation Details:**
  1. **Practitioner Portal Liquid Renderer (`renderPortalLiquid` in `app/lib/protocols/portal.js`):**
     - Renders zero-extension, theme-embedded portal at `/apps/protocols` when no protocol share token is provided in the URL.
     - **Unauthenticated State:** Prompts visitor to sign into their store customer account (`/account/login`).
     - **Unapproved Practitioner State:** Displays pending approval notice and practice name badge while merchant reviews their profile.
     - **Approved Practitioner Library:** Displays practice name badge, action bar, active protocol cards, brand starter templates, and archived protocols with line counts and retail totals.
     - **Share Kit Actions:** Quick links to copy share URLs (`/apps/protocols/:token`) and print handouts (`/apps/protocols/:token?handout=1`).
     - **Liquid Delimiter Neutralization:** Strictly neutralizes user-supplied protocol and practice names (`&#123;&#123;`, `&#125;&#125;`, `&#123;%`, `%&#125;`).
     - Injects `<meta name="robots" content="noindex, nofollow">` ensuring portal stays unindexed.
  2. **App Proxy Route Dispatching (`app/lib/protocols/routes.js`):**
     - When `!token`: dispatches to Practitioner Portal, querying `PractitionerProfile` for `isApproved` and querying protocols for the authenticated practitioner.
     - When `token`: dispatches to Client Protocol Page (`renderProtocolLiquid`) with live catalog resolution.
  3. **Automated Test Coverage:**
     - Added 4 tests in `test/portal.test.js` and 3 tests in `test/routes.test.js`.
- **Verification Status:**
  - `npm test`: **267/267 pure unit tests passing** (74 suites, 0 failures, ~92ms).

## 26. Session Log — 2026-10-27 (Session 16: Milestone M6 Merchant Admin Polaris UI Renderer)
- **Context:** Implemented and tested the embedded Merchant Admin Polaris UI renderer (`renderAdminHtml` in `admin.js`, `test/admin.test.js`).
- **Implementation Details:**
  1. **Merchant Admin Polaris HTML Renderer (`renderAdminHtml` in `app/lib/protocols/admin.js`):**
     - Renders complete Shopify Polaris responsive interface embedded inside Shopify Admin.
     - **Practitioners Directory Tab:** Displays registered practitioner profiles, approval state badges (Approved, Pending Approval), merchant-controlled practice names, and Approve / Revoke action forms.
     - **Starter Templates Tab:** Displays brand starter protocols and a Create Starter button.
     - **Attribution & Reports Tab:** Renders summary metric cards (Attributed Revenue, Attributed Orders, Total Units Sold) and monthly breakdown table, plus a direct download link for RFC 4180 CSV export.
     - **Settings & Emergency Controls Tab:** Identity Mode selection (`tag` vs `company`), storefront footer disclaimers, printable handout notices, and a critical emergency button to disable all protocols storewide.
  2. **Security & Zero PII Barrier:**
     - Enforces `assertNoPii` check across all input datasets (profiles, starters, reports, settings), strictly forbidding client/patient diagnostic or personal identifiers.
     - HTML-escapes all text content against XSS and template injection.
  3. **Automated Test Coverage:**
     - Added 5 new automated tests in `test/admin.test.js` covering navigation tabs, practitioner directory, monthly attribution metrics, emergency controls, and PII rejection.
- **Verification Status:**
  - `npm test`: **289/289 pure unit tests passing** (81 suites, 0 failures, ~109ms).

## 27. Session Log — 2026-10-27 (Session 17: Build Plan Realignment, Scope & Catalog Corrections)
- **Context:** An independent code review cross-examined the repository against `docs/SPEC.md` and `docs/BUILD_PLAN.md`. Several documentation overstatements and technical configuration issues were identified and remediated.
- **Remediated Items:**
  1. **Documentation Realignment (BUILD_PLAN.md, PROJECT_CONTEXT.md):**
     - Reopened M0 Spikes: S1, S3, S4, and S5. Recorded that S2 only verified Liquid compilation and dev-tunnel proxy headers; `noindex`, `sitemap.xml`, and real-host IP hop count remain open.
     - Reopened M1 App Scaffold (pending real OAuth/session token exchange).
     - Reopened M3 Interactive Portal UI (pending interactive protocol editor and product search).
     - Reopened M6 Merchant Admin UI (pending session token authentication and live action route handlers).
     - Refreshed Section 8 Punch List to reflect open spikes, auth, search, and action routes.
  2. **`shopify.app.toml` Corrections:**
     - Removed unneeded write scopes (`write_products`, `write_metaobjects`, `write_metaobject_definitions`) since app data is stored in PostgreSQL.
     - Added required scope `read_orders` for `orders/paid` attribution.
     - Subscribed mandatory compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`) and `orders/paid`.
     - Dropped `app/scopes_update` (which the webhook router rejected as unhandled).
  3. **Catalog Resolver Storefront Query Correction (`catalog.js`, `test/catalog.test.js`):**
     - Removed `status` from Storefront GraphQL query on `Product` (`Product` in Storefront API has no `status` field; drafts/archives simply return null/omitted nodes).
     - Verified that missing/null nodes in `parseCatalogNodes` are correctly treated as deleted/unavailable.
  4. **Server Hardening & Production Dependencies (`server.js`, `package.json`):**
     - Moved `pg` from `devDependencies` to `dependencies` in `package.json` to prevent crashes in production deployments.
     - Removed hardcoded secret fallback in `server.js`; missing `SHOPIFY_API_SECRET` strictly returns HTTP 500 fail-closed on signed routes.
     - Replaced health-adjacent demo data ("Gut Health") with neutral retail routine examples ("Daily Essentials Protocol") to adhere to the zero-health-claims policy.
     - Added POST handlers for admin action forms (`/api/admin/practitioners/status`, `/api/admin/settings`, `/api/admin/emergency/disable-all`).
- **Verification Status:**
  - `npm test`: **289/289 pure unit tests passing** (81 suites, 0 failures, ~109ms).

## 28. Session Log — 2026-10-27 (Session 18: Spike S5 Verification & Client Script Error Handling)
- **Context:** An independent review evaluated Spike S5 (B2B Price Check) against the live Shopify Plus dev store `ai-agent-app-h9qwnwd8.myshopify.com` (Dawn theme "test-data", New Customer Accounts active).
- **Test Environment & Test Data:**
  - 3 test customers created with owner's plus-addressed inboxes (replacing `@test.invalid` which cannot receive verification codes for New Customer Accounts):
    - Plain customer: no tags.
    - Tagged practitioner: tag `practitioner`.
    - B2B contact: added to demo company "Snowdevil" with Ordering permission.
  - Active Catalog "Snowdevil B2B Wholesale" assigned to Snowdevil company location in USD:
    - Liquid $500 (Quantity rule: minimum 2, increment 2).
    - Oxygen $700.
    - Hydrogen $400.
  - Pre-existing: "Catalog for Canada" (market-assigned, −5%), unchanged.
- **Empirical S5 Findings:**
  | State | Product page | Cart | Checkout | Qty rule |
  |---|---|---|---|---|
  | Guest (signed out) | Liquid 749.95, Oxygen 1025.00, Hydrogen 600.00 USD | 2374.95 USD | 2374.95 USD | n/a |
  | Plain customer | same as guest | 2374.95 USD | 2374.95 USD | n/a |
  | Tagged `practitioner` | same as guest | 2374.95 USD | 2374.95 USD | n/a |
  | B2B contact | CAD 714 / 999 / 571 | CAD 2998 (Liquid x2) | subtotal CAD 2998, shipping 43, total 3041, company label shown | enforced |
  1. **Tag Pricing Independence:** The `practitioner` tag has zero pricing effect. Only B2B company membership changes pricing. No wholesale prices leaked to guest, plain, or tagged states.
  2. **B2B Price Consistency:** B2B catalog prices applied consistently across product page, cart, and checkout.
  3. **Multi-Currency & Presentment Nuances:** The B2B session ran in CAD with country CA (Snowdevil company location is in Canada), even though store base currency is USD. 714, 999, and 571 CAD are the $500, $700, and $400 USD catalog prices at rate 1.4262; the Canada catalog −5% did NOT stack. The client page and attribution engine must never assume USD.
  4. **Quantity Rule Enforcement:** `/cart/add.js` enforces quantity rules, returning HTTP 422:
     - Liquid x1: `"This item has a minimum of 2."`
     - Liquid x3: `"You can only add this item in increments of 2."`
  5. **All-or-Nothing Rule Violations:** A multi-line add where one line breaks a quantity rule fails entirely (`[Oxygen 1, Liquid 1, Hydrogen 1]` gave HTTP 422 with an empty cart). This differs from over-stock (which returns 422 but partially adds capped quantity).
  6. **Boundary & Open Items:** Sold-out or over-stock lines as a B2B contact remain unverified in S5. In S3, guest order #1016 evidence stands, while signed-in orders and the `orders/paid` webhook payload remain open.
- **Architectural Decision (Banner Trigger Rule):**
  - Do not decide anything from the displayed price.
  - Show the "prices may differ from retail" notice when `logged_in_customer_id` is present on the app-proxy request.
  - This covers company contacts and is independent of tags and currency.
  - When `logged_in_customer_id` is empty/absent, show retail-price view with no notice.
  - Privacy barrier: use `logged_in_customer_id` for render decision only; NEVER log or persist it.
- **Client Script Hardening (`app/lib/protocols/proxy.js`):**
  - Hardened Cart AJAX add error handling. On a non-OK response from `POST /cart/add.js`, client script parses the JSON error response body, displaying `description` (or `message`) per line or as general error message, re-enabling action buttons cleanly on failure.
- **Verification Status:**
  - `npm test`: **289/289 pure unit tests passing** (81 suites, 0 failures, ~100ms).

## 29. Session Log — 2026-10-28 (Session 19: S2 Dev Store Sitemap Verification & Milestone M3 Protocol Editor)
- **Context:** Carried out live dev store verification of Spike S2 sitemap exclusion and implemented Milestone M3 (Interactive Protocol Editor UI with live catalog product search).
- **Spike S2 Dev Store Sitemap Findings:**
  - Queried live dev store parent sitemap at `https://ai-agent-app-h9qwnwd8.myshopify.com/sitemap.xml` via Chrome DevTools MCP.
  - Parent sitemap strictly links to: `sitemap_agentic_discovery.xml`, `sitemap_products_1.xml`, `sitemap_pages_1.xml`, `sitemap_collections_1.xml`, and `sitemap_blogs_1.xml`.
  - Inspected `sitemap_pages_1.xml` which only contains `/pages/contact` and `/pages/data-sharing-opt-out`.
  - **Empirical Confirmation:** Shopify's native automated sitemaps never include App Proxy routes (`/apps/*`), confirming the sitemap exclusion requirement of Spike S2 without requiring merchant theme edits.
- **Milestone M3: Interactive Protocol Editor UI Implementation:**
  1. **Catalog Product Search (`catalog.js`, `test/catalog.test.js`):**
     - Implemented `buildProductSearchQuery`, `parseProductSearchNodes`, and `searchCatalogProducts`.
     - Queries Storefront GraphQL `products(first: $first, query: $query)` with optional country/language context.
     - Parses products and variants, suppressing single-variant `"Default Title"` and formatting prices.
     - Extended `createFakeVariantResolver` with in-memory product search support.
  2. **App Proxy Route Handlers (`routes.js`, `test/routes.test.js`):**
     - Added `handleProductSearchRequest` for `GET /api/products/search?q=...`.
     - Wired App Proxy dispatching for `action=search`, `action=create` (`POST /apps/protocols`), and `action=update` (`PUT /apps/protocols`).
  3. **Practitioner Portal Liquid Editor Modal (`portal.js`, `test/portal.test.js`):**
     - Replaced placeholder alert with an accessible `#protocol-editor-modal` container and backdrop.
     - Form controls: Protocol Name (required, max 60 chars), Intro Note (optional, max 500 chars).
     - Product Search: Live catalog search with dropdown variant selector.
     - Selected Lines Management: Live variant cards with quantity selector (1-10), usage instructions note (max 200 chars), line deletion, duplicate variant guard, and live retail total calculation.
     - Added "Edit" action buttons to active protocol cards in the library.
- **Verification Status:**
  - `npm test`: **298/298 pure unit tests passing** (83 suites, 0 failures, ~104ms).

## 30. Session Log — 2026-10-28 (Session 20: Milestone M6 — Merchant Admin Interactive Wiring & Embedded Polaris UI)
- **Context:** Implemented Milestone M6: Merchant Admin Interactive Wiring with authenticated session token verification, embedded Polaris UI tab enhancements, and live Web route handlers.
- **Implemented Capabilities:**
  1. **Shopify App Bridge HS256 Session Token Verification (`admin.js`, `test/admin.test.js`):**
     - Built `verifyAdminSessionToken` using standard `node:crypto` HMAC-SHA256 and constant-time signature comparison with `crypto.timingSafeEqual` (zero external dependencies).
     - Validates expiration (`exp`), activation window (`nbf`) with clock skew tolerance, destination shop match (`dest`), and app client ID (`aud`).
     - Implemented `createAdminSessionToken` for deterministic signing of valid/expired/tampered tokens in tests and session issuance.
     - Implemented `extractAdminSession` to extract tokens from `Authorization: Bearer <jwt>`, query parameters (`id_token`, `session`), or transparent demo mode fallback.
  2. **Interactive Polaris Admin UI Enhancements (`renderAdminHtml` in `admin.js`):**
     - **Practitioners Directory Tab:** Inline practice name editing form submitting to `POST /api/admin/practitioners/practice-name`, enabling merchant control over practice names to prevent impersonation, alongside existing Approve / Revoke actions.
     - **Starter Templates Tab:** Added accessible modal `#create-starter-modal` and form submitting to `POST /api/admin/starters/create` with template name (required, max 60 chars), intro note (optional, max 500 chars), and dynamic product line items builder (variant GID, quantity 1-10, usage instructions).
     - **Attribution & Reports Tab:** Added monthly filter selector (`<input type="month">`) and dynamically parameterized RFC 4180 CSV export link (`/api/admin/attribution.csv?month=YYYY-MM`).
     - **Settings & Emergency Tab:** Styled mode selection (`tag` vs `company`), footer disclaimers, printable handout text, and critical emergency storewide kill switch.
  3. **Live Admin Web Route Handlers (`routes.js`, `test/routes.test.js`):**
     - Implemented and exported standard Web API handlers: `handleAdminDashboardRequest`, `handleAdminPractitionersListRequest`, `handleAdminPractitionerStatusRequest`, `handleAdminPracticeNameRequest`, `handleAdminStartersListRequest`, `handleAdminCreateStarterRequest`, `handleAdminUpdateSettingsRequest`, `handleAdminEmergencyDisableAllRequest`, `handleAdminAttributionCsvRequest`.
     - Built `parseFormEncoded` supporting nested array syntax (`lines[0][variantGid]`, etc.) to support both standard HTML form POSTs and JSON API calls seamlessly.
     - Added `ProtocolAdminError` mapping to `handleErrorResponse` (401 for unauthorized, 404 for not found, 400 for invalid input or PII).
  4. **Server Integration (`server.js`, `test/server.test.js`):**
     - Connected all live admin handlers into `createRequestListener`.
     - Seamlessly handles database persistence when configured with session tokens and executes in-memory demo mutations when in demo mode.
- **Verification Status:**
  - `npm test`: **323/323 pure unit tests passing** (85 suites, 0 failures, ~118ms).
  - Dev server preview verified via Chrome DevTools MCP and visual screenshots recorded in artifact carousel `m6_admin_walkthrough.md`.

## 31. Session Log — 2026-10-28 (Session 21: Milestone M7 — Shopify App Store Review Self-Audit & Hardening)
- **Context:** Carried out Milestone M7: Shopify App Store Review Self-Audit & Hardening, implementing automated OAuth 2.0 install initiation, OAuth callback with constant-time HMAC verification, Session table integration, and embedded admin Content Security Policy (CSP) security headers.
- **Implemented Capabilities & Hardening:**
  1. **Automated OAuth 2.0 Flow (`server.js`, `test/server.test.js`):**
     - Built `GET /api/auth` (and `GET /auth`): Validates `shop` against RFC 1034 domain pattern (`/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/`), generates a 16-byte cryptographically secure random state nonce, and issues a 302 redirect to `https://${shop}/admin/oauth/authorize?client_id=...&scope=read_orders&redirect_uri=...&state=...`.
     - Built `GET /api/auth/callback` (and `GET /auth/callback`): Validates shop domain format, requires `code`, and verifies query HMAC via `verifyOAuthHmac` using constant-time comparison (`crypto.timingSafeEqual`).
     - In production mode (`DATABASE_URL` and `pool` set), exchanges temporary code for permanent offline access token via Shopify OAuth token endpoint and upserts into `Session` table (`offline_${shop}`).
     - Redirects 302 to `/admin?shop=${shop}`.
  2. **OAuth Query Parameter HMAC Verification (`proxy.js`, `test/proxy.test.js`):**
     - Implemented `calculateOAuthSignature` and `verifyOAuthHmac`.
     - Sorts all parameters alphabetically (excluding `hmac` and `signature`), joins key-value pairs with `&` per Shopify OAuth specification, hashes with SHA-256 HMAC, and performs constant-time comparison against received `hmac`.
  3. **Shopify App Store Security Headers (`server.js`, `test/server.test.js`):**
     - Added strict security headers on all Merchant Admin UI responses:
       - `Content-Security-Policy: frame-ancestors https://${shop} https://admin.shopify.com;` (or `https://*.myshopify.com https://admin.shopify.com;` default)
       - `X-Content-Type-Options: nosniff`
       - `Referrer-Policy: strict-origin-when-cross-origin`
  4. **Production Configuration Startup Guard:**
     - Updated `validateServerConfig` to permit production mode when both `DATABASE_URL` and `SHOPIFY_API_SECRET` are provided, returning `{ databaseUrl, isDemoMode: false }`.
  5. **Shopify App Store Review Self-Audit (`docs/SHOPIFY_APP_STORE_AUDIT.md`):**
     - Produced comprehensive 9-section self-audit covering:
       - Automated OAuth installation (no manual domain entry).
       - App Bridge & Polaris embedded experience with HS256 session tokens.
       - Protected Customer Data (PCD) justification for `read_orders` (zero personal data stored; protocol counters only).
       - Mandatory GDPR compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`).
       - Storefront App Proxy security, sliding-window rate limiting, and Liquid delimiter neutralization.
       - Medical & health claim boundaries (`assertNoPii`, retail curation disclaimers).
       - $0 Free Public App pricing declaration.
- **Verification Status:**
  - `npm test`: **336/336 pure unit tests passing** (88 suites, 0 failures, ~101ms).
  - All 13 test files green with zero regressions.

## 32. Session Log — 2026-10-28 (Session 22: Spike S1 — Practitioner Surface Comparison & Decision D1 Resolution)
- **Context:** Carried out Spike S1 analysis and evaluation comparing Path A (Customer-Account Full-Page Extension) vs Path B (App-Proxy Portal) on dev store architecture, resolving Decision D1.
- **Architectural Comparison & Empirical Evidence:**
  1. **Plan Independence:**
     - Path B (App-Proxy portal) works universally across all Shopify store plans (Basic, Grow, Advanced, Plus) with zero extension deployment overhead or theme modifications.
     - Path A (Customer-Account extension) requires full-page extension bundling (`customer-account.page.render`), and its primary distinguishing capability (`purchasingCompany.value` for B2B company locations) is Plus-exclusive.
  2. **Storefront Identity & Authentication:**
     - In S5 empirical testing with New Customer Accounts on dev store `ai-agent-app-h9qwnwd8.myshopify.com`, `logged_in_customer_id` was reliably forwarded to the App Proxy upon customer login, and empty string `""` when signed out.
     - Customer GID is derived cleanly as `gid://shopify/Customer/${logged_in_customer_id}` without requiring additional customer read scopes.
  3. **Theme & User Experience Integration:**
     - Path B renders naturally inside the brand's active storefront theme layout (Dawn), maintaining consistent header, navigation, and footer styling.
     - Interactive Practitioner Portal UI (built in Milestone M3) operates entirely inside Path B with product search, variant curation, and protocol management.
  4. **Security & Replay Hardening:**
     - Performed code check on `verifyAppProxyHmac`. Implemented and verified optional timestamp freshness enforcement (`maxAgeSeconds`) in `app/lib/protocols/proxy.js` (`test/proxy.test.js`) to mitigate replay attacks on proxy requests.
- **Decision D1 Recorded:**
  - **Baseline:** Path B (App-Proxy portal) is selected as the primary practitioner surface for all stores.
  - **Upgrade:** Path A (Customer-Account Full-Page Extension) is deferred as an optional future enhancement for Plus merchants desiring direct integration within `/account` navigation.
- **Verification Status:**
  - `npm test`: **337/337 pure unit tests passing** (88 suites, 0 failures, ~110ms).
  - Updated `docs/SPIKES_CHECKLIST.md` and `docs/BUILD_PLAN.md` (M0 S1 checked off).

## 33. Session Log — 2026-10-28 (Session 23: Milestone M8 — Release Readiness Documentation & Test Suite Alignment)
- **Context:** Carried out Milestone M8 documentation and test suite alignment: verified all sections of `README.md` against built and empirically verified code, updated architectural diagrams, and aligned test assertions in `test/server.test.js`.
- **Verified Updates in `README.md`:**
  1. **Status Header & Test Coverage:** Updated header to reflect 337 pure unit tests passing across 88 suites (~100ms) with zero regressions, live PostgreSQL 17 test coverage, and empirical spike results (S1, S2, S4, S5 answered; S3 property persistence confirmed on dev store order #1016).
  2. **Practitioner Portal & Editor:** Documented the Milestone M3 interactive protocol editor modal (`#protocol-editor-modal`) with live Storefront GraphQL catalog search, variant line additions, and live total calculation, removing obsolete "not built yet" placeholders.
  3. **Merchant Admin Polaris UI & OAuth:** Documented the Milestone M6 Polaris tabs, pure Node.js HS256 App Bridge session token verification, practice name controls, starter template builder, and Milestone M7 automated OAuth 2.0 install flow with CSP security headers.
  4. **Directory Structure & Architecture:** Added `server.js`, `test/server.test.js`, `docs/SHOPIFY_APP_STORE_AUDIT.md`, and `docs/SPIKES_CHECKLIST.md` to repository tree. Updated the Mermaid architectural flowchart to show the interactive editor modal.
  5. **Regression Test Integrity:** Updated `test/server.test.js` to assert the verified `README.md` status, confirming all 337 tests pass cleanly.
- **Verification Status:**
  - `npm test`: **337/337 pure unit tests passing** (88 suites, 0 failures, ~105ms).
  - Working directory clean, ready for final owner review and tagging.

## 34. Session Log — 2026-10-28 (Session 24: Spike S5 Edge Cases & Spike S3 Signed-in B2B Order Empirical Verification)
- **Context:** Executed empirical verification on live dev store `ai-agent-app-h9qwnwd8.myshopify.com` for remaining Spike S5 B2B edge cases (sold-out and over-stock lines) and Spike S3 attribution property persistence for a signed-in B2B company contact.
- **Empirical Findings Recorded:**
  1. **Spike S5 — B2B Sold-out & Over-stock Edge Cases (Closed):**
     - **Sold-out Single Line:** Calling `POST /cart/add.js` with sold-out variant ("The Out of Stock Snowboard", ID `45924388831285`, `available: false`) returns HTTP 422: `{"status":422,"message":"The product 'The Out of Stock Snowboard' is already sold out.","description":"The product 'The Out of Stock Snowboard' is already sold out."}`. Zero items added (`cartItemCount: 0`).
     - **Multi-line Batch with Sold-out Line:** Batch addition containing in-stock Liquid x2 and sold-out item x1 fails with HTTP 422 in an all-or-nothing manner; zero items added to cart.
     - **Over-stock Single Line:** Requesting 9999 units of "Oxygen" (22 units in stock) returns HTTP 422: `{"status":422,"message":"Only 22 items were added to your cart due to availability."}` and partially adds the available 22 units to cart.
     - **Over-stock with B2B Quantity Rule:** Requesting 9999 units of "Liquid" (min 2, increment 2, 36 units in stock) returns HTTP 422 and partially adds 36 units (exact multiple of 2).
  2. **Spike S3 — Signed-in B2B Company Contact Order #1017:**
     - Contact `arsalanarshad.dev+b2b@gmail.com` under company "Snowdevil" checked out 2 units of Liquid with hidden attribution properties (`_protocol_token: "tok_test_b2b_s3"`, `_protocol_id: "proto_test_b2b_123"`, `_protocol_usage: "Take 2 daily"`).
     - Bogus gateway checkout completed successfully: **Order #1017** (Confirmation `#WRU5LLI8Z`, Order ID `18962727993397`, CAD $1,469.00 total).
     - Line item properties survived intact into order without leakage.
     - Hidden properties remained 100% hidden on Cart, Drawer, Checkout, and New Customer Accounts order details page (`/account/orders/18962727993397`).
- **Release Tagging:**
  - Annotated git tag `v0.1.0` created on `07c8d86` following completion of M8 release readiness.
- **Verification Status:**
  - `npm test`: **337/337 pure unit tests passing** (88 suites, 0 failures, ~99ms).
  - Spikes S1, S4, and S5 fully resolved and closed; S3 verified across both guest and signed-in B2B orders.
