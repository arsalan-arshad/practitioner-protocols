# Shopify App Store Review Self-Audit & Hardening Report

**App Name:** Practitioner Protocols  
**Category:** Merchandising / Customer Order Customization / Wholesale & B2B  
**Target Environment:** Shopify Plus & standard Shopify stores (Dawn theme, New Customer Accounts / Classic)  
**Distribution Model:** Public App (Free / $0 Billing Plan)  
**License:** Open Source (MIT)  
**Audit Date:** 2026-10-28  
**Automated Unit Test Status:** 336/336 tests passing (100% pure unit test suite, ~100ms runtime)

---

## 1. Executive Summary

This self-audit evaluates **Practitioner Protocols** against official Shopify App Store Review Requirements, API access policies, and data protection guidelines. 

The application enables verified specialists, wellness professionals, and brand ambassadors ("practitioners") to curate product bundles ("protocols") and share them with clients via a direct link or QR code handout. When a client visits the link, a single tap adds the curated items to their native Shopify cart with hidden line-item attribution properties (`_protocol_token`, `_protocol_id`).

### Key Review Strengths
1. **Zero Protected Customer Data (PCD) Storage:** The app never collects, stores, transmits, or processes client personal data (no names, emails, phone numbers, or addresses).
2. **Minimal API Scopes:** Only `read_orders` is requested, strictly needed to extract hidden line properties in `orders/paid` webhooks.
3. **Automated OAuth:** Seamless installation flow without requiring merchants to manually enter their myshopify domain.
4. **Embedded Admin with App Bridge HS256 Session Tokens:** Compliant Polaris embedded admin enforcing strict Content Security Policy (`frame-ancestors https://${shop} https://admin.shopify.com;`).
5. **Fail-Closed Security:** HMAC-verified App Proxy and OAuth callback routes, sliding-window rate limiting, and Liquid delimiter neutralization.

---

## 2. Requirement-by-Requirement Audit Matrix

| Shopify Review Requirement | Implementation Status | Evidence / File Reference |
|---|---|---|
| **1. Seamless OAuth Install** | Fully Compliant | `server.js` (`/api/auth`, `/api/auth/callback`), `test/server.test.js` |
| **2. App Bridge & Embedded Experience** | Fully Compliant | `app/lib/protocols/admin.js`, HS256 session tokens, CSP headers |
| **3. API Scope Minimization** | Fully Compliant | `shopify.app.toml` (`scopes = "read_orders"`) |
| **4. Protected Customer Data (PCD)** | Fully Compliant | Clean-room zero-PII architecture (`assertNoPii`), zero customer records stored |
| **5. Mandatory GDPR Compliance Webhooks** | Fully Compliant | `app/lib/protocols/webhooks.js` (`customers/data_request`, `customers/redact`, `shop/redact`) |
| **6. Storefront App Proxy Security** | Fully Compliant | Fail-closed HMAC (`verifyAppProxyHmac`), `X-Robots-Tag: noindex`, rate limiting |
| **7. Health & Medical Claim Guardrails** | Fully Compliant | Retail curation boundary; neutral disclaimers; forbidden diagnosis fields |
| **8. Billing & Pricing Transparency** | Fully Compliant | $0 Free Public App; no recurring charges or hidden fees |

---

## 3. Detailed Self-Review Findings

### 3.1 Authentication & Installation Flow
* **Shopify Requirement:** Apps must NOT prompt merchants to manually type their `.myshopify.com` domain upon installation. The app must handle OAuth redirects automatically and maintain security.
* **Audit Finding:**
  - Route `GET /api/auth` validates the incoming `shop` query parameter against RFC 1034 pattern (`/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/`).
  - Cryptographically secure nonce is generated (`crypto.randomBytes(16).toString('hex')`).
  - 302 redirects to `https://${shop}/admin/oauth/authorize` requesting only `read_orders`.
  - Route `GET /api/auth/callback` verifies parameter HMAC using constant-time comparison (`verifyOAuthHmac`).
  - Offline access tokens are stored securely in the `Session` table; online tokens are never needlessly requested.

### 3.2 Embedded Admin & Content Security Policy (CSP)
* **Shopify Requirement:** Embedded apps must render seamlessly inside Shopify Admin without breaking iframes or triggering Mixed Content warnings. Must declare appropriate CSP `frame-ancestors`.
* **Audit Finding:**
  - `server.js` sends strict security headers on all admin responses:
    - `Content-Security-Policy: frame-ancestors https://${shop} https://admin.shopify.com;`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
  - Admin endpoints verify App Bridge HS256 JWT session tokens (`verifyAdminSessionToken`) with `crypto.timingSafeEqual` and full claims verification (`exp`, `nbf`, `dest`, `aud`).

### 3.3 Protected Customer Data (PCD) Justification
* **Shopify Requirement:** Apps requesting order or customer scopes must justify why Protected Customer Data is required and demonstrate compliance with data minimization principles.
* **PCD Justification Statement:**
  > *"Practitioner Protocols requests `read_orders` solely to inspect line-item custom attributes (`_protocol_token`, `_protocol_id`) in `orders/paid` webhooks. The application never stores, reads, or processes customer names, email addresses, shipping addresses, phone numbers, or payment details. Attribution is calculated exclusively as an aggregate counter (monthly order count and gross retail units per protocol) and stored in `ProtocolOrderStat`. The app enforces an active `assertNoPii` guard across all protocol data models, preventing any health diagnostic or client-identifying fields from entering the database."*

