/**
 * @file Catalog Resolver Module for Practitioner Protocols (Milestone M2, Defect 4).
 *
 * Provides batch resolution of Shopify Product Variants via GraphQL (Storefront or Admin API),
 * extracting live retail prices, variant titles, stock availability, and featured images
 * while strictly handling deleted, draft, and out-of-stock products.
 */

import { getCurrencyExponent } from './attribution.js';

/**
 * Extracts numeric ID from a Shopify GID or numeric ID string.
 *
 * @param {string} gid
 * @returns {string}
 */
function extractNumericId(gid) {
  if (!gid || typeof gid !== 'string') return '';
  const match = gid.match(/(\d+)$/);
  return match ? match[1] : gid;
}

/**
 * Formats a decimal price string with standard currency symbols.
 *
 * @param {string|number} price
 * @param {string} [currency='USD']
 * @returns {string}
 */
export function formatPrice(price, currency = 'USD') {
  const num = typeof price === 'number' ? price : parseFloat(String(price || '0'));
  const curr = String(currency || 'USD').toUpperCase();

  try {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: curr,
      minimumFractionDigits: getCurrencyExponent(curr),
      maximumFractionDigits: getCurrencyExponent(curr),
    });
    return formatter.format(num);
  } catch {
    return `${curr} ${num.toFixed(2)}`;
  }
}

/**
 * Constructs the GraphQL query for resolving variants in batch.
 *
 * @param {{ country?: string, language?: string }} [options]
 * @returns {{ query: string, variables?: Record<string, unknown> }}
 */
export function buildVariantQuery(options = {}) {
  const { country, language } = options;
  const hasContext = Boolean(country || language);

  let queryHeader = 'query ResolveVariants($ids: [ID!]!';
  let contextDirective = '';

  if (hasContext) {
    if (country) queryHeader += ', $country: CountryCode';
    if (language) queryHeader += ', $language: LanguageCode';
    queryHeader += ')';

    const contextArgs = [];
    if (country) contextArgs.push('country: $country');
    if (language) contextArgs.push('language: $language');
    contextDirective = ` @inContext(${contextArgs.join(', ')})`;
  } else {
    queryHeader += ')';
  }

  const query = `${queryHeader}${contextDirective} {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      title
      availableForSale
      price {
        amount
        currencyCode
      }
      image {
        url
        altText
      }
      product {
        id
        title
        handle
        featuredImage {
          url
          altText
        }
      }
    }
  }
}`;

  return { query };
}

/**
 * Converts a price amount string/number into integer minor currency units.
 *
 * @param {string|number} amount
 * @param {string} currency
 * @returns {number}
 */
function toMinorUnits(amount, currency = 'USD') {
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount || '0'));
  if (Number.isNaN(num)) return 0;
  const exp = getCurrencyExponent(currency);
  return Math.round(num * Math.pow(10, exp));
}

/**
 * Parses raw GraphQL nodes into a normalized Map of resolved variants.
 *
 * @param {string[]} requestedGids - Ordered array of requested variant GIDs
 * @param {Array<Record<string, any> | null>} [rawNodes=[]] - Raw nodes from GraphQL response
 * @param {{ defaultCurrency?: string }} [options={}]
 * @returns {Map<string, {
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
 *   isPublished: boolean,
 *   image: { url: string, altText: string } | null
 * }>}
 */
