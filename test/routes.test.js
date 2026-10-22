import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  handleAppProxyRequest,
  handleListProtocolsRequest,
  handleCreateProtocolRequest,
  handleGetProtocolRequest,
  handleUpdateProtocolRequest,
  handleDuplicateProtocolRequest,
  handleArchiveProtocolRequest,
  handleRestoreProtocolRequest,
  handleWebhookRequest,
  createRateLimiter,
  getHeader,
  handleErrorResponse
} from '../app/lib/protocols/routes.js';
import { calculateAppProxySignature } from '../app/lib/protocols/proxy.js';
import { ProtocolValidationError } from '../app/lib/protocols/validation.js';
import { ProtocolServiceError } from '../app/lib/protocols/service.js';
import { DENIAL_REASONS } from '../app/lib/protocols/permissions.js';

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
      sessions: (initialState.sessions || []).map(ss => ({ ...ss }))
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
        if (sql.includes('FROM "Protocol" p') && sql.includes('p.token = $2')) {
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

        // 3. SELECT p.* ... FROM "Protocol" p WHERE p.shop = $1 ... (listProtocols)
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
            return { ...proto, lines };
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
          const newLine = {
            id: `line_${state.lines.length + 1}`,
            protocolId: params[0],
            position: params[1],
            variantGid: params[2],
            quantity: params[3],
            usageNote: params[4],
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

        // 10. PractitionerProfile query (check practitioner logged-in banner)
        if (sql.includes('FROM "PractitionerProfile"')) {
          const shop = params[0];
          const gid = params[1];
          const prof = state.profiles.find(pr => pr.shop === shop && (pr.ownerGid === gid || pr.ownerGid === params[2]));
          return { rows: prof ? [prof] : [] };
        }

        // 11. Webhooks queries
        if (sql.includes('FROM "Setting"')) {
          return { rows: [{ identityMode: 'tag' }] };
        }
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

    beforeEach(() => {
      db = createMockDb({
        protocols: [testProtocol],
        lines: [testLine],
        profiles: [testProfile]
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
          headers: { 'cf-connecting-ip': '198.51.100.99' }
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

      assert.equal(data.name, 'Starter Vitamin Routine (Copy)');
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
});
