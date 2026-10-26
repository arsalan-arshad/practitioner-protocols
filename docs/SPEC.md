# Practitioner Protocols — Spec

_Status: planned. Designed from the general "professionals recommend, clients buy" model; verify every platform claim against current docs (see the spikes) before building._

## 1. Scope (v1)
Practitioner portal, share kit, client page with add-all, per-line attribution into aggregate counters, merchant admin (practitioners, starters, disable, practice names, reports).

**Non-goals (v1):** commissions/payouts or practice-specific discounts; the app sending SMS/email to clients; any client-specific record, list or history; checkout customisation; subscriptions from a protocol page; protocol translation beyond what the theme/store already does.

## 2. Roles and permissions (enforced in the backend, not only the UI)
| Role | Can |
|---|---|
| Practitioner (signed-in customer, tag or B2B contact) | create / edit / duplicate / archive / restore / share protocols in **their own** library (tag mode) or **their company's** library (company mode) |
| Client | open a protocol link; add its products to the cart at retail |
| Merchant admin | approve practitioners, create starters, disable any protocol, set practice names, view reports |
- Starter protocols are read-only to practitioners; "use as starting point" creates an owned copy.
- A practitioner can never read or write another owner's protocol, including by direct API calls.
- Removing a practitioner (tag removed / contact removed) revokes access immediately; company-owned protocols stay with the company, personally-owned ones are archived.
- `disabled` is merchant-only and overrides everything.

## 3. Identity modes
- **Tag mode (default, any plan):** `practitioner` customer tag. Owner = customer.
- **Company mode:** B2B company contact. Owner = company; each protocol also records its creator.
Both modes use the same data model (`ownerType`, `ownerId`).

## 4. Spikes — answer these on a dev store before building screens
Run on a Partner dev store with B2B enabled and **new customer accounts**. Record answers in `PROJECT_CONTEXT.md`. See [`docs/SPIKES_CHECKLIST.md`](SPIKES_CHECKLIST.md) for the complete operational checklist, prerequisites, and step-by-step test procedure.

| # | Question | Why it matters |
|---|---|---|
| **S1** | Which practitioner surface works: **(A)** customer-account full-page extension (`customer-account.page.render`) or **(B)** an app-proxy portal using the signed `logged_in_customer_id`? Check plan availability, whether the purchasing company is readable, whether network access can be granted, and whether (B) still receives the logged-in customer with new customer accounts. | Decides the whole practitioner UI and which plans it supports |
| **S2** | Can an **app-proxy page render inside the theme layout** (Liquid response), stay `noindex` (meta tag, or header if the proxy passes it), and out of the sitemap? *Note: Also verify the exact reverse-proxy header chain and trusted proxy hop count (`TRUSTED_PROXY_HOPS`) Shopify App Proxy forwards in `X-Forwarded-For` so sliding-window rate limiting extracts the true client IP rather than an internal Shopify proxy node.* | Client page must match the store and not be indexed |
| **S3** | Does a **hidden line-item property** (underscore-prefixed) carry through to the order for signed-out and signed-in shoppers, and stay hidden at checkout? Compare with a cart attribute. | Attribution accuracy and cleanliness |
| **S4** | Can the Cart AJAX API add up to 20 lines in **one request** and keep existing cart items? | "Add all" must be one tap and never clear the cart |
| **S5** | For a signed-in practitioner previewing a protocol, what price do they see, and how do we show the "clients will see retail prices" banner? | Avoids practitioners misquoting prices |

## 5. Client page behaviour
| Situation | Behaviour |
|---|---|
| Valid active protocol | Practice name, protocol name, intro, products, notes, retail prices, **Add all** and per-line **Add** |
| Product deleted / variant removed / unpublished | Line hidden for clients; practitioner sees "1 product no longer available" in their library with a replace prompt |
| Product out of stock | Shown unavailable, skipped by Add all with a notice; follows the store's normal oversell setting |
| Client already has cart items | Add all adds to the cart; never clears it |
| Link opened twice | Quantities add again (accepted for v1) |
| Archived or disabled | Friendly "no longer active" message, no product list; restoring brings the same link back |
| Invalid or guessed token | Standard 404 |
| Store runs a sale | Client sees the sale price like any shopper |
| Practitioner signed in | Banner: "You're signed in as a professional. Clients will see retail prices." |
| Two practitioners edit at once | Last save wins with a warning if `updatedAt` changed since opened |
Always `noindex`. Prices are always the store's live retail price — a protocol never carries a price or discount, and no discount code rides on a link.