export function parseCatalogNodes(requestedGids = [], rawNodes = [], options = {}) {
  const map = new Map();
  const defaultCurrency = options.defaultCurrency || 'USD';

  // Build a lookup map of raw nodes by id
  const nodesById = new Map();
  if (Array.isArray(rawNodes)) {
    for (let i = 0; i < rawNodes.length; i++) {
      const node = rawNodes[i];
      if (node && node.id) {
        nodesById.set(node.id, node);
      }
    }
  }

  for (let i = 0; i < requestedGids.length; i++) {
    const gid = requestedGids[i];
    const node = nodesById.get(gid) ?? (rawNodes ? rawNodes[i] : null);

    if (!node || typeof node !== 'object' || (node.id && node.id !== gid && !nodesById.has(gid))) {
      // Node was deleted, missing, or returned null
      map.set(gid, {
        variantGid: gid,
        variantId: extractNumericId(gid),
        productTitle: 'Unavailable Product',
        variantTitle: null,
        title: 'Unavailable Product',
        price: '0.00',
        priceMinor: 0,
        currency: defaultCurrency,
        availableForSale: false,
        isDeleted: true,
        isPublished: false,
        image: null,
      });
      continue;
    }

    const productTitle = node.product?.title || 'Unknown Product';
    const rawVariantTitle = node.title && node.title.trim() !== 'Default Title' ? node.title.trim() : null;
    const displayTitle = rawVariantTitle ? `${productTitle} - ${rawVariantTitle}` : productTitle;

    // Price extraction: supports Storefront { price: { amount, currencyCode } } and Admin { price: "29.99" }
    let priceAmount = '0.00';
    let currencyCode = defaultCurrency;

    if (node.price && typeof node.price === 'object') {
      priceAmount = String(node.price.amount ?? '0.00');
      currencyCode = String(node.price.currencyCode ?? defaultCurrency).toUpperCase();
    } else if (node.price) {
      priceAmount = String(node.price);
    }

    const priceMinor = toMinorUnits(priceAmount, currencyCode);

    // Publication status: products with status !== 'ACTIVE' are unpublished drafts/archives
    const productStatus = node.product?.status ? String(node.product.status).toUpperCase() : 'ACTIVE';
    const isPublished = productStatus === 'ACTIVE';

    const isAvailableForSale = Boolean(node.availableForSale) && isPublished;

    // Image extraction
    let image = null;
    if (node.image?.url) {
      image = { url: node.image.url, altText: node.image.altText || '' };
    } else if (node.product?.featuredImage?.url) {
      image = { url: node.product.featuredImage.url, altText: node.product.featuredImage.altText || '' };
    }

    map.set(gid, {
      variantGid: gid,
      variantId: extractNumericId(node.id || gid),
      productTitle,
      variantTitle: rawVariantTitle,
      title: displayTitle,
      price: priceAmount,
      priceMinor,
      currency: currencyCode,
      availableForSale: isAvailableForSale,
      isDeleted: false,
      isPublished,
      image,
    });
  }

  return map;
}

/**
 * Resolves catalog details for an array of variant GIDs via a GraphQL executor.
 * Pure contract: deterministic output, never throws uncaught exceptions for network or missing variants.
 *
 * @param {string} shop - Shop myshopify domain
 * @param {string[]} variantGids - Array of Shopify variant GIDs
 * @param {{
 *   graphqlExecutor?: (args: { query: string, variables: Record<string, unknown> }) => Promise<any>,
 *   country?: string,
 *   language?: string,
 *   defaultCurrency?: string
 * }} [options={}]
 * @returns {Promise<Map<string, any>>}
 */
export async function resolveVariants(shop, variantGids = [], options = {}) {
  if (!Array.isArray(variantGids) || variantGids.length === 0) {
    return new Map();
  }

  const { graphqlExecutor, country, language, defaultCurrency = 'USD' } = options;

  if (typeof graphqlExecutor !== 'function') {
    // If no executor provided, return unpopulated fallback map
    return parseCatalogNodes(variantGids, [], { defaultCurrency });
  }

  const { query } = buildVariantQuery({ country, language });
  const variables = { ids: variantGids };
  if (country) variables.country = country;
  if (language) variables.language = language;

  try {
    const response = await graphqlExecutor({ query, variables });
    const rawNodes = response?.data?.nodes || [];
    return parseCatalogNodes(variantGids, rawNodes, { defaultCurrency });
  } catch {
    // Upstream error: return fail-safe unavailable records without throwing
    return parseCatalogNodes(variantGids, [], { defaultCurrency });
  }
}

