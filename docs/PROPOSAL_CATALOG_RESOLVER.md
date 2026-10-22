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

### Scope & Review Warning (Under CLAUDE.md)
Creating a Storefront access token fails for an app without unauthenticated scopes. Therefore, **Option (b) REQUIRES adding a new access scope (`unauthenticated_read_product_listings`)**. This is a scope addition and under `CLAUDE.md` requires **explicit owner sign-off**. It is **not** a "zero scope" change.

---

## 2. Platform Options Comparison

We evaluate three potential architectures against Shopify platform capabilities and constraints. Every platform fact is verified against current Shopify developer documentation.

### Comparison Matrix

| Evaluation Criteria | (a) Liquid-Native Lookup (App-Proxy) | (b) Storefront API (Private Server Token) | (c) Admin API (`read_products`) |
| :--- | :--- | :--- | :--- |
| **Shopify Scopes Needed** | **None** | **`unauthenticated_read_product_listings`** (Requires Owner Sign-off) | `read_products` (Admin OAuth scope) |
| **Token Type & Headers** | N/A (runs in theme context) | **Private Storefront Token** (`Shopify-Storefront-Private-Token`) | Offline Access Token (`X-Shopify-Access-Token`) |
| **Review & Protected Data Impact** | **Zero impact** (runs in merchant theme context). | **Zero PCD impact** (public storefront catalog data; not Protected Customer Data). | Requires App Review justification for Admin scope; not Protected Customer Data. |
| **Deleted Variants** | Fails / returns `nil` (requires knowing parent product handle first). | Returns `null` in `nodes(ids: $ids)` batch array. | Returns `null` in `nodes(ids: $ids)` batch array. |
| **Unpublished / Draft Products** | Returns `nil` via `all_products[handle]`. | **UNVERIFIED (Requires dev-store check in Spike S2):** Docs indicate sales channel publications govern visibility; must verify whether app-created token only sees published products. | **Returns draft/unpublished items!** Requires custom filtering on `Product.status` and publications. |
| **Out-of-Stock Variants** | `variant.available` is boolean (`true`/`false`). | `ProductVariant.availableForSale` respects inventory policy & overselling. | `ProductVariant.availableForSale` respects inventory policy & overselling. |
| **Price Accuracy & Markets** | Live retail price via Liquid `variant.price`. | Live contextual retail price via `@inContext(country, language)`. Note: automatic cart-level discounts will **not** appear in Storefront variant prices. | Base catalog price only; misses storefront promotions and currency contexts. |
| **Price Accuracy: B2B Signed-In** | **Leaking Risk:** Evaluates to practitioner's B2B catalog price if signed in with company context. | **Guaranteed Retail:** Public unauthenticated context always returns public retail price. | Base catalog price (neutral, but misses storefront promotions). |
| **Batch Lookup Capability** | **None:** Liquid has no `all_variants` lookup; limited to 20 product handles. | **High:** Single `nodes(ids: [ID!]!)` query resolves up to 250 variants in one HTTP request. | **High:** Single `nodes(ids: [ID!]!)` query resolves up to 250 variants in one HTTP request. |
| **Rate Limit & Blast Radius** | Theme rendering quota / edge execution timeouts. | Separate Storefront rate limit bucket; cannot exhaust store Admin API quota. | **Shared Admin Leaky Bucket:** Viral protocol traffic risks exhausting store Admin API quota. |

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

#### Option (b): Storefront API with Private Server Token (Recommended)

