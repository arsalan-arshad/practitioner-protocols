# Practitioner Protocols — Share Product Recommendations by Link or QR, Buy in One Tap

> **Open-Source (MIT)** | Built for the Shopify Merchant & Developer Community | Open for PRs & Discussions
>
> ⚙️ **Status: Pure Engine Modules Verified (272/272 Unit Tests Passing with Mocks)** | **Live PostgreSQL Integration (Last verified 10/10 against PostgreSQL 17.11 in Session 9; test:db skips with a notice when no DB is reachable)** | **Dev Store Spikes Complete (M0 Verified)**

---

## 1. Overview & Vision

**The problem:** Many direct-to-consumer and professional brands sell *through practitioners* — dermatologists, physical therapists, veterinarians, personal trainers, salons, and wellness clinics. The practitioner recommends a curated set of products in the clinic; the client forgets half of it, searches online, and buys somewhere else. The brand never learns which practices actually drive retail sales. The model that solves this (a "protocol": a named, reusable list of products with usage directions, shared by link) exists only inside closed supplement dispensaries. A brand running its own Shopify store has had no open equivalent.

**The approach:** A *protocol* is a reusable, professional product recommendation list. The practitioner builds it once, shares one permanent link or QR code with any number of clients, and the client lands on a theme-native storefront page where **one tap adds everything to their cart at normal retail prices**. The brand sees, in aggregate, which practices and protocols drive sales.

**Privacy by design:** Protocols never accept or store client/patient information. The validator strictly enforces a zero-PII barrier (`PII_NOT_ALLOWED`) both on top-level keys and within nested line items. Attribution is tracked solely via aggregate monthly counters.

**Current build stage:** The pure engine logic, security controls, cryptographic primitives, Liquid renderers, catalog resolver, rate limiters, validation barriers, and PostgreSQL database queries are fully built and covered by 272 automated unit tests using mock database interfaces. Real PostgreSQL query execution, transaction behavior, constraints, row-level locking (`FOR UPDATE`), and migrations are verified against a live PostgreSQL instance via `npm run test:db` (10 integration tests passing). Spikes S1–S5 (Milestone M0) on a live Partner dev store verified App Proxy Liquid evaluation, reverse proxy header chain traversal, and storefront parameters.

---

## 2. Core Modules & Verified Features

### A. Share Tokens & Cryptography ([`app/lib/protocols/token.js`](app/lib/protocols/token.js))
- Unguessable, URL-safe random alphanumeric tokens ($\ge 16$ characters) using `crypto.randomBytes`.
- Over 95 bits of cryptographic entropy, preventing enumeration attacks.
- Validated via `isValidShareToken`.

### B. Input Validation & Privacy Barrier ([`app/lib/protocols/validation.js`](app/lib/protocols/validation.js))
- **Strict Zero-PII Enforcement:** Rejects any top-level or nested `lines[]` key matching `/(?:patient|client|ssn|health|medical|diagnosis|condition)/i` with `PII_NOT_ALLOWED`.
- Protocol name (1–60 chars), optional intro note ($\le 500$ chars), display name ($\le 60$ chars).
- Product lines (1–20 items), quantities (1–10 integers), and line usage instructions ($\le 200$ chars).
- Prohibits duplicate variant GIDs within a single protocol (`DUPLICATE_VARIANT`).
- Enforces Shopify Variant GID format (`gid://shopify/ProductVariant/<id>`) and max length (100 characters).
- Restricts `disabled` status modification and starter creation to administrators only.

### C. Permissions & Multi-Tenant Isolation ([`app/lib/protocols/permissions.js`](app/lib/protocols/permissions.js))
- **Tag Mode (any Shopify plan):** Customer tagged `practitioner`. Owner = `customer`.
- **B2B Company Mode:** B2B company contact. Owner = `company`.
- Backend-enforced authorization across all actions (`read`, `create`, `edit`, `archive`, `restore`, `duplicate`, `delete`). Cross-owner access is strictly blocked (`FORBIDDEN_OWNERSHIP_MISMATCH`).
- Complete HTTP status code mapping across all 9 denial reasons (401, 403, 404, 400).
- **Starter Template Protection:** Brand starter templates are read-only and duplicable by practitioners, but cannot be modified, archived, or deleted by non-admins.
- **Disabled Isolation:** Protocols set to `disabled` cannot be accessed or modified by non-admins.