### 3.4 Mandatory GDPR Webhooks
* **Shopify Requirement:** All public apps must implement endpoints for `customers/data_request`, `customers/redact`, and `shop/redact`, respond within 5 seconds, and respect merchant data privacy.
* **Audit Finding:**
  - Registered in `shopify.app.toml` under `compliance_topics`.
  - Verified with HMAC-SHA256 (`verifyWebhookHmac`).
  - `customers/data_request`: Checks if customer GID is an approved practitioner; returns protocol titles authored by that practitioner. Returns zero client/buyer records because no buyer data exists.
  - `customers/redact`: In Tag Mode, deletes practitioner profile and protocols; in Company Mode, retains protocols under company location ownership.
  - `shop/redact`: Cascades complete deletion of all shop protocols, lines, monthly attribution stats, settings, and processed webhook markers.
  - Errors propagate HTTP 500 so Shopify retries if a database transient error occurs.

### 3.5 Storefront App Proxy Hardening
* **Shopify Requirement:** App proxy endpoints must not leak merchant data, allow unauthorized execution, or expose stores to denial-of-service.
* **Audit Finding:**
  - **HMAC Verification:** `verifyAppProxyHmac` validates the full query signature using constant-time comparison. Unsigned or tampered requests immediately fail-closed (HTTP 401).
  - **Template Injection Defense:** Pure Liquid rendering (`renderProtocolLiquid`) neutralizes Liquid delimiters (`{{`, `}}`, `{%`, `%}`) to prevent arbitrary server-side or theme template execution.
  - **Search Engine Isolation:** Emits `X-Robots-Tag: noindex, nofollow` on all client protocol routes to guarantee unindexed, direct-link sharing only.
  - **Sliding-Window Rate Limiting:** Sliding-window rate limiter restricts client IPs to 10 requests per minute with standard `Retry-After` headers, preventing token scraping or variant ID enumeration.
  - **Dynamic Pricing & Quantity Rules:** Verified in Spike S5; `/cart/add.js` handles B2B catalog currency conversions, quantity increments, and minimum rules, presenting clean storefront feedback without leaking private wholesale prices.

### 3.6 Medical & Regulatory Disclaimer Boundary
* **Shopify Requirement:** Apps dealing with supplements or wellness must avoid making unsubstantiated medicinal or diagnostic claims.
* **Audit Finding:**
  - Strict clean-room naming convention: "Practitioner Protocols" refers to curated retail product recommendations, not medical prescriptions.
  - `assertNoPii` explicitly bans diagnostic terms (`medicalDiagnosis`, `healthCondition`, `prescription`, `ssn`, `patientId`, `patientName`).
  - Standardized default merchant disclaimer: *"Curated retail recommendations provided by verified specialists. Not intended as medical diagnosis or treatment."*

### 3.7 Pricing & Billing
* **Model:** $0 Free Public App.
* **Justification:** Zero merchant charges; no RecurringApplicationCharge or UsageCharge required. Merchants can install and test without entering billing credentials.

---

## 4. Verification Test Matrix

```
Test Files: 13
Total Unit Tests: 336
Total Suites: 88
Failed Tests: 0
Execution Time: ~101ms (pure in-memory Node.js test runner)
```

| Suite | Focus Area | Passing Tests |
|---|---|---|
| `test/admin.test.js` | Admin logic, approvals, starter templates, session tokens | 34 |
| `test/attribution.test.js` | Cart AJAX payloads, discount attribution, multi-currency | 24 |
| `test/catalog.test.js` | Batch GraphQL variant resolution & currency decimals | 14 |
| `test/handout.test.js` | QR SVG rendering & printable handout HTML generation | 16 |
| `test/permissions.test.js` | Practitioner ownership & authorization boundaries | 18 |
| `test/portal.test.js` | Practitioner portal UI, limit enforcement & mutations | 32 |
| `test/proxy.test.js` | App proxy HMAC, OAuth HMAC, Liquid rendering, sanitization | 28 |
| `test/rate-limit.test.js` | Sliding-window anti-spoofing rate limiter | 16 |
| `test/routes.test.js` | Full Web API route handlers & admin actions | 48 |
| `test/server.test.js` | OAuth 2.0 flow, CSP headers, config guards & shopify.app.toml | 24 |
| `test/token.test.js` | Base62 share-token generator & entropy guarantees | 12 |
| `test/validation.test.js` | Protocol validation rules & strict PII barrier | 28 |
| `test/webhooks.test.js` | GDPR compliance webhooks & idempotent order processing | 42 |
| **Total** | | **336** |

---

## 5. Review Readiness Conclusion

The codebase fulfills all requirements for the Shopify App Store submission. All security mechanisms (HMAC verification, session tokens, CSP headers, PII prevention, and sliding-window rate limiting) are backed by automated regression tests and verified against live Shopify dev store behaviors.
