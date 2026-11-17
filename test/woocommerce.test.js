/**
 * @file Automated Test Suite for WooCommerce Adapter.
 * 
 * Verifies cart permalink generation, catalog resolution, Store API batch payloads,
 * webhook HMAC verification, and Zero-PII order attribution parsing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  normalizeWooStoreUrl,
  buildWooCartUrl,
  buildWooStoreApiBatchPayload,
} from '../app/lib/woocommerce/cart.js';

import {
  normalizeWooProduct,
  createFakeWooCatalogResolver,
} from '../app/lib/woocommerce/catalog.js';

import {
  verifyWooWebhookSignature,
  parseWooOrderAttribution,
} from '../app/lib/woocommerce/webhooks.js';

describe('WooCommerce Adapter Layer', () => {

  describe('normalizeWooStoreUrl', () => {
    it('normalizes clean https URLs and strips trailing slashes', () => {
      assert.equal(normalizeWooStoreUrl('https://clinic.example.com/'), 'https://clinic.example.com');
      assert.equal(normalizeWooStoreUrl('https://clinic.example.com/shop'), 'https://clinic.example.com');
    });

    it('adds https prefix when protocol is omitted', () => {
      assert.equal(normalizeWooStoreUrl('clinic.example.com'), 'https://clinic.example.com');
    });

    it('rejects invalid or non-http protocols', () => {
      assert.throws(() => normalizeWooStoreUrl('ftp://clinic.example.com'), TypeError);
      assert.throws(() => normalizeWooStoreUrl(''), TypeError);
      assert.throws(() => normalizeWooStoreUrl(null), TypeError);
    });
  });

  describe('buildWooCartUrl', () => {
    const lines = [
      { variantId: 101, quantity: 2 },
      { variantId: '102', quantity: 1 },
    ];
    const token = 'tok_skin_routine_789';

    it('builds standard 1-tap cart permalink with all items and protocol token', () => {
      const url = buildWooCartUrl({
        storeUrl: 'https://skinclinic.com',
        lines,
        token,
      });

      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://skinclinic.com');
      assert.equal(parsed.pathname, '/cart/');
      assert.equal(parsed.searchParams.get('add-to-cart'), '101,102');
      assert.equal(parsed.searchParams.get('quantity[101]'), '2');
      assert.equal(parsed.searchParams.get('quantity[102]'), '1');
      assert.equal(parsed.searchParams.get('protocol_token'), 'tok_skin_routine_789');
    });

    it('supports destination="checkout" to route directly to checkout page', () => {
      const url = buildWooCartUrl({
        storeUrl: 'https://skinclinic.com',
        lines,
        token,
        destination: 'checkout',
      });

      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/checkout/');
      assert.equal(parsed.searchParams.get('add-to-cart'), '101,102');
      assert.equal(parsed.searchParams.get('protocol_token'), 'tok_skin_routine_789');
    });

    it('rejects missing or invalid inputs cleanly', () => {
      assert.throws(() => buildWooCartUrl({ storeUrl: 'https://test.com', lines: [], token }), TypeError);
      assert.throws(() => buildWooCartUrl({ storeUrl: 'https://test.com', lines, token: '' }), TypeError);
      assert.throws(
        () => buildWooCartUrl({ storeUrl: 'https://test.com', lines: [{ variantId: 'invalid' }], token }),
        /Invalid WooCommerce product/
      );
    });
  });

  describe('buildWooStoreApiBatchPayload', () => {
    it('creates batch requests array with embedded _protocol_token item_data', () => {
      const payload = buildWooStoreApiBatchPayload({
        lines: [
          { variantId: 501, quantity: 1 },
          { variantId: 502, quantity: 3 },
        ],
        token: 'tok_batch_test',
      });

      assert.ok(Array.isArray(payload.requests));
      assert.equal(payload.requests.length, 2);

      const first = payload.requests[0];
      assert.equal(first.path, '/wc/store/v1/cart/add-item');
      assert.equal(first.method, 'POST');
      assert.equal(first.body.id, 501);
      assert.equal(first.body.quantity, 1);
      assert.deepEqual(first.body.item_data, [{ key: '_protocol_token', value: 'tok_batch_test' }]);

      const second = payload.requests[1];
      assert.equal(second.body.id, 502);
      assert.equal(second.body.quantity, 3);
    });
  });

  describe('normalizeWooProduct & Mock Catalog', () => {
    it('normalizes raw Store API product object with minor unit prices', () => {
      const raw = {
        id: 301,
        name: 'Deep Hydrating Serum',
        prices: {
          price: '3450',
          currency_prefix: '$',
          currency_minor_unit: 2,
        },
        is_in_stock: true,
        images: [{ src: 'https://test.com/img.jpg' }],
      };

      const norm = normalizeWooProduct(raw);
      assert.equal(norm.variantId, '301');
      assert.equal(norm.variantGid, 'gid://woocommerce/Product/301');
      assert.equal(norm.title, 'Deep Hydrating Serum');
      assert.equal(norm.price, '34.50');
      assert.equal(norm.priceFormatted, '$34.50');
      assert.equal(norm.inStock, true);
      assert.equal(norm.available, true);
      assert.equal(norm.imageUrl, 'https://test.com/img.jpg');
    });

    it('provides mock catalog search and item lookup', async () => {
      const catalog = createFakeWooCatalogResolver();
      const all = await catalog.search();
      assert.ok(all.length >= 3);

      const searchResults = await catalog.search({ query: 'barrier' });
      assert.equal(searchResults.length, 1);
      assert.ok(searchResults[0].title.includes('Barrier'));

      const item = await catalog.getById(201);
      assert.ok(item);
      assert.equal(item.variantId, '201');
    });
  });

  describe('verifyWooWebhookSignature', () => {
    const secret = 'woo_secret_xyz123';
    const payload = JSON.stringify({ id: 1001, status: 'completed' });

    it('verifies valid HMAC-SHA256 base64 signature', () => {
      const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
      assert.equal(verifyWooWebhookSignature(payload, signature, secret), true);
    });

    it('rejects invalid or tampered signature', () => {
      const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64');
      const tampered = `${payload} `;
      assert.equal(verifyWooWebhookSignature(tampered, signature, secret), false);
      assert.equal(verifyWooWebhookSignature(payload, signature, 'wrong_secret'), false);
    });
  });

  describe('parseWooOrderAttribution (Zero-PII)', () => {
    it('extracts protocol attributions while ignoring all customer details', () => {
      const order = {
        id: 8891,
        status: 'completed',
        currency: 'USD',
        // Potentially sensitive customer fields that MUST be completely ignored:
        customer_id: 42,
        billing: {
          first_name: 'John',
          last_name: 'Doe',
          email: 'patient@example.com',
          phone: '555-0199',
          address_1: '123 Medical Way',
        },
        shipping: {
          first_name: 'John',
          last_name: 'Doe',
        },
        customer_note: 'Patient with sensitive eczema condition',
        // Line items with protocol token:
        line_items: [
          {
            id: 11,
            product_id: 201,
            name: 'Gentle Cleanser',
            total: '32.00',
            quantity: 1,
            meta_data: [
              { key: '_protocol_token', value: 'tok_demo_cleanse' },
            ],
          },
          {
            id: 12,
            product_id: 202,
            name: 'Active Barrier Repair',
            total: '92.00',
            quantity: 2,
            meta_data: [
              { key: '_protocol_token', value: 'tok_demo_cleanse' },
              { key: '_unrelated', value: 'abc' },
            ],
          },
          {
            id: 13,
            product_id: 300,
            name: 'Regular Toothbrush',
            total: '10.00',
            quantity: 1,
            meta_data: [], // No protocol
          },
        ],
      };

      const result = parseWooOrderAttribution(order);

      assert.equal(result.orderId, 8891);
      assert.equal(result.currency, 'USD');
      assert.equal(result.attributions.length, 2);

      const [first, second] = result.attributions;
      assert.equal(first.token, 'tok_demo_cleanse');
      assert.equal(first.lineTotal, '32.00');
      assert.equal(first.lineTotalCents, 3200);
      assert.equal(first.quantity, 1);
      assert.equal(first.productId, 201);

      assert.equal(second.token, 'tok_demo_cleanse');
      assert.equal(second.lineTotal, '92.00');
      assert.equal(second.lineTotalCents, 9200);
      assert.equal(second.quantity, 2);
      assert.equal(second.productId, 202);

      // Strict Zero-PII verification:
      const outputJson = JSON.stringify(result);
      assert.ok(!outputJson.includes('John'), 'Customer name must not leak');
      assert.ok(!outputJson.includes('Doe'), 'Customer name must not leak');
      assert.ok(!outputJson.includes('patient@example.com'), 'Customer email must not leak');
      assert.ok(!outputJson.includes('eczema'), 'Clinical note must not leak');
    });
  });

  describe('Server HTTP Integration (/demo & /api/woocommerce)', () => {
    // Dynamic import to test createRequestListener
    it('serves interactive WooCommerce demo view at /demo?view=woocommerce with status 200', async () => {
      const { createRequestListener } = await import('../server.js');
      const listener = createRequestListener();

      let statusCode = 0;
      let headers = {};
      let body = '';

      const req = {
        url: '/demo?view=woocommerce',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      };
      const res = {
        writeHead(code, h) {
          statusCode = code;
          headers = h || {};
        },
        setHeader() {},
        end(data) {
          body = data || '';
        },
      };

      await listener(req, res);
      assert.equal(statusCode, 200);
      assert.ok(body.includes('WooCommerce Adapter'));
      assert.ok(body.includes('1-Tap Multi-Product Cart & Checkout Permalinks'));
      assert.ok(body.includes('/cart/?add-to-cart='));
    });

    it('generates cart URLs via /api/woocommerce/cart-url endpoint', async () => {
      const { createRequestListener } = await import('../server.js');
      const listener = createRequestListener();

      let statusCode = 0;
      let body = '';

      const req = {
        url: '/api/woocommerce/cart-url?storeUrl=https://clinic.com&token=tok_api_test&lines=301,302',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      };
      const res = {
        writeHead(code) {
          statusCode = code;
        },
        setHeader() {},
        end(data) {
          body = data || '';
        },
      };

      await listener(req, res);
      assert.equal(statusCode, 200);
      const json = JSON.parse(body);
      const decodedCart = decodeURIComponent(json.cartUrl);
      assert.ok(decodedCart.includes('add-to-cart=301,302'));
      assert.ok(json.cartUrl.includes('protocol_token=tok_api_test'));
      assert.ok(json.checkoutUrl.includes('/checkout/'));
      assert.equal(json.batchPayload.requests.length, 2);
    });

    it('serves downloadable companion WordPress plugin zip at /download/practitioner-protocols.zip', async () => {
      const { createRequestListener } = await import('../server.js');
      const listener = createRequestListener();

      let statusCode = 0;
      let headers = {};
      let buffer = null;

      const req = {
        url: '/download/practitioner-protocols.zip',
        method: 'GET',
        headers: { host: 'localhost:3000' },
      };
      const res = {
        writeHead(code, h) {
          statusCode = code;
          headers = h || {};
        },
        setHeader() {},
        end(data) {
          buffer = data;
        },
      };

      await listener(req, res);
      assert.equal(statusCode, 200);
      assert.equal(headers['Content-Type'], 'application/zip');
      assert.ok(headers['Content-Disposition'].includes('practitioner-protocols-wc.zip'));
      assert.ok(Buffer.isBuffer(buffer));
      assert.ok(buffer.length > 500, 'Zip buffer must contain data');
    });
  });

});
