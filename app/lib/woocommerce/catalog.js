/**
 * @file WooCommerce Catalog & Product Resolver.
 * 
 * Fetches and hydrates products and variations from WooCommerce Store API
 * (/wp-json/wc/store/v1/products) into standard Protocol line items.
 * 
 * Zero external dependencies. Pure Node.js ESM.
 */

import { normalizeWooStoreUrl } from './cart.js';

/**
 * Normalizes a raw WooCommerce product object from Store API into a standard Protocol line.
 * 
 * @param {Object} raw - Product from /wp-json/wc/store/v1/products
 * @returns {Object} Standardized protocol line
 */
export function normalizeWooProduct(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('Raw product must be an object');
  }

  const id = raw.id;
  const name = String(raw.name || raw.title || 'Untitled Product').trim();
  
  // Prices in WC Store API are formatted as integer minor units (cents) or string numbers
  let rawPrice = '0.00';
  let formattedPrice = '$0.00';

  if (raw.prices) {
    const rawPriceNum = parseFloat(raw.prices.price || raw.prices.regular_price || 0);
    // Store API prices often return e.g. "3400" (minor units) or "34.00"
    const currencyPrefix = raw.prices.currency_prefix || '$';
    const decimals = parseInt(String(raw.prices.currency_minor_unit ?? 2), 10);
    
    // If integer cents e.g. 3400
    if (Number.isInteger(rawPriceNum) && rawPriceNum > 100 && !String(raw.prices.price).includes('.')) {
      const dollars = (rawPriceNum / Math.pow(10, decimals)).toFixed(decimals);
      rawPrice = dollars;
      formattedPrice = `${currencyPrefix}${dollars}`;
    } else {
      rawPrice = rawPriceNum.toFixed(2);
      formattedPrice = `${currencyPrefix}${rawPrice}`;
    }
  } else if (raw.price !== undefined) {
    const num = parseFloat(String(raw.price).replace(/[^0-9.]/g, '') || 0);
    rawPrice = num.toFixed(2);
    formattedPrice = `$${rawPrice}`;
  }

  const inStock = raw.is_in_stock ?? raw.in_stock ?? true;
  const images = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : [];
  const imageUrl = images[0]?.src || images[0]?.thumbnail || null;

  return {
    variantId: String(id),
    variantGid: `gid://woocommerce/Product/${id}`,
    title: name,
    productTitle: name,
    variantTitle: raw.type === 'variable' ? 'Default Option' : null,
    price: rawPrice,
    priceFormatted: formattedPrice,
    quantity: 1,
    available: Boolean(inStock),
    inStock: Boolean(inStock),
    usageNote: '',
    imageUrl,
  };
}

/**
 * Searches WooCommerce products via the public WooCommerce Store API.
 * 
 * @param {Object} options
 * @param {string} options.storeUrl - Store origin
 * @param {string} [options.query=''] - Search term
 * @param {number} [options.perPage=10] - Number of items
 * @param {Function} [options.fetchFn=globalThis.fetch] - HTTP fetch function
 * @returns {Promise<Array<Object>>} Normalized protocol lines
 */
export async function searchWooProducts({
  storeUrl,
  query = '',
  perPage = 10,
  fetchFn = globalThis.fetch,
}) {
  const origin = normalizeWooStoreUrl(storeUrl);
  const endpoint = new URL('/wp-json/wc/store/v1/products', origin);
  
  if (query && query.trim()) {
    endpoint.searchParams.set('search', query.trim());
  }
  endpoint.searchParams.set('per_page', String(Math.min(perPage, 50)));

  const res = await fetchFn(endpoint.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PractitionerProtocols-WooAdapter/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`WooCommerce Store API responded with HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map(normalizeWooProduct);
}

/**
 * Creates an in-memory mock WooCommerce catalog resolver for zero-network testing and demo sandboxes.
 * 
 * @param {Array<Object>} [initialProducts]
 * @returns {Object} Mock catalog service
 */
export function createFakeWooCatalogResolver(initialProducts = []) {
  const products = initialProducts.length > 0 ? initialProducts : [
    {
      id: 201,
      name: 'Clinical Gentle Hydrating Cleanser',
      prices: { price: '3200', currency_prefix: '$', currency_minor_unit: 2 },
      is_in_stock: true,
      images: [{ src: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=300' }],
    },
    {
      id: 202,
      name: 'Active Barrier Repair Emulsion',
      prices: { price: '4600', currency_prefix: '$', currency_minor_unit: 2 },
      is_in_stock: true,
      images: [{ src: 'https://images.unsplash.com/photo-1608248597359-002773b06381?w=300' }],
    },
    {
      id: 203,
      name: 'Mineral UV Shield SPF 50+',
      prices: { price: '3800', currency_prefix: '$', currency_minor_unit: 2 },
      is_in_stock: true,
      images: [{ src: 'https://images.unsplash.com/photo-1598440947619-2c35fc9aa908?w=300' }],
    },
  ];

  return {
    async search({ query = '' } = {}) {
      const q = query.toLowerCase().trim();
      const matched = q
        ? products.filter((p) => p.name.toLowerCase().includes(q))
        : products;
      return matched.map(normalizeWooProduct);
    },
    async getById(id) {
      const found = products.find((p) => String(p.id) === String(id));
      return found ? normalizeWooProduct(found) : null;
    },
  };
}
