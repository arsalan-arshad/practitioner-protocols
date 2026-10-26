import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProtocolAdminError,
  ADMIN_ERROR_CODES,
  assertNoPii,
  validatePracticeName,
  formatRevenue,
  escapeCsvField,
  listPractitionerProfiles,
  getPractitionerProfile,
  updatePracticeName,
  setPractitionerApproval,
  approvePractitioner,
  revokePractitioner,
  upsertPractitionerProfile,
  listStarterTemplates,
  createStarterTemplate,
  updateStarterTemplate,
  emergencyDisableProtocol,
  emergencyDisableAllProtocols,
  restoreDisabledProtocol,
  getSettings,
  updateSettings,
  getAttributionReport,
  formatAttributionCsv,
  exportAttributionCsv,
  renderAdminHtml
} from '../app/lib/protocols/admin.js';

describe('Merchant Admin Layer (app/lib/protocols/admin.js)', () => {
  const testShop = 'brand-store.myshopify.com';
  const adminUser = { id: 'admin_1', role: 'admin' };
  const practitionerUser = { id: 'user_1', role: 'practitioner' };

  function createMockDb(initialState = {}) {
    const state = {
      queries: [],
      profiles: (initialState.profiles || []).map(p => ({ ...p })),
      protocols: (initialState.protocols || []).map(p => ({ ...p })),
      lines: (initialState.lines || []).map(l => ({ ...l })),
      settings: (initialState.settings || []).map(s => ({ ...s })),
      orderStats: (initialState.orderStats || []).map(o => ({ ...o }))
    };

    return {
      state,
      async query(sql, params = []) {
        state.queries.push({ sql, params });

        // Transactions
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }

        // PractitionerProfile COUNT
        if (sql.includes('SELECT COUNT(*) as total FROM') && sql.includes('"PractitionerProfile"')) {
          let rows = state.profiles.filter(p => p.shop === params[0]);
          if (params.length > 1 && typeof params[1] === 'boolean') {
            rows = rows.filter(p => p.isApproved === params[1]);
          }
          return { rows: [{ total: rows.length }] };
        }

        // PractitionerProfile SELECT (list or single)
        if (sql.includes('SELECT') && sql.includes('FROM "PractitionerProfile"')) {
          if (sql.includes('"ownerGid" = $2')) {
            const profile = state.profiles.find(p => p.shop === params[0] && p.ownerGid === params[1]);
            return { rows: profile ? [{ ...profile }] : [] };
          }
          let rows = state.profiles.filter(p => p.shop === params[0]);
          if (params.includes(true)) {
            rows = rows.filter(p => p.isApproved === true);
          } else if (params.includes(false)) {
            rows = rows.filter(p => p.isApproved === false);
          }
          if (params.includes('company')) {
            rows = rows.filter(p => p.ownerType === 'company');
          } else if (params.includes('customer')) {
            rows = rows.filter(p => p.ownerType === 'customer');
          }
          return { rows: rows.map(r => ({ ...r })) };
        }

        // PractitionerProfile UPDATE practiceName
        if (sql.includes('UPDATE "PractitionerProfile"') && sql.includes('"practiceName" = $1')) {
          const [practiceName, shop, ownerGid] = params;
          const profile = state.profiles.find(p => p.shop === shop && p.ownerGid === ownerGid);
          if (!profile) return { rows: [] };
          profile.practiceName = practiceName;
          profile.updatedAt = new Date();
          return { rows: [{ ...profile }] };
        }

        // PractitionerProfile UPDATE isApproved
        if (sql.includes('UPDATE "PractitionerProfile"') && sql.includes('"isApproved" = $1')) {
          const [isApproved, shop, ownerGid] = params;
          const profile = state.profiles.find(p => p.shop === shop && p.ownerGid === ownerGid);
          if (!profile) return { rows: [] };
          profile.isApproved = isApproved;
          profile.updatedAt = new Date();
          return { rows: [{ ...profile }] };
        }

        // PractitionerProfile UPSERT
        if (sql.includes('INSERT INTO "PractitionerProfile"')) {
          const [shop, ownerType, ownerGid, practiceName, logoUrl, isApproved] = params;
          const existing = state.profiles.find(p => p.shop === shop && p.ownerGid === ownerGid);
          if (existing) {
            existing.practiceName = practiceName;
            existing.ownerType = ownerType;
            existing.logoUrl = logoUrl ?? existing.logoUrl;
            existing.isApproved = isApproved;
            existing.updatedAt = new Date();
            return { rows: [{ ...existing }] };
          }
          const created = {
            id: `prof_${Date.now()}_${Math.random()}`,
            shop,
            ownerType,
            ownerGid,
            practiceName,
            logoUrl,
            isApproved,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.profiles.push(created);
          return { rows: [{ ...created }] };
        }

        // Protocol starter check (SELECT id, "isStarter" FROM "Protocol" ...)
        if (sql.includes('SELECT id, "isStarter" FROM "Protocol"')) {
          const proto = state.protocols.find(p => p.shop === params[0] && p.id === params[1]);
          return { rows: proto ? [{ id: proto.id, isStarter: proto.isStarter }] : [] };
        }

        // Protocol list starters (SELECT p.*, ... FROM "Protocol" p ... "isStarter" = true)
        if (sql.includes('FROM "Protocol" p') && sql.includes('"isStarter" = true')) {
          let rows = state.protocols.filter(p => p.shop === params[0] && p.isStarter === true);
          if (params[1]) {
            rows = rows.filter(p => p.status === params[1]);
          }
          const mapped = rows.map(p => ({
            ...p,
            lines: state.lines.filter(l => l.protocolId === p.id)
          }));
          return { rows: mapped };
        }

        // Protocol by ID for service.updateProtocol / getProtocolById
        if (sql.includes('FROM "Protocol"') && (sql.includes('p.id = $2') || sql.includes('id = $2'))) {
          const proto = state.protocols.find(p => p.shop === params[0] && p.id === params[1]);
          if (!proto) return { rows: [] };
          const lines = state.lines.filter(l => l.protocolId === proto.id);
          return { rows: [{ ...proto, lines }] };
        }

        // Protocol INSERT (service.createProtocol)
        if (sql.includes('INSERT INTO "Protocol"')) {
          const [
            shop, token, name, introNote, displayName,
            ownerType, ownerId, createdBy, status,
            isStarter, sourceProtocolId
          ] = params;
          const created = {
            id: `proto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            shop,
            token,
            name,
            introNote,
            displayName,
            ownerType,
            ownerId,
            createdBy,
            updatedBy: createdBy,
            status,
            isStarter,
            sourceProtocolId,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.protocols.push(created);
          return { rows: [{ ...created }] };
        }

        // ProtocolLine INSERT
        if (sql.includes('INSERT INTO "ProtocolLine"')) {
          const [protocolId, position, variantGid, quantity, usageNote] = params;
          const line = {
            id: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            protocolId,
            position,
            variantGid,
            quantity,
            usageNote,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.lines.push(line);
          return { rows: [{ ...line }] };
        }

        // ProtocolLine DELETE
        if (sql.includes('DELETE FROM "ProtocolLine" WHERE "protocolId" = $1')) {
          state.lines = state.lines.filter(l => l.protocolId !== params[0]);
          return { rowCount: 1, rows: [] };
        }

        // Protocol UPDATE
        if (sql.includes('UPDATE "Protocol"') && sql.includes('SET')) {
          // Emergency disable all
          if (sql.includes('WHERE shop = $2 AND "status" != \'disabled\'')) {
            const [updatedBy, shop] = params;
            let count = 0;
            for (const p of state.protocols) {
              if (p.shop === shop && p.status !== 'disabled') {
                p.status = 'disabled';
                p.updatedBy = updatedBy;
                p.updatedAt = new Date();
                count++;
              }
            }
            return { rowCount: count, rows: state.protocols.filter(p => p.shop === shop).map(p => ({ id: p.id })) };
          }

          // Emergency disable or restore single
          if (sql.includes('SET "status" = \'disabled\'') || sql.includes('SET "status" = \'active\'')) {
            const [updatedBy, shop, id] = params;
            const proto = state.protocols.find(p => p.shop === shop && p.id === id);
            if (!proto) return { rows: [] };
            const newStatus = sql.includes('SET "status" = \'disabled\'') ? 'disabled' : 'active';
            proto.status = newStatus;
            proto.updatedBy = updatedBy;
            proto.updatedAt = new Date();
            return { rows: [{ ...proto }] };
          }

          // Normal protocol update (service.updateProtocol)
          const [name, introNote, displayName, status, updatedBy, protocolId, shop] = params;
          const proto = state.protocols.find(p => p.shop === shop && p.id === protocolId);
          if (!proto) return { rows: [] };
          if (name !== null) proto.name = name;
          if (introNote !== null) proto.introNote = introNote;
          if (displayName !== null) proto.displayName = displayName;
          if (status !== null) proto.status = status;
          proto.updatedBy = updatedBy;
          proto.updatedAt = new Date();
          return { rows: [{ ...proto }] };
        }

        // Setting SELECT
        if (sql.includes('SELECT') && sql.includes('FROM "Setting"')) {
          const setting = state.settings.find(s => s.shop === params[0]);
          return { rows: setting ? [{ ...setting }] : [] };
        }

        // Setting UPSERT
        if (sql.includes('INSERT INTO "Setting"')) {
          const [shop, identityMode, footerDisclaimer, handoutText] = params;
          const existing = state.settings.find(s => s.shop === shop);
          if (existing) {
            existing.identityMode = identityMode || existing.identityMode;
            existing.footerDisclaimer = footerDisclaimer;
            existing.handoutText = handoutText;
            existing.updatedAt = new Date();
            return { rows: [{ ...existing }] };
          }
          const created = {
            shop,
            identityMode,
            footerDisclaimer,
            handoutText,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.settings.push(created);
          return { rows: [{ ...created }] };
        }

        // Attribution Report SELECT
        if (sql.includes('FROM "ProtocolOrderStat" s')) {
          let stats = state.orderStats.filter(s => s.shop === params[0]);
          if (params.includes('2026-10')) {
            stats = stats.filter(s => s.month === '2026-10');
          }
          const rows = stats.map(s => {
            const proto = state.protocols.find(p => p.id === s.protocolId);
            const prof = state.profiles.find(p => p.ownerGid === s.ownerId);
            return {
              month: s.month,
              protocolId: s.protocolId,
              protocolName: proto?.name || 'Unknown Protocol',
              isStarter: Boolean(proto?.isStarter),
              sourceProtocolId: proto?.sourceProtocolId || null,
              ownerId: s.ownerId,
              practiceName: prof?.practiceName || 'Unknown Practice',
              orders: s.orders,
              units: s.units,
              revenueMinor: s.revenueMinor,
              currency: s.currency || 'USD'
            };
          });
          return { rows };
        }

        return { rows: [] };
      }
    };
  }

  // ==========================================
  // Section 1: Helper & Validator Functions
  // ==========================================
  describe('Helper & Validator Functions', () => {
    it('validates practice names and trims whitespace', () => {
      assert.equal(validatePracticeName('  Apex Integrative Clinic  '), 'Apex Integrative Clinic');
    });

    it('rejects empty or whitespace-only practice names', () => {
      assert.throws(() => validatePracticeName(''), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.INVALID_INPUT
      });
      assert.throws(() => validatePracticeName('    '), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.INVALID_INPUT
      });
    });

    it('rejects practice names exceeding 100 characters', () => {
      const longName = 'A'.repeat(101);
      assert.throws(() => validatePracticeName(longName), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.INVALID_INPUT
      });
    });

    it('strictly forbids client PII or diagnostic terms in assertNoPii', () => {
      assert.throws(() => assertNoPii({ patientName: 'John Doe' }), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      });
      assert.throws(() => assertNoPii({ clientEmail: 'jane@example.com' }), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      });
      assert.throws(() => assertNoPii({ medicalDiagnosis: 'Hypertension' }), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      });
      assert.throws(() => assertNoPii({ nested: { healthCondition: 'Arthritis' } }), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      });
      // Non-PII is safely allowed
      assert.doesNotThrow(() => assertNoPii({ practiceName: 'Pacific Wellness', status: 'active' }));
    });

    it('formats revenue cents to 2-decimal strings', () => {
      assert.equal(formatRevenue(0), '0.00');
      assert.equal(formatRevenue(2450), '24.50');
      assert.equal(formatRevenue(100000), '1000.00');
      assert.equal(formatRevenue(BigInt(5599)), '55.99');
      assert.equal(formatRevenue(null), '0.00');
    });

    it('escapes CSV fields according to RFC 4180', () => {
      assert.equal(escapeCsvField('Simple Text'), 'Simple Text');
      assert.equal(escapeCsvField('Smith, Jones & Associates'), '"Smith, Jones & Associates"');
      assert.equal(escapeCsvField('Dr. "Healing" Center'), '"Dr. ""Healing"" Center"');
      assert.equal(escapeCsvField("Line 1\nLine 2"), '"Line 1\nLine 2"');
      assert.equal(escapeCsvField(null), '');
      assert.equal(escapeCsvField(123), '123');
    });
  });

  // ==========================================
  // Section 2: Practitioner Profile Management
  // ==========================================
  describe('Practitioner Profile Management', () => {
    const initialProfiles = [
      {
        id: 'prof_1',
        shop: testShop,
        ownerType: 'customer',
        ownerGid: 'gid://shopify/Customer/101',
        practiceName: 'Apex Integrative Wellness',
        logoUrl: 'https://cdn.shopify.com/logo1.png',
        isApproved: true
      },
      {
        id: 'prof_2',
        shop: testShop,
        ownerType: 'customer',
        ownerGid: 'gid://shopify/Customer/102',
        practiceName: 'Holistic Health Clinic',
        logoUrl: null,
        isApproved: false
      }
    ];

    it('lists practitioner profiles with approval filtering', async () => {
      const db = createMockDb({ profiles: initialProfiles });

      const all = await listPractitionerProfiles(db, { shop: testShop });
      assert.equal(all.profiles.length, 2);
      assert.equal(all.total, 2);

      const approved = await listPractitionerProfiles(db, { shop: testShop, isApproved: true });
      assert.equal(approved.profiles.length, 1);
      assert.equal(approved.profiles[0].ownerGid, 'gid://shopify/Customer/101');

      const unapproved = await listPractitionerProfiles(db, { shop: testShop, isApproved: false });
      assert.equal(unapproved.profiles.length, 1);
      assert.equal(unapproved.profiles[0].ownerGid, 'gid://shopify/Customer/102');
    });

    it('gets a practitioner profile by owner GID', async () => {
      const db = createMockDb({ profiles: initialProfiles });
      const profile = await getPractitionerProfile(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/101'
      });
      assert.ok(profile);
      assert.equal(profile.practiceName, 'Apex Integrative Wellness');

      const nonExistent = await getPractitionerProfile(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/999'
      });
      assert.equal(nonExistent, null);
    });

    it('updates practice name and enforces merchant control', async () => {
      const db = createMockDb({ profiles: initialProfiles });
      const updated = await updatePracticeName(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/101',
        practiceName: 'Apex Precision Medicine'
      });
      assert.equal(updated.practiceName, 'Apex Precision Medicine');

      // Rejects not found profile
      await assert.rejects(
        () => updatePracticeName(db, {
          shop: testShop,
          ownerGid: 'gid://shopify/Customer/999',
          practiceName: 'Unknown Clinic'
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.NOT_FOUND }
      );
    });

    it('approves and revokes practitioner access', async () => {
      const db = createMockDb({ profiles: initialProfiles });

      // Revoke customer 101
      const revoked = await revokePractitioner(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/101'
      });
      assert.equal(revoked.isApproved, false);

      // Approve customer 102
      const approved = await approvePractitioner(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/102'
      });
      assert.equal(approved.isApproved, true);
    });

    it('upserts a practitioner profile cleanly', async () => {
      const db = createMockDb({ profiles: initialProfiles });

      // Upsert new profile
      const created = await upsertPractitionerProfile(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Company/501',
        ownerType: 'company',
        practiceName: 'Northwest Integrative Health',
        logoUrl: 'https://cdn.shopify.com/northwest.png'
      });
      assert.equal(created.ownerGid, 'gid://shopify/Company/501');
      assert.equal(created.practiceName, 'Northwest Integrative Health');

      // Update existing
      const modified = await upsertPractitionerProfile(db, {
        shop: testShop,
        ownerGid: 'gid://shopify/Company/501',
        practiceName: 'Northwest Integrative Medicine'
      });
      assert.equal(modified.practiceName, 'Northwest Integrative Medicine');
    });
  });

  // ==========================================
  // Section 3: Starter Templates Management
  // ==========================================
  describe('Starter Templates Management', () => {
    const initialStarters = [
      {
        id: 'proto_starter_1',
        shop: testShop,
        token: 'startertok123456789',
        name: 'Mitochondrial Cellular Support',
        introNote: 'Foundational starter for daily cell vitality',
        ownerType: 'company',
        ownerId: 'brand',
        isStarter: true,
        status: 'active'
      }
    ];

    const starterLines = [
      {
        id: 'line_s1',
        protocolId: 'proto_starter_1',
        position: 0,
        variantGid: 'gid://shopify/ProductVariant/111',
        quantity: 1,
        usageNote: '1 capsule morning with food'
      }
    ];

    it('lists starter templates including protocol line items', async () => {
      const db = createMockDb({ protocols: initialStarters, lines: starterLines });
      const starters = await listStarterTemplates(db, { shop: testShop });

      assert.equal(starters.length, 1);
      assert.equal(starters[0].name, 'Mitochondrial Cellular Support');
      assert.equal(starters[0].isStarter, true);
      assert.equal(starters[0].lines.length, 1);
      assert.equal(starters[0].lines[0].variantGid, 'gid://shopify/ProductVariant/111');
    });

    it('creates a brand starter template with admin authorization', async () => {
      const db = createMockDb();
      const newStarter = await createStarterTemplate(db, {
        shop: testShop,
        adminUser,
        input: {
          name: 'Sleep & Nervous System Support',
          introNote: 'Core evening restorative routine.',
          lines: [
            {
              variantGid: 'gid://shopify/ProductVariant/222',
              quantity: 2,
              usageNote: 'Take 30 minutes before bed'
            }
          ]
        }
      });

      assert.ok(newStarter);
      assert.equal(newStarter.name, 'Sleep & Nervous System Support');
      assert.equal(newStarter.isStarter, true);
      assert.equal(newStarter.ownerType, 'company');
      assert.equal(newStarter.ownerId, 'brand');
      assert.equal(newStarter.lines.length, 1);
    });

    it('blocks non-admin from creating starter templates', async () => {
      const db = createMockDb();
      await assert.rejects(
        () => createStarterTemplate(db, {
          shop: testShop,
          adminUser: practitionerUser,
          input: {
            name: 'Unauthorized Starter',
            lines: [{ variantGid: 'gid://shopify/ProductVariant/222', quantity: 1 }]
          }
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.UNAUTHORIZED }
      );
    });

    it('updates a starter template and rejects updating non-starter protocols', async () => {
      const nonStarterProtocol = {
        id: 'proto_practitioner_1',
        shop: testShop,
        token: 'practok1234567890',
        name: 'Private Patient Routine',
        ownerType: 'customer',
        ownerId: 'gid://shopify/Customer/101',
        isStarter: false,
        status: 'active'
      };

      const db = createMockDb({
        protocols: [...initialStarters, nonStarterProtocol],
        lines: starterLines
      });

      // Valid update
      const updated = await updateStarterTemplate(db, {
        shop: testShop,
        adminUser,
        protocolId: 'proto_starter_1',
        input: {
          name: 'Mitochondrial Cellular Support v2',
          introNote: 'Updated clinical formulation notes.'
        }
      });
      assert.equal(updated.name, 'Mitochondrial Cellular Support v2');

      // Reject non-starter protocol
      await assert.rejects(
        () => updateStarterTemplate(db, {
          shop: testShop,
          adminUser,
          protocolId: 'proto_practitioner_1',
          input: { name: 'Attempted Hijack' }
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.NOT_STARTER }
      );
    });
  });

  // ==========================================
  // Section 4: Storewide Emergency Disable Control
  // ==========================================
  describe('Emergency Disable Control', () => {
    const protocols = [
      {
        id: 'proto_1',
        shop: testShop,
        token: 'tok_active_11111111',
        name: 'Protocol One',
        status: 'active',
        isStarter: false
      },
      {
        id: 'proto_2',
        shop: testShop,
        token: 'tok_active_22222222',
        name: 'Protocol Two',
        status: 'active',
        isStarter: true
      },
      {
        id: 'proto_3',
        shop: testShop,
        token: 'tok_disabled_33333333',
        name: 'Protocol Three',
        status: 'disabled',
        isStarter: false
      }
    ];

    it('disables an individual protocol immediately', async () => {
      const db = createMockDb({ protocols });
      const disabled = await emergencyDisableProtocol(db, {
        shop: testShop,
        protocolId: 'proto_1',
        adminUser
      });

      assert.equal(disabled.id, 'proto_1');
      assert.equal(disabled.status, 'disabled');
      assert.equal(disabled.updatedBy, adminUser.id);
    });

    it('blocks non-admin from executing emergency disable', async () => {
      const db = createMockDb({ protocols });
      await assert.rejects(
        () => emergencyDisableProtocol(db, {
          shop: testShop,
          protocolId: 'proto_1',
          adminUser: practitionerUser
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.UNAUTHORIZED }
      );
    });

    it('executes storewide emergency disable across all active protocols', async () => {
      const db = createMockDb({ protocols });
      const result = await emergencyDisableAllProtocols(db, {
        shop: testShop,
        adminUser
      });

      assert.equal(result.disabledCount, 2); // proto_1 and proto_2 were active
      const all = db.state.protocols.filter(p => p.shop === testShop);
      assert.ok(all.every(p => p.status === 'disabled'));
    });

    it('restores a disabled protocol back to active', async () => {
      const db = createMockDb({ protocols });
      const restored = await restoreDisabledProtocol(db, {
        shop: testShop,
        protocolId: 'proto_3',
        adminUser
      });

      assert.equal(restored.id, 'proto_3');
      assert.equal(restored.status, 'active');
    });
  });

  // ==========================================
  // Section 5: Settings Management
  // ==========================================
  describe('Settings Management', () => {
    it('returns default settings when none exist in database', async () => {
      const db = createMockDb();
      const settings = await getSettings(db, { shop: testShop });

      assert.deepEqual(settings, {
        shop: testShop,
        identityMode: 'tag',
        footerDisclaimer: null,
        handoutText: null
      });
    });

    it('updates identity mode to company and configures disclaimers', async () => {
      const db = createMockDb();
      const updated = await updateSettings(db, {
        shop: testShop,
        adminUser,
        settings: {
          identityMode: 'company',
          footerDisclaimer: 'For educational purposes only. Consult your physician.',
          handoutText: 'Scan the QR code to order recommended products directly.'
        }
      });

      assert.equal(updated.shop, testShop);
      assert.equal(updated.identityMode, 'company');
      assert.equal(updated.footerDisclaimer, 'For educational purposes only. Consult your physician.');
      assert.equal(updated.handoutText, 'Scan the QR code to order recommended products directly.');
    });

    it('rejects invalid identity mode', async () => {
      const db = createMockDb();
      await assert.rejects(
        () => updateSettings(db, {
          shop: testShop,
          adminUser,
          settings: { identityMode: 'invalid_mode' }
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.INVALID_INPUT }
      );
    });

    it('strictly forbids client PII inside settings disclaimers or handouts', async () => {
      const db = createMockDb();
      await assert.rejects(
        () => updateSettings(db, {
          shop: testShop,
          adminUser,
          settings: {
            footerDisclaimer: 'Patient diagnosis must remain confidential.'
          }
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED }
      );
    });

    it('blocks non-admin from updating shop settings', async () => {
      const db = createMockDb();
      await assert.rejects(
        () => updateSettings(db, {
          shop: testShop,
          adminUser: practitionerUser,
          settings: { identityMode: 'tag' }
        }),
        { name: 'ProtocolAdminError', code: ADMIN_ERROR_CODES.UNAUTHORIZED }
      );
    });
  });

  // ==========================================
  // Section 6: Attribution Reports & RFC 4180 CSV Export
  // ==========================================
  describe('Attribution Reports & RFC 4180 CSV Export', () => {
    const mockProfiles = [
      {
        id: 'prof_1',
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/101',
        practiceName: 'Dr. Smith, ND & Associates',
        isApproved: true
      },
      {
        id: 'prof_2',
        shop: testShop,
        ownerGid: 'gid://shopify/Customer/102',
        practiceName: 'Apex "Precision" Health',
        isApproved: true
      }
    ];

    const mockProtocols = [
      {
        id: 'proto_1',
        shop: testShop,
        name: 'Mitochondrial Energy, Morning Routine',
        isStarter: false
      },
      {
        id: 'proto_2',
        shop: testShop,
        name: 'Immune "Boost" Essentials',
        isStarter: true
      }
    ];

    const mockStats = [
      {
        id: 'stat_1',
        shop: testShop,
        protocolId: 'proto_1',
        ownerId: 'gid://shopify/Customer/101',
        month: '2026-10',
        orders: 12,
        units: 24,
        revenueMinor: 24550,
        currency: 'USD'
      },
      {
        id: 'stat_2',
        shop: testShop,
        protocolId: 'proto_2',
        ownerId: 'gid://shopify/Customer/102',
        month: '2026-10',
        orders: 5,
        units: 10,
        revenueMinor: 11000,
        currency: 'USD'
      }
    ];

    it('generates aggregate monthly reports with practice and protocol rollups', async () => {
      const db = createMockDb({
        profiles: mockProfiles,
        protocols: mockProtocols,
        orderStats: mockStats
      });

      const report = await getAttributionReport(db, { shop: testShop, month: '2026-10' });

      assert.equal(report.rows.length, 2);
      assert.equal(report.summary.totalOrders, 17);
      assert.equal(report.summary.totalUnits, 34);
      assert.equal(report.summary.totalRevenueMinor, 35550);
      assert.equal(report.summary.totalRevenueFormatted, '355.50');

      assert.equal(report.byPractice.length, 2);
      const drSmith = report.byPractice.find(p => p.ownerId === 'gid://shopify/Customer/101');
      assert.equal(drSmith.orders, 12);
      assert.equal(drSmith.revenueFormatted, '245.50');

      assert.equal(report.byProtocol.length, 2);
      const starterProto = report.byProtocol.find(p => p.protocolId === 'proto_2');
      assert.equal(starterProto.isStarter, true);
      assert.equal(starterProto.units, 10);
    });

    it('formats RFC 4180 compliant CSV export with proper quotes and commas escaping', () => {
      const sampleRows = [
        {
          month: '2026-10',
          practiceName: 'Dr. Smith, ND & Associates',
          ownerId: 'gid://shopify/Customer/101',
          protocolId: 'proto_1',
          protocolName: 'Mitochondrial Energy, Morning Routine',
          isStarter: false,
          orders: 12,
          units: 24,
          revenueMinor: 24550,
          currency: 'USD'
        },
        {
          month: '2026-10',
          practiceName: 'Apex "Precision" Health',
          ownerId: 'gid://shopify/Customer/102',
          protocolId: 'proto_2',
          protocolName: 'Immune "Boost" Essentials',
          isStarter: true,
          orders: 5,
          units: 10,
          revenueMinor: 11000,
          currency: 'USD'
        }
      ];

      const csv = formatAttributionCsv(sampleRows);

      // Verify RFC 4180 CRLF line endings
      assert.ok(csv.includes('\r\n'));
      const lines = csv.split('\r\n').filter(Boolean);
      assert.equal(lines.length, 3); // 1 header + 2 data rows

      // Verify Headers
      assert.equal(
        lines[0],
        'Month,Practice Name,Owner GID,Protocol ID,Protocol Name,Is Starter,Orders,Units,Revenue,Currency'
      );

      // Verify escaping commas inside field
      assert.ok(lines[1].includes('"Dr. Smith, ND & Associates"'));
      assert.ok(lines[1].includes('"Mitochondrial Energy, Morning Routine"'));
      assert.ok(lines[1].includes('245.50'));

      // Verify escaping double quotes as ""
      assert.ok(lines[2].includes('"Apex ""Precision"" Health"'));
      assert.ok(lines[2].includes('"Immune ""Boost"" Essentials"'));
      assert.ok(lines[2].includes('110.00'));
      assert.ok(lines[2].includes('true'));
    });

    it('strictly verifies zero client PII during CSV export', () => {
      const rowsWithPii = [
        {
          month: '2026-10',
          practiceName: 'Wellness Clinic',
          ownerId: 'gid://shopify/Customer/101',
          protocolId: 'proto_1',
          protocolName: 'Energy Support',
          isStarter: false,
          orders: 1,
          units: 2,
          revenueMinor: 2000,
          currency: 'USD',
          patientName: 'Confidential Client' // Forbidden!
        }
      ];

      assert.throws(() => formatAttributionCsv(rowsWithPii), {
        name: 'ProtocolAdminError',
        code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
      });
    });

    it('executes full end-to-end exportAttributionCsv pipeline', async () => {
      const db = createMockDb({
        profiles: mockProfiles,
        protocols: mockProtocols,
        orderStats: mockStats
      });

      const csvOutput = await exportAttributionCsv(db, { shop: testShop, month: '2026-10' });
      assert.ok(csvOutput.startsWith('Month,Practice Name,Owner GID,Protocol ID'));
      assert.ok(csvOutput.includes('245.50'));
      assert.ok(csvOutput.includes('110.00'));
    });
  });

  describe('renderAdminHtml (M6 Embedded Polaris Admin UI)', () => {
    const mockProfiles = [
      {
        id: 'prof_1',
        ownerGid: 'gid://shopify/Customer/101',
        practiceName: 'Elite Naturopathic Clinic',
        isApproved: true,
        ownerType: 'customer'
      },
      {
        id: 'prof_2',
        ownerGid: 'gid://shopify/Customer/102',
        practiceName: 'Holistic Skin Studio',
        isApproved: false,
        ownerType: 'customer'
      }
    ];

    const mockStarters = [
      {
        id: 'starter_1',
        name: 'Brand Gut Starter Template',
        status: 'active',
        linesCount: 3
      }
    ];

    const mockReport = {
      month: '2026-10',
      totalOrders: 14,
      totalUnits: 38,
      totalRevenueFormatted: '$1,245.50',
      items: [
        {
          practiceName: 'Elite Naturopathic Clinic',
          protocolName: 'Daily Gut Regimen',
          orders: 10,
          units: 25,
          revenueFormatted: '$850.00'
        }
      ]
    };

    const mockSettings = {
      mode: 'tag',
      disclaimer: 'For educational use only.',
      handoutText: 'Recommended by your healthcare professional.'
    };

    it('renders Polaris admin container with tabs: Practitioners, Starters, Attribution, and Settings', () => {
      const html = renderAdminHtml({
        shop: testShop,
        profiles: mockProfiles,
        starters: mockStarters,
        report: mockReport,
        settings: mockSettings
      });

      assert.ok(html.includes('Practitioners'));
      assert.ok(html.includes('Starter Templates'));
      assert.ok(html.includes('Attribution &amp; Reports'));
      assert.ok(html.includes('Settings &amp; Emergency'));
      assert.ok(html.includes('Polaris'));
    });

    it('renders practitioner approvals list with practice names, statuses, and action buttons', () => {
      const html = renderAdminHtml({
        shop: testShop,
        profiles: mockProfiles,
        starters: mockStarters,
        report: mockReport,
        settings: mockSettings,
        activeTab: 'practitioners'
      });

      assert.ok(html.includes('Elite Naturopathic Clinic'));
      assert.ok(html.includes('Holistic Skin Studio'));
      assert.ok(html.includes('Approved'));
      assert.ok(html.includes('Pending Approval'));
      assert.ok(html.includes('Revoke'));
      assert.ok(html.includes('Approve'));
    });

    it('renders monthly attribution metrics summary and RFC 4180 CSV export link', () => {
      const html = renderAdminHtml({
        shop: testShop,
        profiles: mockProfiles,
        starters: mockStarters,
        report: mockReport,
        settings: mockSettings,
        activeTab: 'attribution'
      });

      assert.ok(html.includes('$1,245.50'));
      assert.ok(html.includes('14')); // total orders
      assert.ok(html.includes('38')); // total units
      assert.ok(html.includes('/api/admin/attribution.csv'));
    });

    it('renders emergency storewide disable button with warning styling in settings tab', () => {
      const html = renderAdminHtml({
        shop: testShop,
        profiles: mockProfiles,
        starters: mockStarters,
        report: mockReport,
        settings: mockSettings,
        activeTab: 'settings'
      });

      assert.ok(html.includes('Emergency Controls'));
      assert.ok(html.includes('Disable All Protocols Storewide'));
      assert.ok(html.includes('Polaris-Button--critical'));
    });

    it('strictly rejects any PII inside renderAdminHtml payload', () => {
      assert.throws(
        () =>
          renderAdminHtml({
            shop: testShop,
            profiles: [{ practiceName: 'Clinic', patientName: 'Forbidden' }]
          }),
        {
          name: 'ProtocolAdminError',
          code: ADMIN_ERROR_CODES.PII_NOT_ALLOWED
        }
      );
    });
  });
});
