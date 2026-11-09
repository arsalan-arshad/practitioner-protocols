import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleAppProxyRequest,
  handleListProtocolsRequest,
  handleProductSearchRequest,
  handleCreateProtocolRequest,
  handleGetProtocolRequest,
  handleUpdateProtocolRequest,
  handleDuplicateProtocolRequest,
  handleArchiveProtocolRequest,
  handleRestoreProtocolRequest,
  handleWebhookRequest,
  createRateLimiter,
  getHeader,
  handleErrorResponse,
  handleAdminDashboardRequest,
  handleAdminPractitionersListRequest,
  handleAdminPractitionerStatusRequest,
  handleAdminPracticeNameRequest,
  handleAdminStartersListRequest,
  handleAdminCreateStarterRequest,
  handleAdminUpdateSettingsRequest,
  handleAdminEmergencyDisableAllRequest,
  handleAdminAttributionCsvRequest,
  handleAdminContactsCsvRequest,
  handleAdminDeleteContactRequest,
  handleAdminDeletePracticeContactsRequest,
  handleAdminCustomFeatureRequest,
  handleAdminFeedbackRequest,
  handleAdminMarketingOptInRequest,
  setDefaultCustomRequestRateLimiter,
  getDefaultCustomRequestRateLimiter,
  createAdminSessionToken,
  validateAppProxyCsrf,
  handleEnrolRequest,
  setDefaultEnrolRateLimiter,
  getDefaultEnrolRateLimiter,
  setDefaultProxyRateLimiter,
  getDefaultProxyRateLimiter
} from '../app/lib/protocols/routes.js';
import { calculateAppProxySignature } from '../app/lib/protocols/proxy.js';
import { ProtocolValidationError } from '../app/lib/protocols/validation.js';
import { ProtocolServiceError } from '../app/lib/protocols/service.js';
import { DENIAL_REASONS } from '../app/lib/protocols/permissions.js';
import { createFakeVariantResolver } from '../app/lib/protocols/catalog.js';

