# Catalog Resolver Proposal (Defect 4)

_Architecture proposal, trade-off evaluation, and injectable interface specification for resolving product title, retail price, and in-stock state on protocol client pages._

---

## 1. Executive Summary & Defect 4 Context

### The Defect
In Practitioner Protocols, when a client opens a protocol link via the App Proxy (`/apps/protocols/:token`), the backend queries the database for the protocol and its lines. The database schema (`ProtocolLine`) stores only relational metadata:
- `variantGid`: e.g. `gid://shopify/ProductVariant/41234567890123`
- `quantity`: e.g. `2`
- `usageNote`: e.g. `"Take 1 capsule twice daily with food"`
- `position`: e.g. `0`

Currently, `renderProtocolLiquid` in `app/lib/protocols/proxy.js` attempts to extract product title, variant title, price, and stock status directly from each protocol line:
```javascript
const title = line.title || line.productTitle || line.name || 'Recommended Product';
const variantTitle = line.variantTitle || '';
const price = line.price || line.priceFormatted || '';
const isAvailable = line.available !== false && line.inStock !== false;
```
Because no catalog resolution step exists between the database query and Liquid rendering:
1. **Product Title:** Always falls back to the generic string `"Recommended Product"`.
2. **Variant Title:** Always evaluates to `""`.
3. **Retail Price:** Always evaluates to `""`, leaving the client unable to see prices or estimated order totals.
4. **In-Stock State:** Always assumes `isAvailable: true`, even if the underlying variant has been deleted, unpublished, or has zero inventory with overselling disabled.

Per SPEC §5, the client page requires live retail prices, real product titles, and accurate availability states (with out-of-stock items flagged and deleted/unpublished items hidden).

---

## 2. Platform Options Comparison

We evaluate three potential architectures against Shopify platform capabilities and constraints. Every platform fact is verified against current Shopify developer documentation.

### Comparison Matrix

| Evaluation Criteria | (a) Liquid-Native Lookup (App-Proxy) | (b) Storefront API (Public Token) | (c) Admin API (`read_products`) |
| :--- | :--- | :--- | :--- |
| **Shopify Scopes Needed** | **None** | `unauthenticated_read_product_listings` | `read_products` (Admin OAuth scope) |
| **Review & Protected Data Impact** | **Zero impact** (runs in merchant theme context). | **Zero impact** (public storefront catalog data; not Protected Customer Data). | Requires App Review justification for Admin scope; not Protected Customer Data. |
| **Deleted Variants** | Fails / returns `nil` (requires knowing parent product handle first). | Returns `null` in `nodes(ids: $ids)` batch array. | Returns `null` in `nodes(ids: $ids)` batch array. |
| **Unpublished / Draft Products** | Returns `nil` via `all_products[handle]`. | **Returns `null` automatically** (strictly honors sales channel publications). | **Returns draft/unpublished items!** Requires custom filtering on `Product.status` and publications. |
| **Out-of-Stock Variants** | `variant.available` is boolean (`true`/`false`). | `ProductVariant.availableForSale` respects inventory policy & overselling. | `ProductVariant.availableForSale` respects inventory policy & overselling. |
| **Price Accuracy: Storefront Sales** | Live retail price via Liquid `variant.price`. | Live retail price via `ProductVariant.price.amount` (reflects active promotions). | Base catalog price only; ignores storefront dynamic channel discounts without contextual queries. |
| **Price Accuracy: B2B Signed-In** | **Leaking Risk:** Evaluates to practitioner's B2B catalog price if signed in with company context. | **Guaranteed Retail:** Public unauthenticated context always returns public retail price. | Base catalog price (neutral, but misses storefront promotions). |
| **Batch Lookup Capability** | **None:** Liquid has no `all_variants` lookup; limited to 20 product handles. | **High:** Single `nodes(ids: [ID!]!)` query resolves up to 250 variants in one HTTP request. | **High:** Single `nodes(ids: [ID!]!)` query resolves up to 250 variants in one HTTP request. |
| **Caching Efficiency** | Bound to full-page App Proxy caching headers (`Cache-Control`). | **High:** In-memory LRU or Redis cache by variant GID across all protocols (TTL 1–5m). | **High:** In-memory LRU or Redis cache by variant GID across all protocols (TTL 1–5m). |
| **Rate Limit & Blast Radius** | Theme rendering quota / edge execution timeouts. | High unauthenticated bucket (separate from Admin API; cannot disrupt store admin operations). | **Shared Admin Leaky Bucket:** Viral protocol traffic risks exhausting store Admin API quota. |

