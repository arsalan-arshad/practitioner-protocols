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
  handleOrdersPaid
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
  });
});
