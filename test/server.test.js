import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateServerConfig,
  createRequestListener,
  startServer,
  SHOPIFY_DOMAIN_REGEX,
  DEMO_PROFILES,
  DEMO_SETTINGS,
  DEMO_REPORT,
  DEMO_PROTOCOL,
  signOAuthState,
  verifyOAuthState,
  renderPrivacyHtml,
  parseCookies,
  buildAdminCsp,
} from '../server.js';
import { runMigrations, getDatabaseSslConfig, MIGRATION_FILES } from '../scripts/migrate.js';
import { calculateOAuthSignature } from '../app/lib/protocols/proxy.js';
import { createAdminSessionToken } from '../app/lib/protocols/admin.js';

// Minimal mock request and response helpers for testing HTTP request listeners in-memory
function createMockReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = {
    method,
    url,
    headers: { host: 'localhost:3000', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, 'utf-8');
    },
  };
  return req;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, val) {
      res.headers[name] = val;
      res.headers[name.toLowerCase()] = val;
    },
    getHeader(name) {
      return res.headers[name] || res.headers[name.toLowerCase()];
    },
    writeHead(status, headers = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) {
        res.headers[k] = v;
        res.headers[k.toLowerCase()] = v;
      }
      return res;
    },
    end(data) {
      if (data) res.body += data;
      return res;
    },
  };
  return res;
}