* **Shopify Documentation Citations:**
  - Storefront GraphQL API: [`shopify.dev/docs/api/storefront`](https://shopify.dev/docs/api/storefront)
  - Unauthenticated Access Scopes: [`shopify.dev/docs/api/usage/access-scopes#unauthenticated-access-scopes`](https://shopify.dev/docs/api/usage/access-scopes#unauthenticated-access-scopes)
  - Storefront `nodes` Query: [`shopify.dev/docs/api/storefront/latest/queries/nodes`](https://shopify.dev/docs/api/storefront/latest/queries/nodes)
  - Storefront `ProductVariant`: [`shopify.dev/docs/api/storefront/latest/objects/ProductVariant`](https://shopify.dev/docs/api/storefront/latest/objects/ProductVariant)
  - Storefront Context Directive (`@inContext`): [`shopify.dev/docs/api/storefront/latest/directives/inContext`](https://shopify.dev/docs/api/storefront/latest/directives/inContext)
  - Storefront Access Tokens: [`shopify.dev/docs/api/admin-graphql/latest/mutations/storefrontAccessTokenCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/storefrontAccessTokenCreate)

* **Mechanism:**
  The app backend acts as a server-side client of the Storefront GraphQL API. Rather than using a public client-side token, the backend uses a **Private Storefront Token** (`Shopify-Storefront-Private-Token` header), which Shopify documentation explicitly recommends for confidential server-to-server calls.
* **Scope Addition (Mandatory Owner Sign-off):**
  - Requires requesting `unauthenticated_read_product_listings` in `shopify.app.toml`.
  - Creating a Storefront access token fails without this unauthenticated scope.
* **Market & Currency Handling (`@inContext`):**
  By applying `@inContext(country: $country, language: $language)`, the query resolves prices and titles accurately in the buyer's storefront country and language:
  ```graphql
  query ResolveProtocolVariants($ids: [ID!]!, $country: CountryCode, $language: LanguageCode)
  @inContext(country: $country, language: $language) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        availableForSale
        price {
          amount
          currencyCode
        }
        product {
          id
          title
          handle
          status
        }
      }
    }
  }
  ```
* **Storefront Price Limitation Notice:**
  Automatic cart-level promotions (such as "Buy 2, Get 1 Free" or storewide cart thresholds) are evaluated only inside the Cart AJAX engine (`/cart/add.js`) and will **not** be reflected in individual Storefront variant price queries. Line item prices show the item catalog/sale price.
* **Unpublished Product Visibility (UNVERIFIED — Spike S2):**
  Shopify documentation indicates that Storefront API lookups respect sales channel publication. However, whether an app-generated token automatically returns `null` for products unpublished from the Online Store channel or requires explicit channel publication configuration is **UNVERIFIED** and must be verified on a development store in Spike S2.
* **Verdict:** **Recommended with Owner Approval.** Provides optimal data isolation, guaranteed retail pricing, and zero Admin API contention, subject to owner sign-off on `unauthenticated_read_product_listings`.

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
  - In Shopify App Store review, reviewers scrutinize why an app serving customer-facing storefront pages requires backend Admin API product scopes rather than Storefront API scopes.
* **Rate Limits & Blast Radius:**
  The Admin API uses a leaky bucket rate limit (40 to 100 cost points per second). If a protocol link receives viral traffic, uncached resolver queries could drain the store's Admin API rate limit, throttling critical backend background workers (e.g. order webhooks or admin operations).
* **Verdict:** **Viable fallback, but inferior to Option (b)** due to Admin scope addition requirements, rate limit blast radius, and risk of leaking draft items.

---

## 3. Pure Injectable Interface Specification

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
  priceMinor: number;           // Price in minor units (cents): 2999
  currency: string;             // ISO 4217 code: "USD"
  availableForSale: boolean;    // In-stock or backorders allowed
  isDeleted: boolean;           // true if variant was not found
  isPublished: boolean;         // true if published to online store
}

type VariantCatalogMap = Map<VariantGid, ResolvedVariant>;

interface VariantResolver {
  resolveVariants(
    shop: string,
    variantGids: string[],
    options?: { country?: string, language?: string }
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
 * @param {{ country?: string, language?: string }} [options]
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
export async function resolveVariants(shop, variantGids, options = {}) {
  // Pure interface to be implemented by live adapter (Storefront API client)
}
```

### Contract Guarantees:
1. **Completeness:** Every requested GID will have an entry in the returned `Map`.
2. **Missing / Deleted Handling:** If a variant cannot be found or is unpublished, `isDeleted: true`, `isPublished: false`, `availableForSale: false`, and `title: "Unavailable Product"`.
3. **Title Normalization:** If `variantTitle` is `"Default Title"` or empty, `title` is simply `productTitle`. Otherwise, `title` is formatted as `${productTitle} - ${variantTitle}`.
4. **Minor Currency Safety:** `priceMinor` is always an integer representation in minor currency units, respecting currency exponents (e.g. JPY=0, KWD=3, USD=2).
5. **No Network Exceptions Leaked:** Resolvers must catch upstream GraphQL errors and return fallback records with `availableForSale: false` rather than throwing uncaught exceptions to the proxy controller.

---

## 4. Testing Architecture with Fakes

Because `resolveVariants` is a pure injectable dependency, unit tests and controller integration tests can verify `renderProtocolLiquid` and proxy route behaviors with 100% determinism, zero network calls, and zero external dependencies.

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

---

## 5. Owner Decisions Needed

Before implementing any live catalog resolver adapter in code, the owner must make the following binding decisions:

1. **Scope Addition Sign-off:** Sign off on requesting `unauthenticated_read_product_listings` in `shopify.app.toml` to permit Storefront API private token resolution.
2. **Token Provisioning Strategy:** Decide whether the private storefront token is created at OAuth install time via `storefrontAccessTokenCreate` and stored in the `Setting` table, or fetched dynamically.
3. **Spike S2 Dev-Store Verification:** In Spike S2, verify on a live development store:
   - Does an app-created private storefront token see products only when published to the Online Store channel?
   - How does `@inContext(country, language)` interact with active Markets on Shopify Plus / standard plans?
4. **Live Adapter Implementation:** Confirm that live API client implementation remains deferred until a development store is available for end-to-end verification.
