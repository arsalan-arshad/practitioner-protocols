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
import {
  withTransaction,
  createProtocol,
  updateProtocol,
  recordOrderAttribution
} from '../app/lib/protocols/service.js';

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

    it('computes revenue from discounted line totals (REST total_discount)', () => {
      const discountedOrder = {
        id: 991122,
        line_items: [
          {
            id: 301,
            variant_id: 445566,
            quantity: 2,
            price: '40.00', // Gross = 80.00
            total_discount: '15.00', // Discounted line total = 65.00
            properties: [
              { name: '_protocol_token', value: 'tok_XYZ9876543210' },
              { name: '_protocol_id', value: 'prot_abc123' }
            ]
          }
        ]
      };

      const attributions = extractAttributionFromOrder(discountedOrder);
      assert.equal(attributions.length, 1);
      assert.equal(attributions[0].quantity, 2);
      assert.equal(attributions[0].priceMinor, 6500, 'Revenue must be 6500 cents (discounted line total)');
    });

    it('computes revenue from discounted line totals (REST discount_allocations)', () => {
      const allocatedOrder = {
        id: 991123,
        line_items: [
          {
            id: 302,
            variant_id: 445566,
            quantity: 1,
            price: '50.00',
            discount_allocations: [
              { amount: '10.00' },
              { amount: '2.50' }
            ], // Discounted line total = 37.50
            properties: [
              { name: '_protocol_token', value: 'tok_XYZ9876543210' }
            ]
          }
        ]
      };

      const attributions = extractAttributionFromOrder(allocatedOrder);
      assert.equal(attributions.length, 1);
      assert.equal(attributions[0].priceMinor, 3750, 'Revenue must be 3750 cents (after allocated discounts)');
    });

    it('prefers discount_allocations over legacy total_discount when both exist', () => {
      const orderWithBoth = {
        id: 991125,
        currency: 'USD',
        line_items: [
          {
            id: 304,
            variant_id: 445566,
            quantity: 1,
            price: '50.00',
            discount_allocations: [{ amount: '12.50' }], // should be used: net 37.50 = 3750
            total_discount: '5.00', // legacy deprecated field: should be IGNORED
            properties: [
              { name: '_protocol_token', value: 'tok_XYZ9876543210' }
            ]
          }
        ]
      };

      const attributions = extractAttributionFromOrder(orderWithBoth);
      assert.equal(attributions.length, 1);
      assert.equal(attributions[0].priceMinor, 3750, 'Must compute discount from discount_allocations, ignoring legacy total_discount');
    });

    it('correctly scales minor currency units according to currency exponent (JPY=0, KWD=3, USD=2)', () => {
      const jpyOrder = {
        id: 991126,
        currency: 'JPY',
        line_items: [
          {
            id: 305,
            variant_id: 445566,
            quantity: 1,
            price: '5000',
            discount_allocations: [{ amount: '500' }],
            properties: [{ name: '_protocol_token', value: 'tok_XYZ9876543210' }]
          }
        ]
      };
      const jpyAttrs = extractAttributionFromOrder(jpyOrder);
      assert.equal(jpyAttrs[0].priceMinor, 4500, 'JPY has 0 decimal places: factor is 1');

      const kwdOrder = {
        id: 991127,
        currency: 'KWD',
        line_items: [
          {
            id: 306,
            variant_id: 445566,
            quantity: 1,
            price: '15.000',
            discount_allocations: [{ amount: '2.500' }],
            properties: [{ name: '_protocol_token', value: 'tok_XYZ9876543210' }]
          }
        ]
      };
      const kwdAttrs = extractAttributionFromOrder(kwdOrder);
      assert.equal(kwdAttrs[0].priceMinor, 12500, 'KWD has 3 decimal places: factor is 1000');
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

  describe('withTransaction & Connection Pool Single-Client Guarantees (Defect 5)', () => {
    function createFakePool() {
      const poolQueries = [];
      const clientQueries = [];
      let connectCalls = 0;
      let releaseCalls = 0;

      const fakeClient = {
        async query(sql, params) {
          clientQueries.push({ sql, params });
          if (sql.includes('INSERT INTO "Protocol"')) {
            return { rows: [{ id: 'proto_new', name: 'Test', token: 'tok_test123456789' }] };
          }
          if (sql.includes('INSERT INTO "ProtocolLine"')) {
            return { rows: [{ id: 'line_1' }] };
          }
          if (sql.includes('SELECT') && sql.includes('FROM "Protocol"') && sql.includes('WHERE')) {
            return {
              rows: [{
                id: 'proto_1',
                name: 'Test',
                shop: 'test.myshopify.com',
                ownerId: 'gid://shopify/Customer/1',
                ownerType: 'customer',
                status: 'active',
                lines: [{ id: 'l1', variantGid: 'gid://shopify/ProductVariant/1001', quantity: 1 }]
              }]
            };
          }
          if (sql.includes('UPDATE "Protocol"')) {
            return { rows: [{ id: 'proto_1', name: 'Updated' }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {
          releaseCalls++;
        }
      };

      const fakePool = {
        async query(sql, params) {
          poolQueries.push({ sql, params });
          // If pool.query is invoked directly during a transaction, this fails the single client invariant!
          throw new Error(`pool.query() was invoked directly instead of client.query()! Query: ${sql}`);
        },
        async connect() {
          connectCalls++;
          return fakeClient;
        }
      };

      return { fakePool, fakeClient, poolQueries, clientQueries, getConnectCalls: () => connectCalls, getReleaseCalls: () => releaseCalls };
    }

    it('withTransaction acquires a single client from pool, executes queries, commits, and releases', async () => {
      const { fakePool, clientQueries, getConnectCalls, getReleaseCalls } = createFakePool();

      const result = await withTransaction(fakePool, async (tx) => {
        await tx.query('SELECT 1');
        await tx.query('UPDATE test SET x = 1');
        return 'success';
      });

      assert.equal(result, 'success');
      assert.equal(getConnectCalls(), 1, 'Should call pool.connect() exactly once');
      assert.equal(getReleaseCalls(), 1, 'Should call client.release() exactly once');
      assert.equal(clientQueries[0].sql, 'BEGIN');
      assert.equal(clientQueries[1].sql, 'SELECT 1');
      assert.equal(clientQueries[2].sql, 'UPDATE test SET x = 1');
      assert.equal(clientQueries[3].sql, 'COMMIT');
    });

    it('withTransaction rolls back and releases client when transaction fn throws', async () => {
      const { fakePool, clientQueries, getConnectCalls, getReleaseCalls } = createFakePool();

      await assert.rejects(
        async () => {
          await withTransaction(fakePool, async (tx) => {
            await tx.query('INSERT INTO something VALUES (1)');
            throw new Error('Transaction failure');
          });
        },
        /Transaction failure/
      );

      assert.equal(getConnectCalls(), 1);
      assert.equal(getReleaseCalls(), 1);
      assert.equal(clientQueries[0].sql, 'BEGIN');
      assert.equal(clientQueries[1].sql, 'INSERT INTO something VALUES (1)');
      assert.equal(clientQueries[2].sql, 'ROLLBACK');
    });

    it('withTransaction recognizes pg.Client without relying on constructor.name (Item 4)', async () => {
      // Simulates a pg.Client with minified constructor name ('c' or 'MinifiedClient')
      // and pg.Client properties (connectionParameters, _queryable)
      const queries = [];
      const minifiedClient = {
        _queryable: true,
        connectionParameters: { host: 'localhost', database: 'test' },
        async query(sql, params) {
          queries.push(sql);
          return { rows: [] };
        },
        async connect() {
          // In real pg, client.connect() connects the socket and returns Promise<void>,
          // NOT a checked-out client. If withTransaction mistakes this for a pool,
          // it will try to use the returned void/undefined as the client or throw here.
          throw new Error('pool checkout connect() called on a pg.Client');
        }
      };
      Object.defineProperty(minifiedClient, 'constructor', { value: { name: 'c' } });

      const res = await withTransaction(minifiedClient, async (tx) => {
        await tx.query('SELECT 1');
        return 'success';
      });

      assert.equal(res, 'success');
      assert.deepEqual(queries, ['BEGIN', 'SELECT 1', 'COMMIT']);
    });

    it('recordOrderAttribution uses withTransaction and checked-out client from pool', async () => {
      const { fakePool, clientQueries, poolQueries, getConnectCalls, getReleaseCalls } = createFakePool();

      const result = await recordOrderAttribution(fakePool, {
        shop: 'test.myshopify.com',
        attributions: [{ protocolToken: 'tok_test123456789', quantity: 2, priceMinor: 4000 }],
        month: '2026-10',
        currency: 'USD'
      });

      assert.equal(result.updatedCount, 1);
      assert.equal(getConnectCalls(), 1, 'Should check out a single client from pool');
      assert.equal(getReleaseCalls(), 1, 'Should release client back to pool');
      assert.equal(poolQueries.length, 0, 'No queries should run on pool.query');
      assert.equal(clientQueries[0].sql, 'BEGIN');
      assert.ok(clientQueries.some(q => q.sql.includes('INSERT INTO "ProtocolOrderStat"')));
      assert.equal(clientQueries[clientQueries.length - 1].sql, 'COMMIT');
    });

    it('createProtocol uses withTransaction and checked-out client from pool', async () => {
      const { fakePool, clientQueries, poolQueries, getConnectCalls, getReleaseCalls } = createFakePool();

      const user = { id: 'usr_1', role: 'practitioner', ownerType: 'customer', ownerId: 'gid://shopify/Customer/1' };
      const input = {
        name: 'New Cardio Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/1001', quantity: 1 }]
      };

      const result = await createProtocol(fakePool, {
        shop: 'test.myshopify.com',
        user,
        input
      });

      assert.ok(result.id);
      assert.equal(getConnectCalls(), 1);
      assert.equal(getReleaseCalls(), 1);
      assert.equal(poolQueries.length, 0);
      assert.equal(clientQueries[0].sql, 'BEGIN');
      assert.equal(clientQueries[clientQueries.length - 1].sql, 'COMMIT');
    });

    it('updateProtocol uses withTransaction and checked-out client from pool', async () => {
      const { fakePool, clientQueries, poolQueries, getConnectCalls, getReleaseCalls } = createFakePool();

      const user = { id: 'gid://shopify/Customer/1', role: 'practitioner', ownerType: 'customer', ownerId: 'gid://shopify/Customer/1' };
      const input = {
        name: 'Updated Cardio Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/1001', quantity: 2 }]
      };

      const result = await updateProtocol(fakePool, {
        shop: 'test.myshopify.com',
        user,
        protocolId: 'proto_1',
        input
      });

      assert.ok(result.id);
      assert.equal(getConnectCalls(), 1);
      assert.equal(getReleaseCalls(), 1);
      assert.equal(poolQueries.length, 0);
      assert.ok(clientQueries.some(q => q.sql === 'BEGIN'));
      assert.ok(clientQueries.some(q => q.sql === 'COMMIT'));
    });

    it('updateProtocol does not combine GROUP BY with FOR UPDATE (PostgreSQL 0A000 compatibility)', async () => {
      const { fakePool, fakeClient, clientQueries } = createFakePool();
      const origClientQuery = fakeClient.query;
      fakeClient.query = async (sql, params) => {
        if (sql.includes('GROUP BY') && sql.includes('FOR UPDATE')) {
          throw new Error('PostgreSQL 0A000: FOR UPDATE is not allowed with GROUP BY clause');
        }
        return origClientQuery(sql, params);
      };

      const user = { id: 'gid://shopify/Customer/1', role: 'practitioner', ownerType: 'customer', ownerId: 'gid://shopify/Customer/1' };
      const input = {
        name: 'Updated Cardio Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/1001', quantity: 2 }]
      };

      const result = await updateProtocol(fakePool, {
        shop: 'test.myshopify.com',
        user,
        protocolId: 'proto_1',
        input
      });

      assert.ok(result.id);
      // Ensure the initial lock query is executed
      assert.ok(clientQueries.some(q => q.sql.includes('SELECT id FROM "Protocol"') && q.sql.includes('FOR UPDATE')));
      // Ensure the aggregate query does not have FOR UPDATE
      const aggregateQuery = clientQueries.find(q => q.sql.includes('GROUP BY'));
      assert.ok(aggregateQuery);
      assert.ok(!aggregateQuery.sql.includes('FOR UPDATE'));
    });
  });
});
