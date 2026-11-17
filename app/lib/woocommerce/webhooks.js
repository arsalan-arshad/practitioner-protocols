/**
 * @file WooCommerce Webhook & Attribution Processor.
 * 
 * Validates WooCommerce webhook signatures (HMAC-SHA256 Base64),
 * extracts protocol token attributions from order line item metadata,
 * and maintains strict Zero-PII privacy boundaries.
 * 
 * Zero external dependencies. Pure Node.js ESM.
 */

import crypto from 'node:crypto';

/**
 * Verifies the X-WC-Webhook-Signature header using the shared secret.
 * 
 * @param {string|Buffer} rawBody - Raw unparsed webhook body
 * @param {string} signatureHeader - Base64 signature from X-WC-Webhook-Signature
 * @param {string} secret - Webhook secret key
 * @returns {boolean} True if signature is valid
 */
export function verifyWooWebhookSignature(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !secret) {
    return false;
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const digest = hmac.digest('base64');

    const expectedBuffer = Buffer.from(digest, 'utf8');
    const actualBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch {
    return false;
  }
}

/**
 * Extracts protocol token attributions from a WooCommerce order webhook payload.
 * 
 * Enforces strict Zero-PII:
 * - Completely ignores customer billing/shipping names, emails, phones, and addresses.
 * - Extracts ONLY the protocol token, quantity, item revenue, and currency.
 * 
 * @param {Object} order - WooCommerce order object (v3 / Store API)
 * @returns {{ orderId: string|number, currency: string, attributions: Array<{ token: string, lineTotal: string, lineTotalCents: number, quantity: number, productId: number }> }}
 */
export function parseWooOrderAttribution(order) {
  if (!order || typeof order !== 'object') {
    throw new TypeError('Order must be an object');
  }

  const orderId = order.id || 'unknown';
  const currency = String(order.currency || 'USD').toUpperCase();
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  const attributions = [];

  for (const item of lineItems) {
    let token = null;

    // Check meta_data array (standard WooCommerce REST format: [{ key: '_protocol_token', value: '...' }])
    if (Array.isArray(item.meta_data)) {
      const found = item.meta_data.find(
        (m) => m.key === '_protocol_token' || m.key === 'protocol_token'
      );
      if (found && typeof found.value === 'string' && found.value.trim()) {
        token = found.value.trim();
      }
    }

    // Direct property fallback
    if (!token && typeof item.protocol_token === 'string') {
      token = item.protocol_token.trim();
    }

    if (token) {
      const rawTotal = parseFloat(String(item.total ?? 0));
      const lineTotal = Number.isFinite(rawTotal) ? rawTotal.toFixed(2) : '0.00';
      const lineTotalCents = Math.round(parseFloat(lineTotal) * 100);
      const quantity = parseInt(String(item.quantity ?? 1), 10) || 1;
      const productId = parseInt(String(item.product_id ?? item.id ?? 0), 10);

      attributions.push({
        token,
        lineTotal,
        lineTotalCents,
        quantity,
        productId,
      });
    }
  }

  return {
    orderId,
    currency,
    attributions,
  };
}