/**
 * Merges resolved catalog items into protocol lines.
 *
 * @param {Array<Record<string, any>>} lines - Protocol lines from database
 * @param {Map<string, any>} catalogMap - Map returned by resolveVariants
 * @param {{ filterUnavailable?: boolean }} [options={}]
 * @returns {Array<Record<string, any>>} Enriched protocol lines
 */
export function enrichProtocolLines(lines = [], catalogMap = new Map(), options = {}) {
  if (!Array.isArray(lines)) return [];

  const enriched = [];

  for (const line of lines) {
    const gid = line.variantGid || line.variantId || line.id || '';
    const resolved = catalogMap.get(gid) || {
      productTitle: 'Unavailable Product',
      variantTitle: null,
      title: 'Unavailable Product',
      price: '0.00',
      priceMinor: 0,
      currency: 'USD',
      availableForSale: false,
      isDeleted: true,
      isPublished: false,
      image: null,
    };

    if (options.filterUnavailable && (resolved.isDeleted || !resolved.isPublished)) {
      continue;
    }

    enriched.push({
      ...line,
      productTitle: resolved.productTitle,
      variantTitle: resolved.variantTitle,
      title: resolved.title,
      price: resolved.price,
      priceFormatted: formatPrice(resolved.price, resolved.currency),
      priceMinor: resolved.priceMinor,
      currency: resolved.currency,
      available: resolved.availableForSale,
      inStock: resolved.availableForSale,
      isDeleted: resolved.isDeleted,
      isPublished: resolved.isPublished,
      image: resolved.image,
    });
  }

  return enriched;
}

/**
 * Constructs the GraphQL query for searching products in the catalog.
 *
 * @param {{ country?: string, language?: string }} [options]
 * @returns {{ query: string }}
 */
export function buildProductSearchQuery(options = {}) {
  const { country, language } = options;
  const hasContext = Boolean(country || language);

  let queryHeader = 'query SearchProducts($query: String!, $first: Int!';
  let contextDirective = '';

  if (hasContext) {
    if (country) queryHeader += ', $country: CountryCode';
    if (language) queryHeader += ', $language: LanguageCode';
    queryHeader += ')';

    const contextArgs = [];
    if (country) contextArgs.push('country: $country');
    if (language) contextArgs.push('language: $language');
    contextDirective = ` @inContext(${contextArgs.join(', ')})`;
  } else {
    queryHeader += ')';
  }

  const query = `${queryHeader}${contextDirective} {
  products(first: $first, query: $query) {
    edges {
      node {
        id
        title
        handle
        featuredImage {
          url
          altText
        }
        variants(first: 20) {
          edges {
            node {
              id
              title
              availableForSale
              price {
                amount
                currencyCode
              }
              image {
                url
                altText
              }
            }
          }
        }
      }
    }
  }
}`;

  return { query };
}

/**
 * Parses GraphQL Storefront product search edges into clean product and variant representations.
 *
 * @param {Array<any>} productEdges
 * @returns {Array<{
 *   id: string,
 *   productId: string,
 *   title: string,
 *   handle: string,
 *   imageUrl: string | null,
 *   variants: Array<{
 *     id: string,
 *     variantId: string,
 *     title: string | null,
 *     displayTitle: string,
 *     price: string,
 *     priceFormatted: string,
 *     currency: string,
 *     availableForSale: boolean,
 *     imageUrl: string | null
 *   }>
 * }>}
 */