describe('HTTP Routes & Request Handlers (app/lib/protocols/routes.js)', () => {
  const testShop = 'wellness-store.myshopify.com';
  const apiSecret = 'test_secret_shhh_123456';

  const practitionerUser = {
    id: 'user_practitioner_1',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/112233',
    shop: testShop
  };

  const otherPractitionerUser = {
    id: 'user_practitioner_2',
    role: 'practitioner',
    ownerType: 'customer',
    ownerId: 'gid://shopify/Customer/998877',
    shop: testShop
  };

  const adminUser = {
    id: 'user_admin_1',
    role: 'admin',
    ownerType: 'company',
    ownerId: 'brand_corp',
    shop: testShop
  };

  function createMockDb(initialState = {}) {
    const state = {
      queries: [],
      protocols: (initialState.protocols || []).map(p => ({ ...p })),
      lines: (initialState.lines || []).map(l => ({ ...l })),
      profiles: (initialState.profiles || []).map(pr => ({ ...pr })),
      settings: (initialState.settings || []).map(s => ({ ...s })),
      stats: (initialState.stats || []).map(st => ({ ...st })),
      sessions: (initialState.sessions || []).map(ss => ({ ...ss })),
      contacts: (initialState.contacts || []).map(c => ({ ...c })),
      feedback: (initialState.feedback || []).map(f => ({ ...f }))
    };

    return {
      state,
      async query(sql, params = []) {
        state.queries.push({ sql, params });

        // Transactions
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }

        // 1. SELECT p.* ... FROM "Protocol" p WHERE p.shop = $1 AND p.token = $2 (getProtocolByToken)
        if (sql.includes('FROM "Protocol"') && (sql.includes('token = $2') || sql.includes('"token" = $2'))) {
          const shop = params[0];
          const token = params[1];
          const proto = state.protocols.find(p => p.shop === shop && p.token === token);
          if (!proto) return { rows: [] };

          const lines = state.lines
            .filter(l => l.protocolId === proto.id)
            .sort((a, b) => a.position - b.position);
          const profile = state.profiles.find(pr => pr.shop === shop && pr.ownerGid === proto.ownerId);

          return {
            rows: [{
              ...proto,
              practiceName: profile?.practiceName || proto.displayName || null,
              logoUrl: profile?.logoUrl || null,
              lines
            }]
          };
        }

        // 2. SELECT p.* ... FROM "Protocol" p WHERE p.shop = $1 AND p.id = $2 (getProtocolById)
        if (sql.includes('FROM "Protocol"') && (sql.includes('p.id = $2') || sql.includes('id = $2'))) {
          const shop = params[0];
          const id = params[1];
          const proto = state.protocols.find(p => p.shop === shop && p.id === id);
          if (!proto) return { rows: [] };

          const lines = state.lines
            .filter(l => l.protocolId === proto.id)
            .sort((a, b) => a.position - b.position);

          return {
            rows: [{
              ...proto,
              lines
            }]
          };
        }

        // 3a. Portal query: SELECT p.* ... FROM "Protocol" p LEFT JOIN "ProtocolLine" pl ... WHERE p."shop" = $1 AND (p."ownerId" = $2 OR p."createdBy" = $2) AND p."status" = $3
        if (sql.includes('p."ownerId" = $2 OR p."createdBy" = $2')) {
          const shop = params[0];
          const customerGid = params[1];
          const status = params[2];
          const filtered = state.protocols.filter(p =>
            p.shop === shop &&
            (p.ownerId === customerGid || p.createdBy === customerGid) &&
            p.status === status
          );
          const rows = filtered.map(proto => {
            const lines = state.lines
              .filter(l => l.protocolId === proto.id)
              .sort((a, b) => a.position - b.position);
            return { ...proto, lines, linesCount: lines.length };
          });
          return { rows };
        }

        // 3b. Portal starters query: WHERE p."shop" = $1 AND p."isStarter" = true AND p."status" = $2
        if (sql.includes('p."isStarter" = true AND p."status" = $2')) {
          const shop = params[0];
          const status = params[1];
          const filtered = state.protocols.filter(p =>
            p.shop === shop &&
            Boolean(p.isStarter) &&
            p.status === status
          );
          const rows = filtered.map(proto => {
            const lines = state.lines
              .filter(l => l.protocolId === proto.id)
              .sort((a, b) => a.position - b.position);
            return { ...proto, lines, linesCount: lines.length };
          });
          return { rows };
        }

        // 3c. SELECT p.* ... FROM "Protocol" p WHERE p.shop = $1 ... (listProtocols)
        if (sql.includes('FROM "Protocol" p') && sql.includes('LEFT JOIN "ProtocolLine" pl')) {
          const shop = params[0];
          let filtered = state.protocols.filter(p => p.shop === shop);

          // Check if admin or practitioner
          if (params.length >= 3 && params[1] && params[2]) {
            const ownerType = params[1];
            const ownerId = params[2];
            // Include matching owner or non-disabled starters
            filtered = filtered.filter(p =>
              (p.ownerType === ownerType && p.ownerId === ownerId) ||
              (p.isStarter === true && p.status !== 'disabled')
            );
            filtered = filtered.filter(p => p.status !== 'disabled');
          }

          // Check status parameter if present
          const statusParam = params.find((param, idx) => idx >= 3 && ['active', 'archived', 'disabled'].includes(param));
          if (statusParam) {
            filtered = filtered.filter(p => p.status === statusParam);
          }

          const rows = filtered.map(proto => {
            const lines = state.lines
              .filter(l => l.protocolId === proto.id)
              .sort((a, b) => a.position - b.position);
            return { ...proto, lines, linesCount: lines.length };
          });

          return { rows };
        }

        // 4. INSERT INTO "Protocol"
        if (sql.includes('INSERT INTO "Protocol"')) {
          const newProtocol = {
            id: `proto_${state.protocols.length + 1}`,
            shop: params[0],
            token: params[1],
            name: params[2],
            introNote: params[3],
            displayName: params[4],
            ownerType: params[5],
            ownerId: params[6],
            createdBy: params[7],
            updatedBy: params[7],
            status: params[8] || 'active',
            isStarter: Boolean(params[9]),
            sourceProtocolId: params[10],
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.protocols.push(newProtocol);
          return { rows: [newProtocol] };
        }

        // 5. INSERT INTO "ProtocolLine"
        if (sql.includes('INSERT INTO "ProtocolLine"')) {
          const hasHandleCol = sql.includes('productHandle');
          const newLine = {
            id: `line_${state.lines.length + 1}`,
            protocolId: params[0],
            position: params[1],
            variantGid: params[2],
            productHandle: hasHandleCol ? (params[3] || null) : null,
            quantity: hasHandleCol ? params[4] : params[3],
            usageNote: hasHandleCol ? params[5] : params[4],
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.lines.push(newLine);
          return { rows: [newLine] };
        }

        // 6. UPDATE "Protocol" (updateProtocol)
        if (sql.includes('UPDATE "Protocol"') && sql.includes('"updatedBy" = $5')) {
          const id = params[5];
          const shop = params[6];
          const proto = state.protocols.find(p => p.id === id && p.shop === shop);
          if (proto) {
            if (params[0] !== null) proto.name = params[0];
            if (params[1] !== null) proto.introNote = params[1];
            if (params[2] !== null) proto.displayName = params[2];
            if (params[3] !== null) proto.status = params[3];
            proto.updatedBy = params[4];
            proto.updatedAt = new Date();
          }
          return { rows: proto ? [proto] : [] };
        }

        // 7. UPDATE "Protocol" SET "status" = 'archived'
        if (sql.includes('UPDATE "Protocol"') && sql.includes('"status" = \'archived\'')) {
          const proto = state.protocols.find(p => p.id === params[1] && p.shop === params[2]);
          if (proto) {
            proto.status = 'archived';
            proto.updatedBy = params[0];
            proto.updatedAt = new Date();
          }
          return { rows: proto ? [proto] : [] };
        }

        // 8. UPDATE "Protocol" SET "status" = 'active'
        if (sql.includes('UPDATE "Protocol"') && sql.includes('"status" = \'active\'')) {
          const proto = state.protocols.find(p => p.id === params[1] && p.shop === params[2]);
          if (proto) {
            proto.status = 'active';
            proto.updatedBy = params[0];
            proto.updatedAt = new Date();
          }
          return { rows: proto ? [proto] : [] };
        }

        // 9. DELETE FROM "ProtocolLine"
        if (sql.includes('DELETE FROM "ProtocolLine" WHERE "protocolId" = $1')) {
          const protoId = params[0];
          state.lines = state.lines.filter(l => l.protocolId !== protoId);
          return { rowCount: 1, rows: [] };
        }

        // 10. PractitionerProfile query
        if (sql.includes('COUNT(*)') && sql.includes('"PractitionerProfile"')) {
          let rows = state.profiles.filter(p => p.shop === params[0]);
          if (sql.includes('"isApproved" = false')) {
            rows = rows.filter(p => p.isApproved === false);
          }
          return { rows: [{ count: rows.length, total: rows.length }] };
        }
        if (sql.includes('INSERT INTO "PractitionerProfile"')) {
          let id, shop, ownerType, ownerGid, practiceName, isApproved;
          if (params.length === 4) {
            [id, shop, ownerGid, practiceName] = params;
            ownerType = 'customer';
            isApproved = false;
          } else {
            [id, shop, ownerType, ownerGid, practiceName, isApproved] = params;
          }
          const numericId = String(ownerGid).replace(/^gid:\/\/shopify\/Customer\//, '');
          const existing = state.profiles.find(p => p.shop === shop && (p.ownerGid === ownerGid || p.ownerGid === numericId));
          if (existing) {
            return { rows: [] };
          }
          const newProfile = {
            id,
            shop,
            ownerType: ownerType || 'customer',
            ownerGid,
            practiceName,
            isApproved: isApproved ?? false,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          state.profiles.push(newProfile);
          return { rows: [newProfile] };
        }
        if (sql.includes('UPDATE "PractitionerProfile"') && sql.includes('"practiceName" = $1')) {
          const [practiceName, shop, ownerGid] = params;
          const profile = state.profiles.find(p => p.shop === shop && p.ownerGid === ownerGid);
          if (!profile) return { rows: [] };
          profile.practiceName = practiceName;
          profile.updatedAt = new Date();
          return { rows: [{ ...profile }] };
        }
        if (sql.includes('UPDATE "PractitionerProfile"') && sql.includes('"isApproved" = $1')) {
          const [isApproved, shop, ownerGid] = params;
          const profile = state.profiles.find(p => p.shop === shop && p.ownerGid === ownerGid);
          if (!profile) return { rows: [] };
          profile.isApproved = isApproved;
          profile.updatedAt = new Date();
          return { rows: [{ ...profile }] };
        }
        if (sql.includes('FROM "PractitionerProfile"')) {
          const shop = params[0];
          if (sql.includes('"ownerGid" = $2') || sql.includes('"ownerGid" = $3')) {
            const gid = params[1];
            const numId = params[2] || (gid ? String(gid).replace(/^gid:\/\/shopify\/Customer\//, '') : '');
            const prof = state.profiles.find(pr => pr.shop === shop && (pr.ownerGid === gid || pr.ownerGid === numId || pr.ownerGid === `gid://shopify/Customer/${numId}`));
            return { rows: prof ? [prof] : [] };
          }
          let rows = state.profiles.filter(p => p.shop === shop);
          return { rows: rows.map(r => ({ ...r })) };
        }

        // 11. Starters & Emergency query
        if (sql.includes('FROM "Protocol" p') && sql.includes('p."isStarter" = true')) {
          const shop = params[0];
          const starters = state.protocols.filter(p => p.shop === shop && p.isStarter);
          return { rows: starters.map(s => ({ ...s, lines: state.lines.filter(l => l.protocolId === s.id) })) };
        }
        if (sql.includes('UPDATE "Protocol"') && sql.includes('SET "status" = \'disabled\'')) {
          state.protocols.forEach(p => { p.status = 'disabled'; });
          return { rowCount: state.protocols.length, rows: state.protocols.map(p => ({ id: p.id })) };
        }

        // 12. Settings & Stats queries
        if (sql.includes('FROM "Setting"')) {
          return { rows: state.settings.length > 0 ? state.settings : [{ shop: params[0], identityMode: 'tag', allowSelfEnrol: false, footerDisclaimer: null, handoutText: null }] };
        }
        if (sql.includes('INSERT INTO "Setting"')) {
          const [shop, modeVal, hasMode, selfEnrolVal, hasAllowSelfEnrol, footerVal, hasFooter, handoutVal, hasHandout] = params;
          const prev = state.settings.find(s => s.shop === shop) || {};
          const setting = {
            shop,
            identityMode: hasMode ? (modeVal ?? 'tag') : (prev.identityMode ?? 'tag'),
            allowSelfEnrol: hasAllowSelfEnrol ? (selfEnrolVal ?? false) : (prev.allowSelfEnrol ?? false),
            footerDisclaimer: hasFooter ? (footerVal ?? null) : (prev.footerDisclaimer ?? null),
            handoutText: hasHandout ? (handoutVal ?? null) : (prev.handoutText ?? null)
          };
          state.settings = [setting];
          return { rows: [setting] };
        }
        if (sql.includes('FROM "ProtocolOrderStat"')) {
          return { rows: state.stats.map(s => ({ ...s, protocolName: 'Test Protocol', practiceName: 'Test Practice' })) };
        }

        // 13. Webhooks & deletion queries
        if (sql.includes('DELETE FROM "ProtocolLine"') || sql.includes('DELETE FROM "ProtocolOrderStat"') ||
            sql.includes('DELETE FROM "Protocol"') || sql.includes('DELETE FROM "PractitionerProfile"') ||
            sql.includes('DELETE FROM "Session"')) {
          return { rowCount: 1, rows: [{ id: 'deleted' }] };
        }
        if (sql.includes('UPDATE "Setting"')) {
          return { rowCount: 1, rows: [{ shop: params[0] }] };
        }
        if (sql.includes('INSERT INTO "ProtocolOrderStat"')) {
          return { rowCount: 1, rows: [{ id: 'stat_1' }] };
        }

        // 14. M11 ShopperContact queries
        if (sql.includes('INSERT INTO "ShopperContact"')) {
          const [shop, ownerId, email, firstName, consentText, consentVersion, consentedAt] = params;
          const existingIdx = state.contacts.findIndex(c =>
            c.shop === shop && c.ownerId === ownerId && c.email.toLowerCase() === email.toLowerCase()
          );
          if (existingIdx >= 0) {
            state.contacts[existingIdx] = {
              ...state.contacts[existingIdx],
              firstName: firstName || state.contacts[existingIdx].firstName,
              consentText,
              consentVersion,
              consentedAt
            };
            return { rowCount: 1, rows: [{ id: state.contacts[existingIdx].id }] };
          }
          const newC = {
            id: `c_${state.contacts.length + 1}`,
            shop,
            ownerId,
            email,
            firstName,
            consentText,
            consentVersion,
            consentedAt,
            source: 'protocol_page',
            createdAt: new Date()
          };
          state.contacts.push(newC);
          return { rowCount: 1, rows: [{ id: newC.id }] };
        }

        if (sql.includes('SELECT') && sql.includes('FROM "ShopperContact"')) {
          // Merchant query (with LEFT JOIN PractitionerProfile)
          if (sql.includes('LEFT JOIN "PractitionerProfile"')) {
            const shop = params[0];
            const matching = state.contacts.filter(c => c.shop === shop);
            const rows = matching.map(c => {
              const prof = state.profiles.find(p => p.shop === shop && p.ownerGid === c.ownerId);
              return { ...c, practiceName: prof?.practiceName || 'Individual Practitioner' };
            });
            return { rows };
          }
          // Practitioner query (WHERE "shop" = $1 AND "ownerId" = $2)
          const shop = params[0];
          const ownerId = params[1];
          const rows = state.contacts.filter(c => c.shop === shop && c.ownerId === ownerId);
          return { rows };
        }

        if (sql.includes('DELETE FROM "ShopperContact"')) {
          const shop = params[0];
          if (sql.includes('"ownerId" = $2') && sql.includes('"id" = $3')) {
            // Practitioner delete
            const ownerId = params[1];
            const id = params[2];
            const idx = state.contacts.findIndex(c => c.shop === shop && c.ownerId === ownerId && c.id === id);
            if (idx >= 0) {
              state.contacts.splice(idx, 1);
              return { rowCount: 1, rows: [{ id }] };
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('"ownerId" = $2')) {
            // Delete practice contacts
            const ownerId = params[1];
            const before = state.contacts.length;
            state.contacts = state.contacts.filter(c => !(c.shop === shop && c.ownerId === ownerId));
            const deletedCount = before - state.contacts.length;
            return { rowCount: deletedCount, rows: [] };
          }
          if (sql.includes('"id" = $2')) {
            // Single admin delete
            const id = params[1];
            const idx = state.contacts.findIndex(c => c.shop === shop && c.id === id);
            if (idx >= 0) {
              state.contacts.splice(idx, 1);
              return { rowCount: 1, rows: [{ id }] };
            }
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 1, rows: [{ id: 'deleted' }] };
        }

        // 15. M11 MerchantFeedback queries
        if (sql.includes('INSERT INTO "MerchantFeedback"')) {
          const [shop, shopName, ownerName, replyEmail, planName, country, message, kind] = params;
          const newF = {
            id: `fb_${state.feedback.length + 1}`,
            shop,
            shopName,
            ownerName,
            replyEmail,
            planName,
            country,
            message,
            kind,
            createdAt: new Date()
          };
          state.feedback.push(newF);
          return { rowCount: 1, rows: [{ id: newF.id }] };
        }

        if (sql.includes('SELECT') && sql.includes('FROM "MerchantFeedback"')) {
          const shop = params[0];
          const kind = params[1];
          const rows = state.feedback.filter(f => f.shop === shop && (!kind || f.kind === kind));
          return { rows };
        }

        if (sql.includes('FROM "Session"')) {
          const shop = params[0];
          const session = state.sessions.find(s => s.shop === shop);
          return { rows: session ? [session] : [] };
        }

        if (sql.includes('INSERT INTO "Session"')) {
          return { rowCount: 1, rows: [{ id: params[0] }] };
        }

        return { rows: [] };
      }
    };
  }

  describe('Rate Limiter & Request Utilities', () => {
    it('creates in-memory sliding window rate limiter and blocks excess requests', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
      assert.equal(limiter.isAllowed('ip_1'), true);
      assert.equal(limiter.isAllowed('ip_1'), true);
      assert.equal(limiter.isAllowed('ip_1'), false, 'Should block 3rd request in window');

      // Different IP is unaffected
      assert.equal(limiter.isAllowed('ip_2'), true);

      limiter.reset();
      assert.equal(limiter.isAllowed('ip_1'), true, 'Should allow after reset');
    });

    it('extracts headers case-insensitively from Headers instance and plain objects', () => {
      const webReq = new Request('https://test.com', {
        headers: {
          'X-Shopify-Topic': 'orders/paid',
          'X-Shopify-Hmac-Sha256': 'abc12345'
        }
      });
      assert.equal(getHeader(webReq, 'x-shopify-topic'), 'orders/paid');
      assert.equal(getHeader(webReq, 'X-Shopify-Topic'), 'orders/paid');
      assert.equal(getHeader(webReq, 'x-shopify-hmac-sha256'), 'abc12345');

      const plainObj = {
        headers: {
          'x-forwarded-for': '192.168.1.1'
        }
      };
      assert.equal(getHeader(plainObj, 'X-Forwarded-For'), '192.168.1.1');
      assert.equal(getHeader(null, 'any'), null);
    });

    it('formats domain and validation errors with appropriate HTTP status codes', async () => {
      const valErr = new ProtocolValidationError('Invalid name', 'NAME_EMPTY', 'name');
      const valRes = handleErrorResponse(valErr);
      assert.equal(valRes.status, 400);
      const valBody = await valRes.json();
      assert.equal(valBody.code, 'NAME_EMPTY');

      const forbiddenErr = new ProtocolServiceError('Forbidden', 'FORBIDDEN_OWNERSHIP_MISMATCH');
      const forbiddenRes = handleErrorResponse(forbiddenErr);
      assert.equal(forbiddenRes.status, 404);

      const notFoundErr = new ProtocolServiceError('Not found', 'NOT_FOUND');
      const notFoundRes = handleErrorResponse(notFoundErr);
      assert.equal(notFoundRes.status, 404);

      const unauthErr = new ProtocolServiceError('Unauthenticated', 'UNAUTHENTICATED');
      const unauthRes = handleErrorResponse(unauthErr);
      assert.equal(unauthRes.status, 401);

      const genericRes = handleErrorResponse(new Error('Unexpected disk fail'));
      assert.equal(genericRes.status, 500);
    });

    it('maps every real code from permissions.js DENIAL_REASONS to explicit HTTP status codes', async () => {
      const expectedStatusMap = {
        [DENIAL_REASONS.UNAUTHENTICATED]: 401,
        [DENIAL_REASONS.UNAUTHORIZED_ROLE]: 403,
        [DENIAL_REASONS.INVALID_ACTION]: 400,
        [DENIAL_REASONS.PROTOCOL_NOT_FOUND]: 404,
        [DENIAL_REASONS.ADMIN_ONLY_DISABLED_PROTOCOL]: 403,
        [DENIAL_REASONS.STARTER_CREATION_ADMIN_ONLY]: 403,
        [DENIAL_REASONS.STARTER_MODIFICATION_FORBIDDEN]: 403,
        [DENIAL_REASONS.ARCHIVED_PROTOCOL_READ_ONLY]: 403,
        [DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH]: 404 // 404 prevents ID enumeration for cross-owner access
      };

      for (const key of Object.keys(DENIAL_REASONS)) {
        const code = DENIAL_REASONS[key];
        const err = new ProtocolServiceError(`Denied reason: ${code}`, code);
        const res = handleErrorResponse(err);
        const expectedStatus = expectedStatusMap[code];
        assert.ok(expectedStatus, `DENIAL_REASON ${code} must be defined in expectedStatusMap`);
        assert.equal(
          res.status,
          expectedStatus,
          `DENIAL_REASON ${code} must map to HTTP ${expectedStatus}, but got ${res.status}`
        );
        const body = await res.json();
        const expectedCode = code === DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH ? 'NOT_FOUND' : code;
        assert.equal(body.code, expectedCode);
      }
    });
  });

  describe('handleAppProxyRequest (M2 & SPEC §5)', () => {
    let db;
    const testProtocol = {
      id: 'proto_active_1',
      shop: testShop,
      token: 'tok_guthealth123456',
      name: 'Gut Health Daily Regimen',
      introNote: 'Take these with breakfast.',
      displayName: 'Gut Protocol',
      ownerType: 'customer',
      ownerId: 'gid://shopify/Customer/112233',
      createdBy: 'gid://shopify/Customer/112233',
      updatedBy: 'gid://shopify/Customer/112233',
      status: 'active',
      isStarter: false
    };

    const testLine = {
      id: 'line_1',
      protocolId: 'proto_active_1',
      position: 0,
      variantGid: 'gid://shopify/ProductVariant/554433',
      quantity: 2,
      usageNote: '2 capsules daily'
    };

    const testProfile = {
      id: 'prof_1',
      shop: testShop,
      ownerGid: 'gid://shopify/Customer/112233',
      practiceName: 'Elite Naturopathic Clinic'
    };

    const testPendingProfile = {
      id: 'prof_2',
      shop: testShop,
      ownerGid: 'gid://shopify/Customer/999888',
      practiceName: 'Pending Health Center',
      isApproved: false
    };

    beforeEach(() => {
      db = createMockDb({
        protocols: [testProtocol],
        lines: [testLine],
        profiles: [testProfile, testPendingProfile]
      });
    });

    it('renders 200 Liquid response with Content-Type application/liquid for active protocol', async () => {
      const params = {
        shop: testShop,
        token: testProtocol.token,
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('application/liquid'));
      assert.ok(res.headers.get('x-robots-tag').includes('noindex'));

      const liquid = await res.text();
      assert.ok(liquid.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(liquid.includes('Gut Health Daily Regimen'));
      assert.ok(liquid.includes('Elite Naturopathic Clinic'));
      assert.ok(liquid.includes('Add all to cart'));
      assert.ok(liquid.includes('_protocol_token'));
    });

    it('extracts token from URL pathname when not in query parameters', async () => {
      const params = {
        shop: testShop,
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols/${testProtocol.token}?shop=${testShop}&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Gut Health Daily Regimen'));
    });

    it('enriches protocol lines with live catalog titles and prices when variantResolver is provided', async () => {
      const fakeResolver = createFakeVariantResolver({
        'gid://shopify/ProductVariant/554433': {
          productTitle: 'Live Resolved Probiotic',
          variantTitle: '60 capsules',
          price: '34.95',
          currency: 'USD',
          availableForSale: true
        }
      });

      const params = {
        shop: testShop,
        token: testProtocol.token,
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), {
        apiSecret,
        variantResolver: fakeResolver
      });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Live Resolved Probiotic - 60 capsules'));
      assert.ok(liquid.includes('$34.95'));
    });

    it('rejects tampered query parameters with 401 Unauthorized', async () => {
      const params = {
        shop: testShop,
        token: testProtocol.token,
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      // Tamper shop parameter
      const url = `https://${testShop}/apps/protocols?shop=evil.com&token=${testProtocol.token}&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 401);
      const text = await res.text();
      assert.ok(text.includes('Unauthorized'));
    });

    it('fails closed (500) when apiSecret is missing or undefined', async () => {
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&timestamp=1729500000`;

      const resWithoutOptions = await handleAppProxyRequest(db, new Request(url));
      assert.equal(resWithoutOptions.status, 500, 'Must fail closed with 500 when options/apiSecret is omitted');

      const resWithEmptySecret = await handleAppProxyRequest(db, new Request(url), { apiSecret: '' });
      assert.equal(resWithEmptySecret.status, 500, 'Must fail closed with 500 when apiSecret is empty');
    });

    it('fails closed (401) when signature parameter is missing from request', async () => {
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&timestamp=1729500000`;
      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });
      assert.equal(res.status, 401, 'Must reject unsigned request with 401');
    });

    it('blocks request with 429 Too Many Requests and returns Liquid 429 page from rate-limit.js', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 1 });
      const params = {
        shop: testShop,
        token: testProtocol.token,
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&timestamp=1729500000&signature=${signature}`;

      const req1 = new Request(url, { headers: { 'x-forwarded-for': '203.0.113.1' } });
      const res1 = await handleAppProxyRequest(db, req1, { apiSecret, rateLimiter: limiter });
      assert.equal(res1.status, 200);

      const req2 = new Request(url, { headers: { 'x-forwarded-for': '203.0.113.1' } });
      const res2 = await handleAppProxyRequest(db, req2, { apiSecret, rateLimiter: limiter });
      assert.equal(res2.status, 429);
      assert.equal(res2.headers.get('retry-after'), '60');
      assert.ok(res2.headers.get('content-type').includes('application/liquid'), '429 response must have Content-Type: application/liquid');
      const text2 = await res2.text();
      assert.ok(text2.includes('<meta name="robots" content="noindex, nofollow">'), '429 page must include robots noindex');
      assert.ok(text2.includes('Too Many Requests'), '429 page must include user-friendly title');
      assert.ok(text2.includes('Please retry in'), '429 page must include retry-after notice');
    });

    it('renders 404 Liquid for non-existent or invalid protocol token', async () => {
      const params = {
        shop: testShop,
        token: 'tok_nonexistent_999999',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=tok_nonexistent_999999&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 404);
      assert.ok(res.headers.get('content-type').includes('application/liquid'));
      const liquid = await res.text();
      assert.ok(liquid.includes('Protocol Not Found'));
      assert.ok(liquid.includes('<meta name="robots" content="noindex, nofollow">'));
    });

    it('displays practitioner banner when logged_in_customer_id matches practitioner with approved profile (Fix 6a)', async () => {
      // Profile has isApproved = true
      db.state.profiles[0].isApproved = true;

      const params = {
        shop: testShop,
        token: testProtocol.token,
        logged_in_customer_id: '112233',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&logged_in_customer_id=112233&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes("You're signed in as a professional. Clients will see retail prices."));
    });

    it('does NOT display practitioner banner when practitioner profile is NOT approved (Fix 6a)', async () => {
      // Profile has isApproved = false
      db.state.profiles[0].isApproved = false;

      const params = {
        shop: testShop,
        token: testProtocol.token,
        logged_in_customer_id: '112233',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&logged_in_customer_id=112233&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.equal(liquid.includes("You're signed in as a professional. Clients will see retail prices."), false, 'Unapproved practitioner must NOT see professional banner');
    });

    it('displays practitioner banner in company mode when logged-in customer created protocol and company profile is approved (Item 3)', async () => {
      const companyProtocol = {
        id: 'proto_company_1',
        shop: testShop,
        token: 'tok_company_123456789',
        name: 'Company Wellness Routine',
        introNote: 'Shared clinic protocol',
        displayName: 'Clinic Team',
        ownerType: 'company',
        ownerId: 'gid://shopify/Company/888',
        createdBy: 'gid://shopify/Customer/999',
        updatedBy: 'gid://shopify/Customer/999',
        status: 'active',
        isStarter: false,
        sourceProtocolId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      db.state.protocols.push(companyProtocol);

      // Company profile has isApproved = true
      db.state.profiles.push({
        id: 'prof_comp_1',
        shop: testShop,
        ownerType: 'company',
        ownerGid: 'gid://shopify/Company/888',
        practiceName: 'Elite Medical Group',
        logoUrl: '',
        isApproved: true
      });

      const params = {
        shop: testShop,
        token: companyProtocol.token,
        logged_in_customer_id: '999',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${companyProtocol.token}&logged_in_customer_id=999&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes("You're signed in as a professional. Clients will see retail prices."));
    });

    it('enforces rate limiting by default when no rateLimiter option is provided (Fix 3)', async () => {
      // Uses module-level default limiter: 60 requests/min
      // Send 60 requests that succeed, then 61st must yield 429
      const params = {
        shop: testShop,
        token: testProtocol.token,
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&timestamp=1729500000&signature=${signature}`;

      let lastRes = null;
      for (let i = 0; i < 62; i++) {
        lastRes = await handleAppProxyRequest(db, new Request(url, {
          headers: { 'x-forwarded-for': '198.51.100.99' }
        }), { apiSecret });
        if (lastRes.status === 429) break;
      }

      assert.equal(lastRes.status, 429, 'Default rate limiter must trigger 429 after threshold');
      const body = await lastRes.text();
      assert.ok(body.includes('Too Many Requests'));
      assert.ok(lastRes.headers.get('Retry-After'));
    });

    it('renders friendly archived state when protocol status is archived', async () => {
      db.state.protocols[0].status = 'archived';

      const params = {
        shop: testShop,
        token: testProtocol.token,
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${testProtocol.token}&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Protocol No Longer Active'));
      assert.ok(liquid.includes('no longer active'));
    });

    it('renders Practitioner Portal sign-in prompt when visiting /apps/protocols without token and signed out', async () => {
      const params = {
        shop: testShop,
        path_prefix: '/apps/protocols',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Practitioner Sign In Required'));
      assert.ok(liquid.includes('/account/login'));
      assert.ok(liquid.includes('<meta name="robots" content="noindex, nofollow">'));
    });

    it('renders Practitioner Portal pending approval prompt when signed in but not approved', async () => {
      const params = {
        shop: testShop,
        path_prefix: '/apps/protocols',
        logged_in_customer_id: '999888',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&path_prefix=%2Fapps%2Fprotocols&logged_in_customer_id=999888&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Account Pending Approval'));
    });

    it('renders full Practitioner Portal library with active protocols when signed in and approved', async () => {
      db.state.profiles[0].isApproved = true;

      const params = {
        shop: testShop,
        path_prefix: '/apps/protocols',
        logged_in_customer_id: '112233',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&path_prefix=%2Fapps%2Fprotocols&logged_in_customer_id=112233&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });

      assert.equal(res.status, 200);
      const liquid = await res.text();
      assert.ok(liquid.includes('Practitioner Protocols'));
      assert.ok(liquid.includes('Elite Naturopathic Clinic'));
      assert.ok(liquid.includes('My Active Protocols'));
    });
  });

  describe('handleListProtocolsRequest', () => {
    let db;
    beforeEach(() => {
      db = createMockDb({
        protocols: [
          {
            id: 'proto_1',
            shop: testShop,
            name: 'Digestive Balance',
            introNote: 'Morning routine',
            ownerType: 'customer',
            ownerId: 'gid://shopify/Customer/112233',
            status: 'active'
          },
          {
            id: 'proto_2',
            shop: testShop,
            name: 'Sleep Support',
            introNote: 'Nightly routine',
            ownerType: 'customer',
            ownerId: 'gid://shopify/Customer/112233',
            status: 'archived'
          },
          {
            id: 'proto_starter',
            shop: testShop,
            name: 'General Wellness Starter',
            introNote: 'Template',
            ownerType: 'company',
            ownerId: 'brand_corp',
            status: 'active',
            isStarter: true
          }
        ]
      });
    });

    it('rejects unauthenticated user with 401', async () => {
      const res = await handleListProtocolsRequest(db, null, `https://${testShop}/api/protocols`);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.code, 'UNAUTHENTICATED');
    });

    it('lists active protocols including starters for practitioner', async () => {
      const res = await handleListProtocolsRequest(
        db,
        practitionerUser,
        `https://${testShop}/api/protocols?status=active`
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.protocols.length, 2);
      assert.ok(data.protocols.some(p => p.name === 'Digestive Balance'));
      assert.ok(data.protocols.some(p => p.isStarter === true));
    });

    it('filters protocols by search query term', async () => {
      const res = await handleListProtocolsRequest(
        db,
        practitionerUser,
        `https://${testShop}/api/protocols?status=active&search=Digestive`
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.protocols.length, 1);
      assert.equal(data.protocols[0].name, 'Digestive Balance');
    });

    it('returns empty list when search term has no match', async () => {
      const res = await handleListProtocolsRequest(
        db,
        practitionerUser,
        `https://${testShop}/api/protocols?search=xyznonexistent`
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.protocols.length, 0);
    });
  });

  describe('handleCreateProtocolRequest', () => {
    let db;
    beforeEach(() => {
      db = createMockDb();
    });

    it('creates a new protocol and returns 201 Created JSON', async () => {
      const payload = {
        name: 'Immune Shield',
        introNote: 'Daily immune defense protocol.',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/101', quantity: 2, usageNote: 'With meals' }
        ]
      };

      const res = await handleCreateProtocolRequest(db, practitionerUser, payload);
      assert.equal(res.status, 201);
      const data = await res.json();

      assert.equal(data.name, 'Immune Shield');
      assert.equal(data.lines.length, 1);
      assert.ok(data.token, 'Should generate unique share token');
      assert.equal(data.ownerId, practitionerUser.ownerId);
      assert.equal(data.status, 'active');
    });

    it('rejects forbidden client PII fields with 400 Bad Request', async () => {
      const payloadWithPii = {
        name: 'Immune Shield',
        patientName: 'Jane Doe', // FORBIDDEN PII
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 }
        ]
      };

      const res = await handleCreateProtocolRequest(db, practitionerUser, payloadWithPii);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'PII_NOT_ALLOWED');
    });

    it('rejects cross-owner creation attempt with 404 Not Found to prevent enumeration', async () => {
      const invalidOwnerPayload = {
        name: 'Sneaky Protocol',
        ownerType: 'customer',
        ownerId: 'gid://shopify/Customer/someone_else',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 }
        ]
      };

      const res = await handleCreateProtocolRequest(db, practitionerUser, invalidOwnerPayload);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('persists and returns productHandle in created protocol lines (M9b-3a)', async () => {
      const payload = {
        name: 'Protocol with Product Handles',
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/5050',
            productHandle: 'hydrating-daily-cleanser',
            quantity: 2,
            usageNote: '1 pump AM/PM'
          }
        ]
      };

      const res = await handleCreateProtocolRequest(db, practitionerUser, payload);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.lines.length, 1);
      assert.equal(data.lines[0].productHandle, 'hydrating-daily-cleanser');
      assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/5050');
    });
  });

  describe('handleGetProtocolRequest', () => {
    let db;
    const sampleProtocol = {
      id: 'proto_100',
      shop: testShop,
      token: 'tok_sample12345678',
      name: 'Adrenal Protocol',
      ownerType: 'customer',
      ownerId: 'gid://shopify/Customer/112233',
      createdBy: 'gid://shopify/Customer/112233',
      status: 'active'
    };

    beforeEach(() => {
      db = createMockDb({
        protocols: [sampleProtocol],
        lines: [{ id: 'line_100', protocolId: 'proto_100', variantGid: 'gid://shopify/ProductVariant/1', quantity: 1, position: 0 }]
      });
    });

    it('returns protocol details with 200 OK for rightful owner', async () => {
      const res = await handleGetProtocolRequest(db, practitionerUser, sampleProtocol.id);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.id, sampleProtocol.id);
      assert.equal(data.lines.length, 1);
    });

    it('denies access with 404 Not Found to another practitioner to prevent ID enumeration', async () => {
      const res = await handleGetProtocolRequest(db, otherPractitionerUser, sampleProtocol.id);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('returns 404 Not Found for non-existent protocol ID', async () => {
      const res = await handleGetProtocolRequest(db, practitionerUser, 'non_existent_id');
      assert.equal(res.status, 404);
    });
  });

  describe('handleUpdateProtocolRequest', () => {
    let db;
    const existingProto = {
      id: 'proto_edit_1',
      shop: testShop,
      token: 'tok_edit1234567890',
      name: 'Initial Name',
      introNote: 'Initial note',
      ownerType: 'customer',
      ownerId: 'gid://shopify/Customer/112233',
      createdBy: 'gid://shopify/Customer/112233',
      status: 'active'
    };

    beforeEach(() => {
      db = createMockDb({
        protocols: [existingProto],
        lines: [
          { id: 'l1', protocolId: existingProto.id, position: 0, variantGid: 'gid://shopify/ProductVariant/1', quantity: 1 }
        ]
      });
    });

    it('updates protocol details and lines, returning 200 OK JSON', async () => {
      const updatePayload = {
        name: 'Updated Name',
        introNote: 'Updated notes',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/2', quantity: 3, usageNote: 'Take 3 daily' }
        ]
      };

      const res = await handleUpdateProtocolRequest(db, practitionerUser, existingProto.id, updatePayload);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.name, 'Updated Name');
      assert.equal(data.introNote, 'Updated notes');
      assert.equal(data.lines.length, 1);
      assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/2');
    });

    it('persists and returns productHandle in updated protocol lines (M9b-3a)', async () => {
      const updatePayload = {
        name: 'Updated with Handles',
        lines: [
          {
            variantGid: 'gid://shopify/ProductVariant/777',
            productHandle: 'gentle-gel-cleanser',
            quantity: 1,
            usageNote: 'Morning only'
          }
        ]
      };

      const res = await handleUpdateProtocolRequest(db, practitionerUser, existingProto.id, updatePayload);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.lines[0].productHandle, 'gentle-gel-cleanser');
      assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/777');
    });

    it('prevents non-owner from updating someone else protocol (404 Not Found to prevent enumeration)', async () => {
      const res = await handleUpdateProtocolRequest(db, otherPractitionerUser, existingProto.id, {
        name: 'Hacked Protocol'
      });
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('authorizes before validating so unauthorized callers receive 404 instead of validation errors (Fix 6d)', async () => {
      const res = await handleUpdateProtocolRequest(db, otherPractitionerUser, existingProto.id, {
        name: '' // invalid empty name
      });
      assert.equal(res.status, 404, 'Must return 404 Not Found before validating input');
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('ignores or strips sourceProtocolId on direct create/update by non-admin (Fix 6b)', async () => {
      const payloadWithSource = {
        name: 'My New Routine',
        sourceProtocolId: 'proto_someone_elses_starter',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/55', quantity: 1 }
        ]
      };

      const res = await handleCreateProtocolRequest(db, practitionerUser, payloadWithSource);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.sourceProtocolId, null, 'Non-admin cannot supply sourceProtocolId on direct create');
    });
  });

  describe('handleDuplicateProtocolRequest', () => {
    let db;
    const starterProto = {
      id: 'proto_starter_1',
      shop: testShop,
      token: 'tok_starter1234567',
      name: 'Starter Vitamin Routine',
      introNote: 'Standard brand routine',
      ownerType: 'company',
      ownerId: 'brand_corp',
      status: 'active',
      isStarter: true
    };

    beforeEach(() => {
      db = createMockDb({
        protocols: [starterProto],
        lines: [
          { id: 'sl1', protocolId: starterProto.id, position: 0, variantGid: 'gid://shopify/ProductVariant/1', quantity: 1 }
        ]
      });
    });

    it('duplicates a starter template into practitioner library and returns 201 Created JSON', async () => {
      const res = await handleDuplicateProtocolRequest(db, practitionerUser, starterProto.id);
      assert.equal(res.status, 201);
      const data = await res.json();

      assert.equal(data.name, 'Copy of Starter Vitamin Routine');
      assert.equal(data.ownerId, practitionerUser.ownerId);
      assert.equal(data.isStarter, false);
      assert.equal(data.sourceProtocolId, starterProto.id);
      assert.notEqual(data.token, starterProto.token, 'Should have new unique share token');
    });
  });

  describe('handleArchiveProtocolRequest & handleRestoreProtocolRequest', () => {
    let db;
    const activeProto = {
      id: 'proto_lifecycle_1',
      shop: testShop,
      token: 'tok_life1234567890',
      name: 'Lifecycle Protocol',
      ownerType: 'customer',
      ownerId: 'gid://shopify/Customer/112233',
      createdBy: 'gid://shopify/Customer/112233',
      status: 'active'
    };

    beforeEach(() => {
      db = createMockDb({
        protocols: [activeProto]
      });
    });

    it('archives an active protocol and returns 200 OK', async () => {
      const res = await handleArchiveProtocolRequest(db, practitionerUser, activeProto.id);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'archived');
    });

    it('restores an archived protocol back to active and returns 200 OK', async () => {
      activeProto.status = 'archived';
      const res = await handleRestoreProtocolRequest(db, practitionerUser, activeProto.id);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'active');
    });

    it('prevents non-owner from archiving another protocol (404 Not Found to prevent enumeration)', async () => {
      const res = await handleArchiveProtocolRequest(db, otherPractitionerUser, activeProto.id);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });
  });

  describe('handleWebhookRequest (M5, M7 & SPEC §10)', () => {
    let db;
    beforeEach(() => {
      db = createMockDb();
    });

    function createSignedWebhookRequest(topic, payload, extraHeaders = {}) {
      const rawBody = JSON.stringify(payload);
      const hmac = crypto
        .createHmac('sha256', apiSecret)
        .update(Buffer.from(rawBody, 'utf8'))
        .digest('base64');

      return new Request('https://app.test/api/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': topic,
          'X-Shopify-Hmac-Sha256': hmac,
          'X-Shopify-Shop-Domain': testShop,
          'X-Shopify-Webhook-Id': 'wh_test_header_id_123',
          ...extraHeaders
        },
        body: rawBody
      });
    }

    it('verifies valid HMAC and successfully dispatches orders/paid webhook', async () => {
      const payload = {
        id: 11223344,
        shop_domain: testShop,
        line_items: [
          {
            id: 1,
            variant_id: 554433,
            quantity: 2,
            price: '29.99',
            properties: [
              { name: '_protocol_token', value: 'tok_guthealth123456' }
            ]
          }
        ]
      };

      const req = createSignedWebhookRequest('orders/paid', payload);
      const res = await handleWebhookRequest(db, req, { apiSecret });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.topic, 'orders/paid');
    });

    it('dispatches customers/data_request webhook', async () => {
      const payload = {
        shop_domain: testShop,
        customer: { id: 112233 }
      };

      const req = createSignedWebhookRequest('customers/data_request', payload);
      const res = await handleWebhookRequest(db, req, { apiSecret });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.result.clientPii, null, 'Strictly zero client PII');
    });

    it('dispatches customers/redact compliance webhook', async () => {
      const payload = {
        shop_domain: testShop,
        customer: { id: 112233 }
      };

      const req = createSignedWebhookRequest('customers/redact', payload);
      const res = await handleWebhookRequest(db, req, { apiSecret });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });

    it('dispatches shop/redact compliance webhook', async () => {
      const payload = {
        shop_domain: testShop
      };

      const req = createSignedWebhookRequest('shop/redact', payload);
      const res = await handleWebhookRequest(db, req, { apiSecret });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });

    it('dispatches app/uninstalled webhook', async () => {
      const payload = {
        shop_domain: testShop
      };

      const req = createSignedWebhookRequest('app/uninstalled', payload);
      const res = await handleWebhookRequest(db, req, { apiSecret });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
    });

    it('rejects webhooks with invalid HMAC signature with 401 Unauthorized', async () => {
      const payload = { shop_domain: testShop };
      const rawBody = JSON.stringify(payload);

      const req = new Request('https://app.test/api/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': 'orders/paid',
          'X-Shopify-Hmac-Sha256': 'invalid_base64_hmac=='
        },
        body: rawBody
      });

      const res = await handleWebhookRequest(db, req, { apiSecret });
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.ok(text.includes('Unauthorized'));
    });

    it('rejects webhooks missing X-Shopify-Topic header with 400 Bad Request', async () => {
      const req = new Request('https://app.test/api/webhooks', {
        method: 'POST',
        headers: {
          'X-Shopify-Hmac-Sha256': 'some_signature=='
        },
        body: '{}'
      });

      const res = await handleWebhookRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
    });

    it('rejects orders/paid webhook missing X-Shopify-Webhook-Id header with 400 Bad Request (Fix 1b)', async () => {
      const payload = { shop_domain: testShop, id: 991122 };
      const rawBody = JSON.stringify(payload);
      const hmac = crypto.createHmac('sha256', apiSecret).update(Buffer.from(rawBody, 'utf8')).digest('base64');

      const req = new Request('https://app.test/api/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': 'orders/paid',
          'X-Shopify-Hmac-Sha256': hmac
        },
        body: rawBody
      });

      const res = await handleWebhookRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'MISSING_WEBHOOK_ID');
    });

    it('returns 500 JSON when a webhook handler throws an error (Fix 2)', async () => {
      const failingDb = {
        query: async () => {
          throw new Error('Database connection dropped during webhook execution');
        }
      };

      const payload = { shop_domain: testShop };
      const rawBody = JSON.stringify(payload);
      const hmac = crypto.createHmac('sha256', apiSecret).update(Buffer.from(rawBody, 'utf8')).digest('base64');

      const req = new Request('https://app.test/api/webhooks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': 'shop/redact',
          'X-Shopify-Hmac-Sha256': hmac
        },
        body: rawBody
      });

      const res = await handleWebhookRequest(failingDb, req, { apiSecret });
      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.error, 'Webhook processing failed');
      assert.equal(data.retryable, true);
    });
  });

  describe('Product Search and App Proxy Interactive Actions (Milestone M3)', () => {
    let db;
    beforeEach(() => {
      db = createMockDb({
        profiles: [
          {
            id: 'prof_1',
            shop: testShop,
            ownerGid: 'gid://shopify/Customer/112233',
            isApproved: true,
            practiceName: 'Elite Naturopathic Clinic'
          }
        ]
      });
    });

    it('handles product search requests and returns products array', async () => {
      const mockResolver = createFakeVariantResolver({}, [
        {
          id: 'gid://shopify/Product/1',
          title: 'Liposomal Vitamin C',
          variants: [
            { id: 'gid://shopify/ProductVariant/101', displayTitle: 'Liposomal Vitamin C - 150ml', price: '24.99' }
          ]
        }
      ]);

      const res = await handleProductSearchRequest(testShop, 'vitamin', {
        variantResolver: mockResolver
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.products.length, 1);
      assert.equal(data.products[0].title, 'Liposomal Vitamin C');
    });

    it('returns empty products array for blank search query', async () => {
      const res = await handleProductSearchRequest(testShop, '   ');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.products, []);
    });

    it('dispatches action=search through handleAppProxyRequest', async () => {
      const mockResolver = createFakeVariantResolver({}, [
        {
          id: 'gid://shopify/Product/2',
          title: 'Organic Ashwagandha',
          variants: [
            { id: 'gid://shopify/ProductVariant/201', displayTitle: 'Organic Ashwagandha - 60 Caps', price: '19.99' }
          ]
        }
      ]);

      const params = {
        shop: testShop,
        action: 'search',
        q: 'ashwagandha',
        logged_in_customer_id: '112233',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&action=search&q=ashwagandha&logged_in_customer_id=112233&timestamp=1729500000&signature=${signature}`;

      const res = await handleAppProxyRequest(db, new Request(url), {
        apiSecret,
        variantResolver: mockResolver
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.products.length, 1);
      assert.equal(data.products[0].title, 'Organic Ashwagandha');
    });

    it('dispatches action=create through handleAppProxyRequest when practitioner is approved', async () => {
      // Ensure profile is approved
      db.state.profiles[0].isApproved = true;

      const payload = {
        name: 'Immune Support Stack',
        introNote: 'Take daily during winter',
        lines: [
          { variantGid: 'gid://shopify/ProductVariant/9901', quantity: 1, usageNote: '1 cap daily' }
        ]
      };

      const params = {
        shop: testShop,
        action: 'create',
        logged_in_customer_id: '112233',
        timestamp: '1729500000'
      };
      const signature = calculateAppProxySignature(params, apiSecret);
      const url = `https://${testShop}/apps/protocols?shop=${testShop}&action=create&logged_in_customer_id=112233&timestamp=1729500000&signature=${signature}`;

      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.protocol.name, 'Immune Support Stack');
      assert.ok(data.protocol.token);
    });
  });

  describe('Merchant Admin Route Handlers (Milestone M6)', () => {
    let db;
    let adminToken;

    beforeEach(() => {
      adminToken = createAdminSessionToken({
        userId: 'gid://shopify/User/admin_1',
        shop: testShop,
        expiresInSec: 3600
      }, apiSecret);

      db = createMockDb({
        profiles: [
          {
            id: 'prof_1',
            shop: testShop,
            ownerGid: 'gid://shopify/Customer/112233',
            practiceName: 'Elite Naturopathic Clinic',
            isApproved: false,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ],
        protocols: [
          {
            id: 'proto_1',
            shop: testShop,
            token: 'tok_active_1',
            name: 'Immune Protocol',
            status: 'active',
            isStarter: false
          },
          {
            id: 'proto_starter_1',
            shop: testShop,
            token: 'tok_starter_1',
            name: 'Brand Starter Protocol',
            status: 'active',
            isStarter: true
          }
        ],
        settings: [
          {
            shop: testShop,
            identityMode: 'tag',
            footerDisclaimer: 'Demo Disclaimer',
            handoutText: 'Demo Handout'
          }
        ],
        stats: [
          {
            shop: testShop,
            month: '2026-10',
            protocolId: 'proto_1',
            ownerId: 'gid://shopify/Customer/112233',
            orders: 5,
            units: 12,
            revenueMinor: 125000,
            currency: 'USD'
          }
        ]
      });
    });

    it('handleAdminDashboardRequest returns 200 HTML with Polaris tabs', async () => {
      const req = new Request(`https://${testShop}/admin?tab=practitioners`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminDashboardRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/html'));
      const text = await res.text();
      assert.ok(text.includes('Practitioner Directory'));
      assert.ok(text.includes('Elite Naturopathic Clinic'));
    });

    it('handleAdminDashboardRequest rejects unauthenticated requests with 401', async () => {
      const req = new Request(`https://${testShop}/admin?tab=practitioners`);
      const res = await handleAdminDashboardRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 401);
    });

    it('handleAdminPractitionersListRequest returns profiles list', async () => {
      const req = new Request(`https://${testShop}/api/admin/practitioners`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminPractitionersListRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.profiles.length, 1);
      assert.equal(data.profiles[0].practiceName, 'Elite Naturopathic Clinic');
    });

    it('handleAdminPractitionerStatusRequest updates approval status', async () => {
      const req = new Request(`https://${testShop}/api/admin/practitioners/status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ownerGid: 'gid://shopify/Customer/112233',
          action: 'approve'
        })
      });

      const res = await handleAdminPractitionerStatusRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.profile.isApproved, true);
    });

    it('handleAdminPracticeNameRequest updates practice name and prevents impersonation', async () => {
      const req = new Request(`https://${testShop}/api/admin/practitioners/practice-name`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ownerGid: 'gid://shopify/Customer/112233',
          practiceName: 'Renamed Holistic Center'
        })
      });

      const res = await handleAdminPracticeNameRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.profile.practiceName, 'Renamed Holistic Center');
    });

    it('handleAdminPracticeNameRequest strictly rejects PII in practice name', async () => {
      const req = new Request(`https://${testShop}/api/admin/practitioners/practice-name`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ownerGid: 'gid://shopify/Customer/112233',
          practiceName: 'Clinic with patient name John'
        })
      });

      const res = await handleAdminPracticeNameRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'PII_NOT_ALLOWED');
    });

    it('handleAdminStartersListRequest returns starter templates', async () => {
      const req = new Request(`https://${testShop}/api/admin/starters`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminStartersListRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.starters.length >= 1);
      assert.ok(data.starters.some(s => s.name === 'Brand Starter Protocol'));
    });

    it('handleAdminCreateStarterRequest creates brand starter template', async () => {
      const req = new Request(`https://${testShop}/api/admin/starters/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Seasonal Routine Starter',
          introNote: 'Guidance for all specialists',
          lines: [
            { variantGid: 'gid://shopify/ProductVariant/5050', quantity: 1, usageNote: 'Daily morning' }
          ]
        })
      });

      const res = await handleAdminCreateStarterRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.starter.name, 'Seasonal Routine Starter');
      assert.equal(data.starter.isStarter, true);
    });

    it('handleAdminCreateStarterRequest rejects starter template containing PII', async () => {
      const req = new Request(`https://${testShop}/api/admin/starters/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Care Plan',
          patientName: 'Jane Smith',
          lines: [
            { variantGid: 'gid://shopify/ProductVariant/5050', quantity: 1 }
          ]
        })
      });

      const res = await handleAdminCreateStarterRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.code, 'PII_NOT_ALLOWED');
    });

    it('handleAdminUpdateSettingsRequest updates shop identity mode and disclaimers', async () => {
      const req = new Request(`https://${testShop}/api/admin/settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          identityMode: 'company',
          footerDisclaimer: 'Updated company footer disclaimer',
          handoutText: 'Updated handout instructions'
        })
      });

      const res = await handleAdminUpdateSettingsRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.settings.identityMode, 'company');
      assert.equal(data.settings.footerDisclaimer, 'Updated company footer disclaimer');
    });

    it('handleAdminEmergencyDisableAllRequest shuts down all protocols storewide', async () => {
      const req = new Request(`https://${testShop}/api/admin/emergency/disable-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminEmergencyDisableAllRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.ok(data.disabledCount >= 1);
      assert.ok(db.state.protocols.every(p => p.status === 'disabled'));
    });

    it('handleAdminAttributionCsvRequest streams RFC 4180 compliant CSV', async () => {
      const req = new Request(`https://${testShop}/api/admin/attribution.csv?month=2026-10`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminAttributionCsvRequest(db, req, { apiSecret, expectedShop: testShop });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/csv'));
      assert.ok(res.headers.get('content-disposition').includes('attribution-wellness-store.myshopify.com-2026-10.csv'));
      const csv = await res.text();
      assert.ok(csv.startsWith('Month,Practice Name,Owner GID,Protocol ID,Protocol Name,Is Starter,Orders,Units,Revenue,Currency'));
    });

    it('handleAdminDashboardRequest sets CSP frame-ancestors, nosniff, and strict-origin headers', async () => {
      const req = new Request(`https://${testShop}/admin?tab=practitioners`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      const res = await handleAdminDashboardRequest(db, req, { apiSecret, apiKey: 'test_api_key', expectedShop: testShop });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-security-policy').startsWith(`frame-ancestors https://${testShop} https://admin.shopify.com;`));
      assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    });

    it('rejects cross-shop mismatch with 403 Forbidden across all admin routes', async () => {
      const mismatchedShop = 'attacker-store.myshopify.com';
      const mismatchOpts = { apiSecret, expectedShop: mismatchedShop };

      // GET /admin
      const dashReq = new Request(`https://${testShop}/admin`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const dashRes = await handleAdminDashboardRequest(db, dashReq, mismatchOpts);
      assert.equal(dashRes.status, 403);
      const dashJson = await dashRes.json();
      assert.equal(dashJson.code, 'FORBIDDEN');

      // GET /api/admin/practitioners
      const pracListReq = new Request(`https://${testShop}/api/admin/practitioners`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const pracListRes = await handleAdminPractitionersListRequest(db, pracListReq, mismatchOpts);
      assert.equal(pracListRes.status, 403);

      // POST /api/admin/practitioners/status
      const pracStatusReq = new Request(`https://${testShop}/api/admin/practitioners/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerGid: 'gid://shopify/Customer/112233', action: 'approve' })
      });
      const pracStatusRes = await handleAdminPractitionerStatusRequest(db, pracStatusReq, mismatchOpts);
      assert.equal(pracStatusRes.status, 403);

      // POST /api/admin/practitioners/practice-name
      const nameReq = new Request(`https://${testShop}/api/admin/practitioners/practice-name`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerGid: 'gid://shopify/Customer/112233', practiceName: 'New Name' })
      });
      const nameRes = await handleAdminPracticeNameRequest(db, nameReq, mismatchOpts);
      assert.equal(nameRes.status, 403);

      // GET /api/admin/starters
      const startersReq = new Request(`https://${testShop}/api/admin/starters`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const startersRes = await handleAdminStartersListRequest(db, startersReq, mismatchOpts);
      assert.equal(startersRes.status, 403);

      // POST /api/admin/starters/create
      const createStarterReq = new Request(`https://${testShop}/api/admin/starters/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Starter A', lines: [{ variantGid: 'gid://shopify/ProductVariant/1', quantity: 1 }] })
      });
      const createStarterRes = await handleAdminCreateStarterRequest(db, createStarterReq, mismatchOpts);
      assert.equal(createStarterRes.status, 403);

      // POST /api/admin/settings
      const settingsReq = new Request(`https://${testShop}/api/admin/settings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'company', disclaimer: 'Test' })
      });
      const settingsRes = await handleAdminUpdateSettingsRequest(db, settingsReq, mismatchOpts);
      assert.equal(settingsRes.status, 403);

      // POST /api/admin/emergency/disable-all
      const emergencyReq = new Request(`https://${testShop}/api/admin/emergency/disable-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const emergencyRes = await handleAdminEmergencyDisableAllRequest(db, emergencyReq, mismatchOpts);
      assert.equal(emergencyRes.status, 403);

      // GET /api/admin/attribution.csv
      const csvReq = new Request(`https://${testShop}/api/admin/attribution.csv`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const csvRes = await handleAdminAttributionCsvRequest(db, csvReq, mismatchOpts);
      assert.equal(csvRes.status, 403);
    });

    it('handleAdminDashboardRequest queries live tables strictly using shop derived from token (tenant isolation)', async () => {
      const shopA = 'store-a.myshopify.com';
      const shopB = 'store-b.myshopify.com';
      const tokenA = createAdminSessionToken({ shop: shopA, apiKey: 'test_api_key' }, apiSecret);

      const executedQueries = [];
      const spyDb = {
        async query(sql, params = []) {
          executedQueries.push({ sql, params });
          if (sql.includes('COUNT(*) as total FROM') && sql.includes('"PractitionerProfile"')) {
            return { rows: [{ total: 1 }] };
          }
          if (sql.includes('FROM "PractitionerProfile"')) {
            return {
              rows: [{
                ownerGid: 'gid://shopify/Customer/100',
                shop: params[0],
                practiceName: params[0] === shopA ? 'Shop A Clinic' : 'Shop B Clinic',
                isApproved: true,
                createdAt: new Date(),
                updatedAt: new Date()
              }]
            };
          }
          if (sql.includes('FROM "Protocol"') && sql.includes('"isStarter" = true')) {
            return {
              rows: [{
                id: 'starter_1',
                shop: params[0],
                name: params[0] === shopA ? 'Shop A Protocol' : 'Shop B Protocol',
                status: 'active',
                isStarter: true,
                lines: []
              }]
            };
          }
          if (sql.includes('FROM "Setting"')) {
            return {
              rows: [{
                shop: params[0],
                identityMode: 'tag',
                footerDisclaimer: null,
                handoutText: null
              }]
            };
          }
          if (sql.includes('FROM "ProtocolOrderStat"')) {
            return { rows: [] };
          }
          return { rows: [] };
        }
      };

      const req = new Request(`https://${shopA}/admin`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });

      const res = await handleAdminDashboardRequest(spyDb, req, { apiSecret, apiKey: 'test_api_key' });
      assert.equal(res.status, 200);

      assert.ok(executedQueries.length >= 4, `Expected at least 4 queries, got ${executedQueries.length}`);
      for (const q of executedQueries) {
        assert.equal(q.params[0], shopA, `Query must use shopA as first parameter: ${q.sql}`);
        assert.ok(!q.params.includes(shopB), `Query parameters must never reference shopB`);
      }

      const html = await res.text();
      assert.ok(html.includes('Shop A Clinic'));
      assert.ok(!html.includes('Shop B Clinic'));

      // Also verify tab=starters renders Shop A starter template and never Shop B
      const startersReq = new Request(`https://${shopA}/admin?tab=starters`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      const startersRes = await handleAdminDashboardRequest(spyDb, startersReq, { apiSecret, apiKey: 'test_api_key' });
      assert.equal(startersRes.status, 200);
      const startersHtml = await startersRes.text();
      assert.ok(startersHtml.includes('Shop A Protocol'));
      assert.ok(!startersHtml.includes('Shop B Protocol'));
    });
  });

  describe('Storefront Practitioner Self-Enrolment & Proxy CSRF (Milestone M9b-2)', () => {
    let db;
    const testCustomerId = '445566';
    const customerGid = `gid://shopify/Customer/${testCustomerId}`;

    beforeEach(() => {
      db = createMockDb({
        profiles: [],
        settings: [{
          shop: testShop,
          identityMode: 'tag',
          allowSelfEnrol: true,
          footerDisclaimer: null,
          handoutText: null
        }]
      });
      // Reset default limiters
      setDefaultProxyRateLimiter(createRateLimiter({ windowMs: 60000, maxRequests: 60 }));
      setDefaultEnrolRateLimiter(createRateLimiter({ windowMs: 3600000, maxRequests: 5 }));
    });

    function makeSignedProxyUrl(paramsObj) {
      const allParams = {
        shop: testShop,
        timestamp: '1729500000',
        ...paramsObj
      };
      const signature = calculateAppProxySignature(allParams, apiSecret);
      const searchParams = new URLSearchParams(allParams);
      searchParams.set('signature', signature);
      return `https://${testShop}/apps/protocols?${searchParams.toString()}`;
    }

    it('CSRF: rejects mutating proxy request without application/json Content-Type (HTTP 415)', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ practiceName: 'Health Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 415);
      const data = await res.json();
      assert.ok(data.error.includes('Content-Type must be application/json'));
    });

    it('CSRF: rejects form-encoded mutating proxy request (HTTP 415)', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'practiceName=Health+Clinic'
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 415);
    });

    it('CSRF: rejects mutating proxy request with Sec-Fetch-Site: cross-site (HTTP 403)', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site'
        },
        body: JSON.stringify({ practiceName: 'Health Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('cross-site'));
    });

    it('CSRF: allows mutating proxy request with Sec-Fetch-Site: same-origin', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin'
        },
        body: JSON.stringify({ practiceName: 'Health Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.status, 'pending');
    });

    it('CSRF: allows mutating proxy request when Sec-Fetch-Site header is omitted', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ practiceName: 'Health Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
    });

    describe('CSRF exact media type verification (enrol, create, update)', () => {
      const bypassTypes = [
        'text/plain; application/json',
        'application/x-www-form-urlencoded; x=application/json',
        'multipart/form-data; boundary=application/json',
        'application/jsonx'
      ];
      const validTypes = [
        'application/json; charset=utf-8',
        'APPLICATION/JSON'
      ];

      describe('action=enrol', () => {
        for (const ct of bypassTypes) {
          it(`rejects bypass Content-Type '${ct}' with 415 on enrol`, async () => {
            const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({ practiceName: 'Health Clinic' })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.equal(res.status, 415);
            const data = await res.json();
            assert.ok(data.error.includes('Content-Type must be application/json'));
          });
        }

        for (const ct of validTypes) {
          it(`accepts valid Content-Type '${ct}' on enrol`, async () => {
            const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({ practiceName: 'Health Clinic' })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.ok(res.status === 200 || res.status === 201);
          });
        }
      });

      describe('action=create', () => {
        beforeEach(() => {
          db.state.profiles.push({
            id: 'prof_approved_create',
            shop: testShop,
            ownerGid: customerGid,
            practiceName: 'Approved Center',
            isApproved: true
          });
        });

        for (const ct of bypassTypes) {
          it(`rejects bypass Content-Type '${ct}' with 415 on create`, async () => {
            const url = makeSignedProxyUrl({ action: 'create', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({
                name: 'Immune Protocol',
                lines: [{ variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 }]
              })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.equal(res.status, 415);
          });
        }

        for (const ct of validTypes) {
          it(`accepts valid Content-Type '${ct}' on create`, async () => {
            const url = makeSignedProxyUrl({ action: 'create', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({
                name: 'Immune Protocol',
                lines: [{ variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 }]
              })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.equal(res.status, 201);
          });
        }
      });

      describe('action=update', () => {
        beforeEach(() => {
          db.state.profiles.push({
            id: 'prof_approved_update',
            shop: testShop,
            ownerGid: customerGid,
            practiceName: 'Approved Center',
            isApproved: true
          });
          db.state.protocols.push({
            id: 'proto_update_target',
            shop: testShop,
            ownerType: 'customer',
            ownerId: customerGid,
            createdBy: customerGid,
            name: 'Original Protocol',
            status: 'active'
          });
        });

        for (const ct of bypassTypes) {
          it(`rejects bypass Content-Type '${ct}' with 415 on update`, async () => {
            const url = makeSignedProxyUrl({ action: 'update', id: 'proto_update_target', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({ name: 'Renamed Protocol' })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.equal(res.status, 415);
          });
        }

        for (const ct of validTypes) {
          it(`accepts valid Content-Type '${ct}' on update`, async () => {
            const url = makeSignedProxyUrl({ action: 'update', id: 'proto_update_target', logged_in_customer_id: testCustomerId });
            const req = new Request(url, {
              method: 'POST',
              headers: { 'Content-Type': ct },
              body: JSON.stringify({ name: 'Renamed Protocol' })
            });
            const res = await handleAppProxyRequest(db, req, { apiSecret });
            assert.equal(res.status, 200);
          });
        }
      });
    });

    it('CSRF: rejects unknown action on POST request with HTTP 400 (never falls through to create)', async () => {
      const url = makeSignedProxyUrl({ action: 'hack_admin', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Malicious Protocol' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid or unknown action'));
    });

    it('CSRF: rejects unknown action on PUT request with HTTP 400', async () => {
      const url = makeSignedProxyUrl({ action: 'unknown_put', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Malicious' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
    });

    it('Enrolment: requires customer to be logged in (HTTP 401)', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol' }); // No logged_in_customer_id
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Apex Health' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.ok(data.error.includes('login required'));
    });

    it('Enrolment: creates pending profile with status 201 when allowSelfEnrol is enabled in Tag mode', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Zenith Integrative Care' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.deepEqual(data, { status: 'pending' });

      // Verify profile in DB state
      const profile = db.state.profiles.find(p => p.ownerGid === customerGid);
      assert.ok(profile);
      assert.equal(profile.isApproved, false);
      assert.equal(profile.practiceName, 'Zenith Integrative Care');
      assert.equal(profile.ownerType, 'customer');
    });

    it('Enrolment: returns status 200 { status: "pending" } idempotently on repeat submission', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req1 = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'First Submission' })
      });

      const res1 = await handleAppProxyRequest(db, req1, { apiSecret });
      assert.equal(res1.status, 201);

      // Repeat request with different requested name
      const req2 = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Second Submission' })
      });

      const res2 = await handleAppProxyRequest(db, req2, { apiSecret });
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.deepEqual(data2, { status: 'pending' });

      // Count profiles in state: should still be exactly 1
      const matchingProfiles = db.state.profiles.filter(p => p.ownerGid === customerGid);
      assert.equal(matchingProfiles.length, 1);
      assert.equal(matchingProfiles[0].practiceName, 'First Submission');
    });

    it('Enrolment: returns 200 { status: "approved" } when existing profile is already approved', async () => {
      db.state.profiles.push({
        id: 'prof_already_approved',
        shop: testShop,
        ownerGid: customerGid,
        practiceName: 'Elite Naturopathic Clinic',
        isApproved: true
      });

      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Re-request' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: 'approved' });
    });

    it('Enrolment: rejects enrolment with HTTP 403 when allowSelfEnrol is false', async () => {
      db.state.settings[0].allowSelfEnrol = false;
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('not enabled'));
    });

    it('Enrolment: rejects enrolment with HTTP 403 when store is in company mode', async () => {
      db.state.settings[0].identityMode = 'company';
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'B2B Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('not enabled'));
    });

    it('Enrolment: defaults practiceName to "Pending Practitioner" when blank or omitted', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
      const profile = db.state.profiles.find(p => p.ownerGid === customerGid);
      assert.equal(profile.practiceName, 'Pending Practitioner');
    });

    it('Enrolment: accepts requested practiceName up to 60 characters', async () => {
      const name60 = 'A'.repeat(60);
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: name60 })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 201);
      const profile = db.state.profiles.find(p => p.ownerGid === customerGid);
      assert.equal(profile.practiceName, name60);
    });

    it('Enrolment: rejects practiceName exceeding 60 characters with HTTP 400', async () => {
      const name61 = 'A'.repeat(61);
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: name61 })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('cannot exceed 60 characters'));
    });

    it('Enrolment: rejects invalid non-object JSON body with HTTP 400', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '["array_not_object"]'
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
    });

    it('Enrolment: strictly forbids client/patient PII in enrolment payload (HTTP 400)', async () => {
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          practiceName: 'Wellness Center',
          patientName: 'John Doe',
          clientEmail: 'john@example.com'
        })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('forbidden') || data.error.includes('PII'));
    });

    it('Enrolment: enforces per-shop pending cap (200 rows) with HTTP 429', async () => {
      // Seed 200 pending profiles
      for (let i = 1; i <= 200; i++) {
        db.state.profiles.push({
          id: `prof_pending_${i}`,
          shop: testShop,
          ownerGid: `gid://shopify/Customer/seed_${i}`,
          practiceName: `Pending Clinic ${i}`,
          isApproved: false
        });
      }

      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Over Capacity Clinic' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 429);
      const data = await res.json();
      assert.ok(data.error.includes('at capacity'));
    });

    it('Enrolment: enforces per-customer sliding window rate limit (5 requests / hour) with HTTP 429', async () => {
      const limiter = createRateLimiter({ windowMs: 3600000, maxRequests: 5 });
      const url = makeSignedProxyUrl({ action: 'enrol', logged_in_customer_id: testCustomerId });

      // First 5 requests succeed (first creates 201, subsequent are 200 idempotent)
      for (let i = 0; i < 5; i++) {
        const req = new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ practiceName: 'Fast Repeat' })
        });
        const res = await handleAppProxyRequest(db, req, { apiSecret, enrolRateLimiter: limiter });
        assert.ok(res.status === 200 || res.status === 201);
      }

      // 6th request is blocked by customer rate limiter
      const req6 = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ practiceName: 'Fast Repeat 6' })
      });
      const res6 = await handleAppProxyRequest(db, req6, { apiSecret, enrolRateLimiter: limiter });
      assert.equal(res6.status, 429);
      const data6 = await res6.json();
      assert.ok(data6.error.includes('Too many enrolment requests'));
      assert.ok(res6.headers.get('retry-after'));
    });

    it('Authorization: rejects protocol create attempt by pending practitioner with HTTP 403', async () => {
      db.state.profiles.push({
        id: 'prof_unapproved',
        shop: testShop,
        ownerGid: customerGid,
        practiceName: 'Unapproved Clinic',
        isApproved: false
      });

      const url = makeSignedProxyUrl({ action: 'create', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Unauthorized Protocol',
          lines: [{ variantGid: 'gid://shopify/ProductVariant/101', quantity: 1 }]
        })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('pending approval'));
    });

    it('Authorization: rejects protocol update attempt by pending practitioner with HTTP 403', async () => {
      db.state.profiles.push({
        id: 'prof_unapproved',
        shop: testShop,
        ownerGid: customerGid,
        practiceName: 'Unapproved Clinic',
        isApproved: false
      });

      const url = makeSignedProxyUrl({ action: 'update', id: 'proto_1', logged_in_customer_id: testCustomerId });
      const req = new Request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked Protocol' })
      });

      const res = await handleAppProxyRequest(db, req, { apiSecret });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.ok(data.error.includes('pending approval'));
    });

    describe('App Proxy Protocol Authoring & Rule-4 Isolation (M9b-3a)', () => {
      beforeEach(() => {
        db.state.profiles.push({
          id: 'prof_author',
          shop: testShop,
          ownerGid: customerGid,
          practiceName: 'Approved Author Practice',
          isApproved: true
        });
      });

      it('creates new protocol with productHandle via POST /apps/protocols?action=create', async () => {
        const url = makeSignedProxyUrl({ action: 'create', logged_in_customer_id: testCustomerId });
        const req = new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: 'Client Evening Protocol',
            introNote: 'Follow instructions nightly.',
            lines: [
              {
                variantGid: 'gid://shopify/ProductVariant/6001',
                productHandle: 'night-repair-cream',
                quantity: 1,
                usageNote: 'Apply thin layer'
              }
            ]
          })
        });

        const res = await handleAppProxyRequest(db, req, { apiSecret });
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.name, 'Client Evening Protocol');
        assert.equal(data.lines.length, 1);
        assert.equal(data.lines[0].productHandle, 'night-repair-cream');
        assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/6001');
      });

      it('updates existing protocol with productHandle via POST /apps/protocols?action=update&id=...', async () => {
        const proto = {
          id: 'proto_my_editable',
          shop: testShop,
          token: 'tok_editable_123',
          name: 'Original Routine',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };
        db.state.protocols.push(proto);
        db.state.lines.push({
          id: 'line_init',
          protocolId: proto.id,
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/1111',
          productHandle: 'old-product',
          quantity: 1
        });

        const url = makeSignedProxyUrl({ action: 'update', id: proto.id, logged_in_customer_id: testCustomerId });
        const req = new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: 'Updated Routine Name',
            lines: [
              {
                variantGid: 'gid://shopify/ProductVariant/2222',
                productHandle: 'new-product-handle',
                quantity: 2,
                usageNote: 'Twice daily'
              }
            ]
          })
        });

        const res = await handleAppProxyRequest(db, req, { apiSecret });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.name, 'Updated Routine Name');
        assert.equal(data.lines[0].productHandle, 'new-product-handle');
        assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/2222');
      });

      it('Rule-4: rejects cross-owner protocol update via App Proxy with 404 Not Found', async () => {
        const otherProto = {
          id: 'proto_other_practitioner',
          shop: testShop,
          token: 'tok_other_123',
          name: 'Other Doctor Routine',
          ownerType: 'customer',
          ownerId: 'gid://shopify/Customer/someone_else',
          createdBy: 'gid://shopify/Customer/someone_else',
          status: 'active'
        };
        db.state.protocols.push(otherProto);

        const url = makeSignedProxyUrl({ action: 'update', id: otherProto.id, logged_in_customer_id: testCustomerId });
        const req = new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: 'Hijacked Protocol',
            lines: [{ variantGid: 'gid://shopify/ProductVariant/3333', quantity: 1 }]
          })
        });

        const res = await handleAppProxyRequest(db, req, { apiSecret });
        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.code, 'NOT_FOUND');
      });

      it('Rule-4: enforces cross-shop isolation (Shop A practitioner cannot access Shop B)', async () => {
        const shopB = 'different-store.myshopify.com';
        const shopBProto = {
          id: 'proto_shop_b',
          shop: shopB,
          token: 'tok_shop_b_123',
          name: 'Shop B Routine',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };
        db.state.protocols.push(shopBProto);

        // Attempt to update Shop B protocol via Shop A URL
        const url = makeSignedProxyUrl({ action: 'update', id: shopBProto.id, logged_in_customer_id: testCustomerId });
        const req = new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: 'Cross Shop Update',
            lines: [{ variantGid: 'gid://shopify/ProductVariant/4444', quantity: 1 }]
          })
        });

        const res = await handleAppProxyRequest(db, req, { apiSecret });
        assert.equal(res.status, 404);
      });

      it('portal embedded JSON (#portal-protocols-data) contains owner protocol lines including productHandle and isolates other owners and shops (Rule 4)', async () => {
        const ownerProto = {
          id: 'proto_owner_1',
          shop: testShop,
          token: 'tok_owner_111',
          name: 'Owner Regimen',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };
        const otherOwnerProto = {
          id: 'proto_other_2',
          shop: testShop,
          token: 'tok_other_222',
          name: 'Other Practitioner Regimen',
          ownerType: 'customer',
          ownerId: 'gid://shopify/Customer/someone_else',
          createdBy: 'gid://shopify/Customer/someone_else',
          status: 'active'
        };
        const otherShopProto = {
          id: 'proto_other_shop_3',
          shop: 'other-brand.myshopify.com',
          token: 'tok_other_shop_333',
          name: 'Other Shop Regimen',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };

        db.state.protocols.push(ownerProto, otherOwnerProto, otherShopProto);
        db.state.lines.push({
          id: 'line_owner_1',
          protocolId: ownerProto.id,
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/7777',
          productHandle: 'cleanser-glow',
          quantity: 2,
          usageNote: 'Morning and night'
        });
        db.state.lines.push({
          id: 'line_other_2',
          protocolId: otherOwnerProto.id,
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/8888',
          productHandle: 'other-secret-tonic',
          quantity: 1
        });

        const url = makeSignedProxyUrl({ logged_in_customer_id: testCustomerId });
        const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });
        assert.equal(res.status, 200);
        const html = await res.text();

        // Extract JSON from #portal-protocols-data
        const match = html.match(/<script type="application\/json" id="portal-protocols-data">\s*([\s\S]*?)\s*<\/script>/);
        assert.ok(match, 'portal-protocols-data element must exist in response HTML');
        const protocolsData = JSON.parse(match[1]);

        // Assert owner protocol is present with lines including productHandle
        const foundOwner = protocolsData.find(p => p.id === ownerProto.id);
        assert.ok(foundOwner, 'Owner protocol must be included');
        assert.equal(foundOwner.lines.length, 1);
        assert.equal(foundOwner.lines[0].productHandle, 'cleanser-glow');
        assert.equal(foundOwner.lines[0].variantGid, 'gid://shopify/ProductVariant/7777');
        assert.equal(foundOwner.linesCount, 1);

        // Rule-4 isolation assertions:
        const foundOtherOwner = protocolsData.find(p => p.id === otherOwnerProto.id);
        assert.equal(foundOtherOwner, undefined, 'Rule 4: Other owner protocol must NOT be in portal-protocols-data');
        assert.ok(!html.includes('other-secret-tonic'), 'Other owner product handle must not appear');

        const foundOtherShop = protocolsData.find(p => p.id === otherShopProto.id);
        assert.equal(foundOtherShop, undefined, 'Rule 4: Other shop protocol must NOT be in portal-protocols-data');
      });

      it('update safety: POST update with lines: [] is rejected (400 validation error) and existing lines remain unchanged in DB', async () => {
        const proto = {
          id: 'proto_safe_update',
          shop: testShop,
          token: 'tok_safe_update_123',
          name: 'Safe Routine',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };
        db.state.protocols.push(proto);
        const originalLine = {
          id: 'line_must_stay',
          protocolId: proto.id,
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/9999',
          productHandle: 'vital-serum',
          quantity: 1,
          usageNote: 'Do not delete'
        };
        db.state.lines.push(originalLine);

        const url = makeSignedProxyUrl({ action: 'update', id: proto.id, logged_in_customer_id: testCustomerId });
        const req = new Request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            name: 'Attempted Empty Lines',
            lines: []
          })
        });

        const res = await handleAppProxyRequest(db, req, { apiSecret });
        assert.equal(res.status, 400);
        const data = await res.json();
        assert.ok(data.error.includes('at least 1 product line') || data.code === 'MIN_ITEMS');

        // Verify DB lines for this protocol were untouched
        const linesInDb = db.state.lines.filter(l => l.protocolId === proto.id);
        assert.equal(linesInDb.length, 1);
        assert.equal(linesInDb[0].id, 'line_must_stay');
        assert.equal(linesInDb[0].variantGid, 'gid://shopify/ProductVariant/9999');
      });

      it('GET /apps/protocols/<token>?handout=1 renders print-friendly handout layout with window.print(), no-print, settings disclaimer and no Add buttons', async () => {
        db.state.settings = [{
          shop: testShop,
          identityMode: 'tag',
          allowSelfEnrol: true,
          handoutText: 'Take daily as directed by Dr. Smith.',
          footerDisclaimer: 'These statements have not been evaluated by the FDA.'
        }];

        const handoutProto = {
          id: 'proto_handout_1',
          shop: testShop,
          token: 'tok_handout_test',
          name: 'Morning Skincare Handout Protocol',
          ownerType: 'customer',
          ownerId: customerGid,
          createdBy: customerGid,
          status: 'active'
        };
        db.state.protocols.push(handoutProto);
        db.state.lines.push({
          id: 'line_handout_1',
          protocolId: handoutProto.id,
          position: 0,
          variantGid: 'gid://shopify/ProductVariant/54321',
          productHandle: 'restorative-oil',
          quantity: 1,
          usageNote: '2 drops morning'
        });

        const proxyParams = {
          shop: testShop,
          token: handoutProto.token,
          handout: '1',
          path_prefix: '/apps/protocols',
          timestamp: '1729500000'
        };
        const sig = calculateAppProxySignature(proxyParams, apiSecret);
        const url = `https://${testShop}/apps/protocols?shop=${testShop}&token=${handoutProto.token}&handout=1&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${sig}`;

        const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });
        assert.equal(res.status, 200);
        const html = await res.text();

        // Print button and print media stylesheet
        assert.ok(html.includes('window.print()'), 'Must contain window.print()');
        assert.ok(html.includes('no-print'), 'Must contain .no-print utility class');
        assert.ok(html.includes('@media print'), 'Must contain @media print stylesheet');

        // Titles and notes
        assert.ok(html.includes('Morning Skincare Handout Protocol'));
        assert.ok(html.includes('Take daily as directed by Dr. Smith.'));
        assert.ok(html.includes('These statements have not been evaluated by the FDA.'));

        // No Add buttons or practitioner banner in handout markup
        assert.ok(!html.includes('Add all to cart'), 'Handout must not have Add all to cart text');
        assert.ok(!html.includes('id="protocol-add-all-btn"'), 'Handout must not have protocol-add-all-btn in markup');
        assert.ok(!html.includes('<button type="button" class="protocol-btn protocol-btn-secondary protocol-line-add-btn"'), 'Handout must not have line Add buttons in markup');
        assert.ok(!html.includes('<div class="protocol-practitioner-banner"'), 'Handout must not show professional banner in markup');
        assert.ok(!html.includes("You're signed in as a professional"), 'Handout must not show professional message');

        // Item 1: Inline SVG QR and absolute share URL
        assert.ok(html.includes('<svg'), 'Handout must contain inline SVG QR code');
        assert.ok(html.includes(`https://${testShop}/apps/protocols/${handoutProto.token}`), 'Handout must contain absolute share URL');
        assert.ok(html.includes('practice-label'), 'Handout must render practice-label');
      });

      it('GET /apps/protocols/<token>?handout=1 enforces cross-shop isolation and returns 404 for another shop\'s token', async () => {
        const foreignShop = 'other-brand.myshopify.com';
        const proxyParams = {
          shop: foreignShop,
          token: 'tok_handout_test',
          handout: '1',
          path_prefix: '/apps/protocols',
          timestamp: '1729500000'
        };
        const sig = calculateAppProxySignature(proxyParams, apiSecret);
        const url = `https://${foreignShop}/apps/protocols?shop=${foreignShop}&token=tok_handout_test&handout=1&path_prefix=%2Fapps%2Fprotocols&timestamp=1729500000&signature=${sig}`;

        const res = await handleAppProxyRequest(db, new Request(url), { apiSecret });
        assert.equal(res.status, 404);
        const text = await res.text();
        assert.ok(text.includes('Protocol not found'));
      });

      describe('Protocol Lifecycle Actions via App Proxy: archive, restore, duplicate (M9b-3b)', () => {
        let lifecycleProto;
        let starterTemplate;
        let foreignCustomerProto;
        let foreignShopProto;

        beforeEach(() => {
          lifecycleProto = {
            id: 'proto_life_own_1',
            shop: testShop,
            token: 'tok_life_own_1',
            name: 'Hydration Protocol',
            introNote: 'Drink plenty of water',
            ownerType: 'customer',
            ownerId: customerGid,
            createdBy: customerGid,
            status: 'active'
          };

          starterTemplate = {
            id: 'proto_starter_tmpl_1',
            shop: testShop,
            token: 'tok_starter_tmpl_1',
            name: 'Essential Routine Template',
            introNote: 'Core starter routine',
            isStarter: true,
            status: 'active'
          };

          foreignCustomerProto = {
            id: 'proto_foreign_cust_1',
            shop: testShop,
            token: 'tok_foreign_cust_1',
            name: 'Private Regimen',
            ownerType: 'customer',
            ownerId: 'gid://shopify/Customer/other_user_99',
            createdBy: 'gid://shopify/Customer/other_user_99',
            status: 'active'
          };

          foreignShopProto = {
            id: 'proto_foreign_shop_1',
            shop: 'other-brand.myshopify.com',
            token: 'tok_foreign_shop_1',
            name: 'Other Shop Protocol',
            ownerType: 'customer',
            ownerId: customerGid,
            createdBy: customerGid,
            status: 'active'
          };

          db.state.protocols.push(lifecycleProto, starterTemplate, foreignCustomerProto, foreignShopProto);
          db.state.lines.push(
            {
              id: 'line_life_1',
              protocolId: lifecycleProto.id,
              position: 0,
              variantGid: 'gid://shopify/ProductVariant/1111',
              productHandle: 'electrolyte-powder',
              quantity: 2,
              usageNote: '1 scoop daily'
            },
            {
              id: 'line_starter_1',
              protocolId: starterTemplate.id,
              position: 0,
              variantGid: 'gid://shopify/ProductVariant/2222',
              productHandle: 'daily-vitamins',
              quantity: 1,
              usageNote: 'With breakfast'
            }
          );
        });

        it('POST action=archive archives owner protocol and returns 200 JSON', async () => {
          const url = makeSignedProxyUrl({ action: 'archive', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });

          const res = await handleAppProxyRequest(db, req, { apiSecret });
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.status, 'archived');

          // Verify DB state updated
          const inDb = db.state.protocols.find(p => p.id === lifecycleProto.id);
          assert.equal(inDb.status, 'archived');
        });

        it('POST action=archive enforces CSRF application/json (415) and Sec-Fetch-Site (403)', async () => {
          const url = makeSignedProxyUrl({ action: 'archive', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });

          // Non-JSON media type -> 415
          const textReq = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: '{}'
          });
          const textRes = await handleAppProxyRequest(db, textReq, { apiSecret });
          assert.equal(textRes.status, 415);

          // Cross-site Sec-Fetch-Site -> 403
          const csrfReq = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
            body: '{}'
          });
          const csrfRes = await handleAppProxyRequest(db, csrfReq, { apiSecret });
          assert.equal(csrfRes.status, 403);
        });

        it('POST action=archive requires authenticated customer (401) and approved profile (403)', async () => {
          // Unauthenticated (no customer ID) -> 401
          const unauthUrl = makeSignedProxyUrl({ action: 'archive', id: lifecycleProto.id });
          const unauthReq = new Request(unauthUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const unauthRes = await handleAppProxyRequest(db, unauthReq, { apiSecret });
          assert.equal(unauthRes.status, 401);

          // Unapproved customer -> 403
          db.state.profiles.forEach(p => { p.isApproved = false; });
          const unapprovedUrl = makeSignedProxyUrl({ action: 'archive', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const unapprovedReq = new Request(unapprovedUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const unapprovedRes = await handleAppProxyRequest(db, unapprovedReq, { apiSecret });
          assert.equal(unapprovedRes.status, 403);
        });

        it('POST action=archive returns 404 for another customer protocol and cross-shop (Rule 4)', async () => {
          // Other customer's protocol -> 404 (prevents ID enumeration)
          const otherUrl = makeSignedProxyUrl({ action: 'archive', id: foreignCustomerProto.id, logged_in_customer_id: testCustomerId });
          const otherReq = new Request(otherUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const otherRes = await handleAppProxyRequest(db, otherReq, { apiSecret });
          assert.equal(otherRes.status, 404);

          // Cross-shop protocol -> 404
          const crossUrl = makeSignedProxyUrl({ action: 'archive', id: foreignShopProto.id, logged_in_customer_id: testCustomerId });
          const crossReq = new Request(crossUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const crossRes = await handleAppProxyRequest(db, crossReq, { apiSecret });
          assert.equal(crossRes.status, 404);
        });

        it('POST action=archive returns 403 when attempting to archive a brand starter template', async () => {
          const starterUrl = makeSignedProxyUrl({ action: 'archive', id: starterTemplate.id, logged_in_customer_id: testCustomerId });
          const starterReq = new Request(starterUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const starterRes = await handleAppProxyRequest(db, starterReq, { apiSecret });
          assert.equal(starterRes.status, 403);
          const data = await starterRes.json();
          assert.equal(data.code, 'STARTER_MODIFICATION_FORBIDDEN');
        });

        it('POST action=restore restores archived protocol back to active and returns 200 JSON', async () => {
          lifecycleProto.status = 'archived';

          const url = makeSignedProxyUrl({ action: 'restore', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });

          const res = await handleAppProxyRequest(db, req, { apiSecret });
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.status, 'active');

          const inDb = db.state.protocols.find(p => p.id === lifecycleProto.id);
          assert.equal(inDb.status, 'active');
        });

        it('POST action=restore returns 404 for another customer protocol or cross-shop (Rule 4)', async () => {
          foreignCustomerProto.status = 'archived';
          const otherUrl = makeSignedProxyUrl({ action: 'restore', id: foreignCustomerProto.id, logged_in_customer_id: testCustomerId });
          const otherReq = new Request(otherUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const otherRes = await handleAppProxyRequest(db, otherReq, { apiSecret });
          assert.equal(otherRes.status, 404);

          foreignShopProto.status = 'archived';
          const crossUrl = makeSignedProxyUrl({ action: 'restore', id: foreignShopProto.id, logged_in_customer_id: testCustomerId });
          const crossReq = new Request(crossUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const crossRes = await handleAppProxyRequest(db, crossReq, { apiSecret });
          assert.equal(crossRes.status, 404);
        });

        it('POST action=duplicate duplicates own protocol with "Copy of <name>", new ID and token', async () => {
          const url = makeSignedProxyUrl({ action: 'duplicate', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });

          const res = await handleAppProxyRequest(db, req, { apiSecret });
          assert.equal(res.status, 201);
          const data = await res.json();

          assert.equal(data.name, 'Copy of Hydration Protocol');
          assert.equal(data.ownerId, customerGid);
          assert.equal(data.isStarter, false);
          assert.equal(data.status, 'active');
          assert.notEqual(data.id, lifecycleProto.id);
          assert.notEqual(data.token, lifecycleProto.token);

          // Lines copied with productHandle, quantity, usageNote
          assert.equal(data.lines.length, 1);
          assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/1111');
          assert.equal(data.lines[0].productHandle, 'electrolyte-powder');
          assert.equal(data.lines[0].quantity, 2);
          assert.equal(data.lines[0].usageNote, '1 scoop daily');
        });

        it('POST action=duplicate duplicates a brand starter template into practitioner library', async () => {
          const url = makeSignedProxyUrl({ action: 'duplicate', id: starterTemplate.id, logged_in_customer_id: testCustomerId });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });

          const res = await handleAppProxyRequest(db, req, { apiSecret });
          assert.equal(res.status, 201);
          const data = await res.json();

          assert.equal(data.name, 'Copy of Essential Routine Template');
          assert.equal(data.ownerId, customerGid);
          assert.equal(data.isStarter, false);
          assert.equal(data.sourceProtocolId, starterTemplate.id);
          assert.notEqual(data.id, starterTemplate.id);
          assert.notEqual(data.token, starterTemplate.token);

          assert.equal(data.lines.length, 1);
          assert.equal(data.lines[0].variantGid, 'gid://shopify/ProductVariant/2222');
          assert.equal(data.lines[0].productHandle, 'daily-vitamins');
          assert.equal(data.lines[0].quantity, 1);
        });

        it('POST action=duplicate returns 404 for another customer non-starter protocol and cross-shop', async () => {
          const otherUrl = makeSignedProxyUrl({ action: 'duplicate', id: foreignCustomerProto.id, logged_in_customer_id: testCustomerId });
          const otherReq = new Request(otherUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const otherRes = await handleAppProxyRequest(db, otherReq, { apiSecret });
          assert.equal(otherRes.status, 404);

          const crossUrl = makeSignedProxyUrl({ action: 'duplicate', id: foreignShopProto.id, logged_in_customer_id: testCustomerId });
          const crossReq = new Request(crossUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          const crossRes = await handleAppProxyRequest(db, crossReq, { apiSecret });
          assert.equal(crossRes.status, 404);
        });

        it('POST unknown action returns 400 and never falls through', async () => {
          const url = makeSignedProxyUrl({ action: 'delete', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });

          const res = await handleAppProxyRequest(db, req, { apiSecret });
          assert.equal(res.status, 400);
          const data = await res.json();
          assert.ok(data.error.includes('Invalid or unknown action'));
        });

        it('Client link renders inactive state for archived protocol, and becomes active again when restored with same token', async () => {
          // 1. Initially active
          const clientUrl = makeSignedProxyUrl({ token: lifecycleProto.token });
          const activeRes = await handleAppProxyRequest(db, new Request(clientUrl), { apiSecret });
          assert.equal(activeRes.status, 200);
          const activeHtml = await activeRes.text();
          assert.ok(activeHtml.includes('Hydration Protocol'));
          assert.ok(activeHtml.includes('Add all to cart'));

          // 2. Archive the protocol
          const archiveUrl = makeSignedProxyUrl({ action: 'archive', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const archiveRes = await handleAppProxyRequest(db, new Request(archiveUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          }), { apiSecret });
          assert.equal(archiveRes.status, 200);

          // 3. Client link now renders inactive page
          const archivedClientRes = await handleAppProxyRequest(db, new Request(clientUrl), { apiSecret });
          assert.equal(archivedClientRes.status, 200);
          const archivedHtml = await archivedClientRes.text();
          assert.ok(archivedHtml.includes('Protocol No Longer Active'));
          assert.ok(archivedHtml.includes('This recommendation is no longer active'));
          assert.ok(!archivedHtml.includes('Add all to cart'));
          assert.ok(!archivedHtml.includes('protocol-add-all-btn'));

          // 4. Restore the protocol
          const restoreUrl = makeSignedProxyUrl({ action: 'restore', id: lifecycleProto.id, logged_in_customer_id: testCustomerId });
          const restoreRes = await handleAppProxyRequest(db, new Request(restoreUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          }), { apiSecret });
          assert.equal(restoreRes.status, 200);

          // 5. Client link works again with the SAME token
          const restoredClientRes = await handleAppProxyRequest(db, new Request(clientUrl), { apiSecret });
          assert.equal(restoredClientRes.status, 200);
          const restoredHtml = await restoredClientRes.text();
          assert.ok(restoredHtml.includes('Hydration Protocol'));
          assert.ok(restoredHtml.includes('Add all to cart'));
        });
      });

      describe('M11 Shopper Opt-In & Contact Management Routes', () => {
        const optinProto = {
          id: 'proto_optin_1',
          shop: testShop,
          token: 'tok_optin_123',
          name: 'Gut Health Protocol',
          ownerId: 'gid://shopify/Customer/' + testCustomerId,
          createdBy: 'gid://shopify/Customer/' + testCustomerId,
          status: 'active'
        };

        const inactiveOptinProto = {
          id: 'proto_optin_inactive',
          shop: testShop,
          token: 'tok_optin_inactive',
          name: 'Inactive Protocol',
          ownerId: 'gid://shopify/Customer/' + testCustomerId,
          createdBy: 'gid://shopify/Customer/' + testCustomerId,
          status: 'archived'
        };

        let optinDb;

        beforeEach(() => {
          optinDb = createMockDb({
            protocols: [optinProto, inactiveOptinProto],
            profiles: [
              {
                id: 'prof_optin',
                shop: testShop,
                ownerGid: 'gid://shopify/Customer/' + testCustomerId,
                practiceName: 'Elite Naturopathic Clinic',
                isApproved: true
              }
            ],
            contacts: [
              {
                id: 'contact_existing_1',
                shop: testShop,
                ownerId: 'gid://shopify/Customer/' + testCustomerId,
                email: 'existing@shopper.com',
                firstName: 'Eve',
                consentText: 'I consent',
                consentVersion: 1,
                consentedAt: new Date('2026-11-04T10:00:00Z'),
                source: 'protocol_page',
                createdAt: new Date('2026-11-04T10:00:00Z')
              },
              {
                id: 'contact_other_practitioner',
                shop: testShop,
                ownerId: 'gid://shopify/Customer/999999',
                email: 'other@shopper.com',
                firstName: 'Bob',
                consentText: 'I consent',
                consentVersion: 1,
                consentedAt: new Date('2026-11-04T10:00:00Z'),
                source: 'protocol_page',
                createdAt: new Date('2026-11-04T10:00:00Z')
              }
            ]
          });
        });

        it('Guest subscribe: rejects unticked consent checkbox with 400', async () => {
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'shopper@example.com',
              consent: false,
              consentText: 'I agree'
            })
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 400);
          const data = await res.json();
          assert.ok(data.error.includes('Explicit consent is required'));
        });

        it('Guest subscribe: silent discard when honeypot is filled (returns 200 without DB write)', async () => {
          const initialContactsCount = optinDb.state.contacts.length;
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'bot@spam.com',
              consent: true,
              consentText: 'I agree',
              honeypot: 'bot filled this'
            })
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.success, true);
          assert.equal(optinDb.state.contacts.length, initialContactsCount, 'Honeypot must not write to DB');
        });

        it('Guest subscribe: CSRF rejects missing or invalid Content-Type with 415', async () => {
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'plain text body'
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 415);
        });

        it('Guest subscribe: CSRF rejects cross-site Sec-Fetch-Site with 403', async () => {
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });
          const req = new Request(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Sec-Fetch-Site': 'cross-site'
            },
            body: JSON.stringify({
              email: 'shopper@example.com',
              consent: true,
              consentText: 'I agree'
            })
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 403);
        });

        it('Guest subscribe: returns 404 when protocol is non-existent or inactive', async () => {
          const url = makeSignedProxyUrl({ action: 'subscribe', token: 'tok_optin_inactive' });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'shopper@example.com',
              consent: true,
              consentText: 'I agree'
            })
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 404);
        });

        it('Guest subscribe: successful opt-in saves contact with zero PII leakage in errors', async () => {
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });
          const req = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'New.Shopper@Clinic.org',
              firstName: 'Alice',
              consent: true,
              consentText: 'I agree to stay in touch with Elite Naturopathic Clinic'
            })
          });

          const res = await handleAppProxyRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.success, true);

          const saved = optinDb.state.contacts.find(c => c.email === 'new.shopper@clinic.org');
          assert.ok(saved);
          assert.equal(saved.firstName, 'Alice');
          assert.equal(saved.ownerId, 'gid://shopify/Customer/' + testCustomerId);

          // Test invalid email error message does not echo the submitted email
          const badEmailReq = new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: 'not-an-email-value',
              consent: true,
              consentText: 'I agree'
            })
          });
          const badRes = await handleAppProxyRequest(optinDb, badEmailReq, { apiSecret });
          assert.equal(badRes.status, 400);
          const badData = await badRes.json();
          assert.ok(!badData.error.includes('not-an-email-value'), 'Error message must not leak input email');
        });

        it('Guest subscribe: dedicated subscribe rate limiter enforces 5 per hour per client key (returns 429)', async () => {
          const testLimiter = createRateLimiter({ windowMs: 3600000, maxRequests: 5 });
          const url = makeSignedProxyUrl({ action: 'subscribe', token: optinProto.token });

          for (let i = 0; i < 5; i++) {
            const req = new Request(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.42'
              },
              body: JSON.stringify({
                email: `shopper${i}@example.com`,
                consent: true
              })
            });
            const res = await handleAppProxyRequest(optinDb, req, {
              apiSecret,
              subscribeRateLimiter: testLimiter
            });
            assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
          }

          // 6th request from the same IP exceeds limit
          const limitedReq = new Request(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '198.51.100.42'
            },
            body: JSON.stringify({
              email: 'shopper6@example.com',
              consent: true
            })
          });
          const limitedRes = await handleAppProxyRequest(optinDb, limitedReq, {
            apiSecret,
            subscribeRateLimiter: testLimiter
          });
          assert.equal(limitedRes.status, 429);
          const data = await limitedRes.json();
          assert.equal(data.error, 'Too many requests. Please try again later.');
          assert.ok(limitedRes.headers.get('Retry-After'));
        });

        it('Practitioner contacts: POST action=delete_contact deletes own contact and blocks cross-owner deletion', async () => {
          // 1. Attempt to delete other practitioner's contact (contact_other_practitioner) -> fails / returns success: false
          const crossDeleteUrl = makeSignedProxyUrl({
            action: 'delete_contact',
            logged_in_customer_id: testCustomerId
          });
          const crossReq = new Request(crossDeleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId: 'contact_other_practitioner' })
          });

          const crossRes = await handleAppProxyRequest(optinDb, crossReq, { apiSecret });
          assert.equal(crossRes.status, 200);
          const crossData = await crossRes.json();
          assert.equal(crossData.success, false, 'Cannot delete contact owned by another practitioner');
          assert.ok(optinDb.state.contacts.some(c => c.id === 'contact_other_practitioner'));

          // 2. Delete own contact (contact_existing_1) -> succeeds
          const ownReq = new Request(crossDeleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId: 'contact_existing_1' })
          });

          const ownRes = await handleAppProxyRequest(optinDb, ownReq, { apiSecret });
          assert.equal(ownRes.status, 200);
          const ownData = await ownRes.json();
          assert.equal(ownData.success, true);
          assert.ok(!optinDb.state.contacts.some(c => c.id === 'contact_existing_1'));
        });

        it('Practitioner contacts: GET action=contacts_csv exports RFC 4180 CSV of own contacts only', async () => {
          // 1. Unauthorized when logged_in_customer_id is missing
          const unauthUrl = makeSignedProxyUrl({ action: 'contacts_csv' });
          const unauthRes = await handleAppProxyRequest(optinDb, new Request(unauthUrl), { apiSecret });
          assert.equal(unauthRes.status, 401);

          // 2. Authorized returns text/csv with attachment header
          const authUrl = makeSignedProxyUrl({ action: 'contacts_csv', logged_in_customer_id: testCustomerId });
          const authRes = await handleAppProxyRequest(optinDb, new Request(authUrl), { apiSecret });
          assert.equal(authRes.status, 200);
          assert.equal(authRes.headers.get('Content-Type'), 'text/csv; charset=utf-8');
          assert.ok(authRes.headers.get('Content-Disposition').includes('attachment; filename="my-contacts.csv"'));

          const csvBody = await authRes.text();
          assert.ok(csvBody.includes('Email,First Name,Consented At'));
          assert.ok(csvBody.includes('existing@shopper.com'));
          assert.ok(!csvBody.includes('other@shopper.com'), 'Must not include contacts belonging to other practitioners');
        });

        it('Merchant Admin Contacts: GET /api/admin/contacts.csv exports all shop contacts', async () => {
          const token = createAdminSessionToken({ shop: testShop }, apiSecret);
          const req = new Request(`https://${testShop}/api/admin/contacts.csv`, {
            headers: { Authorization: `Bearer ${token}` }
          });

          const res = await handleAdminContactsCsvRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
          assert.ok(res.headers.get('Content-Disposition').includes(`attachment; filename="contacts-${testShop}.csv"`));

          const csvBody = await res.text();
          assert.ok(csvBody.includes('Shop,Practice Name,Owner GID,Email,First Name,Consent Text,Consent Version,Consented At,Created At'));
          assert.ok(csvBody.includes('existing@shopper.com'));
          assert.ok(csvBody.includes('other@shopper.com'));
        });

        it('Merchant Admin Contacts: POST /api/admin/contacts/delete deletes single contact with admin authority', async () => {
          const token = createAdminSessionToken({ shop: testShop }, apiSecret);
          const req = new Request(`https://${testShop}/api/admin/contacts/delete`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'contactId=contact_existing_1'
          });

          const res = await handleAdminDeleteContactRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 303);
          assert.ok(res.headers.get('Location').includes('tab=contacts'));
          assert.ok(!optinDb.state.contacts.some(c => c.id === 'contact_existing_1'));
        });

        it('Merchant Admin Contacts: POST /api/admin/contacts/delete-practice deletes all contacts for a practice', async () => {
          const token = createAdminSessionToken({ shop: testShop }, apiSecret);
          const req = new Request(`https://${testShop}/api/admin/contacts/delete-practice`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `ownerId=gid://shopify/Customer/${testCustomerId}`
          });

          const res = await handleAdminDeletePracticeContactsRequest(optinDb, req, { apiSecret });
          assert.equal(res.status, 303);
          assert.ok(res.headers.get('Location').includes('tab=contacts'));
          assert.ok(!optinDb.state.contacts.some(c => c.ownerId === `gid://shopify/Customer/${testCustomerId}`));
          assert.ok(optinDb.state.contacts.some(c => c.id === 'contact_other_practitioner'), 'Other practice contacts preserved');
        });

        it('Merchant Custom Request: POST /api/admin/feedback/custom-request enforces validation, rate limit (3/hr), and saves feedback', async () => {
          const token = createAdminSessionToken({ shop: testShop }, apiSecret);
          const customLimiter = createRateLimiter({ windowMs: 3600000, maxRequests: 3 });

          // 1. Missing message returns 400
          const emptyReq = new Request(`https://${testShop}/api/admin/feedback/custom-request`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({ message: '' })
          });
          const emptyRes = await handleAdminCustomFeatureRequest(optinDb, emptyReq, { apiSecret, rateLimiter: customLimiter });
          assert.equal(emptyRes.status, 400);

          // 2. Valid request saves feedback (JSON mode returns 200, form mode returns 303)
          const validJsonReq = (msg) => new Request(`https://${testShop}/api/admin/feedback/custom-request`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({ message: msg, replyEmail: 'merchant@example.com' })
          });

          // Custom limiter already consumed 1 on emptyReq, so next 2 are allowed (total 3)
          const res1 = await handleAdminCustomFeatureRequest(optinDb, validJsonReq('Request 1'), { apiSecret, rateLimiter: customLimiter });
          assert.equal(res1.status, 200);
          const res2 = await handleAdminCustomFeatureRequest(optinDb, validJsonReq('Request 2'), { apiSecret, rateLimiter: customLimiter });
          assert.equal(res2.status, 200);

          // Form mode redirect check with separate shop to verify cross-shop isolation
          const otherShop = 'other-merchant.myshopify.com';
          const otherToken = createAdminSessionToken({ shop: otherShop }, apiSecret);
          const formReq = new Request(`https://${otherShop}/api/admin/feedback/custom-request`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${otherToken}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'message=Need+CSV+export&replyEmail=merchant%40example.com'
          });
          const formRes = await handleAdminCustomFeatureRequest(optinDb, formReq, { apiSecret });
          assert.equal(formRes.status, 303);
          assert.equal(formRes.headers.get('Location'), '/admin?tab=settings&notice=request_sent');

          // URL-encoded with Accept: application/json returns 200 JSON with notice and no redirect
          const ajaxFormReq = new Request(`https://${otherShop}/api/admin/feedback/custom-request`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${otherToken}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json'
            },
            body: 'message=Need+JSON+response&replyEmail=merchant%40example.com'
          });
          const ajaxFormRes = await handleAdminCustomFeatureRequest(optinDb, ajaxFormReq, { apiSecret });
          assert.equal(ajaxFormRes.status, 200);
          assert.equal(ajaxFormRes.headers.get('Location'), null);
          const ajaxFormData = await ajaxFormRes.json();
          assert.equal(ajaxFormData.success, true);
          assert.equal(ajaxFormData.notice, 'request_sent');
          assert.ok(ajaxFormData.message.includes('Thanks'));

          // 3. 4th request in same hour on customLimiter is rate-limited (HTTP 429)
          const res4 = await handleAdminCustomFeatureRequest(optinDb, validJsonReq('Request 4'), { apiSecret, rateLimiter: customLimiter });
          assert.equal(res4.status, 429);
          const rateData = await res4.json();
          assert.ok(rateData.error.includes('Too many requests'));
          assert.ok(res4.headers.get('Retry-After'));
        });

        it('Merchant Feedback: POST /api/admin/feedback saves rating, message, and marketing opt-in', async () => {
          const token = createAdminSessionToken({ shop: testShop }, apiSecret);
          const feedbackDb = {
            feedback: [],
            profiles: [{ shop: testShop, marketingOptIn: false }],
            async query(sql, params) {
              if (sql.includes('INSERT INTO "MerchantFeedback"')) {
                const [shop, shopName, ownerName, replyEmail, planName, country, message, rating] = params;
                const row = { id: 'fb_' + Date.now(), shop, shopName, ownerName, replyEmail, planName, country, message, rating };
                feedbackDb.feedback.push(row);
                return { rowCount: 1, rows: [{ id: row.id }] };
              }
              if (sql.includes('UPDATE "ShopProfile"')) {
                const [shop, optIn] = params;
                const p = feedbackDb.profiles.find(x => x.shop === shop);
                if (p) p.marketingOptIn = optIn;
                return { rows: [p] };
              }
              if (sql.includes('SELECT * FROM "ShopProfile"')) {
                const [shop] = params;
                return { rows: feedbackDb.profiles.filter(x => x.shop === shop) };
              }
              return { rows: [] };
            }
          };

          // Valid submission with rating 5, message, and marketingOptIn: true
          const req = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              rating: 5,
              message: 'Great app experience!',
              marketingOptIn: true
            })
          });

          const res = await handleAdminFeedbackRequest(feedbackDb, req, { apiSecret });
          assert.equal(res.status, 200);
          const data = await res.json();
          assert.equal(data.success, true);
          assert.equal(data.notice, 'feedback_saved');
          assert.equal(feedbackDb.feedback.length, 1);
          assert.equal(feedbackDb.feedback[0].rating, 5);
          assert.equal(feedbackDb.feedback[0].message, 'Great app experience!');
          assert.equal(feedbackDb.profiles[0].marketingOptIn, true);

          // URL-encoded with Accept: application/json returns 200 JSON with notice and no redirect
          const urlencodedJsonReq = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json'
            },
            body: '_is_feedback_form=1&rating=4&message=Solid+workflow&marketingOptIn=1'
          });
          const urlencodedJsonRes = await handleAdminFeedbackRequest(feedbackDb, urlencodedJsonReq, { apiSecret });
          assert.equal(urlencodedJsonRes.status, 200);
          assert.equal(urlencodedJsonRes.headers.get('Location'), null);
          const urlencodedJsonData = await urlencodedJsonRes.json();
          assert.equal(urlencodedJsonData.success, true);
          assert.equal(urlencodedJsonData.notice, 'feedback_saved');
          assert.ok(urlencodedJsonData.message.includes('Thanks'));

          // URL-encoded without Accept: application/json returns 303 redirect to /admin?tab=settings&notice=feedback_saved
          const plainFormReq = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: '_is_feedback_form=1&rating=5&message=Great'
          });
          const plainFormRes = await handleAdminFeedbackRequest(feedbackDb, plainFormReq, { apiSecret });
          assert.equal(plainFormRes.status, 303);
          assert.equal(plainFormRes.headers.get('Location'), '/admin?tab=settings&notice=feedback_saved');

          // Invalid rating returns 400
          const badRatingReq = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rating: 10 })
          });
          const badRes = await handleAdminFeedbackRequest(feedbackDb, badRatingReq, { apiSecret });
          assert.equal(badRes.status, 400);

          // Dedicated contact-optin endpoint
          const optinReq = new Request(`https://${testShop}/api/admin/feedback/contact-optin`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ marketingOptIn: false })
          });
          const optinRes = await handleAdminMarketingOptInRequest(feedbackDb, optinReq, { apiSecret });
          assert.equal(optinRes.status, 200);
          assert.equal(feedbackDb.profiles[0].marketingOptIn, false);

          // Cross-shop denial: token for otherShop attempting testShop returns 403
          const otherShopToken = createAdminSessionToken({ shop: 'intruder.myshopify.com' }, apiSecret);
          const crossReq = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${otherShopToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rating: 5 })
          });
          const crossRes = await handleAdminFeedbackRequest(feedbackDb, crossReq, { apiSecret, expectedShop: testShop });
          assert.equal(crossRes.status, 403);

          // Direct API missing authorization header returns 401
          const unauthReq = new Request(`https://${testShop}/api/admin/feedback`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rating: 5 })
          });
          const unauthRes = await handleAdminFeedbackRequest(feedbackDb, unauthReq, { apiSecret, expectedShop: testShop });
          assert.equal(unauthRes.status, 401);
        });
      });
    });
  });
});
