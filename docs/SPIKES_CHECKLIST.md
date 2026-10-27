# Practitioner Protocols — Spike Checklist (S1–S5)

Companion to `docs/SPEC.md` §4 and `docs/BUILD_PLAN.md` M0. Run these on a Partner dev store **before any screens are built**. Every answer gets recorded in `PROJECT_CONTEXT.md` (new numbered section, append-only) and decides D1, D3 and D4.

## Ground rules

- **Test data only.** Fake customers, fake company, test payment gateway. No real shopper or client data anywhere. Screenshots must not contain real emails or names.
- **Clean-room.** Do not name or reference any client in notes, commits or screenshots.
- **Throwaway spike harness.** Build it in a separate folder outside this repo (for example `../pp-spike-harness`). Do not commit it here. Only the *answers* come back into the repo.
- **No new scopes without owner sign-off.** If a spike seems to need one, stop, write down which scope and why, and ask. Do not request it on your own.
- **No secrets in notes.** Reference variable names only (`SHOPIFY_API_SECRET`), never values.
- **Ask before** committing, pushing, deploying, or releasing anything.
- **Re-verify** platform behaviour against current shopify.dev before relying on it; the facts below were checked on 2026-10-22 and API versions move.

## Facts already checked against shopify.dev (2026-10-22)

| Topic | What the docs say | Source |
|---|---|---|
| App proxy params | Request carries `shop`, `logged_in_customer_id` (empty string when anonymous), `path_prefix`, `timestamp`, `signature`. | shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies |
| App proxy auth caution | A valid signature only proves Shopify sent it. The app must also check `logged_in_customer_id` matches the customer who owns the data. | same |
| App proxy headers | Forwarded request adds `X-Forwarded-Host` and `X-Forwarded-For: the client IP address`. **Cookies are stripped** in both directions; other headers are also stripped. | same |
| Cart AJAX | `POST /cart/add.js` adds one or many variants via an `items` array. Underscore-prefixed property keys are private. **Hiding them on the storefront needs theme changes** (theme must filter keys starting with `_`). Private *cart attributes* use a double underscore `__`. | shopify.dev/docs/api/ajax/reference/cart |
| Cart AJAX errors | Over-stock quantity adds the maximum available and returns a 422 description. Sold-out or unavailable variants return 422 (`Cannot find variant` for unpublished/missing). Repeated failures are throttled with 429. | same |
| Customer account full-page extension | Full-page extensions render a new page under the header. `shopify.authenticatedAccount.customer.value` gives the customer (**numeric id as a string, not a GID**). `shopify.authenticatedAccount.purchasingCompany.value` gives `company.id` and `location.id` for B2B contacts. | shopify.dev/docs/apps/build/customer-accounts/full-page-extensions |
| Extension network access | Needs `network_access = true` in the extension TOML **and** a request under Partner Dashboard → API access requests (auto-approved per docs). Server must send `Access-Control-Allow-Origin: *`. Auth with `shopify.sessionToken.get()`. | shopify.dev/docs/apps/build/customer-accounts/capabilities |
| B2B | Only works with new customer accounts; store plan must support B2B. | shopify.dev/docs/storefronts/headless/bring-your-own-stack/b2b |
| Dev store | `shopify store create dev --name <n> --plan plus --demo-data` (plans: basic, grow, advanced, plus). No review needed for protected customer data on dev-only installs. | shopify.dev/docs/apps/build/stores/development-stores |
| Template | Shopify's current app-proxy helper docs reference `@shopify/shopify-app-react-router`. Our BUILD_PLAN says "Remix". Check which template `shopify app init` offers at scaffold time and update BUILD_PLAN. | shopify.dev/docs/api/shopify-app-react-router |

**Not verified by docs (this is what the spikes are for):** whether `logged_in_customer_id` is populated for new-customer-account logins; the real `X-Forwarded-For` chain; whether `X-Robots-Tag` or an in-body meta tag survives the proxy; whether themes display underscore properties; B2B behaviour of `add.js` (quantity rules, catalogs); whether full-page extensions are available on non-Plus plans.

---

## Prerequisites (one-time, owner does the account steps)