### D. Storefront App Proxy & Client Page ([`app/lib/protocols/proxy.js`](app/lib/protocols/proxy.js))
- **Fails Closed on Missing/Invalid Signature:** Requires valid `apiSecret` and timing-safe HMAC SHA-256 validation (`crypto.timingSafeEqual`). Missing secret yields 500; invalid/missing signature yields 401.
- **Theme-Native Liquid:** Generates `application/liquid` responses rendered inside `theme.liquid`.
- **Liquid Injection Neutralization:** Neutralizes Liquid template tags (`{{`, `}}`, `{%`, `%}`) in HTML, attributes, and script tags via HTML entities and Unicode escapes to prevent template injection when evaluated by Shopify's App Proxy.
- **Search Engine Isolation:** Injects `<meta name="robots" content="noindex, nofollow">` across all states.
- **Protocol Lifecycle States:**
  - `active`: Renders practice branding, intro notes, product cards with usage notes, and 1-tap **"Add all to cart"** via Cart AJAX (`POST /cart/add.js`) carrying hidden line item properties (`_protocol_token`, `_protocol_id`, `_protocol_usage`).
  - `archived`: Friendly "Protocol No Longer Active" card.
  - `disabled`: Friendly "Protocol No Longer Active" card.
  - `not_found`: Friendly "Protocol Not Found" card.
- **Professional Preview Banner:** Displays *"You're signed in as a professional. Clients will see retail prices."* when `logged_in_customer_id` matches the practitioner.
- **Catalog Resolver Architecture:** See [`docs/PROPOSAL_CATALOG_RESOLVER.md`](docs/PROPOSAL_CATALOG_RESOLVER.md) for how product titles, prices, and stock statuses are resolved on the client page without requiring expanded Admin scopes.

### E. Practitioner Portal ([`app/lib/protocols/portal.js`](app/lib/protocols/portal.js))
- **Protocol Library:** Library card view with line counters, live retail price total calculation (`calculateProtocolRetailTotal`), starter template badges, and out-of-stock notices (*"1 product no longer available"*).
- **Protocol Editor:** Add/remove products, adjust quantities (1–10), set usage instructions, and reorder lines.
- **Concurrent Edit Detection:** Compares `updatedAt` to warn practitioners in the same practice if another member edited the protocol simultaneously (`PEER_PRACTITIONER_EDIT`).

### F. Vector QR Code & Printable Handout ([`app/lib/protocols/qr.js`](app/lib/protocols/qr.js), [`handout.js`](app/lib/protocols/handout.js))
- Pure JavaScript ISO/IEC 18004 QR generator (zero external dependencies, zero native binaries).
- Output: Scalable, crisp vector SVG with Reed-Solomon Error Correction Level M (15% recovery).
- Print-ready single-page HTML/CSS handout with `@media print` rules for US Letter and A4, XSS-escaped dynamic fields, practice branding, routine table, and embedded QR code.

### G. Order Attribution & Reports ([`app/lib/protocols/attribution.js`](app/lib/protocols/attribution.js), [`admin.js`](app/lib/protocols/admin.js))
- **Mixed-Cart Isolation:** Webhook extractor isolates lines carrying `_protocol_token` and `_protocol_id`, ignoring organic store items.
- **Discounted Revenue Accounting:** Revenue is calculated strictly from discounted line totals (`total_discount` or `discount_allocations`) in minor currency units (cents).
- **Atomic Multi-Protocol Updates:** Transactional processing with single-client checkout guarantees atomicity across multiple attributed protocols in an order.
- **Currency Isolation:** Monthly stats are partitioned by currency `(shop, protocolId, month, currency)` so multi-currency stores do not mix amounts.
- **RFC 4180 CSV Export:** Exports monthly attribution reports with proper escaping, quotes, and CRLF line terminators (strictly aggregate counters; zero client PII).

