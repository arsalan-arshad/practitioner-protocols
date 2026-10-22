import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyWebhookHmac,
  extractShopDomain,
  extractCustomerId,
  toCustomerGid,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  handleAppUninstalled,
  handleOrdersPaid,
  pruneProcessedWebhooks
} from '../app/lib/protocols/webhooks.js';

describe('Shopify Compliance & Attribution Webhooks (app/lib/protocols/webhooks.js)', () => {
  const apiSecret = 'test_webhook_secret_key_998877';

  describe('verifyWebhookHmac', () => {
    it('verifies valid X-Shopify-Hmac-Sha256 base64 header', () => {
      const rawBody = JSON.stringify({ shop_id: 12345, customer: { id: 6789 } });
      const hmac = crypto
        .createHmac('sha256', apiSecret)
        .update(Buffer.from(rawBody, 'utf8'))
        .digest('base64');

      assert.equal(verifyWebhookHmac(rawBody, hmac, apiSecret), true);
    });

    it('rejects tampered webhook payload or mismatched secret', () => {
      const rawBody = JSON.stringify({ shop_id: 12345, customer: { id: 6789 } });
      const hmac = crypto
        .createHmac('sha256', apiSecret)
        .update(Buffer.from(rawBody, 'utf8'))
        .digest('base64');

      const tamperedBody = JSON.stringify({ shop_id: 12345, customer: { id: 9999 } });
      assert.equal(verifyWebhookHmac(tamperedBody, hmac, apiSecret), false);
      assert.equal(verifyWebhookHmac(rawBody, hmac, 'wrong_secret'), false);
    });

    it('safely handles empty or invalid inputs', () => {
      assert.equal(verifyWebhookHmac('', 'abc', apiSecret), false);
      assert.equal(verifyWebhookHmac('body', '', apiSecret), false);
      assert.equal(verifyWebhookHmac('body', 'abc', ''), false);
    });
  });

  describe('Helper parsers', () => {
    it('extracts shop domain from multiple webhook shapes', () => {
      assert.equal(extractShopDomain({ shop_domain: 'store.myshopify.com' }), 'store.myshopify.com');
      assert.equal(extractShopDomain({ myshopify_domain: 'store2.myshopify.com' }), 'store2.myshopify.com');
      assert.equal(extractShopDomain({ shop: 'store3.myshopify.com' }), 'store3.myshopify.com');
    });

    it('extracts customer ID and normalizes to GID', () => {
      assert.equal(extractCustomerId({ customer: { id: 4455 } }), '4455');
      assert.equal(extractCustomerId({ customer_id: 8899 }), '8899');
      assert.equal(toCustomerGid('4455'), 'gid://shopify/Customer/4455');
      assert.equal(toCustomerGid('gid://shopify/Customer/4455'), 'gid://shopify/Customer/4455');
    });
  });

  describe('Mock DB Webhook Handlers', () => {
    function createMockDb() {
      const state = {
        queries: [],
        profiles: [{ id: 'prof_1', shop: 'test.myshopify.com', ownerGid: 'gid://shopify/Customer/100', practiceName: 'Apex Health' }],
        protocols: [{ id: 'proto_1', shop: 'test.myshopify.com', ownerId: 'gid://shopify/Customer/100', createdBy: 'gid://shopify/Customer/100', ownerType: 'customer', status: 'active' }],
        stats: [{ id: 'stat_1', shop: 'test.myshopify.com', protocolId: 'proto_1', month: '2026-10' }],
        sessions: [{ id: 'sess_1', shop: 'test.myshopify.com' }]
      };

      return {
        state,
        async query(sql, params) {
          state.queries.push({ sql, params });

          // customers/data_request profile query
          if (sql.includes('FROM "PractitionerProfile"') && sql.includes('WHERE "shop" = $1')) {
            const row = state.profiles.find(p => p.shop === params[0] && (p.ownerGid === params[1] || p.ownerGid === params[2]));
            return { rows: row ? [row] : [] };
          }

          // customers/data_request protocols query
          if (sql.includes('FROM "Protocol"') && sql.includes('WHERE "shop" = $1')) {
            const rows = state.protocols.filter(p => p.shop === params[0] && (p.ownerId === params[1] || p.createdBy === params[1]));
            return { rows };
          }

          // Setting query
          if (sql.includes('FROM "Setting"')) {
            return { rows: [{ identityMode: 'tag' }] };
          }

          // DELETE or UPDATE queries
          return { rowCount: 1, rows: [{ id: 'deleted_or_updated' }] };
        }
      };
    }

    it('handleCustomersDataRequest reports practitioner references with zero client PII', async () => {
      const mockDb = createMockDb();
      const payload = {
        shop_domain: 'test.myshopify.com',
        customer: { id: 100 }
      };

      const res = await handleCustomersDataRequest(mockDb, payload);
      assert.equal(res.success, true);
      assert.equal(res.shop, 'test.myshopify.com');
      assert.equal(res.customer.gid, 'gid://shopify/Customer/100');
      assert.ok(res.practitionerProfile);
      assert.equal(res.practitionerProfile.practiceName, 'Apex Health');
      assert.equal(res.clientPii, null);
      assert.equal(res.clientDataStored, false);
    });

    it('handleCustomersRedact handles Tag mode by removing profile and protocols', async () => {
      const mockDb = createMockDb();
      const payload = {
        shop_domain: 'test.myshopify.com',
        customer: { id: 100 }
      };

      const res = await handleCustomersRedact(mockDb, payload, { mode: 'tag' });
      assert.equal(res.success, true);
      assert.equal(res.mode, 'tag');
      assert.equal(res.profileDeleted, true);
    });

    it('handleCustomersRedact handles Company mode by preserving company protocols', async () => {
      const mockDb = createMockDb();
      const payload = {
        shop_domain: 'test.myshopify.com',
        customer: { id: 100 }
      };

      const res = await handleCustomersRedact(mockDb, payload, { mode: 'company' });
      assert.equal(res.success, true);
      assert.equal(res.mode, 'company');
      assert.ok(res.referencesCleared >= 0);
    });

    it('handleShopRedact deletes all shop records', async () => {
      const mockDb = createMockDb();
      const payload = { shop_domain: 'test.myshopify.com' };

      const res = await handleShopRedact(mockDb, payload);
      assert.equal(res.success, true);
      assert.equal(res.shop, 'test.myshopify.com');
      assert.ok(mockDb.state.queries.some(q => q.sql.includes('DELETE FROM "Protocol"')));
      assert.ok(mockDb.state.queries.some(q => q.sql.includes('DELETE FROM "PractitionerProfile"')));
    });

    it('handleAppUninstalled revokes sessions and updates shop state', async () => {
      const mockDb = createMockDb();
      const payload = { shop_domain: 'test.myshopify.com' };

      const res = await handleAppUninstalled(mockDb, payload);
      assert.equal(res.success, true);
      assert.ok(res.uninstalledAt);
      assert.ok(mockDb.state.queries.some(q => q.sql.includes('DELETE FROM "Session"')));
    });

    it('handleOrdersPaid extracts protocol attributions and triggers stats update', async () => {
      const mockDb = {
        queries: [],
        async query(sql, params) {
          this.queries.push({ sql, params });
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/100' }] };
          }
          return { rowCount: 1, rows: [{ id: 'stat_1' }] };
        }
      };

      const payload = {
        shop_domain: 'test.myshopify.com',
        line_items: [
          {
            id: 111,
            variant_id: 222,
            quantity: 2,
            price: '25.00',
            properties: [
              { name: '_protocol_token', value: 'tok_test123456789' },
              { name: '_protocol_id', value: 'proto_1' }
            ]
          }
        ]
      };

      const res = await handleOrdersPaid(mockDb, payload, { month: '2026-10' });
      assert.equal(res.success, true);
      assert.equal(res.attributions.length, 1);
      assert.equal(res.attributions[0].protocolToken, 'tok_test123456789');
      assert.equal(res.updatedCount, 1);
    });

    it('handleOrdersPaid ignores duplicate webhooks idempotently (Defect 6)', async () => {
      const processedWebhooks = new Set();
      const mockDb = {
        queries: [],
        async query(sql, params) {
          this.queries.push({ sql, params });
          if (sql.includes('INSERT INTO "ProcessedWebhook"')) {
            const key = `${params[0]}:${params[1]}`;
            if (processedWebhooks.has(key)) {
              return { rowCount: 0, rows: [] }; // duplicate
            }
            processedWebhooks.add(key);
            return { rowCount: 1, rows: [{ id: 'pw_1' }] };
          }
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/100' }] };
          }
          return { rowCount: 1, rows: [{ id: 'stat_1' }] };
        }
      };

      const payload = {
        id: 7788990011,
        shop_domain: 'test.myshopify.com',
        line_items: [
          {
            id: 111,
            variant_id: 222,
            quantity: 1,
            price: '20.00',
            properties: [{ name: '_protocol_token', value: 'tok_test123456789' }]
          }
        ]
      };

      // First run: processes normally
      const res1 = await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_id_7788', month: '2026-10' });
      assert.equal(res1.success, true);
      assert.equal(res1.updatedCount, 1);
      assert.equal(res1.duplicate, undefined);

      // Second run with same webhook ID: recognized as duplicate and skipped
      const res2 = await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_id_7788', month: '2026-10' });
      assert.equal(res2.success, true);
      assert.equal(res2.duplicate, true);
      assert.equal(res2.updatedCount, 0);
    });

    it('handleOrdersPaid guarantees atomicity across multiple protocol attributions (Defect 6)', async () => {
      let rollbackCalled = false;
      let secondProtocolQueryCount = 0;

      const mockDb = {
        queries: [],
        async query(sql, params) {
          this.queries.push({ sql, params });
          if (sql === 'ROLLBACK') {
            rollbackCalled = true;
            return {};
          }
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            if (params[1] === 'tok_success') {
              return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/1' }] };
            }
            if (params[1] === 'tok_fail') {
              secondProtocolQueryCount++;
              throw new Error('Database connection failure during protocol B update');
            }
          }
          return { rowCount: 1, rows: [{ id: 'ok' }] };
        }
      };

      const payload = {
        id: 999111,
        shop_domain: 'test.myshopify.com',
        line_items: [
          {
            id: 1,
            variant_id: 10,
            quantity: 1,
            price: '10.00',
            properties: [{ name: '_protocol_token', value: 'tok_success' }]
          },
          {
            id: 2,
            variant_id: 20,
            quantity: 1,
            price: '20.00',
            properties: [{ name: '_protocol_token', value: 'tok_fail' }]
          }
        ]
      };

      await assert.rejects(
        async () => {
          await handleOrdersPaid(mockDb, payload, { month: '2026-10' });
        },
        /Database connection failure/
      );

      assert.equal(rollbackCalled, true, 'Transaction must rollback atomically when any protocol attribution fails');
    });

    it('handleCustomersRedact propagates database errors (Defect 7)', async () => {
      const failingDb = {
        async query(sql) {
          if (sql.includes('DELETE FROM "PractitionerProfile"')) {
            throw new Error('Database disk error during redaction');
          }
          return { rowCount: 1, rows: [] };
        }
      };

      const payload = { shop_domain: 'test.myshopify.com', customer: { id: 100 } };

      await assert.rejects(
        async () => {
          await handleCustomersRedact(failingDb, payload, { mode: 'tag' });
        },
        /Database disk error during redaction/
      );
    });

    it('handleCustomersRedact rejects when required identifiers are missing (Defect 7)', async () => {
      const mockDb = { async query() { return { rowCount: 1, rows: [] }; } };

      await assert.rejects(
        async () => {
          await handleCustomersRedact(mockDb, { customer: { id: 100 } }); // missing shop
        },
        /Redaction failed/
      );

      await assert.rejects(
        async () => {
          await handleCustomersRedact(mockDb, { shop_domain: 'test.myshopify.com' }); // missing customer
        },
        /Redaction failed/
      );
    });

    it('handleShopRedact propagates database errors (Defect 7)', async () => {
      const failingDb = {
        async query(sql) {
          if (sql.includes('DELETE FROM "Protocol"')) {
            throw new Error('Database timeout during shop redaction');
          }
          return { rowCount: 1, rows: [] };
        }
      };

      const payload = { shop_domain: 'test.myshopify.com' };

      await assert.rejects(
        async () => {
          await handleShopRedact(failingDb, payload);
        },
        /Database timeout during shop redaction/
      );
    });

    it('pruneProcessedWebhooks removes rows older than specified days using parameterized query (Fix 1d)', async () => {
      let executedSql = '';
      let executedParams = [];
      const mockDb = {
        async query(sql, params) {
          executedSql = sql;
          executedParams = params;
          return { rowCount: 14, rows: [] };
        }
      };

      const result = await pruneProcessedWebhooks(mockDb, 7);
      assert.equal(result.rowCount, 14);
      assert.ok(executedSql.includes('DELETE FROM "ProcessedWebhook"'));
      assert.ok(executedSql.includes('processedAt'));
      assert.deepEqual(executedParams, [7], 'Days parameter must be passed as parameterized value');
    });

    it('handleShopRedact deletes ProcessedWebhook rows and includes them in deleted count (Fix 1d)', async () => {
      let webhooksDeleted = false;
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('DELETE FROM "ProcessedWebhook"')) {
            webhooksDeleted = true;
            return { rowCount: 5, rows: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }] };
          }
          return { rowCount: 1, rows: [{ id: '1' }] };
        }
      };

      const result = await handleShopRedact(mockDb, { shop_domain: 'redact-test.myshopify.com' });
      assert.equal(webhooksDeleted, true, 'shop/redact must delete ProcessedWebhook rows');
      assert.equal(result.deleted.webhooks, 5);
    });

    it('handleAppUninstalled propagates database errors on session deletion (Fix 2)', async () => {
      const failingDb = {
        async query(sql) {
          if (sql.includes('DELETE FROM "Session"')) {
            throw new Error('Database connection reset during session deletion');
          }
          return { rowCount: 1, rows: [] };
        }
      };

      await assert.rejects(
        async () => {
          await handleAppUninstalled(failingDb, { shop_domain: 'test.myshopify.com' });
        },
        /Database connection reset during session deletion/
      );
    });

    it('first delivery failure rolls back marker so retry counts exactly once (Fix 1a)', async () => {
      let attempt = 0;
      const processedStore = new Set();
      let committedStats = 0;

      // Mock database simulating transactional rollback on delivery failure
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('INSERT INTO "ProcessedWebhook"')) {
            const key = `${params[0]}:${params[1]}`;
            if (processedStore.has(key)) {
              return { rowCount: 0, rows: [] }; // duplicate
            }
            // Record tentatively inside transaction
            processedStore.add(key);
            return { rowCount: 1, rows: [{ id: 'pw_1' }] };
          }
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/100' }] };
          }
          if (sql.includes('INSERT INTO "ProtocolOrderStat"')) {
            if (attempt === 0) {
              // Delivery 1 throws transient error during stat update
              throw new Error('Transient PostgreSQL serialization failure');
            }
            committedStats++;
            return { rowCount: 1, rows: [{ id: 'stat_1' }] };
          }
          if (sql === 'ROLLBACK') {
            // Transaction rolls back the ProcessedWebhook insert
            processedStore.clear();
            return {};
          }
          return { rowCount: 1, rows: [] };
        }
      };

      const payload = {
        id: 998877, // Order ID (must NOT be used as webhookId)
        shop_domain: 'test.myshopify.com',
        line_items: [
          { id: 1, variant_id: 10, quantity: 1, price: '25.00', properties: [{ name: '_protocol_token', value: 'tok_retry' }] }
        ]
      };

      // Delivery 1: fails during stat update
      attempt = 0;
      await assert.rejects(
        async () => {
          await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_delivery_123', month: '2026-10' });
        },
        /Transient PostgreSQL serialization failure/
      );

      // Delivery 2 (Shopify retry): succeeds and counts exactly once
      attempt = 1;
      const retryResult = await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_delivery_123', month: '2026-10' });
      assert.equal(retryResult.success, true);
      assert.equal(retryResult.duplicate, undefined);
      assert.equal(retryResult.updatedCount, 1, 'Retry must count attribution after initial failure');
      assert.equal(committedStats, 1);

      // Delivery 3 (True duplicate): skipped
      const duplicateResult = await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_delivery_123', month: '2026-10' });
      assert.equal(duplicateResult.success, true);
      assert.equal(duplicateResult.duplicate, true);
      assert.equal(duplicateResult.updatedCount, 0, 'True duplicate must be skipped');
      assert.equal(committedStats, 1);
    });

    it('never writes order ID or customer ID to ProcessedWebhook table (Fix 1b & 1c)', async () => {
      const capturedParams = [];
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('INSERT INTO "ProcessedWebhook"')) {
            capturedParams.push(params);
            return { rowCount: 1, rows: [{ id: 'pw_1' }] };
          }
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/100' }] };
          }
          return { rowCount: 1, rows: [{ id: 'stat_1' }] };
        }
      };

      const orderIdNumeric = 99112233;
      const customerIdNumeric = 445566;
      const payload = {
        id: orderIdNumeric,
        customer: { id: customerIdNumeric },
        shop_domain: 'test.myshopify.com',
        line_items: [
          { id: 1, variant_id: 10, quantity: 1, price: '30.00', properties: [{ name: '_protocol_token', value: 'tok_test' }] }
        ]
      };

      await handleOrdersPaid(mockDb, payload, { webhookId: 'wh_unique_header_id_777', month: '2026-10' });

      assert.equal(capturedParams.length, 1);
      const insertParams = capturedParams[0];
      // Assert order ID and customer ID are never written to ProcessedWebhook
      for (const param of insertParams) {
        assert.notEqual(param, String(orderIdNumeric), 'Order ID must NEVER be stored in ProcessedWebhook');
        assert.notEqual(param, orderIdNumeric, 'Order ID must NEVER be stored in ProcessedWebhook');
        assert.notEqual(param, String(customerIdNumeric), 'Customer ID must NEVER be stored in ProcessedWebhook');
        assert.notEqual(param, customerIdNumeric, 'Customer ID must NEVER be stored in ProcessedWebhook');
      }
      assert.equal(insertParams[1], 'wh_unique_header_id_777', 'Must use exact webhookId from header');
    });

    it('handleOrdersPaid tracks separate stats per currency for the same protocol and month (Defect 6)', async () => {
      const upsertParams = [];
      const mockDb = {
        async query(sql, params) {
          if (sql.includes('SELECT id, "ownerId" FROM "Protocol"')) {
            return { rows: [{ id: 'proto_1', ownerId: 'gid://shopify/Customer/100' }] };
          }
          if (sql.includes('INSERT INTO "ProtocolOrderStat"')) {
            upsertParams.push(params);
            return { rowCount: 1, rows: [{ id: 'stat_1' }] };
          }
          return { rowCount: 1, rows: [] };
        }
      };

      const usdPayload = {
        id: 1001,
        shop_domain: 'test.myshopify.com',
        currency: 'USD',
        line_items: [
          { id: 1, variant_id: 10, quantity: 1, price: '20.00', properties: [{ name: '_protocol_token', value: 'tok_1' }] }
        ]
      };

      const eurPayload = {
        id: 1002,
        shop_domain: 'test.myshopify.com',
        currency: 'EUR',
        line_items: [
          { id: 2, variant_id: 10, quantity: 2, price: '18.00', properties: [{ name: '_protocol_token', value: 'tok_1' }] }
        ]
      };

      await handleOrdersPaid(mockDb, usdPayload, { month: '2026-10' });
      await handleOrdersPaid(mockDb, eurPayload, { month: '2026-10' });

      assert.equal(upsertParams.length, 2);
      assert.equal(upsertParams[0][6], 'USD');
      assert.equal(upsertParams[1][6], 'EUR');
    });
  });
});