## 6. Data model (Postgres via Prisma, proposed)
| Model | Key fields |
|---|---|
| `Protocol` | id, shop, **token** (≥16 random chars, unique), name (≤60), introNote (≤500), ownerType, ownerId, createdBy, updatedBy, displayName (optional), status (`active`/`archived`/`disabled`), isStarter, sourceProtocolId, updatedAt |
| `ProtocolLine` | protocolId, position, variantGid, quantity (1–10), usageNote (≤200); unique (protocolId, variantGid); max 20 per protocol |
| `PractitionerProfile` | shop, customerGid or companyGid, practiceName (**merchant-controlled**), logo (optional) |
| `ProtocolOrderStat` | shop, protocolId, ownerId, month, orders, units, revenueMinor, currency — **aggregates only** |
| `Setting` | shop, mode, footer disclaimer, handout text |
No client name, email, phone or diagnosis field exists anywhere.

## 7. Backend API (sketch)
Practitioner requests are authenticated by the extension session token **or** the HMAC-verified app-proxy signature (per S1). Every handler checks ownership.
`GET /protocols` · `POST /protocols` · `PUT /protocols/:id` · `POST /protocols/:id/duplicate` · `POST /protocols/:id/archive` · `POST /protocols/:id/restore` · `GET /products/search?q=` (sellable catalog only) · `GET /protocols/:id/share` (link + QR assets). Admin routes live in the embedded admin and require the Shopify admin session.

## 8. QR and handout
Server-side QR generation (SVG and PNG) from the permanent link; handout is a print-optimised page with `@page` sizing for Letter and A4; the QR must scan to the correct token.

## 9. Attribution and reports
1. Add-to-cart sets a hidden per-line property with the token (S3).
2. `orders/paid` webhook reads line items' properties, resolves owner via token, and increments `ProtocolOrderStat` for **those lines only**.
3. v1 reports: orders and revenue by practice and month; by protocol (starters and their copies via `sourceProtocolId`); top products. CSV export.
4. Not v1: a practitioner-facing "client orders" count (aggregate only, never individual orders).

## 10. Compliance and data handling
- `customers/redact`: tag mode → delete the customer's profile and archive/delete their protocols; company mode → keep company protocols, clear the creator reference.
- `customers/data_request`: report profile and protocol references held for that customer.
- `shop/redact` and `app/uninstalled`: delete all shop data / revoke access.
- Declare subscriptions in `shopify.app.toml` and run `shopify app deploy` — editing TOML alone does not register them.
- Order data used: line items, properties, totals. No client identity is stored.

## 11. Review and risk
- Public app: protected customer data request (level 1 for tag lookup; keep order fields minimal), App Proxy review points, health-adjacent categories — keep copy neutral and claim-free.
- Impersonation: merchant controls practice names; protocol pages are public so abuse reporting/disable must be fast.
- Token security: unguessable tokens, no enumeration, rate limiting on the proxy page.
- Platform dependency: S1 and S2 outcomes may force a different surface; the data model and attribution survive either way.

## 12. Acceptance criteria
- A signed-in practitioner creates a 3-product protocol with notes and copies its link in under 2 minutes, desktop and mobile.
- A second practitioner in the same company (company mode) can edit it; another owner cannot read or write it, including via direct API calls.
- A signed-out phone visitor sees practice, products, notes, retail prices; **Add all** puts every in-stock item in the cart in one tap without clearing existing items.
- A paid order containing protocol lines increments exactly those lines' counters.
- Archiving changes the link to the "no longer active" message within one page load; restoring brings it back.
- A deleted or out-of-stock product never blocks Add all and is flagged to the practitioner.
- QR scans to the right link; the handout fits one page (Letter and A4).
- Protocol pages are `noindex` and absent from the sitemap.
- No field anywhere accepts client-identifying information.