### H. Merchant Admin Management ([`app/lib/protocols/admin.js`](app/lib/protocols/admin.js))
- **Practitioner Approvals & Anti-Impersonation:** Merchant controls practice names (`PractitionerProfile`) to prevent unauthorized clinic representation.
- **Starter Templates Manager:** Brand administrators create and manage starter templates (`isStarter = true`).
- **Emergency Disable:** Single-protocol or storewide protocol killswitch (`status: 'disabled'`).
- **App Settings:** Configures storefront identity mode (`tag` vs `company`), custom legal disclaimers, and print instructions.

### I. Security Hardening & Rate Limiter ([`app/lib/protocols/rate-limit.js`](app/lib/protocols/rate-limit.js))
- In-memory sliding-window log rate limiter with zero external dependencies, instantiated by default in `routes.js`.
- Prevents token enumeration, scraping, and brute-force attacks on public App Proxy endpoints (returns Liquid 429 error template after threshold).
- Auto-pruning with `maxKeys` eviction cap and unreferenced cleanup intervals to prevent memory leaks.
- Employs RFC-compliant HTTP headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`).
- Anti-spoofing client IP extraction:
  - `TRUSTED_PROXY_HOPS` (env var, default `1`): Configures the number of trusted reverse proxy hops from the rightmost `X-Forwarded-For` entry (behind Shopify App Proxy and edge infrastructure, the exact hop count is unverified; see Spike S2).
  - `TRUST_CF_CONNECTING_IP` (env var, default `false`): Opt-in trust for `CF-Connecting-IP` header; only enable when deployed directly behind Cloudflare.
  - Falls back to `X-Real-IP`, direct socket address, or shared `'unknown'` bucket. Attacker-controlled leftmost headers cannot manipulate rate limit buckets.

### J. Mandatory Compliance Webhooks ([`app/lib/protocols/webhooks.js`](app/lib/protocols/webhooks.js))
- **Atomic Webhook Idempotency & Rollback:** Tracks processed webhook IDs in `ProcessedWebhook` table inside the exact same database transaction as monthly stat upserts. If stat counting fails, the idempotency marker is rolled back so Shopify delivery retries can succeed. True duplicates return `{ updatedCount: 0, duplicate: true }`. Requires `X-Shopify-Webhook-Id` header (rejects missing header with 400 on `orders/paid`). Zero order IDs or customer IDs are ever stored in `ProcessedWebhook`. Includes parameterized retention pruning (`pruneProcessedWebhooks`).
- `customers/data_request`: Shopify discards compliance webhook response bodies. By architectural design, the app accepts zero shopper or patient PII (`clientPii: null`, `clientDataStored: false`). Practitioner data (practice profiles and authored protocols) can be inspected, but an automated out-of-band delivery channel to merchants is not yet implemented.
- `customers/redact`: Tag mode removes practitioner profile and archives/deletes protocols; Company mode preserves company protocols and scrubs personal creator references. Propagates database errors to trigger Shopify retries.
- `shop/redact`: Deletes all shop protocols, lines, stats, profiles, settings, sessions, and `ProcessedWebhook` records. Propagates failures.
- `app/uninstalled`: Revokes all active shop sessions immediately.

---

## 3. Architecture & Data Flow

```mermaid
flowchart TD
    subgraph Practitioner ["Practitioner (Signed In)"]
        UI["Portal UI & Library\n(Tag Mode: Customer · B2B Mode: Company)"]
        ED["Protocol Editor\n(1-20 lines, usage notes, reorder)"]
        SH["Share Kit\n(Vector QR SVG, Printable Handout)"]
    end

    subgraph App ["App Core & Database"]
        SEC["HMAC & Rate Limiting Guard\n(timingSafeEqual, Sliding Window)"]
        API["Protocol API & Service Layer\n(Backend Permission Checks)"]
        DB[("PostgreSQL via Prisma\nProtocol · Lines · Profiles · OrderStats · WebhookLog")]
        RL["RFC 4180 CSV Reports\n(Aggregate Monthly Counters)"]
        WH["Webhook Router\n(orders/paid · GDPR Compliance)"]
    end

    subgraph Client ["Client (Storefront Visitor)"]
        PX["App Proxy Page\n/apps/protocols/:token (Liquid, noindex)"]
        CART["Cart AJAX POST /cart/add.js\n(_protocol_token, _protocol_id)"]
    end

    UI --> API
    ED --> API
    SH --> API
    API --- DB
    SEC --- PX
    PX --- DB
    PX --> CART
    CART -->|"orders/paid"| WH
    WH --- DB
    DB --- RL
