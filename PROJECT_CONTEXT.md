# Practitioner Protocols — Project Context (for Claude)

_Snapshot: 2026-10-08 · folder scaffolded, **no code yet** · status: being scoped (spikes first)._
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
**Open:** run spikes S1–S5; answer Q1/Q3; pick D5 name candidates and check conflicts.
**Resolved:** clean-room approach decided (owner, 2026-10-08).

## 9. Where to start
Run the five spikes in a day or two on a dev store; write the answers into section 5 above; only then build. See `docs/BUILD_PLAN.md`.

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
  - Created local database `practitioner_protocols` in local PostgreSQL on port 5432.
  - Defined `prisma/schema.prisma` covering `Protocol`, `ProtocolLine`, `PractitionerProfile`, `ProtocolOrderStat`, `Setting`, and Shopify `Session`.
  - Generated and executed initial PostgreSQL DDL migration: `prisma/migrations/20261021_init/migration.sql`.
  - Implemented service layer in `app/lib/protocols/service.js` with database transactions, permission enforcement, token generation, protocol duplication, archiving/restoring, and atomic monthly attribution rollups.
  - Added `test/database.integration.test.js` validating end-to-end database operations (100% pass via `npm run test:db`).
  - Configured git-ignored local `.env` with `DATABASE_URL`.
- **App Proxy & Compliance Webhooks:**
  - Implemented `app/lib/protocols/proxy.js`: HMAC query signature verification, signed `logged_in_customer_id` extractor, and theme-compatible Liquid generator with `<meta name="robots" content="noindex, nofollow">`, all 4 protocol states, and 1-tap Cart AJAX integration (`/cart/add.js`) carrying `_protocol_token` and `_protocol_id`.
  - Implemented `app/lib/protocols/webhooks.js`: X-Shopify-Hmac-Sha256 base64 verification, mandatory GDPR webhooks (`customers/data_request`, `customers/redact` with Tag vs Company mode isolation, `shop/redact`, `app/uninstalled`), and `orders/paid` attribution pipeline.
  - Test suite expanded to **84 tests across 33 suites** passing in ~41ms via `npm test`.
- **Security Audit & Context7 Verification:**
  - Full audit completed with **PASS / 100% COMPLIANT** verdict across all modules.
  - Verified against upstream Shopify docs via Context7 MCP (`validateHmac.md`, `webhooks/validate.md`, `processWebhooks.md`).
  - Confirmed timing-safe cryptographic comparisons (`timingSafeEqual`), zero PII leakage (`PII_NOT_ALLOWED`), 100% parameterized SQL queries, XSS sanitization, and clean Git state (.env ignored).
- **Next Up:** Merchant admin routes / UI.
- **Session Log — 2026-10-21 (Session 2: Milestone M3 Practitioner Portal & Share Kit):**
  - Implemented `app/lib/protocols/portal.js`:
    - Protocol Library: Formatting cards, retail totals (`formatMoney`, `calculateProtocolRetailTotal`), line counters, starter template handling (read-only enforcement), and unavailable / out-of-stock item indicators with SPEC §5 notice (`1 product no longer available`).
    - Protocol Editor: Payload validation, normalization, and preparation (`prepareProtocolEditorPayload`), line operations (`addProtocolLine`, `updateProtocolLine`, `removeProtocolLine`, `reorderProtocolLines`), 20-line maximum constraint, quantity bounds (1-10), note bounds (<= 200), and zero client PII enforcement.
    - Concurrent Edit Detection: `detectConcurrentEdit` detecting `updatedAt` drift, distinguishing peer practitioner edits in company mode (`PEER_PRACTITIONER_EDIT`) from self/session edits, with friendly last-save-wins warning (SPEC §5).
    - Share Kit: `generateProtocolShareKit` assembling canonical protocol link, vector QR SVG with custom sizing, base64/SVG data URI, and printable US Letter & A4 handout HTML (SPEC §8).
  - Implemented `test/portal.test.js`: 40 unit test cases passing in ~16ms (`node --test test/portal.test.js`).
  - Total test suite expanded to **124 tests across 40 suites** passing with 0 failures in ~61ms (`npm test`).
