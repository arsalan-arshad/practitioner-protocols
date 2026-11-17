/**
 * @file WooCommerce Cart & Checkout Permalink Engine.
 * 
 * Generates 1-tap multi-item add-to-cart permalinks and headless cart payloads
 * for WooCommerce stores with embedded protocol token attribution.
 * 
 * Zero external dependencies. Pure Node.js ESM.
 */

import { URL } from 'node:url';

/**
 * Validates and normalizes a WooCommerce store base URL.
 * 
 * @param {string} storeUrl - e.g. "https://example-clinic.com" or "example-clinic.com"
 * @returns {string} Normalized origin (e.g. "https://example-clinic.com")
 */
export function normalizeWooStoreUrl(storeUrl) {
  if (!storeUrl || typeof storeUrl !== 'string') {
    throw new TypeError('Store URL must be a non-empty string');
  }

  let trimmed = storeUrl.trim();
  if (trimmed.includes('://')) {
    const scheme = trimmed.split('://')[0].toLowerCase();
    if (!['http', 'https'].includes(scheme)) {
      throw new TypeError(`Unsupported protocol: ${scheme}. Store URL protocol must be http or https`);
    }
  } else {
    trimmed = `https://${trimmed}`;
  }

  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('Store URL protocol must be http or https');
  }

  // Return origin without trailing slash
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Builds a 1-tap WooCommerce multi-product cart or checkout permalink.
 * 
 * Example URL generated:
 * https://store.com/cart/?add-to-cart=101,102&quantity[101]=1&quantity[102]=2&protocol_token=tok_essentials123
 * 
 * @param {Object} options
 * @param {string} options.storeUrl - Store base URL
 * @param {Array<{ variantId: string|number, quantity: number }>} options.lines - Recommended items
 * @param {string} options.token - Cryptographic protocol token
 * @param {'cart'|'checkout'} [options.destination='cart'] - Target page
 * @returns {string} Full 1-tap URL
 */
export function buildWooCartUrl({ storeUrl, lines, token, destination = 'cart' }) {
  const origin = normalizeWooStoreUrl(storeUrl);

  if (!token || typeof token !== 'string') {
    throw new TypeError('Protocol token must be a non-empty string');
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError('Lines must be a non-empty array of items');
  }

  const validIds = [];
  const quantities = {};

  for (const line of lines) {
    const rawId = line.variantId ?? line.id ?? line.productId;
    const parsedId = parseInt(String(rawId), 10);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      throw new Error(`Invalid WooCommerce product/variation ID: ${rawId}`);
    }

    const qty = parseInt(String(line.quantity ?? 1), 10);
    const validQty = Number.isInteger(qty) && qty > 0 ? qty : 1;

    validIds.push(parsedId);
    quantities[parsedId] = validQty;
  }

  const path = destination === 'checkout' ? '/checkout/' : '/cart/';
  const url = new URL(path, origin);

  // WooCommerce bulk add-to-cart convention:
  // ?add-to-cart=id1,id2&quantity[id1]=qty1&quantity[id2]=qty2&protocol_token=token
  url.searchParams.set('add-to-cart', validIds.join(','));
  for (const id of validIds) {
    url.searchParams.set(`quantity[${id}]`, String(quantities[id]));
  }
  url.searchParams.set('protocol_token', token.trim());

  return url.toString();
}

/**
 * Builds the batch JSON payload for WooCommerce Store API (/wp-json/wc/store/v1/batch)
 * for headless storefronts adding all items in one asynchronous request.
 * 
 * @param {Object} options
 * @param {Array<{ variantId: string|number, quantity: number }>} options.lines
 * @param {string} options.token
 * @returns {Object} Store API batch requests payload
 */
export function buildWooStoreApiBatchPayload({ lines, token }) {
  if (!token || typeof token !== 'string') {
    throw new TypeError('Protocol token must be a non-empty string');
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError('Lines must be a non-empty array');
  }

  const requests = lines.map((line) => {
    const rawId = line.variantId ?? line.id ?? line.productId;
    const id = parseInt(String(rawId), 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid WooCommerce product ID: ${rawId}`);
    }
    const qty = parseInt(String(line.quantity ?? 1), 10);
    const quantity = Number.isInteger(qty) && qty > 0 ? qty : 1;

    return {
      path: '/wc/store/v1/cart/add-item',
      method: 'POST',
      body: {
        id,
        quantity,
        item_data: [
          {
            key: '_protocol_token',
            value: token.trim(),
          },
        ],
      },
    };
  });

  return { requests };
}