```

---

## 4. Database Schema (Prisma)

The PostgreSQL data model is defined in [`prisma/schema.prisma`](prisma/schema.prisma):

- **`Protocol`**: ID, shop, token (unique, $\ge 16$ chars), name ($\le 60$), introNote ($\le 500$), displayName, ownerType (`customer` or `company`), ownerId, createdBy, updatedBy, status (`active`, `archived`, `disabled`), isStarter, sourceProtocolId, timestamps.
- **`ProtocolLine`**: ID, protocolId (cascade delete), position, variantGid, quantity (1–10), usageNote ($\le 200$), unique on `(protocolId, variantGid)`.
- **`PractitionerProfile`**: ID, shop, ownerType, ownerGid, practiceName (merchant-controlled), logoUrl, isApproved, unique on `(shop, ownerGid)`.
- **`ProtocolOrderStat`**: ID, shop, protocolId, ownerId, month (`YYYY-MM`), orders, units, revenueMinor (BigInt, cents), currency, unique on `(shop, protocolId, month, currency)`.
- **`ProcessedWebhook`**: ID, shop, webhookId, topic, processedAt, unique on `(shop, webhookId)`.
- **`Setting`**: Shop (PK), identityMode (`tag` vs `company`), footerDisclaimer, handoutText.
- **`Session`**: Shopify session storage table matching `@shopify/shopify-app-session-storage-prisma`.

---

## 5. Local Setup & Testing

### Prerequisites
- Node.js $\ge 22.12$ (tested on Node v22 and Node v24)
- PostgreSQL 16 (for optional live database integration tests)

### Installation
```bash
cd 04-practitioner-protocols
npm install
```

### Running Tests
The project features a deterministic test suite using native Node.js test runner (`node:test`):

```bash
# Run all 272 pure unit tests using mock database interfaces (zero external network dependencies, ~90ms):
npm test

# Run PostgreSQL live database integration tests against a running Postgres instance:
npm run test:db
```

> **Database Tests & Migrations Note:** `npm test` runs 272 pure unit tests against deterministic mock database interfaces. Real PostgreSQL coverage exists when `npm run test:db` is run against PostgreSQL running on `localhost:5432` with database `practitioner_protocols` and migrations applied. The live integration test suite verifies 10/10 tests against real PostgreSQL, including row-level locking (`FOR UPDATE`), transaction rollbacks, multi-line replacement, webhook idempotency, and GDPR compliance.

### Applying Migrations (PostgreSQL)
When running against a live PostgreSQL database, apply the versioned migrations in order:
```bash
# 1. Initial schema:
psql $DATABASE_URL -f prisma/migrations/20261021_init/migration.sql

