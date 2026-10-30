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
} from '../server.js';
import { runMigrations, getDatabaseSslConfig, MIGRATION_FILES } from '../scripts/migrate.js';
import { calculateOAuthSignature } from '../app/lib/protocols/proxy.js';

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

    it('returns 501 on POST /api/admin/practitioners/status without hardcoded adminUser', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/practitioners/status',
        body: 'ownerGid=gid://shopify/Customer/112233&action=revoke',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 501);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Not Implemented');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 501 on POST /api/admin/settings without hardcoded adminUser', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/settings',
        body: 'mode=company&disclaimer=test',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 501);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Not Implemented');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 501 on POST /api/admin/emergency/disable-all without hardcoded adminUser', async () => {
      const req = createMockReq({
        method: 'POST',
        url: '/api/admin/emergency/disable-all',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 501);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Not Implemented');
      assert.ok(data.message.includes('session-token verification'));
    });

    it('returns 501 on GET /api/admin/attribution.csv when database is configured', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/admin/attribution.csv',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 501);
      const data = JSON.parse(res.body);
      assert.equal(data.error, 'Not Implemented');
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
      assert.ok(res.body.includes('Month,Practice Name,Protocol,Orders,Units,Revenue'));
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

    it('GET /api/auth/callback rejects request with invalid HMAC signature with HTTP 400', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/api/auth/callback?shop=my-store.myshopify.com&code=auth_code_123&state=nonce1&hmac=deadbeef',
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

    it('GET /api/auth/callback in demo mode redirects 302 to /admin on valid HMAC', async () => {
      const params = {
        code: 'valid_auth_code_999',
        shop: 'my-store.myshopify.com',
        state: 'nonce_abc_123',
        timestamp: '1729500000',
      };
      const hmac = calculateOAuthSignature(params, apiSecret);
      const queryString = new URLSearchParams({ ...params, hmac }).toString();

      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?${queryString}`,
      });
      const res = createMockRes();
      await oauthListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?shop=my-store.myshopify.com');
    });

    it('GET /api/auth/callback in production mode exchanges code, writes session, and redirects 302', async () => {
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

      const params = {
        code: 'valid_auth_code_prod',
        shop: 'my-store.myshopify.com',
        state: 'nonce_prod_state',
        timestamp: '1729500000',
      };
      const hmac = calculateOAuthSignature(params, apiSecret);
      const queryString = new URLSearchParams({ ...params, hmac }).toString();

      const req = createMockReq({
        method: 'GET',
        url: `/api/auth/callback?${queryString}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.Location, '/admin?shop=my-store.myshopify.com');
      assert.equal(queriedRows.length, 1);
      assert.ok(queriedRows[0].sql.includes('INSERT INTO "Session"'));
      assert.equal(queriedRows[0].params[0], 'offline_my-store.myshopify.com');
      assert.equal(queriedRows[0].params[1], 'my-store.myshopify.com');
      assert.equal(queriedRows[0].params[4], 'shpca_token_xyz_999');
    });
  });

  describe('Shopify App Store Security Headers (server.js)', () => {
    const listener = createRequestListener();

    it('returns Content-Security-Policy with frame-ancestors for the current shop', async () => {
      const req = createMockReq({
        method: 'GET',
        url: '/admin?shop=verified-store.myshopify.com',
      });
      const res = createMockRes();
      await listener(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(
        res.headers['Content-Security-Policy'],
        'frame-ancestors https://verified-store.myshopify.com https://admin.shopify.com;'
      );
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
      assert.equal(
        res.headers['Content-Security-Policy'],
        'frame-ancestors https://*.myshopify.com https://admin.shopify.com;'
      );
    });
  });

  describe('shopify.app.toml Configuration Integrity', () => {
    const tomlContent = readFileSync(join(process.cwd(), 'shopify.app.toml'), 'utf-8');

    it('sets client_id to the production Practitioner Protocols app record', () => {
      assert.ok(tomlContent.includes('client_id = "840a22df2708a4a51a443180b8c332db"'));
      assert.ok(tomlContent.includes('application_url = "https://practitioner-protocols-production.up.railway.app"'));
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
          if (typeof sql === 'string' && (sql.includes('CREATE TABLE "Protocol"') || sql.includes('ProcessedWebhook'))) {
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
      '/',
      '/admin',
      '/app',
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
        url: `/admin?month=${targetMonth}`,
      });
      const res = createMockRes();
      await prodListener(req, res);

      assert.equal(res.statusCode, 404);
      assert.equal(DEMO_REPORT.month, initialMonth, 'DEMO_REPORT.month must remain unmutated in production mode');
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
