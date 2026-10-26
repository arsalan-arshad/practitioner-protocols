import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateServerConfig,
  createRequestListener,
  DEMO_PROFILES,
  DEMO_SETTINGS,
  DEMO_PROTOCOL,
} from '../server.js';

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
    writeHead(status, headers = {}) {
      res.statusCode = status;
      Object.assign(res.headers, headers);
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

  describe('shopify.app.toml Configuration Integrity', () => {
    const tomlContent = readFileSync(join(process.cwd(), 'shopify.app.toml'), 'utf-8');

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
  });

  describe('README.md Status & Scope Integrity', () => {
    const readmeContent = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');

    it('states spikes are partially done (S2 only)', () => {
      assert.ok(
        readmeContent.includes('Dev Store Spikes Partially Done (S2 Liquid Evaluation Verified; S1, S3–S5 Open)')
      );
      assert.ok(
        readmeContent.includes('Spikes are partially done: Spike S2 verified App Proxy Liquid evaluation')
      );
    });

    it('marks protocol editor as not built yet', () => {
      assert.ok(readmeContent.includes('Protocol Editor (Not Built Yet)'));
      assert.ok(readmeContent.includes('interactive editor UI screen and product search are not built yet'));
    });
  });
});
