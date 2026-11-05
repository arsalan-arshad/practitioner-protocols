import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  performTokenExchange,
  ensureOfflineSession,
  _resetTokenExchangeCaches,
  GRANT_TYPE_TOKEN_EXCHANGE,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_OFFLINE_ACCESS,
  NEGATIVE_CACHE_TTL_MS
} from '../app/lib/protocols/exchange.js';
import { decryptAccessToken } from '../app/lib/protocols/crypto.js';
import { renderAdminHtml, createAdminSessionToken } from '../app/lib/protocols/admin.js';
import { handleAdminDashboardRequest } from '../app/lib/protocols/routes.js';
import { handleAppUninstalled } from '../app/lib/protocols/webhooks.js';
import { getCanonicalConsentText, saveShopperContact } from '../app/lib/protocols/contacts.js';
import { createRequestListener } from '../server.js';

describe('Shopify Token Exchange & Managed Install Hardening (app/lib/protocols/exchange.js)', () => {
  const testShop = 'wellness-store.myshopify.com';
  const apiKey = 'test_api_client_key_123';
  const apiSecret = 'test_api_client_secret_xyz';
  const validIdToken = createAdminSessionToken({
    userId: 'gid://shopify/User/admin_1',
    shop: testShop,
    apiKey,
    expiresInSec: 3600
  }, apiSecret);

  beforeEach(() => {
    _resetTokenExchangeCaches();
    process.env.SESSION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  });

  afterEach(() => {
    _resetTokenExchangeCaches();
  });

  /**
   * High-fidelity in-memory SQL mock DB tracking state and queries.
   */
  function createTestDb(initial = {}) {
    const state = {
      sessions: (initial.sessions || []).map(s => ({ ...s })),
      shopProfiles: (initial.shopProfiles || []).map(p => ({ ...p })),
      protocols: (initial.protocols || []).map(pr => ({ ...pr })),
      shopperContacts: [],
      queries: []
    };

    return {
      state,
      async query(sql, params = []) {
        state.queries.push({ sql, params });

        // DELETE Session (e.g. app/uninstalled)
        if (sql.includes('DELETE FROM "Session"')) {
          const shop = params[0];
          const before = state.sessions.length;
          state.sessions = state.sessions.filter(s => s.shop !== shop);
          return { rowCount: before - state.sessions.length, rows: [] };
        }

        // SELECT Session
        if (sql.includes('SELECT') && sql.includes('FROM "Session"')) {
          const shop = params[0];
          const session = state.sessions.find(s => s.shop === shop && (params.length === 1 || s.isOnline === false));
          return { rows: session ? [{ ...session }] : [] };
        }

        // INSERT / UPSERT Session
        if (sql.includes('INSERT INTO "Session"')) {
          const [id, shop, stateVal, isOnline, scope, accessToken] = [
            params[0], params[1], params[2], false, params[3], params[4]
          ];
          const idx = state.sessions.findIndex(s => s.id === id);
          const row = { id, shop, state: stateVal, isOnline, scope, accessToken };
          if (idx >= 0) {
            state.sessions[idx] = row;
          } else {
            state.sessions.push(row);
          }
          return { rowCount: 1, rows: [row] };
        }

        // SELECT ShopProfile
        if (sql.includes('FROM "ShopProfile"') && sql.includes('"shop" = $1')) {
          const shop = params[0];
          const profile = state.shopProfiles.find(p => p.shop === shop);
          return { rows: profile ? [{ ...profile }] : [] };
        }

        // INSERT / UPSERT ShopProfile
        if (sql.includes('INSERT INTO "ShopProfile"')) {
          const [shop, shopName, ownerName, email, planName, country] = params;
          const idx = state.shopProfiles.findIndex(p => p.shop === shop);
          const row = {
            id: `prof_${shop}`,
            shop,
            shopName,
            ownerName,
            email,
            planName,
            country,
            installedAt: new Date().toISOString(),
            uninstalledAt: null,
            marketingOptIn: false,
            updatedAt: new Date().toISOString()
          };
          if (idx >= 0) {
            state.shopProfiles[idx] = { ...state.shopProfiles[idx], ...row };
          } else {
            state.shopProfiles.push(row);
          }
          return { rowCount: 1, rows: [row] };
        }

        // UPDATE ShopProfile uninstalledAt (app/uninstalled)
        if (sql.includes('UPDATE "ShopProfile"') && sql.includes('"uninstalledAt" = NOW()')) {
          const shop = params[0];
          const prof = state.shopProfiles.find(p => p.shop === shop);
          if (prof) {
            prof.uninstalledAt = new Date().toISOString();
            prof.updatedAt = new Date().toISOString();
          }
          return { rowCount: prof ? 1 : 0, rows: prof ? [prof] : [] };
        }

        // SELECT Protocol
        if (sql.includes('FROM "Protocol"') && (sql.includes('token') || sql.includes('"token"'))) {
          const token = params.find(p => typeof p === 'string' && p.startsWith('tok_'));
          const proto = state.protocols.find(p => p.token === token);
          return { rows: proto ? [{ ...proto }] : [] };
        }

        // INSERT ShopperContact
        if (sql.includes('INSERT INTO "ShopperContact"')) {
          const [shop, ownerId, email, firstName, consentText, consentVersion, consentedAt] = params;
          state.shopperContacts.push({ shop, ownerId, email, firstName, consentText, consentVersion, consentedAt });
          return { rowCount: 1, rows: [{ id: 'sc_1' }] };
        }

        return { rows: [] };
      }
    };
  }

  describe('1. Raw Token Exchange Request Specifications', () => {
    it('sends POST request to https://{shop}/admin/oauth/access_token with exact RFC 8693 parameters matching docs', async () => {
      let capturedUrl = '';
      let capturedOptions = null;

      const fakeFetch = async (url, options) => {
        capturedUrl = String(url);
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'mock_shpat_offline_token_test_123',
              scope: 'read_orders'
            };
          }
        };
      };

      const result = await performTokenExchange({
        shop: testShop,
        idToken: validIdToken,
        apiKey,
        apiSecret,
        fetchFn: fakeFetch
      });

      assert.ok(result);
      assert.equal(result.accessToken, 'mock_shpat_offline_token_test_123');
      assert.equal(result.scope, 'read_orders');

      // Verify endpoint and method
      assert.equal(capturedUrl, `https://${testShop}/admin/oauth/access_token`);
      assert.equal(capturedOptions.method, 'POST');
      assert.equal(capturedOptions.headers['Content-Type'], 'application/json');
      assert.equal(capturedOptions.headers['Accept'], 'application/json');

      // Verify exact JSON body parameters matching Shopify token exchange docs
      const bodyParams = JSON.parse(capturedOptions.body);
      assert.equal(bodyParams.client_id, apiKey);
      assert.equal(bodyParams.client_secret, apiSecret);
      assert.equal(bodyParams.grant_type, GRANT_TYPE_TOKEN_EXCHANGE);
      assert.equal(bodyParams.subject_token, validIdToken);
      assert.equal(bodyParams.subject_token_type, TOKEN_TYPE_ID_TOKEN);
      assert.equal(bodyParams.requested_token_type, TOKEN_TYPE_OFFLINE_ACCESS);
      assert.equal(bodyParams.expiring, 0);
    });
  });

  describe('2. Session Persistence, Encryption & Profile Sync', () => {
    it('exchange success writes an encrypted Session row and synchronizes ShopProfile', async () => {
      const db = createTestDb();
      let exchangeCalls = 0;
      let graphqlCalls = 0;

      const fakeFetch = async (url, options) => {
        const urlStr = String(url);
        if (urlStr.includes('/admin/oauth/access_token')) {
          exchangeCalls++;
          return {
            ok: true,
            status: 200,
            async json() {
              return { access_token: 'mock_offline_raw_token_xyz', scope: 'read_orders' };
            }
          };
        }
        if (urlStr.includes('/admin/api/')) {
          graphqlCalls++;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                data: {
                  shop: {
                    name: 'Elite Natural Health',
                    email: 'owner@elitenaturalhealth.com',
                    shopOwnerName: 'Dr. Jane Smith',
                    plan: { publicDisplayName: 'Shopify Plus' },
                    shopAddress: { countryCodeV2: 'CA' }
                  }
                }
              };
            }
          };
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      };

      const res = await ensureOfflineSession(db, {
        shop: testShop,
        idToken: validIdToken,
        apiKey,
        apiSecret,
        fetchFn: fakeFetch
      });

      assert.ok(res);
      assert.equal(res.success, true);
      assert.equal(exchangeCalls, 1);
      assert.equal(graphqlCalls, 1);

      // Verify Session row
      const savedSession = db.state.sessions.find(s => s.shop === testShop);
      assert.ok(savedSession, 'Session row must be written');
      assert.equal(savedSession.id, `offline_${testShop}`);
      assert.equal(savedSession.isOnline, false);
      assert.equal(savedSession.state, 'authenticated');
      assert.equal(savedSession.scope, 'read_orders');

      // Verify token encryption format enc:v1:<iv>:<tag>:<ciphertext>
      assert.match(savedSession.accessToken, /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      const decrypted = decryptAccessToken(savedSession.accessToken);
      assert.equal(decrypted, 'mock_offline_raw_token_xyz');

      // Verify ShopProfile was synced
      const savedProfile = db.state.shopProfiles.find(p => p.shop === testShop);
      assert.ok(savedProfile, 'ShopProfile row must be written');
      assert.equal(savedProfile.shopName, 'Elite Natural Health');
      assert.equal(savedProfile.email, 'owner@elitenaturalhealth.com');
      assert.equal(savedProfile.ownerName, 'Dr. Jane Smith');
      assert.equal(savedProfile.planName, 'Shopify Plus');
      assert.equal(savedProfile.country, 'CA');
    });

    it('second request does not exchange again when Session already exists', async () => {
      const db = createTestDb({
        sessions: [
          {
            id: `offline_${testShop}`,
            shop: testShop,
            isOnline: false,
            scope: 'read_orders',
            accessToken: 'enc:mock_existing_token'
          }
        ]
      });

      let fetchCalled = false;
      const fakeFetch = async () => {
        fetchCalled = true;
        throw new Error('Should not call fetch when session exists');
      };

      const res = await ensureOfflineSession(db, {
        shop: testShop,
        idToken: validIdToken,
        apiKey,
        apiSecret,
        fetchFn: fakeFetch
      });

      assert.ok(res);
      assert.equal(res.existing, true);
      assert.equal(fetchCalled, false, 'Must not call fetch when offline session is present');
    });
  });

  describe('3. Concurrency Lock & Deduplication', () => {
    it('two concurrent requests trigger exactly one token exchange request', async () => {
      const db = createTestDb();
      let exchangeCalls = 0;

      const fakeFetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/admin/oauth/access_token')) {
          exchangeCalls++;
          // Simulate slight network latency
          await new Promise(r => setTimeout(r, 25));
          return {
            ok: true,
            status: 200,
            async json() {
              return { access_token: 'mock_concurrent_token_456', scope: 'read_orders' };
            }
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: { shop: { name: 'Concurrent Shop', email: 'c@example.com' } } };
          }
        };
      };

      const [res1, res2] = await Promise.all([
        ensureOfflineSession(db, { shop: testShop, idToken: validIdToken, apiKey, apiSecret, fetchFn: fakeFetch }),
        ensureOfflineSession(db, { shop: testShop, idToken: validIdToken, apiKey, apiSecret, fetchFn: fakeFetch })
      ]);

      assert.ok(res1);
      assert.ok(res2);
      assert.equal(res1.success, true);
      assert.equal(res2.success, true);
      assert.equal(exchangeCalls, 1, 'In-flight lock must deduplicate concurrent exchange requests to exactly 1');
    });
  });

  describe('4. Error Handling, Privacy Logging & Negative Cache', () => {
    it('logs non-PII status line on 400 response without leaking tokens or response body, and caches failure', async () => {
      const db = createTestDb();
      const origWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(' '));

      let fetchCount = 0;
      const fakeFetch = async () => {
        fetchCount++;
        return {
          ok: false,
          status: 400,
          async json() {
            return { error: 'invalid_subject_token', error_description: 'Token expired' };
          }
        };
      };

      try {
        const res = await ensureOfflineSession(db, {
          shop: testShop,
          idToken: validIdToken,
          apiKey,
          apiSecret,
          fetchFn: fakeFetch
        });

        assert.equal(res, null);
        assert.equal(fetchCount, 1);

        // Verify log: [TokenExchange] failed shop=<shop> status=400
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0], `[TokenExchange] failed shop=${testShop} status=400`);
        assert.ok(!warnings[0].includes(validIdToken));
        assert.ok(!warnings[0].includes(apiKey));
        assert.ok(!warnings[0].includes(apiSecret));
        assert.ok(!warnings[0].includes('invalid_subject_token'));

        // Verify Negative Cache (60 seconds): immediate second attempt skips fetch
        const res2 = await ensureOfflineSession(db, {
          shop: testShop,
          idToken: validIdToken,
          apiKey,
          apiSecret,
          fetchFn: fakeFetch
        });
        assert.equal(res2, null);
        assert.equal(fetchCount, 1, 'Negative cache must prevent hammering Shopify during the 60s cooldown');
      } finally {
        console.warn = origWarn;
      }
    });

    it('400 token exchange failure still allows handleAdminDashboardRequest to render page normally', async () => {
      const db = createTestDb();
      const fakeFetch = async () => ({
        ok: false,
        status: 400,
        async json() { return { error: 'invalid_subject_token' }; }
      });

      const req = new Request(`https://${testShop}/admin?tab=settings`, {
        headers: { Authorization: `Bearer ${validIdToken}` }
      });

      const res = await handleAdminDashboardRequest(db, req, {
        apiKey,
        apiSecret,
        expectedShop: testShop,
        fetchFn: fakeFetch
      });

      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Polaris-Page'));
      assert.ok(html.includes('Contact &amp; feedback'));
      // Verify inline scripts parse cleanly
      const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
      for (const match of scriptMatches) {
        if (!match[0].includes('src=')) {
          assert.doesNotThrow(() => new vm.Script(match[1]));
        }
      }
    });
  });

  describe('5. App Uninstallation Behavior', () => {
    it('app/uninstalled deletes Session row but preserves ShopProfile with uninstalledAt timestamp', async () => {
      const db = createTestDb({
        sessions: [
          { id: `offline_${testShop}`, shop: testShop, isOnline: false, accessToken: 'token' }
        ],
        shopProfiles: [
          { shop: testShop, shopName: 'Herbal Wellness', email: 'info@herbal.com', uninstalledAt: null }
        ]
      });

      const uninstalledResult = await handleAppUninstalled(db, { domain: testShop });
      assert.equal(uninstalledResult.success, true);
      assert.equal(uninstalledResult.sessionsRevoked, 1);

      // Session row deleted
      assert.equal(db.state.sessions.length, 0);

      // ShopProfile preserved with uninstalledAt set
      const profile = db.state.shopProfiles.find(p => p.shop === testShop);
      assert.ok(profile);
      assert.ok(profile.uninstalledAt);
    });
  });

  describe('6. UI Hardening: Settings Opt-In Card & Custom Requests', () => {
    it('Settings opt-in card shows disabled checkbox with reload text when ShopProfile.email is missing, and never shows "this email"', () => {
      const htmlWithoutEmail = renderAdminHtml({
        shop: testShop,
        apiKey,
        profiles: [],
        starters: [],
        report: { summary: { totalOrders: 0, totalUnits: 0, totalRevenueFormatted: '$0.00' }, rows: [] },
        settings: { identityMode: 'tag' },
        shopProfile: null, // missing email
        activeTab: 'settings'
      });

      assert.ok(!htmlWithoutEmail.includes('this email'));
      assert.ok(htmlWithoutEmail.includes('Your store contact email is still being loaded. Reload this page.'));
      assert.ok(htmlWithoutEmail.includes('disabled'));
    });

    it('Settings opt-in card displays merchant email when ShopProfile.email is present', () => {
      const htmlWithEmail = renderAdminHtml({
        shop: testShop,
        apiKey,
        profiles: [],
        starters: [],
        report: { summary: { totalOrders: 0, totalUnits: 0, totalRevenueFormatted: '$0.00' }, rows: [] },
        settings: { identityMode: 'tag' },
        shopProfile: { email: 'drjane@integrative.clinic', marketingOptIn: false },
        activeTab: 'settings'
      });

      assert.ok(!htmlWithEmail.includes('this email'));
      assert.ok(htmlWithEmail.includes('drjane@integrative.clinic'));
      assert.ok(!htmlWithEmail.includes('Your store contact email is still being loaded.'));
    });

    it('custom request card prefills replyEmail from ShopProfile.email when present, and leaves empty when absent', () => {
      const htmlPrefilled = renderAdminHtml({
        shop: testShop,
        apiKey,
        profiles: [],
        starters: [],
        report: { summary: { totalOrders: 0, totalUnits: 0, totalRevenueFormatted: '$0.00' }, rows: [] },
        settings: { identityMode: 'tag' },
        shopProfile: { email: 'prefilled@shop.com' },
        activeTab: 'settings'
      });
      assert.ok(htmlPrefilled.includes('value="prefilled@shop.com"'));

      const htmlEmpty = renderAdminHtml({
        shop: testShop,
        apiKey,
        profiles: [],
        starters: [],
        report: { summary: { totalOrders: 0, totalUnits: 0, totalRevenueFormatted: '$0.00' }, rows: [] },
        settings: { identityMode: 'tag' },
        shopProfile: null,
        activeTab: 'settings'
      });
      assert.ok(htmlEmpty.includes('name="replyEmail" maxlength="254" value=""'));
    });
  });

  describe('7. Shopper Consent Text Resolution', () => {
    it('uses ShopProfile.shopName in canonical consent text when available, falling back to shop domain', async () => {
      const dbWithShopName = createTestDb({
        shopProfiles: [
          { shop: testShop, shopName: 'Summit Holistic Health' }
        ],
        protocols: [
          { id: 'proto_1', shop: testShop, token: 'tok_summit', ownerId: 'gid://shopify/Customer/1', practiceName: 'Summit Care', status: 'active' }
        ]
      });

      await saveShopperContact(dbWithShopName, {
        shop: testShop,
        token: 'tok_summit',
        email: 'patient@example.com',
        consent: true
      });

      const contact = dbWithShopName.state.shopperContacts[0];
      assert.ok(contact);
      assert.equal(
        contact.consentText,
        'I agree to receive emails from Summit Care and Summit Holistic Health with product recommendations and offers. I can unsubscribe at any time.'
      );

      // Fallback when ShopProfile is absent
      const dbWithoutShopName = createTestDb({
        protocols: [
          { id: 'proto_2', shop: testShop, token: 'tok_fallback', ownerId: 'gid://shopify/Customer/2', practiceName: 'Fallback Care', status: 'active' }
        ]
      });

      await saveShopperContact(dbWithoutShopName, {
        shop: testShop,
        token: 'tok_fallback',
        email: 'patient2@example.com',
        consent: true
      });

      const contact2 = dbWithoutShopName.state.shopperContacts[0];
      assert.ok(contact2);
      assert.equal(
        contact2.consentText,
        `I agree to receive emails from Fallback Care and ${testShop} with product recommendations and offers. I can unsubscribe at any time.`
      );
    });
  });

  describe('8. Friendly Root Page (GET /)', () => {
    it('returns status 200, security headers, noindex, friendly copy with link to /privacy, and no login or domain input field', async () => {
      const listener = createRequestListener({
        databaseUrl: 'postgresql://fake:fake@localhost:5432/fake',
        shopifyApiSecret: apiSecret,
        shopifyApiKey: apiKey
      });

      let responseStatus = 0;
      const responseHeaders = {};
      let responseBody = '';

      const req = {
        method: 'GET',
        url: '/',
        headers: { host: 'app.example.com' },
        [Symbol.asyncIterator]: async function* () {}
      };

      const res = {
        setHeader(k, v) { responseHeaders[k.toLowerCase()] = v; },
        writeHead(status, headers = {}) {
          responseStatus = status;
          for (const [k, v] of Object.entries(headers)) {
            responseHeaders[k.toLowerCase()] = v;
          }
        },
        end(data) { responseBody = data || ''; }
      };

      await listener(req, res);

      assert.equal(responseStatus, 200);
      assert.ok(responseHeaders['content-type'].includes('text/html'));
      assert.equal(responseHeaders['x-robots-tag'], 'noindex, nofollow');
      assert.equal(responseHeaders['x-content-type-options'], 'nosniff');
      assert.ok(responseBody.includes('Practitioner Protocols runs inside your Shopify admin. Open it from your Shopify admin\'s Apps list.'));
      assert.ok(responseBody.includes('href="/privacy"'));

      // Ensure no shop-domain input field and no login form (Shopify app review compliance)
      assert.ok(!responseBody.includes('<input'));
      assert.ok(!responseBody.includes('<form'));
    });
  });
});
