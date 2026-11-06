# Practitioner Protocols — Build Plan

## M0 — Spikes (1–2 days, dev store with B2B + new customer accounts)
- [x] S1 practitioner surface (customer account UI extension vs app-proxy portal; D1 decided: App Proxy portal is the baseline across all plans; full-page extension deferred as optional Plus upgrade; verified on Plus dev store).
- [x] S2 app-proxy page in theme layout + verify `noindex` and `sitemap.xml` exclusion (verified on dev store with reverse proxy headers and `noindex` tag; hop count configuration tracked).
- [x] S3 attribution carrier (verified hidden line property `_protocol_token` survives Cart AJAX through to completed guest order and signed-in B2B order, and verified in live `orders/paid` webhook payload capture; populated `discount_allocations` observation pending).
- [x] S4 Cart AJAX 20 lines (verified adding 20 distinct variant lines in 971ms in single request).
- [x] S5 practitioner-preview pricing (verified retail vs B2B pricing, quantity rules, sold-out all-or-nothing, and overstock partial add on live dev store).
- [x] S6 storefront product search execution (answered on dev store `ai-agent-app-h9qwnwd8`: `/search/suggest.json` returns up to 10 products with empty `variants: []`; `/products/<handle>.js` returns full variants with prices in minor units; client-side storefront fetch chosen; Option A selected: store `ProtocolLine.productHandle` via migration; unblocks M9b-3).
- [x] Record empirical findings for S1–S6 in `PROJECT_CONTEXT.md` §5 & §41 and update decisions D1–D4 & D7. Detailed execution plan in [`docs/SPIKES_CHECKLIST.md`](SPIKES_CHECKLIST.md).

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
- [x] Brand assets v2 produced and verified: text-free App Store icon (`app-icon-1200.png`) and listing feature image (`feature-image-1600x900.png`) replacing the previous shopping-bag motif; wide README hero banner (`readme-banner-1600x400.png`) and social preview thumbnail (`thumbnail-1280x640.png`) with code-rendered typography.
- [ ] Final owner review, dev store end-to-end verification, tagging, and release.

## M9a — Embedded Merchant Admin in Production Mode
- [x] Embedded Merchant Admin in Production Mode (VERIFIED LIVE on dev store `ai-agent-app-h9qwnwd8` 2026-11-04):
  - Embedded admin loads inside Shopify Admin iframe, empty states render cleanly, tab navigation functions with fresh App Bridge session tokens.
  - `GET /`, `GET /admin`, and `GET /app` served via App Bridge ID tokens and HS256 session verification (`renderAdminHtml`, `renderAdminBootstrapHtml`).
  - Embedded iframe bootstrap pattern: missing session token inside admin iframe renders bootstrap page that retrieves `await shopify.idToken()` and reloads with `?id_token=<token>`, never redirecting iframe to `/api/auth`.
  - Top-level direct navigation with `?shop=` redirects to `/api/auth?shop=...`; direct navigation without shop returns 401.
  - Cross-shop parameter mismatch (`?shop=` != `token.dest`) strictly rejected with HTTP 403 Forbidden across `GET /` and all `/api/admin/*` endpoints.
  - Empty database states render clean Polaris empty tables without throwing 500.
  - App Bridge session refresh signal (`X-Shopify-Retry-Invalid-Session-Request: 1`) on 401 unauthorized.

## M9b — Practitioner Self-Enrolment & Portal Production Wiring
- [x] Design doc approved (`docs/M9B_DESIGN.md`) on sequential roadmap (M9b-1, M9b-2, M9b-3).
- [x] **M9b-1: Self-Enrolment Setting, Migration & Admin Controls (VERIFIED LIVE on dev store 2026-11-04)**:
  - Added `allowSelfEnrol` column to `Setting` in `prisma/schema.prisma` and registered migration `20261103_add_allow_self_enrol/migration.sql` in `scripts/migrate.js` (applied automatically on deploy).
  - Added `getSettings`/`updateSettings` support with default `false`, partial update value preservation (COALESCE), and boolean/string parsing.
  - Settings tab toggle renders, saves, and persists across reloads (toggled back off after test).
  - Practitioners tab displays pending practitioners (`isApproved: false`) with `(requested, unverified)` and direct links to Shopify admin customer records (`https://<shop>/admin/customers/<numericId>`).
