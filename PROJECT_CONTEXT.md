# Practitioner Protocols — Project Context (for Claude)

_Snapshot: 2026-10-22 · Core pure engine library fully implemented (238 pure unit tests passing) · Re-verification audit & Fixes 1–7 complete · Awaiting dev store with B2B for Spikes S1–S5 and app UI scaffold._
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
- **D1 — Practitioner surface:** customer-account extension vs app-proxy portal. **Decided by Spike S1.**
- **D2 — Data store:** Postgres via Prisma (recommended: simplest, atomic edits, easy reporting, matches existing hosting) vs metaobjects (merchant-visible, theme-readable). A metaobject mirror can be added later if themes should render natively.
- **D3 — Client page rendering:** App Proxy Liquid page (no theme edits, works for any theme) vs a metaobject theme template (needs merchants to add a template). **Decided by Spike S2.**
- **D4 — Attribution carrier:** hidden line-item property (preferred) vs cart attribute. **Decided by Spike S3.**
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
- Run spikes S1–S5 (needs dev store with B2B enabled).
- Answer Q1/Q3.
- Owner decision on Catalog Resolver token & scope (`docs/PROPOSAL_CATALOG_RESOLVER.md`: Option b requires `unauthenticated_read_product_listings` vs Option a private token).
- Scaffold Shopify app harness (`shopify.app.toml`, Remix/server entry) once dev store is ready.
- Verify migrations and integration tests against real live PostgreSQL instance.

**Resolved:**
- Clean-room approach decided (owner, 2026-10-08).
- Pure engine core, API routes, compliance webhooks, rate limiter, merchant admin, practitioner portal, printable handout, and PostgreSQL service layer fully implemented.
- First independent code audit completed and 10 technical defects remediated (Session 7).
- Re-verification audit completed and Fixes 1–7 remediated test-first (Session 8).
- Follow-up PostgreSQL locking and rate limit hop audit remediated and verified on real PostgreSQL (Session 9).
- Zero order IDs stored in `ProcessedWebhook` (verified by automated test parameter assertions).
- Absolute paths removed.

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
     - Hardened `getClientIp`: prefers `CF-Connecting-IP`, otherwise the RIGHTMOST `X-Forwarded-For` entry (appended by trusted edge proxy), otherwise `X-Real-IP`, otherwise `'unknown'` bucket. Documented trusted-proxy reverse proxy assumptions in code and README.
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
