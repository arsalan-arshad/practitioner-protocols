import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCartAddPayload,
  extractAttributionFromOrder,
  aggregateMonthlyStats,
  normalizeVariantId,
  toVariantGid,
  toLineItemGid
} from '../app/lib/protocols/attribution.js';

describe('Attribution & Cart Payload (app/lib/protocols/attribution.js)', () => {
  const sampleProtocol = {
    id: 'prot_abc123',
    shareToken: 'tok_XYZ9876543210',
    lines: [
      {
        variantGid: 'gid://shopify/ProductVariant/445566',
        quantity: 1,
        usageNote: 'Take 1 capsule in morning'
      },
      {
        variantGid: 'gid://shopify/ProductVariant/778899',
        quantity: 2,
        usageNote: 'Apply evening to clean skin'
      }
    ]
  };

  describe('ID normalizers', () => {
    it('normalizes GID to numeric string and back', () => {
      assert.equal(normalizeVariantId('gid://shopify/ProductVariant/12345'), '12345');
      assert.equal(normalizeVariantId('12345'), '12345');
      assert.equal(toVariantGid('12345'), 'gid://shopify/ProductVariant/12345');
      assert.equal(toLineItemGid('9988'), 'gid://shopify/LineItem/9988');
    });
  });

  describe('buildCartAddPayload', () => {
    it('constructs standard Shopify Cart AJAX payload with hidden protocol properties', () => {
      const { items, skippedLines } = buildCartAddPayload({ protocol: sampleProtocol });
      assert.equal(skippedLines.length, 0);
      assert.equal(items.length, 2);

      assert.deepEqual(items[0], {
        id: '445566',
        quantity: 1,
        properties: {
          _protocol_token: 'tok_XYZ9876543210',
          _protocol_id: 'prot_abc123',
          _protocol_usage: 'Take 1 capsule in morning'
        }
      });

      assert.deepEqual(items[1], {
        id: '778899',
        quantity: 2,
        properties: {
          _protocol_token: 'tok_XYZ9876543210',
          _protocol_id: 'prot_abc123',
          _protocol_usage: 'Apply evening to clean skin'
        }
      });
    });

    it('filters out unavailable items when availableVariantIds is provided', () => {
      const availableVariantIds = ['gid://shopify/ProductVariant/445566']; // 778899 is out of stock
      const { items, skippedLines } = buildCartAddPayload({
        protocol: sampleProtocol,
        availableVariantIds
      });

      assert.equal(items.length, 1);
      assert.equal(items[0].id, '445566');

      assert.equal(skippedLines.length, 1);
      assert.deepEqual(skippedLines[0], {
        variantGid: 'gid://shopify/ProductVariant/778899',
        reason: 'OUT_OF_STOCK'
      });
    });

    it('handles empty or invalid protocol gracefully', () => {
      assert.deepEqual(buildCartAddPayload({ protocol: null }), { items: [], skippedLines: [] });
      assert.deepEqual(buildCartAddPayload({ protocol: {} }), { items: [], skippedLines: [] });
    });
  });

  describe('extractAttributionFromOrder', () => {
    it('extracts attribution from REST orders/paid webhook line items', () => {
      const mockOrder = {
        id: 9988776655,
        line_items: [
          {
            id: 1111,
            variant_id: 445566,
            quantity: 1,
            price: '38.50',
            properties: [
              { name: '_protocol_token', value: 'tok_XYZ9876543210' },
              { name: '_protocol_id', value: 'prot_abc123' },
              { name: '_protocol_usage', value: 'Take 1 capsule in morning' }
            ]
          },
          // Mixed cart: non-protocol regular store item
          {
            id: 2222,
            variant_id: 112233,
            quantity: 3,
            price: '15.00',
            properties: []
          }
        ]
      };

      const attributions = extractAttributionFromOrder(mockOrder);

      // Mixed cart test: only protocol line must be attributed!
      assert.equal(attributions.length, 1);
      assert.deepEqual(attributions[0], {
        protocolToken: 'tok_XYZ9876543210',
        protocolId: 'prot_abc123',
        lineItemGid: 'gid://shopify/LineItem/1111',
        variantGid: 'gid://shopify/ProductVariant/445566',
        quantity: 1,
        priceMinor: 3850 // 38.50 * 100 * 1
      });
    });

    it('extracts attribution from GraphQL lineItems format', () => {
      const mockOrderGql = {
        id: 'gid://shopify/Order/998877',
        lineItems: {
          nodes: [
            {
              id: 'gid://shopify/LineItem/5555',
              variant: { id: 'gid://shopify/ProductVariant/778899' },
              quantity: 2,
              discountedTotalSet: {
                shopMoney: { amount: '60.00' }
              },
              customAttributes: [
                { key: '_protocol_token', value: 'tok_XYZ9876543210' },
                { key: '_protocol_id', value: 'prot_abc123' }
              ]
            }
          ]
        }
      };

      const attributions = extractAttributionFromOrder(mockOrderGql);
      assert.equal(attributions.length, 1);
      assert.equal(attributions[0].protocolId, 'prot_abc123');
      assert.equal(attributions[0].quantity, 2);
      assert.equal(attributions[0].priceMinor, 6000); // 60.00 in cents
    });

    it('returns empty array when order has no attributed lines', () => {
      const organicOrder = {
        line_items: [
          { id: 10, variant_id: 20, quantity: 1, price: '10.00', properties: [] }
        ]
      };
      assert.deepEqual(extractAttributionFromOrder(organicOrder), []);
      assert.deepEqual(extractAttributionFromOrder(null), []);
    });
  });

  describe('aggregateMonthlyStats', () => {
    it('calculates increments and next totals accurately', () => {
      const currentStat = {
        ordersCount: 4,
        unitsCount: 10,
        revenueMinor: 25000 // $250.00
      };

      const newAttributions = [
        { quantity: 2, priceMinor: 6000 },
        { quantity: 1, priceMinor: 3850 }
      ];

      const res = aggregateMonthlyStats(currentStat, newAttributions);

      assert.equal(res.ordersIncrement, 1);
      assert.equal(res.unitsIncrement, 3);
      assert.equal(res.revenueMinorIncrement, 9850);

      assert.equal(res.nextOrdersCount, 5);
      assert.equal(res.nextUnitsCount, 13);
      assert.equal(res.nextRevenueMinor, 34850);
    });

    it('handles empty attribution lists cleanly', () => {
      const currentStat = { ordersCount: 2, unitsCount: 5, revenueMinor: 10000 };
      const res = aggregateMonthlyStats(currentStat, []);

      assert.equal(res.ordersIncrement, 0);
      assert.equal(res.unitsIncrement, 0);
      assert.equal(res.revenueMinorIncrement, 0);
      assert.equal(res.nextOrdersCount, 2);
      assert.equal(res.nextUnitsCount, 5);
      assert.equal(res.nextRevenueMinor, 10000);
    });
  });
});