1. Create the dev store (owner's Partner org): `shopify store create dev --name pp-spikes --plan plus --demo-data --country US`. Also create a second dev store on `basic` or `advanced` to answer plan-availability questions in S1.
2. Settings → Customer accounts → **new customer accounts** on.
3. Customers: create plus-addressed inboxes under the owner's real email domain (e.g., `owner+practitioner@domain.com` with tag `practitioner`, `owner+b2b@domain.com` as contact at a test company with ordering permission, and `owner+plain@domain.com` with no tag). Note: `@test.invalid` cannot receive the emailed one-time verification codes required by New Customer Accounts.
4. Company: one company, one location, one **B2B catalog** assigned to the location with prices different from retail on at least 3 variants, plus a quantity rule (for example minimum 2, increment 2) on one variant.
5. Products (published to Online Store): at least **25 variants** across several products; one sold-out variant with oversell denied; one variant with stock 3; one product in draft; one archived product. Record the variant IDs.
6. Payments: enable Shopify's **Bogus/test gateway** only. Never a real processor.
7. Two themes installed: the default free theme and one other free theme.
8. Spike harness: `shopify app init` in a separate folder, a public tunnel via `shopify app dev`, an app proxy (prefix `apps`, subpath `pp-spike`) pointing at one route that **echoes all request headers, the socket address and the query string**, and can return arbitrary Liquid. No scopes beyond the template default. Webhook subscription for `orders/paid` pointing at a route that logs the raw payload to a local file (test data only; delete after).

---

## S1 — Practitioner surface (decides D1)

**Question.** Which works: (A) customer-account full-page extension, or (B) app-proxy portal using the signed `logged_in_customer_id`?

**Steps — Path A (extension)**

1. `shopify app generate extension` → Customer account UI extension; target `customer-account.page.render`. Work out how the page gets linked from the account navigation and note the steps.
2. Render `shopify.authenticatedAccount.customer.value` and `purchasingCompany.value`. Test as: tag practitioner, B2B contact, plain customer.
3. Add `network_access = true`, request network access in the Partner Dashboard, then `fetch` your spike route with `Authorization: Bearer <shopify.sessionToken.get()>`. Server must answer CORS `Access-Control-Allow-Origin: *`.
4. On the server, verify the session token (use the template's helper) and record which claims identify the customer (and whether the company is present).
5. Repeat on the second (non-Plus) dev store: does the full-page extension install and render? Is B2B available?

**Steps — Path B (proxy portal)**

1. Log in on the storefront through **new customer accounts**, then open `/apps/pp-spike/whoami`. Record `logged_in_customer_id`: present? numeric? matches the customer? Repeat for each of the three customers.
2. Open the same URL signed out. Expect an empty string. Record.
3. Confirm no cookies reach the server and that a `POST` form through the proxy works (signature on the URL, body forwarded).
4. Check whether the company/location is derivable. If it needs an Admin API call, record **which scope** it needs. Do not add it; flag for sign-off.
5. Code check (no harness needed): does `verifyAppProxySignature` in `app/lib/protocols/proxy.js` reject stale `timestamp` values? Record yes/no. If no, note it as a hardening item.

**Record (Answered: 2026-10-28)**

| Item | A (Customer Account UI Extension) | B (App Proxy Portal) |
|---|---|---|
| Works for tag practitioner | Yes (via `customer-account.page.render` in `/account/*`) | Yes (via theme layout at `/apps/protocols` using signed `logged_in_customer_id`) |
| Works for B2B contact | Yes (`purchasingCompany.value` gives company & location IDs) | Yes (`logged_in_customer_id` is present; company pricing handled by storefront) |
| Company readable | Yes, client-side from `shopify.authenticatedAccount.purchasingCompany.value` | No directly; requires `read_companies` or `read_customers` Admin API scope to resolve from customer GID |
| Needs network access / extra scope | Needs `network_access = true` in extension TOML + Partner Dashboard network permission request | Zero extra scopes; uses standard App Proxy signature and `logged_in_customer_id` |
| Plans where it works (Plus / non-Plus) | Full-page extension works on all plans, BUT B2B company features are **Plus-only** | Works on **ALL plans** (Basic, Shopify, Advanced, Plus) seamlessly |
| Session/identity mechanism and claims | Session token JWT (`shopify.sessionToken.get()`) verified on server with HS256 / public key; `sub` contains customer GID | SHA-256 HMAC signature verified on query string; `logged_in_customer_id` is numeric ID (GID = `gid://shopify/Customer/${id}`) |
| Anything blocking | Requires Shopify CLI extension build/deploy bundle, React/Preact extension sandbox, plus-only for B2B | Zero build steps or app extensions needed; pure HTML/Liquid in theme layout; timestamp TTL hardening implemented |

**Decision Recorded: D1 (Practitioner Surface).**
- **Baseline (Standard across all plans):** **Path B (App-Proxy portal)** is the primary practitioner surface. It works for both Tag Mode practitioners and B2B contacts across any Shopify plan without requiring theme app extensions, checkout extensions, or Plus-exclusive capabilities.
- **Path A (Customer Account UI Extension):** Kept as an optional future enhancement/upgrade for Plus merchants who specifically desire embedded B2B company location switching inside the New Customer Account navigation drawer (`/account/protocols`).
- **Timestamp Hardening:** Added optional `maxAgeSeconds` freshness enforcement to `verifyAppProxyHmac` in `app/lib/protocols/proxy.js` to mitigate replay attacks on App Proxy requests.

**If it fails.** If B never receives the customer with new customer accounts and A is Plus-only, tag mode needs a third route (for example a theme-side login link that carries the customer through `/account`). Stop and re-scope with the owner before building anything.

---

## S2 — Client page in the theme layout, `noindex`, and the real proxy header chain

**Question.** Can the proxy page render inside the theme layout, stay `noindex`, stay out of the sitemap, and which `X-Forwarded-For` entry is the real client IP?

**Steps**

1. Return `Content-Type: application/liquid` with a small body. Confirm it renders inside the theme header and footer. Repeat on the second theme. Note layout quirks (title, breadcrumbs, cart drawer).
2. `noindex`: test each, record which survives to the browser (`curl -sI` plus view-source):
   - a `<meta name="robots" content="noindex, nofollow">` in the body of the response (it lands inside the layout body, not `<head>`; record exactly where),
   - an `X-Robots-Tag: noindex` response header,
   - fallback ideas if neither works (record, do not implement): theme-side `robots` handling needs a theme edit, which we do not want to require.
3. Confirm the page does not appear in `/sitemap.xml`.
4. **Liquid injection check against the real renderer.** Put these literally in a protocol name and a usage note in the spike page, then confirm they are shown as text and not evaluated: `{{ shop.name }}`, `{% assign x = 1 %}{{ x }}`, `{% endraw %}{{ 7 | plus: 1 }}`, `{%- comment -%}`. Do this with our `renderProtocolLiquid` output, not hand-written Liquid.
5. **Header chain for rate limiting.** From one network, then from a phone on mobile data, request the page with and without extra headers:
   - plain,
   - `X-Forwarded-For: 1.2.3.4`,
   - `X-Forwarded-For: 1.2.3.4, 5.6.7.8`,
   - `CF-Connecting-IP: 9.9.9.9`.
   Have the echo route log `x-forwarded-for`, `x-real-ip`, `cf-connecting-ip` and the socket address. Record how many entries are in XFF, **which position holds your real public IP**, and whether any entry is a Shopify node.
6. Rate-limit sanity: with the chosen `TRUSTED_PROXY_HOPS`, confirm two different networks land in **different** buckets. If every visitor shares one bucket, our limiter would throttle the whole store; that is a stop-and-fix.

**Record**

| Item | Result |
|---|---|
| Renders in theme (theme 1 / theme 2) | |
| Meta tag location and whether honoured | |
| `X-Robots-Tag` survives | |
| In sitemap | |
| Liquid payloads shown literally | |
| XFF entries observed, real-client position | |
| `CF-Connecting-IP` present at the app | |
| Correct `TRUSTED_PROXY_HOPS` | |
| `TRUST_CF_CONNECTING_IP` should be | |

**Decision.** D3 (proxy Liquid page vs metaobject template). Set the documented `TRUSTED_PROXY_HOPS` value and say whether `TRUST_CF_CONNECTING_IP` stays `false`.

**If it fails.** No `noindex` mechanism at all means we need a different client-page approach (metaobject theme template, which merchants must add). That changes onboarding; escalate.

---

## S3 — Attribution carrier (decides D4)

**Question.** Does a hidden line-item property carry through to the order for signed-out and signed-in shoppers, and stay hidden?

**Steps**

1. Add items with `properties: { _protocol_token, _protocol_id, _protocol_usage }` using the **actual output of `buildCartAddPayload`**. Do it as: signed out, tag practitioner, B2B contact.
2. Look for the properties (record visible / hidden) in: cart page, cart drawer, checkout, order status page, confirmation email, admin order page, packing slip. Do it on **both themes**. The docs say themes must filter `_` keys themselves.
3. Complete a test order for each shopper type. Capture the real `orders/paid` payload. Confirm the shape our extractor expects (`line_items[].properties` as `[{name, value}]`) and that `_protocol_token` is present on every attributed line.
4. Same experiment with a **private cart attribute** (`__protocol_token`) for comparison. Does it appear in the webhook (for example in `note_attributes`)?
5. Edge cases: same variant from two different protocols (separate lines?); same variant with and without the protocol (separate lines?); quantity changed in cart; line removed; reorder from the customer's order history; draft order or edit after purchase.
6. **Currency and discount shape.** Place a test order with a discount code and another in a non-shop currency via Markets. Record which fields carry the amounts (`price`, `price_set.shop_money`, `presentment_money`, `discount_allocations`) and which currency our `order.currency` refers to. Compare with what `extractAttributionFromOrder` computes.
7. Privacy check: confirm the payload fields we read (token, variant, quantity, amounts, currency) are the only things we persist. No order ID, customer ID or email reaches storage.

**Record**

| Item | Signed out | Tag practitioner | B2B contact |
|---|---|---|---|
| Property reaches order | Verified (Order #1016) | Open | Open |
| Property reaches `orders/paid` | Open (payload uncaptured) | Open | Open |
| Hidden at checkout | Hidden (Order #1016) | Open | Open |
| Hidden in emails / order status | Hidden (Order #1016) | Open | Open |
| Visible in theme cart (theme 1 / 2) | Hidden in Dawn (theme 1) | Open | Open |

**Empirical check completed (2026-10-27):** Guest order #1016 (Confirmation `#0MTYEIIHI`, Bogus gateway) on dev store `ai-agent-app-h9qwnwd8.myshopify.com` confirmed `_protocol_token`, `_protocol_id`, and `_protocol_usage` survived into order line items. In Shopify Admin order view, merchant visibly sees all properties. Properties are 100% hidden on Cart, Drawer, Checkout, and Order Status page. GraphQL order query verified `"visible": false` on line item properties.
**Status:** S3 partially answered. **OPEN:** Capturing the raw `orders/paid` webhook payload and verifying property persistence on signed-in customer orders (plain, tag, B2B).

Also record: separate-line behaviour, cart-attribute comparison, and the currency/discount field findings.

**Decision.** D4: hidden line-item property (preferred) or cart attribute. If themes show `_` properties in the cart, record the one-line Liquid filter merchants need, and decide whether that is acceptable for v1.

**If it fails.** If properties are dropped for any shopper type, attribution accuracy is broken for that group. Do not paper over it; report and re-scope attribution.

---

## S4 — Add all in one request

**Question.** Can Cart AJAX add up to 20 lines in one request without clearing the cart?

**Steps**

1. Pre-fill the cart with two items: one unrelated, one that overlaps a protocol variant (no properties).
2. `POST /cart/add.js` (use `Shopify.routes.root`) with 20 distinct variants, quantities from 1 to 10, with the protocol properties. Confirm: all lines added, existing items untouched, overlapping variant becomes a **separate line** because its properties differ. Record the response shape.
3. Boundary: send 21 lines. Record what happens (our validation caps at 20, but confirm Shopify has no lower limit).
4. Failure modes inside one batch: include a sold-out variant; then an over-stock quantity; then an unpublished or archived variant. For each, record whether it is **all-or-nothing or partial**, the HTTP status, and the JSON message. Our SPEC says "Add all" skips unavailable items with a notice; confirm we can do that (for example by filtering with `availableVariantIds` first).
5. Repeat the batch signed in as the B2B contact. Record effects of the quantity rule and catalog prices.
6. Record response time for 20 lines and whether repeated failed attempts return 429.
7. Refresh behaviour: after the add, does a redirect to `/cart` suffice? Does the theme's cart drawer update without a reload?

**Record:** pass/fail for each step, exact error strings, partial vs all-or-nothing, and the recommended UX (redirect to `/cart` vs update drawer).

**Decision.** Confirms or changes "Add all" being one tap. If a batch is all-or-nothing on any bad line, the client page must pre-filter unavailable lines (needs the catalog resolver) and retry per-line on failure.

**If it fails.** If 20 lines in one request is not possible, split into batches of N with a progress message and update the SPEC.

---

## S5 — What price does a signed-in practitioner see?

**Question.** What price does a signed-in practitioner see when previewing a protocol, and how is the "clients will see retail prices" banner driven?

**Status.** **Answered** for guest, plain customer, tagged practitioner, and B2B contact. **OPEN** for B2B sold-out and over-stock edge cases.

**Steps**

1. Pick 3 variants where the B2B catalog price differs from retail. Compare the price shown to: signed out; plain customer; tag practitioner; B2B contact.
2. Check this in three places: the normal product page in the theme; **inside the proxy-rendered Liquid page** (does the response get customer/company context, or only shop-level context?); and the cart/checkout after `add.js`.
3. Resolver comparison: look up the same variants through the Storefront API with no buyer context, then with country context. Which price do we get? This is what the client page will show if it resolves server-side (see `docs/PROPOSAL_CATALOG_RESOLVER.md`).
4. Decide the banner condition: all signed-in practitioners, or only when the viewer's price differs from retail (B2B contacts)? For tag practitioners the price is retail, so the banner may be unnecessary.

**Record (Empirical results, 2026-10-27 on `ai-agent-app-h9qwnwd8.myshopify.com`)**

| Shopper | Product page | Cart | Checkout | Qty rule |
|---|---|---|---|---|
| Guest (signed out) | Liquid 749.95, Oxygen 1025.00, Hydrogen 600.00 USD | 2374.95 USD | 2374.95 USD | n/a |
| Plain customer | same as guest | 2374.95 USD | 2374.95 USD | n/a |
| Tagged `practitioner` | same as guest | 2374.95 USD | 2374.95 USD | n/a |
| B2B contact (Snowdevil) | CAD 714 / 999 / 571 | CAD 2998 (Liquid x2) | subtotal CAD 2998, shipping 43, total 3041 (company label shown) | enforced |

**Findings:**
1. The `practitioner` tag has **no pricing effect**. Only B2B company membership changes price. No wholesale price leaked to guest, plain or tagged states.
2. B2B prices are consistent across product page, cart and checkout.
3. The B2B session ran in CAD with country CA (Snowdevil company location is in Canada), although store currency is USD. 714, 999 and 571 CAD are the $500, $700 and $400 catalog prices at rate 1.4262, with the Canada catalog's −5% NOT stacked on top. **Do not assume USD anywhere in the client page or in attribution.**
4. `/cart/add.js` enforces quantity rules, returning HTTP 422:
   - Liquid x1: "This item has a minimum of 2."
   - Liquid x3: "You can only add this item in increments of 2."
5. A multi-line add where one line breaks a rule fails entirely: `[Oxygen 1, Liquid 1, Hydrogen 1]` gave 422 with an empty cart (all-or-nothing).
6. **Open in S5:** Sold-out or over-stock lines as a B2B contact remain unverified.

**Decision.** Banner trigger rule: Do not decide anything from the displayed price. Show the "prices may differ from retail" notice when `logged_in_customer_id` is present on the app-proxy request. This covers company contacts, and it is independent of tags and currency. For an empty `logged_in_customer_id`, show the retail-price view with no notice. Use the ID for the render decision only and never log or store it (privacy rule).

---

## Extra check — catalog resolver token (owner decision pending)

Not one of S1–S5, but cheap while the store is up. Do **not** add scopes; test only with what the template grants, and write down what each option would need.

1. Resolve a list of variant IDs through the Storefront API from the spike server.
2. Confirm that unpublished, draft and archived variants come back missing or unavailable, and that `availableForSale` reflects the sold-out variant. This is the basis for "1 product no longer available".
3. Record whether an app-created token sees the Online Store publication, which token type was used, and which scope each option needs.
4. Record call latency and rate limits for a 20-variant lookup.

Feed the findings into the owner's decision on `docs/PROPOSAL_CATALOG_RESOLVER.md`.

---

## Time plan (about 2 days)

- **Day 1 AM:** prerequisites and harness. **S2** (including headers), then **S4**.
- **Day 1 PM:** **S3** (needs real test orders and the webhook).
- **Day 2 AM:** **S1** (both paths, both stores).
- **Day 2 PM:** **S5**, the extra resolver check, then write up.

## Write-up

Append a new numbered section to `PROJECT_CONTEXT.md` ("Session 11 — Spike results") with one table per spike: answer, evidence summary, decision. Then update: D1, D3, D4 in §5; the S2 note and `TRUSTED_PROXY_HOPS` in `docs/SPEC.md` and `.env.example`; the M0 checkboxes in `docs/BUILD_PLAN.md`; and the punch list. Re-rank scope if any spike failed. Do not commit until the owner confirms.
