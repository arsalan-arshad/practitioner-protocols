import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAppProxyHmac,
  calculateAppProxySignature,
  normalizeQueryParams,
  getLoggedInCustomerGid,
  renderProtocolLiquid,
  escapeHtml,
  normalizeVariantId
} from '../app/lib/protocols/proxy.js';

describe('Shopify App Proxy & Storefront (app/lib/protocols/proxy.js)', () => {
  const apiSecret = 'test_secret_key_884422';

  describe('normalizeQueryParams & calculateAppProxySignature', () => {
    it('sorts query parameters alphabetically and produces deterministic HMAC signature', () => {
      const params = {
        shop: 'wellness.myshopify.com',
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };

      const sig1 = calculateAppProxySignature(params, apiSecret);
      assert.ok(sig1.length === 64, 'HMAC-SHA256 hex must be 64 characters');

      // Reordering object keys produces identical signature
      const reordered = {
        timestamp: '1729500000',
        shop: 'wellness.myshopify.com',
        path_prefix: '/apps/protocols'
      };
      const sig2 = calculateAppProxySignature(reordered, apiSecret);
      assert.equal(sig1, sig2);
    });

    it('handles URLSearchParams and query strings correctly', () => {
      const qs = '?shop=wellness.myshopify.com&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000';
      const sig = calculateAppProxySignature(qs, apiSecret);
      assert.ok(sig.length === 64);
    });
  });

  describe('verifyAppProxyHmac', () => {
    it('verifies a valid Shopify App Proxy signature', () => {
      const params = {
        shop: 'wellness.myshopify.com',
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const queryWithSig = { ...params, signature };

      assert.equal(verifyAppProxyHmac(queryWithSig, apiSecret), true);
    });

    it('rejects tampered query parameters', () => {
      const params = {
        shop: 'wellness.myshopify.com',
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const tampered = { ...params, shop: 'attacker.myshopify.com', signature };

      assert.equal(verifyAppProxyHmac(tampered, apiSecret), false);
    });

    it('rejects missing or invalid signature', () => {
      assert.equal(verifyAppProxyHmac({ shop: 'wellness.myshopify.com' }, apiSecret), false);
      assert.equal(verifyAppProxyHmac({ shop: 'wellness.myshopify.com', signature: 'invalid_sig' }, apiSecret), false);
      assert.equal(verifyAppProxyHmac(null, apiSecret), false);
    });
  });

  describe('getLoggedInCustomerGid', () => {
    it('extracts and formats logged_in_customer_id', () => {
      assert.equal(
        getLoggedInCustomerGid({ logged_in_customer_id: '12345678' }),
        'gid://shopify/Customer/12345678'
      );
      assert.equal(
        getLoggedInCustomerGid({ logged_in_customer_id: 'gid://shopify/Customer/9988' }),
        'gid://shopify/Customer/9988'
      );
    });

    it('returns null when customer is not logged in', () => {
      assert.equal(getLoggedInCustomerGid({}), null);
      assert.equal(getLoggedInCustomerGid({ logged_in_customer_id: '' }), null);
      assert.equal(getLoggedInCustomerGid(null), null);
    });
  });

  describe('renderProtocolLiquid', () => {
    const mockProtocol = {
      id: 'proto_101',
      token: 'tok_abc123def456',
      name: 'Gut Health Daily Regimen',
      introNote: 'Follow this routine every morning before food.',
      status: 'active',
      lines: [
        {
          variantGid: 'gid://shopify/ProductVariant/5001',
          quantity: 1,
          title: 'Digestive Enzymes Pro',
          priceFormatted: '$34.00',
          usageNote: '1 capsule 10 mins before meals',
          available: true
        },
        {
          variantGid: 'gid://shopify/ProductVariant/5002',
          quantity: 2,
          title: 'L-Glutamine Powder',
          priceFormatted: '$45.00',
          usageNote: 'Mix 1 scoop in water',
          available: false
        }
      ]
    };

    it('always includes <meta name="robots" content="noindex, nofollow"> across all states', () => {
      const activeLiquid = renderProtocolLiquid({ protocol: mockProtocol });
      assert.ok(activeLiquid.includes('<meta name="robots" content="noindex, nofollow">'));

      const archivedLiquid = renderProtocolLiquid({ protocol: { ...mockProtocol, status: 'archived' } });
      assert.ok(archivedLiquid.includes('<meta name="robots" content="noindex, nofollow">'));

      const disabledLiquid = renderProtocolLiquid({ protocol: { ...mockProtocol, status: 'disabled' } });
      assert.ok(disabledLiquid.includes('<meta name="robots" content="noindex, nofollow">'));

      const notFoundLiquid = renderProtocolLiquid({ protocol: null });
      assert.ok(notFoundLiquid.includes('<meta name="robots" content="noindex, nofollow">'));
    });

    it('renders full active client page with 1-tap cart AJAX and hidden protocol properties', () => {
      const liquid = renderProtocolLiquid({
        protocol: mockProtocol,
        practiceName: 'Elite Functional Medicine'
      });

      assert.ok(liquid.includes('Elite Functional Medicine'));
      assert.ok(liquid.includes('Gut Health Daily Regimen'));
      assert.ok(liquid.includes('Digestive Enzymes Pro'));
      assert.ok(liquid.includes('Out of stock'));
      assert.ok(liquid.includes('Add all to cart'));
      assert.ok(liquid.includes('_protocol_token'));
      assert.ok(liquid.includes('_protocol_id'));
      assert.ok(liquid.includes('/cart/add.js'));
      assert.ok(liquid.includes('protocol-line-error'));
      assert.ok(liquid.includes('errBody.description || errBody.message'));
    });

    it('shows practitioner banner when signed in as professional', () => {
      const clientView = renderProtocolLiquid({ protocol: mockProtocol, isLoggedInPractitioner: false });
      assert.ok(!clientView.includes("You're signed in as a professional"));

      const practitionerPreview = renderProtocolLiquid({ protocol: mockProtocol, isLoggedInPractitioner: true });
      assert.ok(practitionerPreview.includes("You're signed in as a professional. Clients will see retail prices."));
    });

    it('renders clean friendly states for archived, disabled, and not found protocols', () => {
      const archived = renderProtocolLiquid({ protocol: { ...mockProtocol, status: 'archived' } });
      assert.ok(archived.includes('Protocol No Longer Active'));
      assert.ok(!archived.includes('Add all to cart'));

      const disabled = renderProtocolLiquid({ protocol: { ...mockProtocol, status: 'disabled' } });
      assert.ok(disabled.includes('Protocol No Longer Active'));

      const notFound = renderProtocolLiquid({ protocol: null });
      assert.ok(notFound.includes('Protocol Not Found'));
    });

    it('neutralizes Liquid syntax across all user outputs including data-* attributes and JSON payloads', () => {
      const injectionProtocol = {
        id: 'proto_inject',
        token: 'tok_{{ customer.email }}',
        name: 'Protocol {{ customer.email }} and {% assign x = 1 %}',
        introNote: 'Intro {{   Customer.Email   }} and {%   assign y = 2   %}',
        status: 'active',
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/5001',
            quantity: 1,
            title: 'Title {{ CUSTOMER.EMAIL }} and {% ASSIGN a = 10 %}',
            variantTitle: 'Variant {{ customer.email }} {% Assign b = 20 %}',
            priceFormatted: '$20.00',
            usageNote: 'Take with water: {{- customer.email -}} and {%- assign x = 1 -%}',
            available: true
          }
        ]
      };

      const liquid = renderProtocolLiquid({
        protocol: injectionProtocol,
        practiceName: 'Clinic {{ customer.email }} {% assign hacked = true %}'
      });

      // 1. Assert user-supplied Liquid syntax is neutralized everywhere in output
      assert.ok(!liquid.includes('{{ customer.email }}'));
      assert.ok(!liquid.includes('{{ Customer.Email }}'));
      assert.ok(!liquid.includes('{{ CUSTOMER.EMAIL }}'));
      assert.ok(!liquid.includes('{{   Customer.Email   }}'));
      assert.ok(!liquid.includes('{{- customer.email -}}'));
      assert.ok(!liquid.includes('{% assign'));
      assert.ok(!liquid.includes('{%   assign'));
      assert.ok(!liquid.includes('{%- assign'));
      assert.ok(!liquid.includes('{% ASSIGN'));
      assert.ok(!liquid.includes('{% Assign'));

      // 2. Assert data-* attributes do not contain raw Liquid delimiters
      const dataUsageMatch = liquid.match(/data-usage="([^"]+)"/);
      assert.ok(dataUsageMatch, 'data-usage attribute must exist');
      assert.ok(!dataUsageMatch[1].includes('{{'), 'data-usage must not contain raw {{');
      assert.ok(!dataUsageMatch[1].includes('}}'), 'data-usage must not contain raw }}');
      assert.ok(!dataUsageMatch[1].includes('{%'), 'data-usage must not contain raw {%');
      assert.ok(!dataUsageMatch[1].includes('%'), 'data-usage must not contain raw %');
      assert.ok(dataUsageMatch[1].includes('&#123;&#123;'), 'data-usage must have escaped {');

      // 3. Assert JSON payload does not contain raw Liquid delimiters and parses safely
      const jsonMatch = liquid.match(/<script type="application\/json" id="protocol-data-payload">\s*([\s\S]*?)\s*<\/script>/);
      assert.ok(jsonMatch, 'JSON payload script tag must exist');
      const rawJson = jsonMatch[1];
      assert.ok(!rawJson.includes('{{'), 'JSON payload must not contain raw {{');
      assert.ok(!rawJson.includes('}}'), 'JSON payload must not contain raw }}');
      assert.ok(!rawJson.includes('{%'), 'JSON payload must not contain raw {%');
      assert.ok(!rawJson.includes('%'), 'JSON payload must not contain raw %');

      const parsed = JSON.parse(rawJson);
      assert.equal(
        parsed.items[0].usageNote,
        'Take with water: {{- customer.email -}} and {%- assign x = 1 -%}',
        'JSON.parse in client JS must recover the exact original text string'
      );
    });
  });
});