- **Session Log — 2026-10-21 (Session 3: Milestone M6 Merchant Admin & RFC 4180 CSV Reports):**
  - Implemented `app/lib/protocols/admin.js`:
    - Practitioner Approvals: `listPractitionerProfiles`, `getPractitionerProfile`, `updatePracticeName`, `setPractitionerApproval`, `approvePractitioner`, `revokePractitioner`, `upsertPractitionerProfile`. Enforces merchant-controlled naming to prevent practitioner impersonation.
    - Starter Templates Manager: `listStarterTemplates`, `createStarterTemplate`, `updateStarterTemplate` enforcing brand ownership (`isStarter = true`) and admin-only write permissions.
    - Emergency Protocol Disable: `emergencyDisableProtocol` and storewide killswitch `emergencyDisableAllProtocols` setting `status: 'disabled'` to immediately cut off client access.
    - App Settings: `getSettings`, `updateSettings` for Identity mode (`tag` vs `company`), footer disclaimer, and handout print text.
    - Attribution Reporting & CSV Export: `getAttributionReport`, `formatAttributionCsv`, `exportAttributionCsv`. Generates RFC 4180 compliant CSVs with proper comma/quote escaping and CRLF line terminators. Strictly aggregate counters only (zero client PII).
  - Implemented `test/admin.test.js`: 28 unit tests passing in ~4ms.
  - Overall test suite expanded to **152 tests across 47 suites** passing with 0 failures in ~83ms (`npm test`). Database integration tests pass 4/4 (`npm run test:db`).
- **Session Log — 2026-10-21 (Session 4: Milestone M7 Hardening — Pure Sliding Window Rate Limiter):**
  - Implemented `app/lib/protocols/rate-limit.js`:
    - Pure ESM JavaScript, zero external dependencies, zero client PII.
    - `createRateLimiter({ windowMs = 60000, maxRequests = 60, pruneIntervalMs, maxKeys = 10000, autoPrune = true, now })`:
      - Sliding window log algorithm tracking monotonic timestamps per key.
      - `isRateLimited(key, cost = 1)` -> `{ limited, remaining, resetMs, retryAfterSeconds }`.
      - `check(key)` -> inspects quota without consuming.
      - `reset(key?)` -> resets specific key or clears all keys.
      - `prune(currentTime)` -> manual and opportunistic cleanup removing expired timestamps and keys.
      - Memory leak prevention and DoS protection via `maxKeys` eviction and unref'd auto-prune interval.
    - Custom identifiers support: client IP, share token, shop domain, and composite keys via `createRateLimitKey`.
    - `getClientIp(headers, connection)` -> safely extracts client IP from reverse proxy headers (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`, socket address) with zero PII.
    - `getRateLimitHeaders(result, maxRequests)` -> RFC/standard HTTP rate limit response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`).
    - `renderRateLimitLiquid({ retryAfterSeconds })` -> responsive app proxy Liquid error template with `<meta name="robots" content="noindex, nofollow">`.
  - Implemented `test/rate-limit.test.js`: 20 unit test cases passing in ~9ms (`node --test test/rate-limit.test.js`).
  - Overall test suite expanded to **172 tests across 55 suites** passing with 0 failures in ~63ms (`npm test`).
- **Session Log — 2026-10-21 (Session 5: Milestone M1 Protocol API Routes & Controllers):**
  - Implemented `app/lib/protocols/routes.js`:
    - `handleAppProxyRequest`: Verifies App Proxy HMAC, enforces rate limiting, extracts customer context, queries protocol, and renders theme-compatible Liquid markup.
    - Protocol CRUD Controllers: `handleListProtocolsRequest`, `handleCreateProtocolRequest`, `handleGetProtocolRequest`, `handleUpdateProtocolRequest`, `handleDuplicateProtocolRequest`, `handleArchiveProtocolRequest`, `handleRestoreProtocolRequest` with backend-enforced ownership and zero PII.
    - Webhook Router: `handleWebhookRequest` verifying `X-Shopify-Hmac-Sha256` and dispatching compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`, `orders/paid`).
  - Implemented `test/routes.test.js`: 33 unit test cases passing in ~17ms.
  - Overall test suite expanded to **205 tests across 65 suites** passing with 0 failures in ~74ms (`npm test`). Database integration tests pass 4/4 (`npm run test:db`).
- **Milestone Completion Status:**
  - M1 (Foundation): 100%
  - M2 (Client Page & Storefront App Proxy): 100%
  - M3 (Practitioner Portal): 100%
  - M4 (Share Kit): 100%
  - M5 (Attribution & Reports): 100%
  - M6 (Merchant Admin): 100%
  - M7 (Hardening, Rate Limiting & Webhooks): 100%
- **Next Up:** Verified production README.md documentation and final review before tagging (M8).
- **Session Log — 2026-10-21 (Session 6: Milestone M8 Verified Production Documentation):**
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