export function parseProductSearchNodes(productEdges = []) {
  if (!Array.isArray(productEdges)) return [];

  const products = [];

  for (const edge of productEdges) {
    const node = edge?.node || edge;
    if (!node || !node.id) continue;

    const productId = extractNumericId(node.id);
    const productTitle = node.title || 'Product';
    const handle = node.handle || '';
    const featuredImageUrl = node.featuredImage?.url || null;

    const variantEdges = node.variants?.edges || (Array.isArray(node.variants) ? node.variants : []);
    const variants = [];

    for (const vEdge of variantEdges) {
      const vNode = vEdge?.node || vEdge;
      if (!vNode || !vNode.id) continue;

      const variantGid = vNode.id;
      const variantId = extractNumericId(variantGid);
      const isDefault = !vNode.title || vNode.title.trim().toLowerCase() === 'default title';
      const variantTitle = isDefault ? null : vNode.title.trim();
      const displayTitle = variantTitle ? `${productTitle} - ${variantTitle}` : productTitle;
      const amount = vNode.price?.amount || '0.00';
      const currency = vNode.price?.currencyCode || 'USD';

      variants.push({
        id: variantGid,
        variantId,
        title: variantTitle,
        displayTitle,
        price: amount,
        priceFormatted: formatPrice(amount, currency),
        currency,
        availableForSale: Boolean(vNode.availableForSale),
        imageUrl: vNode.image?.url || featuredImageUrl,
      });
    }

    products.push({
      id: node.id,
      productId,
      title: productTitle,
      handle,
      imageUrl: featuredImageUrl,
      variants,
    });
  }

  return products;
}

/**
 * Searches the catalog for sellable products matching the query.
 *
 * @param {string} shop
 * @param {string} queryStr
 * @param {Record<string, any>} [options]
 * @returns {Promise<Array<any>>}
 */
export async function searchCatalogProducts(shop, queryStr, options = {}) {
  const q = String(queryStr || '').trim();
  if (!q) return [];

  const first = Number.isInteger(options.first) && options.first >= 1 && options.first <= 50 ? options.first : 10;
  const { query } = buildProductSearchQuery(options);
  const variables = { query: q, first };
  if (options.country) variables.country = options.country;
  if (options.language) variables.language = options.language;

  let data = null;
  if (typeof options.graphqlExecutor === 'function') {
    data = await options.graphqlExecutor(query, variables);
  } else if (typeof options.fetchStorefront === 'function') {
    data = await options.fetchStorefront(shop, query, variables);
  }

  const edges = data?.products?.edges || data?.data?.products?.edges || [];
  return parseProductSearchNodes(edges);
}

/**
 * Test helper factory for creating a fake variant resolver.
 *
 * @param {Record<string, Partial<any>>} [fixtures={}] - Seed data keyed by variantGid
 * @param {Array<any>} [productFixtures=[]] - Seed product search fixtures
 * @returns {{
 *   resolveVariants: (shop: string, variantGids: string[]) => Promise<Map<string, any>>,
 *   searchProducts: (shop: string, query?: string) => Promise<Array<any>>
 * }}
 */
export function createFakeVariantResolver(fixtures = {}, productFixtures = []) {
  return {
    async resolveVariants(shop, variantGids = []) {
      const rawNodes = variantGids.map((gid) => {
        const fixture = fixtures[gid];
        if (!fixture) return null;

        return {
          id: gid,
          title: fixture.variantTitle || 'Default Title',
          availableForSale: fixture.availableForSale ?? true,
          price: {
            amount: fixture.price || '0.00',
            currencyCode: fixture.currency || 'USD',
          },
          image: fixture.image || null,
          product: {
            title: fixture.productTitle || fixture.title || 'Test Product',
            status: fixture.status || (fixture.isPublished === false ? 'DRAFT' : 'ACTIVE'),
            featuredImage: fixture.image || null,
          },
        };
      });

      return parseCatalogNodes(variantGids, rawNodes);
    },

    async searchProducts(shop, query = '') {
      const q = String(query || '').toLowerCase().trim();
      if (!q) return [];
      return productFixtures.filter((p) => {
        const matchTitle = (p.title || '').toLowerCase().includes(q);
        const matchVariants = (p.variants || []).some((v) =>
          (v.displayTitle || v.title || '').toLowerCase().includes(q)
        );
        return matchTitle || matchVariants;
      });
    },
  };
}