# 2. Currency unique key & webhook idempotency table:
psql $DATABASE_URL -f prisma/migrations/20261022_add_currency_to_stat_unique_and_idempotency/migration.sql
```

---

## 6. Directory Structure

```text
04-practitioner-protocols/
├── app/
│   └── lib/
│       └── protocols/
│           ├── token.js         # Cryptographic share token generator & validator
│           ├── validation.js    # Schema validation & zero-PII enforcement barrier
│           ├── permissions.js   # Authorization guard (Tag vs B2B Company mode)
│           ├── attribution.js   # Cart AJAX payload builder & webhook line extractor
│           ├── qr.js            # Pure vector QR SVG generator (GF(256) Reed-Solomon)
│           ├── handout.js       # Printable HTML/CSS handout generator (Letter & A4)
│           ├── proxy.js         # App Proxy HMAC verifier & theme Liquid renderer
│           ├── catalog.js       # Batch variant GraphQL resolver & enrichment (M2)
│           ├── portal.js        # Practitioner portal library, editor, & concurrent edit check
│           ├── admin.js         # Merchant admin controls & RFC 4180 CSV export
│           ├── rate-limit.js    # In-memory sliding-window rate limiter
│           ├── webhooks.js      # Shopify compliance & order attribution webhooks
│           ├── service.js       # Transactional PostgreSQL service layer (withTransaction)
│           └── routes.js        # HTTP request controllers & webhook router
├── docs/
│   ├── BUILD_PLAN.md            # Milestones and progress tracker
│   ├── M1_CONTRACT.md           # Runtime contract specification
│   ├── PROPOSAL_CATALOG_RESOLVER.md # Storefront API variant resolution proposal
│   └── SPEC.md                  # Comprehensive architectural specification
├── prisma/
│   ├── schema.prisma            # PostgreSQL data models
│   └── migrations/              # Versioned SQL DDL migrations
├── test/
│   ├── token.test.js            # Token entropy & format tests
│   ├── validation.test.js       # Input bounds & PII rejection barrier tests
│   ├── permissions.test.js      # Role & ownership isolation tests
│   ├── attribution.test.js      # Cart payload & mixed-cart attribution tests
│   ├── handout.test.js          # QR SVG & printable handout tests
│   ├── proxy.test.js            # App Proxy HMAC & Liquid state tests
│   ├── catalog.test.js          # Catalog resolver batch GraphQL & fallback tests
│   ├── portal.test.js           # Library, editor, & concurrent-edit tests
│   ├── admin.test.js            # Approvals, starters, disable, & CSV export tests
│   ├── rate-limit.test.js       # Sliding window rate limiter tests
│   ├── webhooks.test.js         # GDPR compliance & orders/paid webhook tests
│   ├── routes.test.js           # HTTP API controllers & router tests
│   └── database.integration.test.js # PostgreSQL integration tests
├── CLAUDE.md                    # Repository conventions & safety agreements
├── PROJECT_CONTEXT.md           # Append-only chronological engineering log
└── package.json                 # Native ESM package manifest
```

---

## 7. Security, Privacy & Compliance Guarantees

1. **Zero Client/Patient PII:** Validated across all layers. The app rejects client-identifying or clinical keys (`patientName`, `clientEmail`, `medicalDiagnosis`, etc.) both at top level and inside line items (`PII_NOT_ALLOWED`).
2. **Fail-Closed Cryptography:** All HMAC signatures (App Proxy and Webhooks) are verified using `crypto.timingSafeEqual`. App Proxy routes fail closed with HTTP 500 when `apiSecret` is missing and HTTP 401 when signatures are invalid.
3. **Liquid Injection Defense:** Delimiters (`{{`, `}}`, `{%`, `%}`) in user-supplied strings are neutralized via HTML entities and Unicode escapes, preventing server-side template injection when Shopify parses App Proxy Liquid.
4. **Fully Parameterized SQL:** Database interactions use parameterized queries (`$1, $2, ...`) inside a connection pool safe `withTransaction` wrapper ensuring single-client checkout and atomic rollbacks.
5. **No Search Indexing:** App Proxy responses unconditionally include `<meta name="robots" content="noindex, nofollow">` to prevent indexing of recommendation links.
6. **Anti-Spoofing Rate Limiting:** Public proxy routes are guarded by sliding-window rate limiting enabled by default, using rightmost proxy IP extraction to prevent header spoofing.
7. **Transactional Webhook Idempotency & Error Propagation:** Webhooks track `X-Shopify-Webhook-Id` atomically within the order attribution transaction. All webhook dispatch and database errors propagate retryable 5xx responses.

---

## 8. License & Contact

- **License:** MIT License — Open for the Shopify merchant and developer community.
- **Maintainer:** Arsalan Arshad ([arsalanarshad.dev@gmail.com](mailto:arsalanarshad.dev@gmail.com))