- [x] **M9b-2: Self-Enrolment Flow, Portal States & CSRF Protection (VERIFIED LIVE on dev store 2026-11-04)**:
  - Verified live on dev store:
    - Enrol round trip: JSON POST through the App Proxy (body and `Content-Type: application/json` preserved in transit).
    - Pending portal state displaying requested name.
    - Admin pending row displaying "(requested, unverified)" with direct Shopify admin customer deep link.
    - Merchant approval flips profile to approved.
    - Approved practitioner portal and protocol editor display upon reload.
    - CSRF media-type rejections: form-encoded and `text/plain; application/json` POSTs return HTTP 415.
    - Unknown action returns HTTP 400.
  - Note: The per-customer rate limit (5/hr), the pending cap (200), `customers/redact` profile deletion, and `Sec-Fetch-Site` handling are covered by unit tests and were NOT exercised live.
- [x] **M9b-3a: Catalog Search, Production Authoring & Client Page Hydration (VERIFIED LIVE on the dev store)**:
  - Live Dev Store Verification: VERIFIED: editor search with real products and CAD prices, protocol save, share-page hydration, Add all with `_protocol_token`/`_protocol_id`/`_protocol_usage` in the cart, checkout to orders/paid (webhook 200, stat row written), edit round trip (qty and note persisted, token unchanged), list card item count, handout page layout.
  - Migration `20261104_add_product_handle_to_protocol_line/migration.sql` adding nullable `productHandle TEXT` to `ProtocolLine` table; updated `prisma/schema.prisma` and registered in `scripts/migrate.js`.
  - Validation: `productHandle` format (`^[a-z0-9][a-z0-9-]{0,254}$`), variant GID format, payload sanitization. Handled null handles gracefully (rendered "Product no longer available").
  - Practitioner editor (approved state): client-side debounced (300ms, $\ge 2$ chars) `/search/suggest.json` with `resources[options][unavailable_products]=show`, on-select `/products/<handle>.js` variant hydration converting prices from minor units and disabling out-of-stock variants, quantity 1-10, usage notes $\le 200$ chars, saving via POST JSON `action=create` and `action=update` with strict `textContent` rendering (zero `innerHTML`) and no stored prices.
  - Client protocol page (`/apps/protocols/<token>`, production): rendered cards with data attributes, client-side hydration from `/products/<handle>.js` updating titles, prices, stock status and dynamic "Add all to cart" disabling.
  - Production server cleanup: removed `createFakeVariantResolver` from production `/api/proxy` path (`variantResolver: pool ? undefined : createFakeVariantResolver(...)`).
  - Follow-up live check hotfix:
    - Bug 1 (data loss on edit): Portal queries now join `ProtocolLine` with `json_agg` and `linesCount` matching `service.js` shape, preserving exact customer/starter shop scoping so editing loads all existing lines.
    - Bug 2 (fake `$0.00` total): Removed total retail price display from portal cards (shows `"N item(s)"`), and eliminated all hardcoded `$` symbols in `portal.js` and `proxy.js`.
    - Bug 3 (print handout): Implemented print-friendly layout in `renderProtocolLiquid` when `?handout=1` (with `@media print`, `window.print()` trigger, hidden banner/Add buttons, and settings `handoutText` and `footerDisclaimer`). Chosen over hiding the link because M4 already built handout/QR modules and theme-native client hydration provides a superior print experience.
  - Automated unit test coverage: 493 passing tests across 109 suites (including node:vm script parse regression guards).