---

### Detailed Analysis of Options

#### Option (a): Liquid-Native Lookup in App-Proxy Response

* **Shopify Documentation Citations:**
  - App Proxies: [`shopify.dev/docs/apps/online-store/app-proxies`](https://shopify.dev/docs/apps/online-store/app-proxies)
  - Liquid `all_products` Object: [`shopify.dev/docs/api/liquid/objects/all_products`](https://shopify.dev/docs/api/liquid/objects/all_products)
  - Liquid Product Variant Object: [`shopify.dev/docs/api/liquid/objects/variant`](https://shopify.dev/docs/api/liquid/objects/variant)

* **Mechanism:**
  When an app proxy endpoint responds with `Content-Type: application/liquid`, Shopify's application edge intercepts the response and parses it through the theme's Liquid engine before streaming HTML to the browser.
* **Fatal Flaw (Lookup Impossibility):**
  Shopify Liquid does **not** provide a global `all_variants` lookup map. The only lookup object is `all_products`, which is indexed **strictly by product handle** (e.g. `all_products['daily-multivitamin']`), not by variant ID or GID. Because protocol lines store only `variantGid`, Liquid cannot resolve the variant unless the protocol line is modified to also store the product handle.
* **The 20-Product Limit:**
  Even if the product handle were stored, Shopify strictly enforces a hard limit of **20 unique product lookups per page** using `all_products`:
  > *"You can access up to 20 products by using the `all_products` object on a single page."* — Shopify Liquid Documentation.
  If a protocol has 20 items, and the merchant's theme layout (header, footer, recommendations) accesses any product via `all_products`, lookups will fail or return `nil`.
* **B2B Price Leakage:**
  If a practitioner is signed in via new customer accounts with a B2B company assignment, theme Liquid resolves `variant.price` in the session's company context, rendering wholesale prices on the protocol page. This violates SPEC §5: *"Clients will see retail prices. Avoids practitioners misquoting prices."*
* **Verdict:** **Rejected.** Structurally unviable due to lack of variant-level lookup and the 20-product limit.

---

#### Option (b): Storefront API with Public Storefront Token

* **Shopify Documentation Citations:**
  - Storefront GraphQL API: [`shopify.dev/docs/api/storefront`](https://shopify.dev/docs/api/storefront)
  - Unauthenticated Access Scopes: [`shopify.dev/docs/api/usage/access-scopes#unauthenticated-access-scopes`](https://shopify.dev/docs/api/usage/access-scopes#unauthenticated-access-scopes)
  - Storefront `nodes` Query: [`shopify.dev/docs/api/storefront/latest/queries/nodes`](https://shopify.dev/docs/api/storefront/latest/queries/nodes)
  - Storefront `ProductVariant`: [`shopify.dev/docs/api/storefront/latest/objects/ProductVariant`](https://shopify.dev/docs/api/storefront/latest/objects/ProductVariant)
  - Storefront Access Token Creation: [`shopify.dev/docs/api/admin-graphql/latest/mutations/storefrontAccessTokenCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/storefrontAccessTokenCreate)

* **Mechanism:**
  The app backend acts as an authenticated client of the Storefront GraphQL API on behalf of the public storefront, using a Storefront Access Token generated during app installation via the Admin API mutation `storefrontAccessTokenCreate(input: {title: "Practitioner Protocols Resolver"})`.
* **Scopes & Review Impact:**
  - Scope: `unauthenticated_read_product_listings`.
  - Review Impact: Zero protected customer data (PCD) impact. Product listings are public catalog data. Storefront API is purpose-built for public catalog reads.
* **Deleted, Unpublished, and Out-of-Stock Variants:**
  - **Deleted Variants:** The `nodes(ids: $ids)` query returns `null` at that array position.
  - **Unpublished / Draft Products:** If a merchant unpublishes a product or excludes it from the Online Store sales channel, Storefront API **automatically returns `null`**. It is physically impossible to leak unpublished or draft products through the Storefront API.
  - **Out-of-Stock:** Returns `availableForSale: false` on the `ProductVariant` node, accurately respecting the merchant's inventory policy (`continue` vs `deny`).
* **Price Accuracy:**
  - Storefront API queries executed without a customer buyer identity header always resolve prices at the **public storefront retail price**. Even when a practitioner is previewing their protocol while logged into their B2B customer account, the backend resolver executes an unauthenticated Storefront API query, guaranteeing that only retail prices are returned.
  - Correctly reflects active promotions, sales, and currency formats (`MoneyV2` with `amount` and `currencyCode`).
* **Caching & Rate Limits:**
  - Variants can be cached in-memory (LRU cache with a 60- to 300-second TTL) keyed by `shop:variantGid`.
  - The Storefront API operates on a separate rate limit pool from the Admin API. High traffic to public protocol share links will never exhaust the merchant's Admin API rate limit bucket.
* **Verdict:** **Recommended.** Provides optimal data isolation, automatic sales channel filtering, guaranteed retail pricing, and zero Admin API contention.

---

#### Option (c): Admin API with `read_products`

* **Shopify Documentation Citations:**
  - Admin GraphQL API: [`shopify.dev/docs/api/admin-graphql`](https://shopify.dev/docs/api/admin-graphql)
  - Admin Access Scopes: [`shopify.dev/docs/api/usage/access-scopes#admin-access-scopes`](https://shopify.dev/docs/api/usage/access-scopes#admin-access-scopes)
  - Admin `nodes` Query: [`shopify.dev/docs/api/admin-graphql/latest/queries/nodes`](https://shopify.dev/docs/api/admin-graphql/latest/queries/nodes)
  - Admin `ProductVariant`: [`shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant`](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)

* **Mechanism:**
  The backend resolves variants using the existing offline `Session` token and the Admin GraphQL API `nodes(ids: $ids)` query.
* **Scopes & Review Impact:**
  - Requires adding the `read_products` scope to `shopify.app.toml`.
  - Per `CLAUDE.md`: *"Minimal scopes: request only read-only scopes needed. Any write scope or new scope requires explicit justification and owner sign-off."*
  - In Shopify App Store review, reviewers scrutinize why an app serving customer-facing storefront pages requires backend Admin API product scopes rather than Storefront API scopes.
* **Unpublished & Draft Leakage Risk:**
  Unlike the Storefront API, the Admin API returns products regardless of publication status. A product in `DRAFT` status or archived status will still return variant nodes. To prevent leaking unpublished products to clients, the resolver must perform secondary filtering on `product.status === 'ACTIVE'` and verify channel publication via `publishedOnCurrentPublication`.
* **Rate Limits & Blast Radius:**
  The Admin API uses a leaky bucket rate limit (40 to 100 cost points per second). If a protocol link receives viral traffic or social media shares, uncached resolver queries could drain the store's Admin API rate limit, throttling critical backend background workers (e.g. order webhooks, inventory sync, or the merchant's Admin UI).
* **Verdict:** **Viable fallback, but inferior to Option (b)** due to Admin scope addition requirements, rate limit blast radius, and risk of leaking draft items.

---

## 3. Recommendation

**We recommend Option (b): Storefront API with Public Storefront Token.**

### Key Reasons:
1. **Zero Publication Leakage:** Automatically returns `null` for draft, unpublished, or archived products without custom filtering code.
2. **Guaranteed Retail Pricing:** Never leaks B2B wholesale prices during practitioner previews because the query is executed in public buyer context.
3. **Isolated Rate Limit Bucket:** Protects the store's Admin API quota from storefront traffic spikes.
4. **App Review Alignment:** Respects Shopify's architectural boundary: Storefront API for public buyer views, Admin API for merchant administration.

---

## 4. Pure Injectable Interface Specification

To decouple catalog resolution from the App Proxy controller and `renderProtocolLiquid`, we define a pure, injectable interface:

```typescript
type VariantGid = string; // e.g. "gid://shopify/ProductVariant/12345"

interface ResolvedVariant {
  variantGid: VariantGid;
  variantId: string;            // Numeric ID string: "12345"
  productTitle: string;         // e.g. "Omega-3 Pure EPA/DHA"
  variantTitle: string | null;  // e.g. "60 Softgels" (null if "Default Title")
  title: string;                // Display title: "Omega-3 Pure EPA/DHA (60 Softgels)"
  price: string;                // Decimal string: "29.99"
  priceMinor: number;           // Price in cents: 2999
  currency: string;             // ISO 4217 code: "USD"
  availableForSale: boolean;    // In-stock or backorders allowed
  isDeleted: boolean;           // true if variant was not found
  isPublished: boolean;         // true if published to online store
}

type VariantCatalogMap = Map<VariantGid, ResolvedVariant>;

interface VariantResolver {
  resolveVariants(
    shop: string,
    variantGids: string[]
  ): Promise<VariantCatalogMap>;
}
```

### Pure Functional Signature (ESM JavaScript)

```javascript
/**
 * Resolves catalog details for an array of variant GIDs.
 * Pure contract: deterministic output, never throws for missing variants (flags them as deleted).
 *
 * @param {string} shop - The shop's myshopify domain (e.g. "brand.myshopify.com")
 * @param {string[]} variantGids - Array of Shopify variant GIDs (max 20 per protocol)
 * @returns {Promise<Map<string, {
 *   variantGid: string,
 *   variantId: string,
 *   productTitle: string,
 *   variantTitle: string | null,
 *   title: string,
 *   price: string,
 *   priceMinor: number,
 *   currency: string,
 *   availableForSale: boolean,
 *   isDeleted: boolean,
 *   isPublished: boolean
 * }>>}
 */
export async function resolveVariants(shop, variantGids) {
  // Pure interface to be implemented by live adapter (Storefront API client)
}
```

### Contract Guarantees:
1. **Completeness:** Every requested GID will have an entry in the returned `Map`.
2. **Missing / Deleted Handling:** If a variant cannot be found or is unpublished, `isDeleted: true`, `isPublished: false`, `availableForSale: false`, and `title: "Unavailable Product"`.
3. **Title Normalization:** If `variantTitle` is `"Default Title"` or empty, `title` is simply `productTitle`. Otherwise, `title` is formatted as `${productTitle} - ${variantTitle}`.
4. **Minor Currency Safety:** `priceMinor` is always an integer representation in minor currency units (cents), preventing floating-point calculation errors in totals.
5. **No Network Exceptions Leaked:** Resolvers must catch upstream GraphQL errors and return fallback records with `availableForSale: false` rather than throwing uncaught exceptions to the proxy controller.

---

## 5. Testing Architecture with Fakes

Because `resolveVariants` is a pure injectable dependency, unit tests and controller integration tests can verify `renderProtocolLiquid` and proxy route behaviors with 100% determinism, zero network calls, and zero external dependencies.

### Fake Variant Resolver Implementation

```javascript
/**
 * Factory for creating a fake variant resolver for deterministic testing.
 *
 * @param {Record<string, Partial<ResolvedVariant>>} fixtures - Seed data keyed by variantGid
 * @returns {{ resolveVariants: (shop: string, variantGids: string[]) => Promise<Map<string, any>> }}
 */
export function createFakeVariantResolver(fixtures = {}) {
  return {
    async resolveVariants(shop, variantGids = []) {
      const map = new Map();

      for (const gid of variantGids) {
        const fixture = fixtures[gid];

        if (!fixture) {
          // Variant deleted or not found
          map.set(gid, {
            variantGid: gid,
            variantId: String(gid).replace(/^gid:\/\/shopify\/ProductVariant\//, ''),
            productTitle: 'Unavailable Product',
            variantTitle: null,
            title: 'Unavailable Product',
            price: '0.00',
            priceMinor: 0,
            currency: 'USD',
            availableForSale: false,
            isDeleted: true,
            isPublished: false
          });
          continue;
        }

        const productTitle = fixture.productTitle || 'Test Product';
        const variantTitle = fixture.variantTitle && fixture.variantTitle !== 'Default Title'
          ? fixture.variantTitle
          : null;
        const displayTitle = variantTitle ? `${productTitle} - ${variantTitle}` : productTitle;
        const priceMinor = fixture.priceMinor ?? Math.round(parseFloat(fixture.price || '0') * 100);

        map.set(gid, {
          variantGid: gid,
          variantId: String(gid).replace(/^gid:\/\/shopify\/ProductVariant\//, ''),
          productTitle,
          variantTitle,
          title: displayTitle,
          price: fixture.price || (priceMinor / 100).toFixed(2),
          priceMinor,
          currency: fixture.currency || 'USD',
          availableForSale: fixture.availableForSale ?? true,
          isDeleted: fixture.isDeleted ?? false,
          isPublished: fixture.isPublished ?? true
        });
      }

      return map;
    }
  };
}
```

### Unit Test Sketch for Proxy Rendering with Fake Resolver

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderProtocolLiquid } from '../app/lib/protocols/proxy.js';
import { createFakeVariantResolver } from '../app/lib/protocols/testing/fake-resolver.js';

describe('renderProtocolLiquid with Catalog Resolution', () => {
  const mockProtocol = {
    id: 101,
    token: 'proto_live_test_token_1234',
    name: 'Morning Metabolic Reset',
    status: 'active',
    lines: [
      {
        variantGid: 'gid://shopify/ProductVariant/1001',
        quantity: 2,
        usageNote: '2 capsules upon waking'
      },
      {
        variantGid: 'gid://shopify/ProductVariant/1002',
        quantity: 1,
        usageNote: '1 scoop in water'
      },
      {
        variantGid: 'gid://shopify/ProductVariant/9999', // Deleted product
        quantity: 1,
        usageNote: 'Discontinued booster'
      }
    ]
  };

  it('renders resolved product titles, formatted prices, and flags out-of-stock items', async () => {
    const resolver = createFakeVariantResolver({
      'gid://shopify/ProductVariant/1001': {
        productTitle: 'Pure Berberine HCl',
        variantTitle: '60 Veggie Caps',
        price: '34.50',
        availableForSale: true
      },
      'gid://shopify/ProductVariant/1002': {
        productTitle: 'Electrolyte Mineral Complex',
        variantTitle: null,
        price: '28.00',
        availableForSale: false // Out of stock
      }
      // gid://shopify/ProductVariant/9999 is omitted to simulate a deleted product
    });

    const catalogMap = await resolver.resolveVariants('test-shop.myshopify.com', [
      'gid://shopify/ProductVariant/1001',
      'gid://shopify/ProductVariant/1002',
      'gid://shopify/ProductVariant/9999'
    ]);

    // Enrich protocol lines with resolved data
    const enrichedProtocol = {
      ...mockProtocol,
      lines: mockProtocol.lines.map(line => {
        const item = catalogMap.get(line.variantGid);
        return {
          ...line,
          title: item.title,
          price: item.price ? `$${item.price}` : '',
          priceMinor: item.priceMinor,
          available: item.availableForSale && !item.isDeleted,
          inStock: item.availableForSale,
          isDeleted: item.isDeleted
        };
      })
    };

    const liquid = renderProtocolLiquid({ protocol: enrichedProtocol });

    // Assertions
    assert.match(liquid, /Pure Berberine HCl - 60 Veggie Caps/);
    assert.match(liquid, /\$34\.50/);
    assert.match(liquid, /Electrolyte Mineral Complex/);
    assert.match(liquid, /\$28\.00/);
    assert.match(liquid, /protocol-line-unavailable/);
    assert.match(liquid, /Out of stock/);
  });
});
```

---

## 6. Implementation Plan (Future Phase)

1. **Storage of Storefront Token:** Store the public storefront token in the database `Setting` model (`storefrontAccessToken`) or generate it lazily during app onboarding via `storefrontAccessTokenCreate`.
2. **In-Memory LRU Cache:** Wrap the resolver in a lightweight in-memory cache (keyed by `${shop}:${variantGid}`, TTL: 180s) to minimize Shopify API calls.
3. **Controller Hookup:** In `app/lib/protocols/routes.js` inside `handleAppProxyProtocolRequest`, invoke `resolveVariants` to enrich protocol lines before passing the protocol to `renderProtocolLiquid`.
4. **Library & Handout Sync:** Pass the resolved `VariantCatalogMap` into `portal.js` (`formatProtocolCard` and `calculateProtocolRetailTotal`) so the practitioner library and share handouts share the exact same price and stock state.
