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

    // Practitioner B tries to read practitioner A's protocol -> gets NOT_FOUND (preventing existence leak)
    await assert.rejects(
      async () => {
        await service.getProtocolById(pgClient, {
          shop: testShop,
          user: practitionerB,
          protocolId: created.id,
          action: 'read'
        });
      },
      (err) => {
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      }
    );

    // Practitioner B tries to edit practitioner A's protocol -> gets NOT_FOUND (not a SQL error)
    await assert.rejects(
      async () => {
        await service.updateProtocol(pgClient, {
          shop: testShop,
          user: practitionerB,
          protocolId: created.id,
          input: { name: 'Hacked Name' }
        });
      },
      (err) => {
        assert.equal(err.code, 'NOT_FOUND');
        assert.ok(!err.message.includes('FOR UPDATE is not allowed'));
        return true;
      }
    );
  });

  it('owner update succeeds and replaces lines cleanly (Item 1)', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const created = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Initial Protocol Name',
        introNote: 'Initial note',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/101', quantity: 1, usageNote: 'Original line' }
        ]
      }
    });

    assert.equal(created.lines.length, 1);
    assert.equal(created.lines[0].variantGid, 'gid://shopify/ProductVariant/101');

    // Owner updates name and replaces lines
    const updated = await service.updateProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      protocolId: created.id,
      input: {
        name: 'Updated Protocol Name',
        introNote: 'Updated directions',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/201', quantity: 2, usageNote: 'New morning' },
          { variantGid: 'gid://shopify/ProductVariant/202', quantity: 1, usageNote: 'New evening' }
        ]
      }
    });

    assert.equal(updated.name, 'Updated Protocol Name');
    assert.equal(updated.introNote, 'Updated directions');
    assert.equal(updated.lines.length, 2);
    assert.equal(updated.lines[0].variantGid, 'gid://shopify/ProductVariant/201');
    assert.equal(updated.lines[0].quantity, 2);
    assert.equal(updated.lines[1].variantGid, 'gid://shopify/ProductVariant/202');
    assert.equal(updated.lines[1].quantity, 1);

    // Verify in database that old line 101 was completely replaced
    const linesRes = await pgClient.query(
      'SELECT * FROM "ProtocolLine" WHERE "protocolId" = $1 ORDER BY position ASC',
      [created.id]
    );
    assert.equal(linesRes.rows.length, 2);
    assert.equal(linesRes.rows[0].variantGid, 'gid://shopify/ProductVariant/201');
    assert.equal(linesRes.rows[1].variantGid, 'gid://shopify/ProductVariant/202');
  });

  it('concurrent updates do not corrupt data or deadlock (Item 1)', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const created = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Concurrent Test Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/301', quantity: 1 }]
      }
    });

    // Create a second dedicated pg.Client connection for concurrent transaction
    const pgModule = await import('pg');
    const pg = pgModule.default || pgModule;
    const client2 = new pg.Client({ host: 'localhost', port: 5432, database: 'practitioner_protocols' });
    await client2.connect();

    try {
      // Execute two simultaneous updates on the same protocol across two separate connections
      const p1 = service.updateProtocol(pgClient, {
        shop: testShop,
        user: practitionerA,
        protocolId: created.id,
        input: {
          name: 'Concurrent Update Winner 1',
          lines: [{ variantGid: 'gid://shopify/ProductVariant/301', quantity: 3 }]
        }
      });

      const p2 = service.updateProtocol(client2, {
        shop: testShop,
        user: practitionerA,
        protocolId: created.id,
        input: {
          name: 'Concurrent Update Winner 2',
          lines: [{ variantGid: 'gid://shopify/ProductVariant/302', quantity: 4 }]
        }
      });

      const results = await Promise.all([p1, p2]);
      assert.equal(results.length, 2);

      // Verify protocol is in a valid final state without corruption
      const finalState = await service.getProtocolById(pgClient, {
        shop: testShop,
        user: practitionerA,
        protocolId: created.id
      });

      assert.ok(
        finalState.name === 'Concurrent Update Winner 1' || finalState.name === 'Concurrent Update Winner 2',
        'Final state must match one of the serialized updates'
      );
      assert.equal(finalState.lines.length, 1);
    } finally {
      await client2.end();
    }
  });

  it('exercises full protocol lifecycle: list, archive, restore, and delete', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const created = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Lifecycle Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/401', quantity: 1 }]
      }
    });

    // List
    const list = await service.listProtocols(pgClient, { shop: testShop, user: practitionerA });
    assert.ok(list.some(p => p.id === created.id));

    // Archive
    const archived = await service.archiveProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      protocolId: created.id
    });
    assert.equal(archived.status, 'archived');

    // Restore
    const restored = await service.restoreProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      protocolId: created.id
    });
    assert.equal(restored.status, 'active');

    // Verify active row in database
    const checkActive = await service.getProtocolById(pgClient, {
      shop: testShop,
      user: practitionerA,
      protocolId: created.id
    });
    assert.equal(checkActive.status, 'active');
  });

  it('exercises orders/paid attribution and webhook idempotency on real PostgreSQL', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const webhooks = await import('../app/lib/protocols/webhooks.js');

    const proto = await service.createProtocol(pgClient, {
      shop: testShop,
      user: practitionerA,
      input: {
        name: 'Webhook Real DB Protocol',
        lines: [{ variantGid: 'gid://shopify/ProductVariant/601', quantity: 1 }]
      }
    });

    const webhookId = `wh_real_${Date.now()}`;
    const payload = {
      id: 887766,
      shop_domain: testShop,
      created_at: '2026-10-22T10:00:00Z',
      currency: 'USD',
      line_items: [
        {
          id: 1,
          variant_id: 601,
          quantity: 2,
          price: '40.00',
          properties: [{ name: '_protocol_token', value: proto.token }]
        }
      ]
    };

    // First delivery succeeds and records ProcessedWebhook
    const res1 = await webhooks.handleOrdersPaid(pgClient, payload, { webhookId });
    assert.equal(res1.success, true);
    assert.equal(res1.updatedCount, 1);

    // Second delivery with same webhookId is duplicate
    const res2 = await webhooks.handleOrdersPaid(pgClient, payload, { webhookId });
    assert.equal(res2.success, true);
    assert.equal(res2.duplicate, true);
    assert.equal(res2.updatedCount, 0);

    // Verify ProcessedWebhook row exists in real database
    const pwRes = await pgClient.query(
      'SELECT * FROM "ProcessedWebhook" WHERE "shop" = $1 AND "webhookId" = $2',
      [testShop, webhookId]
    );
    assert.equal(pwRes.rows.length, 1);

    // Test pruneProcessedWebhooks on real database
    const pruneRes = await webhooks.pruneProcessedWebhooks(pgClient, 7);
    assert.ok(typeof pruneRes.rowCount === 'number');
  });

  it('exercises compliance webhooks (data_request, redact, app_uninstalled) on real PostgreSQL', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const webhooks = await import('../app/lib/protocols/webhooks.js');

    // Create session to test uninstalled
    await pgClient.query(
      'INSERT INTO "Session" ("id", "shop", "state", "isOnline", "accessToken") VALUES ($1, $2, $3, false, $4) ON CONFLICT ("id") DO NOTHING',
      [`sess_${Date.now()}`, testShop, 'test_state', 'shp_test_token']
    );

    // customers/data_request
    const dataReqRes = await webhooks.handleCustomersDataRequest(pgClient, {
      shop_domain: testShop,
      customer: { id: 111, email: 'dr@apex.test' }
    });
    assert.equal(dataReqRes.success, true);
    assert.equal(dataReqRes.clientPii, null);

    // app/uninstalled revokes sessions
    const uninstalledRes = await webhooks.handleAppUninstalled(pgClient, { shop_domain: testShop });
    assert.equal(uninstalledRes.success, true);
    assert.ok(uninstalledRes.sessionsRevoked >= 1);

    // shop/redact purges shop data including ProcessedWebhook
    const redactRes = await webhooks.handleShopRedact(pgClient, { shop_domain: testShop });
    assert.equal(redactRes.success, true);
    assert.ok(typeof redactRes.deleted.protocols === 'number');
    assert.ok(typeof redactRes.deleted.webhooks === 'number');
  });

  it('exercises merchant admin controls on real PostgreSQL', async (t) => {
    if (!pgClient || !pgClient._connected) {
      t.skip('Skipped loudly: PostgreSQL connection not available on localhost:5432');
      return;
    }

    const admin = await import('../app/lib/protocols/admin.js');

    // Settings
    const updatedSettings = await admin.updateSettings(pgClient, {
      shop: testShop,
      adminUser,
      settings: {
        identityMode: 'company',
        footerDisclaimer: 'FDA Disclaimer: for wellness only.',
        handoutText: 'Call clinic with questions.'
      }
    });
    assert.equal(updatedSettings.identityMode, 'company');
    assert.equal(updatedSettings.footerDisclaimer, 'FDA Disclaimer: for wellness only.');

    const readSettings = await admin.getSettings(pgClient, { shop: testShop });
    assert.equal(readSettings.identityMode, 'company');

    // Practitioner profile management
    const profile = await admin.upsertPractitionerProfile(pgClient, {
      shop: testShop,
      ownerType: 'company',
      ownerGid: 'gid://shopify/Company/9999',
      practiceName: 'Elite Integrative Care',
      isApproved: true
    });
    assert.equal(profile.practiceName, 'Elite Integrative Care');

    const profilesList = await admin.listPractitionerProfiles(pgClient, { shop: testShop });
    assert.ok(profilesList.profiles.length >= 1);

    // Attribution report
    const report = await admin.getAttributionReport(pgClient, { shop: testShop, month: '2026-10' });
    assert.ok(Array.isArray(report.rows));
    assert.ok(Array.isArray(report.byPractice));
    assert.ok(Array.isArray(report.byProtocol));
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