describe('Server & Configuration Hardening (server.js, shopify.app.toml, README.md)', () => {
  describe('validateServerConfig (Production startup guard)', () => {
    it('refuses to start when DATABASE_URL is set because admin session auth is missing', () => {
      assert.throws(
        () => validateServerConfig({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' }),
        /Production mode disabled: DATABASE_URL is set, but Shopify Admin session-token authentication is not implemented yet/
      );
    });

    it('allows startup when DATABASE_URL is unset (demo mode)', () => {
      const config = validateServerConfig({});
      assert.equal(config.isDemoMode, true);
    });

    it('allows startup when DATABASE_URL is whitespace-only', () => {
      const config = validateServerConfig({ DATABASE_URL: '   ' });
      assert.equal(config.isDemoMode, true);
    });

    it('allows production startup when both DATABASE_URL and SHOPIFY_API_SECRET are provided', () => {
      const config = validateServerConfig({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        SHOPIFY_API_SECRET: 'shpss_secret123',
      });
      assert.equal(config.isDemoMode, false);
      assert.equal(config.databaseUrl, 'postgres://user:pass@localhost:5432/db');
    });
  });

  describe('Admin Routes Persistence Guard (DATABASE_URL configured)', () => {
    const listener = createRequestListener({
      databaseUrl: 'postgres://production.host:5432/practitioner_db',
    });

    it('returns 401 with retry header on POST /api/admin/practitioners/status without session token', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/practitioners/status',
        body: 'ownerGid=gid://shopify/Customer/112233&action=revoke',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['X-Shopify-Retry-Invalid-Session-Request'], '1');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Unauthorized');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 401 with retry header on POST /api/admin/settings without session token', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/settings',
        body: 'mode=company&disclaimer=test',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['X-Shopify-Retry-Invalid-Session-Request'], '1');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Unauthorized');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 401 with retry header on POST /api/admin/emergency/disable-all without session token', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/emergency/disable-all',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['X-Shopify-Retry-Invalid-Session-Request'], '1');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Unauthorized');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 401 with retry header on GET /api/admin/attribution.csv without session token', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/admin/attribution.csv',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['X-Shopify-Retry-Invalid-Session-Request'], '1');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Unauthorized');
      assert.ok(data.message.includes('session-token verification'));
    });
  });

  describe('Demo Mode In-Memory Mutations (No DATABASE_URL)', () => {
    const demoListener = createRequestListener({ databaseUrl: '' });

    it('POST /api/admin/practitioners/status updates in-memory profiles and redirects 302', async () => {
      const targetGid = 'gid://shopify/Customer/445566';
      const initialProf = DEMO_PROFILES.find((p) => p.ownerGid === targetGid);
      assert.equal(initialProf?.isApproved, false);

      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/practitioners/status',
        body: `ownerGid=${encodeURIComponent(targetGid)}&action=approve`,
      });
      const res = createMockRes();
      await demoListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?tab=practitioners');
      assert.equal(initialProf?.isApproved, true);
    });

    it('POST /api/admin/settings updates in-memory demo settings and redirects 302', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/settings',
        body: 'mode=company&disclaimer=Updated+Demo+Disclaimer&handoutText=Updated+Handout',
      });
      const res = createMockRes();
      await demoListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?tab=settings');
      assert.equal(DEMO_SETTINGS.mode, 'company');
      assert.equal(DEMO_SETTINGS.disclaimer, 'Updated Demo Disclaimer');
    });

    it('POST /api/admin/emergency/disable-all updates in-memory demo status and redirects 302', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/emergency/disable-all',
      });
      const res = createMockRes();
      await demoListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?tab=settings');
      assert.equal(DEMO_PROTOCOL.status, 'disabled');
    });

    it('GET /api/admin/attribution.csv returns demo CSV report in demo mode', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/admin/attribution.csv',
      });
      const res = createMockRes();
      await demoListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['Content-Type'].includes('text/csv'));
      assert.ok(res.body.includes('Month,Practice Name,Owner GID,Protocol ID,Protocol Name,Is Starter,Orders,Units,Revenue,Currency'));
      assert.ok(res.body.includes('Daily Essentials Protocol'));
    });
  });

  describe('Shopify OAuth 2.0 & Install Initiation (server.js)', () => {
    const apiSecret = 'test_shopify_secret_oauth_99';
    const apiKey = 'test_shopify_client_id_11';
    const oauthListener = createRequestListener({
      shopifyApiSecret: apiSecret,
      shopifyApiKey: apiKey,
    });

    it('GET /api/auth redirects valid shop to Shopify authorize URL with read_orders scope', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth?shop=my-store.myshopify.com',
        headers: { host: 'app.example.com', 'x-forwarded-proto': 'https' },
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.Location.startsWith('https://my-store.myshopify.com/admin/oauth/authorize'));
      assert.ok(res.headers.Location.includes(`client_id=${apiKey}`));
      assert.ok(res.headers.Location.includes('scope=read_orders'));
      assert.ok(res.headers.Location.includes('redirect_uri=https%3A%2F%2Fapp.example.com%2Fapi%2Fauth%2Fcallback'));
      assert.ok(res.headers.Location.includes('state='));
    });

    it('GET /api/auth rejects missing shop parameter with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Invalid or missing shop parameter');
    });

    it('GET /api/auth rejects invalid myshopify shop format with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth?shop=malicious.domain.com',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Invalid or missing shop parameter');
    });

    it('GET /api/auth initiates OAuth with signed state cookie', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth?shop=my-store.myshopify.com',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.Location.includes('/admin/oauth/authorize'));
      assert.ok(res.headers.Location.includes('state='));
      const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'];
      assert.ok(setCookie, 'Set-Cookie header must be present');
      assert.ok(setCookie.includes('shopify_oauth_state='));
      assert.ok(setCookie.includes('Path=/api/auth'));
      assert.ok(setCookie.includes('Max-Age=600'));
      assert.ok(setCookie.includes('HttpOnly'));
      assert.ok(setCookie.includes('Secure'));
      assert.ok(setCookie.includes('SameSite=Lax'));
    });

    it('GET /api/auth/callback rejects request with invalid HMAC signature with HTTP 400', async () => {
      const state = 'nonce1';
      const signedCookie = signOAuthState(state, apiSecret);
      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123&state=${state}&hmac=deadbeef`,
        headers: { cookie: `shopify_oauth_state=${signedCookie}` },
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Invalid OAuth HMAC signature');
    });

    it('GET /api/auth/callback rejects request with missing code parameter with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&state=nonce1',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Missing code parameter');
    });

    it('GET /api/auth/callback rejects request with missing state parameter with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Missing state parameter');
    });

    it('GET /api/auth/callback rejects request with missing state cookie with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123&state=nonce1',
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Missing OAuth state cookie');
    });

    it('GET /api/auth/callback rejects request with mismatched state cookie with HTTP 400', async () => {
      const signedCookie = signOAuthState('different_state', apiSecret);
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123&state=expected_state',
        headers: { cookie: `shopify_oauth_state=${signedCookie}` },
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Invalid OAuth state');
    });

    it('GET /api/auth/callback rejects request with expired or tampered state cookie with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123&state=tampered_state',
        headers: { cookie: 'shopify_oauth_state=tampered_state.123456.invalidhmac' },
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Invalid OAuth state');
    });

    it('GET /api/auth/callback in demo mode redirects 302 to /admin on valid HMAC and clears cookie', async () => {
      const state = 'nonce_abc_123';
      const signedCookie = signOAuthState(state, apiSecret);
      const params = {
        code: 'valid_auth_code_999',
        shop: 'my-store.myshopify.com',
        state,
        timestamp: '1729500000',
      };
      const hmac = calculateOAuthSignature(params, apiSecret);
      const queryString = new URLSearchParams({ ...params, hmac }).toString();

      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?${queryString}`,
        headers: { cookie: `shopify_oauth_state=${signedCookie}` },
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?shop=my-store.myshopify.com');
      const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'];
      assert.ok(setCookie, 'Must clear state cookie with Set-Cookie header');
      assert.ok(setCookie.includes('Max-Age=0'));
      assert.ok(setCookie.includes('shopify_oauth_state=;'));
    });

    it('GET /api/auth/callback in production mode exchanges code, writes session with state authenticated, and redirects 302', async () => {
      const queriedRows = [];
      const mockPool = {
        async query(sql, params) {
          queriedRows.push({ sql, params });
          return { rows: [] };
        },
      };

      const prodListener = createRequestListener({
        databaseUrl: 'postgres://production.host:5432/db',
        shopifyApiSecret: apiSecret,
        shopifyApiKey: apiKey,
        pool: mockPool,
        tokenExchanger: async ({ shop, code }) => {
          assert.equal(shop, 'my-store.myshopify.com');
          assert.equal(code, 'valid_auth_code_prod');
          return { accessToken: 'shpca_token_xyz_999', scope: 'read_orders' };
        },
      });

      const state = 'nonce_prod_state';
      const signedCookie = signOAuthState(state, apiSecret);
      const params = {
        code: 'valid_auth_code_prod',
        shop: 'my-store.myshopify.com',
        state,
        timestamp: '1729500000',
      };
      const hmac = calculateOAuthSignature(params, apiSecret);
      const queryString = new URLSearchParams({ ...params, hmac }).toString();

      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?${queryString}`,
        headers: { cookie: `shopify_oauth_state=${signedCookie}` },
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?shop=my-store.myshopify.com');
      assert.equal(queriedRows.length, 1);
      assert.ok(queriedRows[0].sql.includes('INSERT INTO "Session"'));
      assert.equal(queriedRows[0].params[0], 'offline_my-store.myshopify.com');
      assert.equal(queriedRows[0].params[1], 'my-store.myshopify.com');
      // Do not store the state in Session.state; store "authenticated"
      assert.equal(queriedRows[0].params[2], 'authenticated');
      assert.equal(queriedRows[0].params[4], 'shpca_token_xyz_999');
      assert.ok(queriedRows[0].params[5] instanceof Date, 'Must persist expires timestamp as Date');

      const setCookie = res.headers['Set-Cookie'] || res.headers['set-cookie'];
      assert.ok(setCookie.includes('Max-Age=0'));
    });

    it('GET /api/auth/callback sends expiring: 1 when requesting access token from Shopify', async () => {
      let tokenRequestUrl = '';
      let tokenRequestBody = null;

      const mockFetch = async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/admin/oauth/access_token')) {
          tokenRequestUrl = urlStr;
          if (init?.body) {
            tokenRequestBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({
            access_token: 'shpca_expiring_token_abc',
            scope: 'read_orders',
            expires_in: 3600,
            refresh_token: 'shprt_test_refresh_token',
            refresh_token_expires_in: 7776000
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          data: {
            shop: {
              name: 'Expiring Store',
              email: 'store@example.com',
              shopOwnerName: 'Owner',
              plan: { publicDisplayName: 'Basic' },
              shopAddress: { countryCodeV2: 'US' }
            }
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const queriedRows = [];
      const mockPool = {
        async query(sql, params) {
          queriedRows.push({ sql, params });
          return { rows: [] };
        },
      };

      const prodListener = createRequestListener({
        databaseUrl: 'postgres://production.host:5432/db',
        shopifyApiSecret: apiSecret,
        shopifyApiKey: apiKey,
        pool: mockPool,
        fetchFn: mockFetch,
      });

      const state = 'nonce_expiring_state';
      const signedCookie = signOAuthState(state, apiSecret);
      const params = {
        code: 'valid_auth_code_expiring',
        shop: 'expiring-store.myshopify.com',
        state,
        timestamp: '1729500000',
      };
      const hmac = calculateOAuthSignature(params, apiSecret);
      const queryString = new URLSearchParams({ ...params, hmac }).toString();

      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?${queryString}`,
        headers: { cookie: `shopify_oauth_state=${signedCookie}` },
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.ok(tokenRequestUrl.includes('/admin/oauth/access_token'));
      assert.equal(tokenRequestBody.client_id, apiKey);
      assert.equal(tokenRequestBody.client_secret, apiSecret);
      assert.equal(tokenRequestBody.code, 'valid_auth_code_expiring');
      assert.equal(tokenRequestBody.expiring, 1, 'Must send expiring: 1 per Shopify migration requirement');

      assert.ok(queriedRows.length >= 1);
      const sessionRow = queriedRows.find(q => q.sql.includes('INSERT INTO "Session"'));
      assert.ok(sessionRow, 'Must insert into Session table');
      assert.equal(sessionRow.params[0], 'offline_expiring-store.myshopify.com');
      assert.ok(sessionRow.params[5] instanceof Date, 'Must persist computed expires Date in Session');
    });
  });

  describe('Shopify App Store Security Headers (server.js)', () => {
    const listener = createRequestListener();

    it('returns Content-Security-Policy with frame-ancestors for the current shop and required directives', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/admin?shop=verified-store.myshopify.com',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      const csp = res.headers['Content-Security-Policy'] || res.headers['content-security-policy'];
      assert.ok(csp.startsWith('frame-ancestors https://verified-store.myshopify.com https://admin.shopify.com;'));
      assert.ok(csp.includes("default-src 'self'"));
      assert.ok(csp.includes('https://cdn.shopify.com'));
      assert.ok(csp.includes('https://cdn.shopifycdn.net'));
      assert.ok(csp.includes('https://admin.shopify.com'));
      assert.ok(csp.includes('https://verified-store.myshopify.com'));
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
    });

    it('returns default wildcard myshopify frame-ancestors when shop is omitted or demo', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/admin',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      const csp = res.headers['Content-Security-Policy'] || res.headers['content-security-policy'];
      assert.ok(csp.startsWith('frame-ancestors https://*.myshopify.com https://admin.shopify.com;'));
      assert.ok(csp.includes("default-src 'self'"));
    });

    it('returns Strict-Transport-Security on all responses (not only HTML)', async () => {
      const endpoints = [
        { method: 'GET', url: '/health' },
        { method: 'GET', url: '/admin?shop=test.myshopify.com' },
        { method: 'GET', url: '/privacy' },
        { method: 'GET', url: '/api/auth?shop=test.myshopify.com' },
      ];

      for (const ep of endpoints) {
        const req = createMockReq(ep);
        const res = createMockRes();
        await listener(req, res);
        const hsts = res.headers['Strict-Transport-Security'] || res.headers['strict-transport-security'];
        assert.equal(
          hsts,
          'max-age=31536000; includeSubDomains',
          `Endpoint ${ep.url} must set Strict-Transport-Security header`
        );
      }
    });
  });

  describe('Privacy Policy Endpoint (GET /privacy)', () => {
    it('serves public HTML privacy policy with status 200 and strict security headers', async () => {
      const listener = createRequestListener({ privacyContactEmail: 'privacy@example.com' });
      const req = createMockReq({ method: 'GET', url: '/privacy' });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.equal(res.headers['Content-Security-Policy'], "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none';");
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');

      const body = res.body;
      assert.ok(body.includes('Practitioner Protocols Privacy Policy'));
      assert.ok(body.includes('What the App Stores'));
      assert.ok(body.includes('What the App Does NOT Store'));
      assert.ok(body.includes('Data Retention and Deletion'));
      assert.ok(body.includes('Sub-Processors'));
      assert.ok(body.includes('Railway'));
      assert.ok(body.includes('Shopify'));
      assert.ok(body.includes('read_orders'));
      assert.ok(body.includes('customers/data_request'));
      assert.ok(body.includes('customers/redact'));
      assert.ok(body.includes('shop/redact'));
      assert.ok(body.includes('app/uninstalled'));
      assert.ok(body.includes('mailto:privacy@example.com'));

      // Check no medical/health claims
      assert.ok(!/\b(cure|cures|curing|cured)\b/i.test(body));
      assert.ok(!/\b(treat|treats|treatment|treating)\b/i.test(body));
      assert.ok(!/\b(disease|diseases)\b/i.test(body));
    });

    it('renders placeholder administrator text when contact email is not provided', async () => {
      const listener = createRequestListener();
      const req = createMockReq({ method: 'GET', url: '/privacy' });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('contact the store administrator'));
    });
  });

  describe('Admin Practitioners Route Security (GET /api/admin/practitioners)', () => {
    it('returns HTTP 401 with retry header when unauthenticated in production mode', async () => {
      const prodListener = createRequestListener({
        databaseUrl: 'postgres://production.host:5432/db',
        shopifyApiSecret: 'secret123',
        shopifyApiKey: 'key123',
        pool: { query: async () => ({ rows: [] }) },
      });

      const req = createMockReq({
        method: 'GET',
        url: '/api/admin/practitioners?shop=test.myshopify.com',
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['X-Shopify-Retry-Invalid-Session-Request'], '1');
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Unauthorized');
    });
  });

  describe('shopify.app.toml Configuration Integrity', () => {
    const tomlContent = readFileSync(join(process.cwd(), 'shopify.app.toml'), 'utf-8');

    it('sets client_id to the production Practitioner Protocols app record', () => {
      assert.ok(tomlContent.includes('client_id = "840a22df2708a4a51a443180b8c332db"'));
      assert.ok(tomlContent.includes('application_url = "https://practitioner.arsalandev.studio"'));
    });

    it('points application_url, app proxy and auth redirects at the custom domain only', () => {
      assert.ok(tomlContent.includes('url = "https://practitioner.arsalandev.studio/api/proxy"'));
      assert.ok(tomlContent.includes('"https://practitioner.arsalandev.studio/api/auth/callback"'));
      assert.ok(tomlContent.includes('"https://practitioner.arsalandev.studio/auth/callback"'));
      assert.ok(!tomlContent.includes('railway.app'), 'no Railway hostname may remain in shopify.app.toml');
    });

    it('declares compliance_topics array for mandatory GDPR webhooks', () => {
      assert.ok(tomlContent.includes('compliance_topics = ['));
      assert.ok(tomlContent.includes('"customers/data_request"'));
      assert.ok(tomlContent.includes('"customers/redact"'));
      assert.ok(tomlContent.includes('"shop/redact"'));
    });

    it('retains topics array for app/uninstalled and orders/paid', () => {
      assert.ok(tomlContent.includes('topics = [ "app/uninstalled" ]'));
      assert.ok(tomlContent.includes('topics = [ "orders/paid" ]'));
    });

    it('does not subscribe unhandled app/scopes_update topic', () => {
      assert.equal(tomlContent.includes('app/scopes_update'), false);
    });

    it('limits scopes to read_orders with zero unneeded write scopes', () => {
      assert.ok(tomlContent.includes('scopes = "read_orders"'));
      assert.equal(tomlContent.includes('write_products'), false);
      assert.equal(tomlContent.includes('write_metaobjects'), false);
    });

    it('registers both /api/auth and /api/auth/callback in redirect_urls', () => {
      assert.ok(tomlContent.includes('redirect_urls = ['));
      assert.ok(tomlContent.includes('/api/auth"'));
      assert.ok(tomlContent.includes('/api/auth/callback"'));
    });
  });

  describe('TLS & SSL Configuration (getDatabaseSslConfig)', () => {
    it('returns false for empty or missing databaseUrl', () => {
      assert.equal(getDatabaseSslConfig(''), false);
      assert.equal(getDatabaseSslConfig(null), false);
    });

    it('returns false for localhost and 127.0.0.1 by parsing URL hostname', () => {
      assert.equal(getDatabaseSslConfig('postgres://user:pass@localhost:5432/db'), false);
      assert.equal(getDatabaseSslConfig('postgres://user:pass@127.0.0.1:5432/db'), false);
    });

    it('returns false for Railway private networking (*.railway.internal)', () => {
      assert.equal(
        getDatabaseSslConfig('postgres://postgres:secret@postgres.railway.internal:5432/railway'),
        false
      );
      assert.equal(
        getDatabaseSslConfig('postgres://user:pass@service.subdomain.railway.internal:5432/db'),
        false
      );
    });

    it('returns false for public host when DATABASE_SSL is not specified', () => {
      assert.equal(
        getDatabaseSslConfig('postgres://user:pass@containers-us-west-1.railway.app:5432/railway', {}),
        false
      );
    });

    it('returns rejectUnauthorized: true when DATABASE_SSL=require or true', () => {
      const configReq = getDatabaseSslConfig(
        'postgres://user:pass@containers-us-west-1.railway.app:5432/railway',
        { DATABASE_SSL: 'require' }
      );
      assert.deepEqual(configReq, { rejectUnauthorized: true });

      const configTrue = getDatabaseSslConfig(
        'postgres://user:pass@containers-us-west-1.railway.app:5432/railway',
        { DATABASE_SSL: 'true' }
      );
      assert.deepEqual(configTrue, { rejectUnauthorized: true });
    });

    it('returns rejectUnauthorized: false when DATABASE_SSL=no-verify (explicit opt-in)', () => {
      const config = getDatabaseSslConfig(
        'postgres://user:pass@containers-us-west-1.railway.app:5432/railway',
        { DATABASE_SSL: 'no-verify' }
      );
      assert.deepEqual(config, { rejectUnauthorized: false });
    });

    it('does not falsely match localhost if password contains localhost', () => {
      // Hostname parser should check parsed.hostname, not substring
      const config = getDatabaseSslConfig(
        'postgres://user:my_localhost_password@containers-us-west-1.railway.app:5432/railway',
        { DATABASE_SSL: 'require' }
      );
      assert.deepEqual(config, { rejectUnauthorized: true });
    });
  });

  describe('Database Migration Runner (scripts/migrate.js)', () => {
    it('includes 20261104_add_product_handle_to_protocol_line migration in MIGRATION_FILES', () => {
      const hasProductHandleMigration = MIGRATION_FILES.some(f => f.includes('20261104_add_product_handle_to_protocol_line'));
      assert.equal(hasProductHandleMigration, true, '20261104_add_product_handle_to_protocol_line must be registered in MIGRATION_FILES');
    });

    it('throws when DATABASE_URL is not set and no client is passed', async () => {
      await assert.rejects(
        () => runMigrations({ databaseUrl: '' }),
        /DATABASE_URL is required to run database migrations/
      );
    });

    it('creates _pp_migrations ledger table and applies migrations inside transactions', async () => {
      const executedQueries = [];
      const ledgerRows = [];

      const mockClient = {
        async query(sql, params) {
          executedQueries.push({ sql, params });
          if (typeof sql === 'string' && sql.includes('SELECT "id" FROM "_pp_migrations"')) {
            return { rows: [...ledgerRows] };
          }
          if (typeof sql === 'string' && sql.includes('INSERT INTO "_pp_migrations"')) {
            ledgerRows.push({ id: params[0] });
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const result = await runMigrations({ client: mockClient });
      assert.equal(result.applied, MIGRATION_FILES.length);
      assert.equal(result.skipped, 0);

      // Verify ledger table was created
      assert.ok(executedQueries.some(q => q.sql.includes('CREATE TABLE IF NOT EXISTS "_pp_migrations"')));

      // Verify BEGIN and COMMIT were executed for each migration
      const begins = executedQueries.filter(q => q.sql === 'BEGIN');
      const commits = executedQueries.filter(q => q.sql === 'COMMIT');
      assert.equal(begins.length, MIGRATION_FILES.length);
      assert.equal(commits.length, MIGRATION_FILES.length);
    });

    it('skips already applied migrations on second run (ledger idempotency)', async () => {
      const ledgerRows = [];
      const executedMigrations = [];

      const statefulClient = {
        async query(sql, params) {
          if (typeof sql === 'string' && sql.includes('SELECT "id" FROM "_pp_migrations"')) {
            return { rows: [...ledgerRows] };
          }
          if (typeof sql === 'string' && sql.includes('INSERT INTO "_pp_migrations"')) {
            ledgerRows.push({ id: params[0] });
            return { rows: [] };
          }
          if (typeof sql === 'string' && (sql.includes('CREATE TABLE "Protocol"') || sql.includes('ProcessedWebhook') || sql.includes('allowSelfEnrol') || sql.includes('productHandle') || sql.includes('ShopperContact') || sql.includes('ShopProfile'))) {
            executedMigrations.push(sql);
          }
          return { rows: [] };
        },
      };

      // Run 1: applies all migrations
      const run1 = await runMigrations({ client: statefulClient });
      assert.equal(run1.applied, MIGRATION_FILES.length);
      assert.equal(run1.skipped, 0);
      assert.equal(executedMigrations.length, MIGRATION_FILES.length);

      // Run 2: skips all previously applied migrations
      const run2 = await runMigrations({ client: statefulClient });
      assert.equal(run2.applied, 0, 'Second run should apply 0 migrations');
      assert.equal(run2.skipped, MIGRATION_FILES.length, 'Second run should skip all migrations');
      assert.equal(executedMigrations.length, MIGRATION_FILES.length, 'No new SQL should be executed on second run');
    });

    it('rolls back transaction on SQL execution error', async () => {
      const executedQueries = [];
      const failingClient = {
        async query(sql) {
          executedQueries.push(sql);
          if (typeof sql === 'string' && sql.includes('SELECT "id" FROM "_pp_migrations"')) {
            return { rows: [] };
          }
          if (typeof sql === 'string' && sql.includes('CREATE TABLE "Protocol"')) {
            throw new Error('Simulated DDL syntax error');
          }
          return { rows: [] };
        },
      };

      await assert.rejects(
        () => runMigrations({ client: failingClient }),
        /Simulated DDL syntax error/
      );

      assert.ok(executedQueries.includes('BEGIN'));
      assert.ok(executedQueries.includes('ROLLBACK'));
    });

    it('verifies allowSelfEnrol migration is registered in MIGRATION_FILES and applies idempotently', () => {
      const found = MIGRATION_FILES.some(f => f.includes('20261103_add_allow_self_enrol'));
      assert.ok(found, '20261103_add_allow_self_enrol migration must be registered in MIGRATION_FILES');
    });

    it('verifies 20261105_add_shopper_contact_and_feedback migration is registered in MIGRATION_FILES', () => {
      const found = MIGRATION_FILES.some(f => f.includes('20261105_add_shopper_contact_and_feedback'));
      assert.ok(found, '20261105_add_shopper_contact_and_feedback migration must be registered in MIGRATION_FILES');
    });
  });

  describe('railway.json Configuration', () => {
    it('configures preDeployCommand to run npm run migrate', () => {
      const railwayContent = readFileSync(join(process.cwd(), 'railway.json'), 'utf-8');
      const config = JSON.parse(railwayContent);
      assert.equal(config.deploy?.preDeployCommand, 'npm run migrate');
      assert.equal(config.deploy?.startCommand, 'node server.js');
      assert.equal(config.deploy?.healthcheckPath, '/health');
    });
  });

  describe('startServer Database Pool Wiring', () => {
    it('instantiates and closes database pool with graceful shutdown', async () => {
      let poolClosed = false;
      const mockPool = {
        async query() { return { rows: [] }; },
        async end() { poolClosed = true; },
      };

      const server = startServer({
        port: 0,
        host: '127.0.0.1',
        pool: mockPool,
        env: {
          DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
          SHOPIFY_API_SECRET: 'test_secret_123',
        },
      });

      assert.ok(server);
      await new Promise((resolve) => server.close(resolve));
      assert.equal(poolClosed, true, 'Pool should be closed when server closes');
    });
  });

  describe('Production Mode: Demo Route Hiding & Mutation Protection (DATABASE_URL configured)', () => {
    const prodListener = createRequestListener({
      databaseUrl: 'postgres://production.host:5432/db',
      shopifyApiSecret: 'prod_secret_123',
    });

    const hiddenRoutes = [
      '/portal',
      '/portal/preview',
      '/protocol/demo',
      '/handout/demo',
      '/protocol/pr_any123',
      '/p/pr_any123',
      '/handout/pr_any123',
      '/apps/protocols',
    ];

    for (const route of hiddenRoutes) {
      it(`returns 404 for ${route} in production mode`, async () => {
        const req = createMockReq({ method: 'GET', url: route });
        const res = createMockRes();
        await prodListener(req, res);
        assert.equal(res.statusCode, 404);
        assert.equal(res.body, 'Not Found');
      });
    }

    it('does not mutate DEMO_REPORT.month when ?month= is supplied in production mode', async () => {
      const initialMonth = DEMO_REPORT.month;
      const targetMonth = '2030-12';
      assert.notEqual(initialMonth, targetMonth);

      const req = createMockReq({
        method: 'GET',
        url: `/portal?month=${targetMonth}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(DEMO_REPORT.month, initialMonth, 'DEMO_REPORT.month must remain unmutated in production mode');
    });
  });

  describe('Public Interactive Showcase (/demo and /try)', () => {
    const prodListener = createRequestListener({
      databaseUrl: 'postgres://production.host:5432/db',
      shopifyApiSecret: 'prod_secret_123',
    });

    it('GET /demo and GET /try return 200 with Practitioner Portal and showcase bar', async () => {
      for (const route of ['/demo', '/try']) {
        const req = createMockReq({ method: 'GET', url: route });
        const res = createMockRes();
        await prodListener(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.body.startsWith('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
        assert.ok(res.body.includes('demo-showcase-bar'), 'Must contain demo showcase bar');
        assert.ok(res.body.includes('Interactive Demo'), 'Must contain demo badge');
        assert.ok(res.body.includes('Daily Essentials Protocol'), 'Must contain demo protocol');
        assert.equal(res.headers['X-Robots-Tag'], 'noindex, nofollow');
      }
    });

    it('GET /demo?view=client renders Client Landing Page preview with showcase bar', async () => {
      const req = createMockReq({ method: 'GET', url: '/demo?view=client' });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.startsWith('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
      assert.ok(res.body.includes('demo-showcase-bar'));
      assert.ok(res.body.includes('Daily Essentials Protocol'));
      assert.ok(res.body.includes('Hydrating Daily Cleanser'));
    });

    it('GET /demo?view=handout renders Printable Handout preview with showcase bar and QR', async () => {
      const req = createMockReq({ method: 'GET', url: '/demo?view=handout' });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.startsWith('<!DOCTYPE html>'), 'Handout must start with <!DOCTYPE html>');
      assert.ok(res.body.includes('demo-showcase-bar'));
      assert.ok(res.body.includes('demo-handout-sheet'));
      assert.ok(res.body.includes('Print Handout'));
      assert.ok(res.body.includes('<svg'));
    });

    it('GET /demo?view=admin renders Polaris Merchant Admin preview with showcase bar', async () => {
      const req = createMockReq({ method: 'GET', url: '/demo?view=admin' });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.startsWith('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
      assert.ok(res.body.includes('demo-showcase-bar'));
      assert.ok(res.body.includes('Apex Integrative Wellness'));
      assert.ok(res.body.includes('Practitioners'));

      const reqAttr = createMockReq({ method: 'GET', url: '/demo?view=admin&tab=attribution' });
      const resAttr = createMockRes();
      await prodListener(reqAttr, resAttr);
      assert.equal(resAttr.statusCode, 200);
      assert.ok(resAttr.body.includes('Attribution by Protocol'));
    });

    it('GET /search/suggest.json returns matching demo products', async () => {
      const req = createMockReq({ method: 'GET', url: '/search/suggest.json?q=cleanser' });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.ok(data.resources.results.products.length >= 1);
      assert.equal(data.resources.results.products[0].title, 'Hydrating Daily Cleanser');
    });

    it('GET /products/:handle.js returns matching demo variant data for hydration', async () => {
      const req = createMockReq({ method: 'GET', url: '/products/hydrating-daily-cleanser.js' });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Type'], 'application/json');
      const data = JSON.parse(res.body);
      assert.equal(data.title, 'Hydrating Daily Cleanser');
      assert.ok(data.variants.length >= 1);
    });

    it('POST /apps/protocols?action=create with demo referer saves mock protocol', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/apps/protocols?action=create',
        headers: {
          referer: 'https://demo-host.railway.app/demo',
        },
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.success, true);
    });
  });

  describe('Production Embedded Merchant Admin (DATABASE_URL configured & App Bridge Session Auth)', () => {
    const apiSecret = 'test_secret_for_prod_admin_123';
    const apiKey = 'test_api_key_prod_456';
    const prodShop = 'wellness-store.myshopify.com';

    const mockPool = {
      async query(sql, params) {
        if (typeof sql === 'string' && sql.includes('"Settings"')) {
          return { rows: [{ shop: prodShop, mode: 'tag', disclaimer: 'Test disclaimer', handoutText: 'Test handout' }] };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const prodListener = createRequestListener({
      databaseUrl: 'postgres://production.host:5432/db',
      shopifyApiSecret: apiSecret,
      shopifyApiKey: apiKey,
      pool: mockPool,
    });

    const validToken = createAdminSessionToken({
      userId: 'gid://shopify/User/admin_1',
      shop: prodShop,
      apiKey,
      expiresInSec: 3600,
    }, apiSecret);

    it('GET / serves App Bridge bootstrap page when embedded iframe has no token (embedded=1)', async () => {
      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${prodShop}&embedded=1`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.getHeader('content-type').includes('text/html'));
      assert.ok(res.getHeader('content-security-policy').includes(`frame-ancestors https://${prodShop} https://admin.shopify.com;`));
      assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
      assert.ok(res.body.includes('<meta name="shopify-api-key" content="test_api_key_prod_456">'));
      assert.ok(res.body.includes('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>'));
      assert.ok(res.body.includes('window.shopify.idToken'));
      assert.ok(res.body.includes('window.location.replace'));
    });

    it('GET / serves App Bridge bootstrap page when host parameter is present', async () => {
      const req = createMockReq({
        method: 'GET',
        url: `/admin?shop=${prodShop}&host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmU=`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('window.shopify.idToken'));
    });

    it('GET / redirects 302 to /api/auth on top-level direct navigation with valid ?shop=', async () => {
      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${prodShop}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.Location.startsWith('/api/auth?shop='));
      assert.ok(res.headers.Location.includes(prodShop));
    });

    it('GET / serves friendly 200 root page on top-level direct navigation with no shop and no session', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/',
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['Content-Type'].includes('text/html'));
      assert.ok(res.body.includes('Practitioner Protocols runs inside your Shopify admin. Open it from your Shopify admin\'s Apps list.'));
      assert.ok(res.body.includes('href="/privacy"'));
      assert.ok(!res.body.includes('<input')); // No shop-domain input field or login form
      assert.ok(!res.body.includes('<form'));
    });

    it('GET / serves embedded Polaris admin HTML when valid id_token query param is provided', async () => {
      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${prodShop}&id_token=${validToken}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.getHeader('content-type').includes('text/html'));
      assert.ok(res.getHeader('content-security-policy').includes(`frame-ancestors https://${prodShop} https://admin.shopify.com;`));
      assert.ok(res.body.includes('<meta name="shopify-api-key" content="test_api_key_prod_456">'));
      assert.ok(res.body.includes('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>'));
      assert.ok(res.body.includes('Practitioner Protocols'));
      assert.ok(res.body.includes('Connected Store: wellness-store.myshopify.com'));
    });

    it('GET / serves embedded Polaris admin HTML when valid Authorization Bearer header is provided', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/app',
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('Practitioner Protocols'));
    });

    it('rejects cross-shop mismatch on GET / with 403 Forbidden even when embedded', async () => {
      const mismatchedShop = 'attacker-shop.myshopify.com';
      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${mismatchedShop}&id_token=${validToken}&embedded=1`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 403);
      const data = JSON.parse(res.body);
      assert.equal(data.code, 'FORBIDDEN');
    });

    it('rejects cross-shop mismatch across all /api/admin/* endpoints with 403 Forbidden', async () => {
      const mismatchedShop = 'attacker-shop.myshopify.com';
      const headers = {
        Authorization: `Bearer ${validToken}`,
        'Content-Type': 'application/json',
      };

      const endpoints = [
        { method: 'POST', url: `/api/admin/practitioners/status?shop=${mismatchedShop}`, body: '{"ownerGid":"gid://shopify/Customer/1","action":"approve"}' },
        { method: 'POST', url: `/api/admin/practitioners/practice-name?shop=${mismatchedShop}`, body: '{"ownerGid":"gid://shopify/Customer/1","practiceName":"Test"}' },
        { method: 'POST', url: `/api/admin/starters/create?shop=${mismatchedShop}`, body: '{"name":"Template","lines":[{"variantGid":"gid://shopify/ProductVariant/1","quantity":1}]}' },
        { method: 'POST', url: `/api/admin/settings?shop=${mismatchedShop}`, body: '{"mode":"company","disclaimer":"Discl"}' },
        { method: 'POST', url: `/api/admin/emergency/disable-all?shop=${mismatchedShop}`, body: '{}' },
        { method: 'GET', url: `/api/admin/attribution.csv?shop=${mismatchedShop}` },
      ];

      for (const ep of endpoints) {
        const req = createMockReq({
          method: ep.method,
          url: ep.url,
          headers,
          body: ep.body || '',
        });
        const res = createMockRes();
        await prodListener(req, res);

        assert.equal(res.statusCode, 403, `Expected 403 for ${ep.method} ${ep.url}, got ${res.statusCode}`);
        const data = JSON.parse(res.body);
        assert.equal(data.code, 'FORBIDDEN');
      }
    });

    it('returns 401 with retry header on expired session token in non-embedded request', async () => {
      const expiredToken = createAdminSessionToken({
        userId: 'gid://shopify/User/admin_1',
        shop: prodShop,
        apiKey,
        expiresInSec: -300, // expired 5 mins ago
      }, apiSecret);

      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${prodShop}&id_token=${expiredToken}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.getHeader('X-Shopify-Retry-Invalid-Session-Request'), '1');
    });

    it('serves App Bridge bootstrap HTML (200) on expired session token in embedded request', async () => {
      const expiredToken = createAdminSessionToken({
        userId: 'gid://shopify/User/admin_1',
        shop: prodShop,
        apiKey,
        expiresInSec: -300, // expired 5 mins ago
      }, apiSecret);

      const req = createMockReq({
        method: 'GET',
        url: `/?shop=${prodShop}&id_token=${expiredToken}&embedded=1`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.getHeader('content-type').includes('text/html'));
      assert.ok(res.getHeader('content-security-policy').includes(`frame-ancestors https://${prodShop} https://admin.shopify.com;`));
      assert.ok(res.body.includes('<meta name="shopify-api-key" content="test_api_key_prod_456">'));
      assert.ok(res.body.includes('<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>'));
      assert.ok(res.body.includes('window.shopify.idToken'));
    });

    it('returns 401 with retry header on forged token signature', async () => {
      const forgedToken = createAdminSessionToken({
        userId: 'gid://shopify/User/admin_1',
        shop: prodShop,
        apiKey,
      }, 'wrong_signature_secret_999');

      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/settings',
        headers: { Authorization: `Bearer ${forgedToken}`, 'Content-Type': 'application/json' },
        body: '{"mode":"tag"}',
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.getHeader('X-Shopify-Retry-Invalid-Session-Request'), '1');
    });
  });

  describe('Demo Mode: Unrestricted Demo Pages & Month Mutation (DATABASE_URL unset/empty)', () => {
    const demoListener = createRequestListener({
      databaseUrl: '', // Unset / demo mode
    });

    it('returns 200 for demo routes in demo mode', async () => {
      for (const route of ['/', '/admin', '/portal', '/protocol/demo', '/handout/demo']) {
        const req = createMockReq({ method: 'GET', url: route });
        const res = createMockRes();
        await demoListener(req, res);
        assert.equal(res.statusCode, 200, `Expected 200 for ${route} in demo mode`);
      }
    });

    it('allows ?month= query parameter to update DEMO_REPORT.month in demo mode', async () => {
      const targetMonth = '2026-11';
      const req = createMockReq({
        method: 'GET',
        url: `/admin?month=${targetMonth}`,
      });
      const res = createMockRes();
      await demoListener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(DEMO_REPORT.month, targetMonth, 'DEMO_REPORT.month should update in demo mode');
    });
  });

  describe('X-Robots-Tag Search Engine Isolation Header', () => {
    const listener = createRequestListener({
      databaseUrl: 'postgres://production.host:5432/db',
    });

    it('does NOT include X-Robots-Tag on /health endpoint', async () => {
      const req = createMockReq({ method: 'GET', url: '/health' });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.getHeader('X-Robots-Tag'), undefined);
    });

    it('includes X-Robots-Tag: noindex, nofollow on all other responses', async () => {
      const testPaths = ['/', '/admin', '/api/auth', '/non-existent-path'];
      for (const path of testPaths) {
        const req = createMockReq({ method: 'GET', url: path });
        const res = createMockRes();
        await listener(req, res);
        assert.equal(
          res.getHeader('X-Robots-Tag'),
          'noindex, nofollow',
          `Expected X-Robots-Tag header on ${path}`
        );
      }
    });
  });

  describe('README.md Status & Scope Integrity', () => {
    const readmeContent = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');

    it('states dev store spikes are verified (S2, S3, S4, S5 answered, S1 on Plus only)', () => {
      assert.ok(
        readmeContent.includes('Dev Store Spikes Verified')
      );
      assert.ok(
        readmeContent.includes('S2, S3, S4, S5 Answered; S1 Answered on Plus Dev Store Only')
      );
    });

    it('documents interactive protocol editor modal built in Milestone M3', () => {
      assert.ok(readmeContent.includes('Interactive Protocol Editor (Milestone M3)'));
      assert.ok(readmeContent.includes('searchCatalogProducts'));
    });
  });
});
