import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('PostgreSQL Database Integration (app/lib/protocols/service.js)', () => {
  let pgClient = null;
  let service = null;

  const testShop = 'test-wellness-store.myshopify.com';
  const practitionerA = {
    id: 'user_a',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/111'
  };
  const practitionerB = {
    id: 'user_b',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/222'
  };
  const adminUser = {
    id: 'admin_1',
    role: 'admin'
  };

  before(async () => {
    // Dynamically import local pg devDependency and service
    let pg = null;
    try {
      const pgModule = await import('pg');
      pg = pgModule.default || pgModule;
    } catch (e) {
      console.warn('⚠️  PostgreSQL Integration Skipped: "pg" driver is not installed in local devDependencies. Run "npm install --save-dev pg" to enable database tests. Details: %s', e.message);
      return;
    }

    service = await import('../app/lib/protocols/service.js');

    pgClient = new pg.Client({
      host: 'localhost',
      port: 5432,
      database: 'practitioner_protocols'
    });

    try {
      await pgClient.connect();
    } catch (e) {
      // If unable to connect to Postgres, skip loudly with detailed instructions
      console.warn('⚠️  PostgreSQL Integration Skipped: Could not connect to PostgreSQL server on localhost:5432. Ensure PostgreSQL is running with database "practitioner_protocols" and migrations applied. Error: %s', e.message);
      return;
    }

    // Insert practice profile for practitionerA with neutral fictional name
    await pgClient.query(`
      INSERT INTO "PractitionerProfile" ("id", "shop", "ownerType", "ownerGid", "practiceName", "isApproved", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, $1, 'customer', $2, 'Apex Integrative Wellness', true, NOW(), NOW())
      ON CONFLICT ("shop", "ownerGid") DO NOTHING
    `, [testShop, practitionerA.ownerId]);
  });

  after(async () => {
    if (pgClient) {
      try {
        await pgClient.query('DELETE FROM "Protocol" WHERE shop = $1', [testShop]);
        await pgClient.query('DELETE FROM "PractitionerProfile" WHERE shop = $1', [testShop]);
        await pgClient.query('DELETE FROM "ProtocolOrderStat" WHERE shop = $1', [testShop]);
        await pgClient.end();
      } catch (e) {
        // cleanup error
      }
    }
  });

  it('creates and reads a protocol with lines and practice branding', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const created = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Daily Cellular Energy Protocol',
        introNote: 'Core morning routine for mitochondrial support.',
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/5501',
            quantity: 1,
            usageNote: 'Take 1 capsule with breakfast'
          },
          {
            variantGid: 'gid://shopify/ProductVariant/5502',
            quantity: 2,
            usageNote: 'Mix 1 scoop in cold water'
          }
        ]
      }
    });

    assert.ok(created.id);
    assert.equal(created.name, 'Daily Cellular Energy Protocol');
    assert.equal(created.lines.length, 2);
    assert.ok(created.token.length >= 16);

    // Fetch via public token (Client page view)
    const publicView = await service.getProtocolByToken(pgClient, {
      shop: testShop,
      token: created.token
    });

    assert.ok(publicView);
    assert.equal(publicView.name, 'Daily Cellular Energy Protocol');
    assert.equal(publicView.practiceName, 'Apex Integrative Wellness');
    assert.equal(publicView.lines.length, 2);
  });

  it('enforces backend ownership: cross-practitioner access denied', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const created = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Private Routine A',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/9001', quantity: 1 }]
      }
    });

    // Practitioner B tries to read practitioner A's protocol
    await assert.rejects(
      async () => {
        await service.getProtocolById(pgClient, {
          shop: testShop,
          user: practitionerB,
          protocolId: created.id,
          action: 'read'
        });
      },
      /FORBIDDEN_OWNERSHIP_MISMATCH/
    );

    // Practitioner B tries to edit practitioner A's protocol
    await assert.rejects(
      async () => {
        await service.updateProtocol(pgClient, {
          shop: testShop,
          user: practitionerB,
          protocolId: created.id,
          input: { name: 'Hacked Name' }
        });
      },
      /FORBIDDEN_OWNERSHIP_MISMATCH/
    );
  });

  it('allows duplicating a protocol into own library', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    // Admin creates starter template
    const starter = await service.createProtocol(pgClient, {
      shop: testShop,
      user: adminUser,
      input: {
        name: 'Brand Foundation Starter',
        isStarter: true,
        lines: [{ variantGid: 'gid://shopify/ProductVariant/1111', quantity: 1 }]
      }
    });

    // Practitioner B duplicates the starter
    const duplicated = await service.duplicateProtocol(pgClient, {
      shop: testShop,
      user: practitionerB,
      protocolId: starter.id
    });

    assert.ok(duplicated.id);
    assert.notEqual(duplicated.id, starter.id);
    assert.notEqual(duplicated.token, starter.token);
    assert.equal(duplicated.ownerId, practitionerB.ownerId);
    assert.equal(duplicated.sourceProtocolId, starter.id);
    assert.equal(duplicated.name, 'Brand Foundation Starter (Copy)');
  });

  it('records monthly aggregate order attribution without individual shopper PII', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const proto = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Attribution Test Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/7777', quantity: 2 }]
      }
    });

    const month = '2026-10';
    const fakeAttributions = [
      {
        protocolToken: proto.token,
        quantity: 2,
        priceMinor: 5000 // $50.00
      }
    ];

    const result = await service.recordOrderAttribution(pgClient, {
      shop: testShop,
      attributions: fakeAttributions,
      month
    });

    assert.equal(result.updatedCount, 1);

    // Query aggregate stats directly
    const statRes = await pgClient.query(
      'SELECT * FROM "ProtocolOrderStat" WHERE shop = $1 AND "protocolId" = $2 AND month = $3',
      [testShop, proto.id, month]
    );

    assert.equal(statRes.rows.length, 1);
    const stat = statRes.rows[0];
    assert.equal(stat.orders, 1);
    assert.equal(stat.units, 2);
    assert.equal(Number(stat.revenueMinor), 5000);

    // Second order in the same month increments atomically
    await service.recordOrderAttribution(pgClient, {
      shop: testShop,
      attributions: fakeAttributions,
      month
    });

    const statRes2 = await pgClient.query(
      'SELECT * FROM "ProtocolOrderStat" WHERE shop = $1 AND "protocolId" = $2 AND month = $3',
      [testShop, proto.id, month]
    );

    const stat2 = statRes2.rows[0];
    assert.equal(stat2.orders, 2);
    assert.equal(stat2.units, 4);
    assert.equal(Number(stat2.revenueMinor), 10000);
  });
});