- [x] **M9b-3b: Protocol Lifecycle Management (Archive, Restore, Duplicate) (VERIFIED LIVE on the dev store)**:
  - App Proxy mutating JSON POST actions (`action=archive&id=<id>`, `action=restore&id=<id>`, `action=duplicate&id=<id>`) with CSRF protection (exact `application/json` Content-Type, `Sec-Fetch-Site: same-origin` check) and unknown action rejection (400).
  - Strict Rule 4 tenant and ownership isolation: cross-owner and cross-shop archive/restore/duplicate requests return 404 without leaking existence; starter templates cannot be modified or archived (403).
  - Duplicating own protocols or starter templates creates a practitioner-owned active copy (`ownerType: 'customer'`, `isStarter: false`) prefixed with `"Copy of <name>"` (trimmed to $\le 60$), copying all lines (`variantGid`, `productHandle`, `quantity`, `usageNote`), with a fresh ID and unique share token.
  - Client link lifecycle: archived protocols render inactive client state ("Protocol No Longer Active" / "This recommendation is no longer active" with zero Add buttons), and restoring brings back the active client page under the exact same share token.
  - Practitioner portal UI: in-page confirmation UI for archiving (inline Confirm/Cancel, strictly zero `window.confirm`, `window.alert`, or `window.prompt` dialogs), dedicated "Archived Protocols (n)" section with Restore buttons, "Use as template" buttons on brand starter templates, and `#portal-global-error` in-page error reporting with `textContent`.
  - VERIFIED LIVE on dev store: in-page archive flow with inline confirmation UI, archived protocol rendering inactive client page with zero Add buttons under its original share token, dedicated Archived Protocols section in portal with one-click Restore, reactivating protocol and immediately restoring active client page under same token, duplicate-own-protocol producing fresh active copy prefixed with `"Copy of <name>"`, and duplicate-from-starter.
  - Remaining NOT-verified live list: logged-out guest view, handoutText/footerDisclaimer rendering, real printing, live cross-owner/cross-shop denial, non-Latin handles (known limitation), discounted-order attribution live, and new CSP inside real admin iframe.
- [x] **Pre-Submission Hardening, Security Headers, Privacy, Attribution Contract Fix & Starter UX**:
  - OAuth state security fix: HMAC-signed `shopify_oauth_state` cookie (`HttpOnly; Secure; SameSite=Lax`, Max-Age 600, Path=/api/auth), validated via `crypto.timingSafeEqual` with 600s max-age, cleared afterwards with Max-Age 0, storing `'authenticated'` in `Session.state`.
  - Public Privacy Policy page: `GET /privacy` (public HTML, status 200, UTF-8, zero shopper PII, read_orders aggregate attribution only, compliance webhooks, sub-processors Railway & Shopify, optional `PRIVACY_CONTACT_EMAIL`, zero health claims).
  - Security headers: `Strict-Transport-Security: max-age=31536000; includeSubDomains` on all responses; expanded embedded App Bridge `Content-Security-Policy`.
  - Attribution reporting contract fix: resolved bug where attribution report page showed zeros for live data (order #1022 produced ProtocolOrderStat row but admin UI read legacy top-level keys). Standardized single contract `{ month, summary, rows, byPractice, byProtocol }` across data service, renderer, demo data, and RFC 4180 CSV export with `Intl.NumberFormat` currency formatting. Added non-PII logging to `handleOrdersPaid`.
  - Admin starter UX: product search with clear degradation message and collapsible "Advanced: Enter Variant GID directly" fallback without requiring additional scopes.
  - Small fixes: suppressed professional banner on archived client page, fixed unauthenticated `GET /api/admin/practitioners` 401 with retry header, renamed settings label to "Individual Mode (Customer Account)", added `.github/CODEOWNERS` with `@arsalan-arshad`.
  - Assets: re-exported `assets/brand/icon-v3-1200.png` under 800 KB (579 KB, 1200x1200 lossless PNG), tracked 3 optimized `-under1mb.png` files, and documented in `assets/listing/README.md`.
  - Automated unit test coverage: 507 passing tests across 111 suites (`npm test`).
- [x] **M11: Shopper Opt-In Contact Capture & Merchant Custom Request (IMPLEMENTED, PENDING LIVE DEV-STORE VERIFICATION)**:
  - Owner decision record (2026-11-05): "zero shopper PII" relaxed strictly for an explicit, opt-in "stay in touch" contact. No product/order/health data linked to shopper.
  - Data model: `ShopperContact` (id, shop, ownerId, email, firstName, consentText, consentVersion, consentedAt, source, createdAt) and `MerchantFeedback` (id, shop, shopName, ownerName, replyEmail, planName, country, message, kind, createdAt); DDL migration `20261105_add_shopper_contact_and_feedback/migration.sql`, registered in `scripts/migrate.js`, mirrored in `prisma/schema.prisma`.
  - Shopper capture (guest via App Proxy): optional "Stay in touch with {practiceName}" card under "Add all to cart", email input, optional first name, unticked checkbox with exact consent text, link to `/privacy`, honeypot, anti-enumeration generic response, and zero PII logging.
  - New proxy action `subscribe` (POST, exact `application/json` else 415, `Sec-Fetch-Site: same-origin` else 403, rate limited, active protocol check, idempotent upsert).
  - Practitioner portal: "My contacts" count, table with inline two-step delete button, and RFC 4180 CSV export (`Email,First Name,Consented At,Verified`) scoped server-side to practitioner's ownerId.
  - Merchant admin: new "Contacts" Polaris tab with counts per practice, global RFC 4180 CSV export (`Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At,Verified`), single delete, and delete-all-for-practice.
  - Merchant contact & feedback (Settings tab): "Contact & feedback" card with 1–5 rating, optional feedback message, and unticked marketing opt-in checkbox; "Need a change or a custom feature?" card with prefilled replyEmail from `ShopProfile.email`, reply-only consent, and 3/hr per-shop rate limit.
  - Compliance webhooks & lifecycle: `customers/redact` deletes matching `ShopperContact` rows by lowercased email; `customers/data_request` includes matching `ShopperContact` rows; `app/uninstalled` sets `uninstalledAt` on `ShopProfile` and revokes sessions; `shop/redact` deletes all `ShopperContact`, `MerchantFeedback`, and `ShopProfile` rows for the shop.
  - Cryptography & Security: AES-256-GCM token encryption at rest for `Session.accessToken` (`enc:v1:<iv>:<tag>:<ciphertext>`), canonical server-enforced consent texts, and dedicated 5/hr rate limiter on shopper opt-in subscriptions.
  - CLI scripts: `scripts/contacts.mjs` listing opted-in installed shops, custom feature requests, and shopper contacts; `scripts/stats.mjs` reporting aggregate platform metrics.
  - Updated `/privacy`, `README.md`, `docs/SPEC.md`, and `PROJECT_CONTEXT.md` honestly stating data handling practices and unverified email disclosure.
  - Automated unit test coverage: 566 passing tests across 123 suites (`npm test`).
- [x] **Shopify Managed Installation & Token Exchange Hardening (IMPLEMENTED, PENDING LIVE DEV-STORE VERIFICATION)**:
  - Fixed empty `Session` and `ShopProfile` bug on stores installing via Shopify Managed Installation: embedded admin requests without stored offline sessions perform RFC 8693 token exchange via `POST https://{shop}/admin/oauth/access_token` (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<id_token>`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`, `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`, `expiring=0`) with a 5s timeout.
  - Upserts `Session` with `id="offline_<shop>"`, `state="authenticated"`, and AES-256-GCM encrypted `accessToken`. Calls `syncShopProfile` non-blocking to populate store name, email, plan, and country via GraphQL.
  - Concurrency & Error Safeguards: Per-shop in-flight lock to deduplicate concurrent exchange requests, 60-second negative cache on exchange failure to protect rate limits, non-PII logging (`[TokenExchange] failed shop=<shop> status=<n>`) with zero token, secret, or body exposure, and normal page rendering on 400 invalid tokens.
  - Lifecycle: `app/uninstalled` deletes the `Session` row while keeping `ShopProfile` with `uninstalledAt` timestamp; `shop/redact` purges all shop records.
  - UI: Settings opt-in card displays a disabled checkbox with `"Your store contact email is still being loaded. Reload this page."` when `ShopProfile.email` is absent (never displays `"this email"`), and custom request cards prefill `replyEmail` when present. Shopper consent text uses `ShopProfile.shopName` when available.
  - Friendly root landing page: `GET /` (or `/admin`, `/app`) outside admin iframe with no session serves status 200 HTML with `"Practitioner Protocols runs inside your Shopify admin. Open it from your Shopify admin's Apps list."`, link to `/privacy`, and zero login or shop domain input fields.
  - Automated unit test coverage: 582 passing tests across 132 suites (`npm test`).

## Later
Practitioner application form · aggregate "client orders" count on protocol cards · protocol version history · Salesforce rollup via Bridge Recipes.
