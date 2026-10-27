/**
 * @file Practitioner Protocols Server Entry (Node.js >= 22.12 ESM).
 * 
 * Serves the demo Merchant Admin (Polaris), App Proxy portal/client pages,
 * printable handouts, and compliance webhooks on local dev / demo.
 * 
 * In production mode (DATABASE_URL set), server startup is refused until real
 * Shopify Admin session-token authentication and OAuth are implemented.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import { renderAdminHtml } from './app/lib/protocols/admin.js';
import { renderPortalLiquid } from './app/lib/protocols/portal.js';
import { renderProtocolLiquid, verifyAppProxyHmac, verifyOAuthHmac } from './app/lib/protocols/proxy.js';
import { renderHandoutHtml } from './app/lib/protocols/handout.js';
import { generateQrSvg } from './app/lib/protocols/qr.js';
import {
  handleAppProxyRequest,
  handleWebhookRequest,
  handleAdminPractitionerStatusRequest,
  handleAdminPracticeNameRequest,
  handleAdminCreateStarterRequest,
  handleAdminUpdateSettingsRequest,
  handleAdminEmergencyDisableAllRequest,
  handleAdminAttributionCsvRequest,
  handleAdminDashboardRequest
} from './app/lib/protocols/routes.js';
import { createFakeVariantResolver } from './app/lib/protocols/catalog.js';

// Neutral retail demo data for previewing without live database (clean-room, zero health claims)
export const DEMO_SHOP = 'practitioner-store.myshopify.com';

/** RFC 1034 compliant shop domain pattern for myshopify.com stores */
export const SHOPIFY_DOMAIN_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/;

export const DEMO_PROTOCOL = {
  id: 'proto_demo_1',
  shop: DEMO_SHOP,
  token: 'tok_essentials_demo123',
  name: 'Daily Essentials Protocol',
  introNote: 'A curated daily routine of personal care essentials. Use morning and evening as recommended.',
  displayName: 'Apex Integrative Wellness',
  status: 'active',
  updatedAt: new Date().toISOString(),
  lines: [
    {
      variantGid: 'gid://shopify/ProductVariant/101',
      variantId: '101',
      title: 'Hydrating Daily Cleanser',
      productTitle: 'Hydrating Daily Cleanser',
      variantTitle: '200ml Bottle',
      price: '34.00',
      priceFormatted: '$34.00',
      quantity: 1,
      available: true,
      inStock: true,
      usageNote: 'Apply 1-2 pumps morning and evening',
    },
    {
      variantGid: 'gid://shopify/ProductVariant/102',
      variantId: '102',
      title: 'Antioxidant Facial Serum',
      productTitle: 'Antioxidant Facial Serum',
      variantTitle: '30ml Dropper',
      price: '48.50',
      priceFormatted: '$48.50',
      quantity: 1,
      available: true,
      inStock: true,
      usageNote: 'Gently smooth 3-4 drops over face after cleansing',
    },
    {
      variantGid: 'gid://shopify/ProductVariant/103',
      variantId: '103',
      title: 'Broad Spectrum Daily SPF 50',
      productTitle: 'Broad Spectrum Daily SPF 50',
      variantTitle: null,
      price: '28.00',
      priceFormatted: '$28.00',
      quantity: 1,
      available: true,
      inStock: true,
      usageNote: 'Apply liberally each morning before sun exposure',
    },
  ],
};

export const DEMO_PROFILES = [
  {
    id: 'prof_1',
    ownerGid: 'gid://shopify/Customer/112233',
    practiceName: 'Apex Integrative Wellness',
    isApproved: true,
    ownerType: 'customer',
  },
  {
    id: 'prof_2',
    ownerGid: 'gid://shopify/Customer/445566',
    practiceName: 'Summit Performance Studio',
    isApproved: false,
    ownerType: 'customer',
  },
];

export const DEMO_STARTERS = [
  {
    id: 'starter_1',
    name: 'Brand Core Essentials Starter',
    status: 'active',
    linesCount: 3,
  },
  {
    id: 'starter_2',
    name: 'Seasonal Care Routine',
    status: 'active',
    linesCount: 2,
  },
];

export const DEMO_REPORT = {
  month: '2026-10',
  totalOrders: 18,
  totalUnits: 46,
  totalRevenueFormatted: '$1,845.50',
  items: [
    {
      practiceName: 'Apex Integrative Wellness',
      protocolName: 'Daily Essentials Protocol',
      orders: 12,
      units: 32,
      revenueFormatted: '$1,290.00',
    },
    {
      practiceName: 'Summit Performance Studio',
      protocolName: 'Active Recovery Routine',
      orders: 6,
      units: 14,
      revenueFormatted: '$555.50',
    },
  ],
};

export const DEMO_SETTINGS = {
  mode: 'tag',
  disclaimer: 'Curated retail recommendations provided by verified specialists. Not intended as medical diagnosis or treatment.',
  handoutText: 'Curated by your specialist. Scan the QR code or visit the link to review and order your personalized routine.',
};

/**
 * Validates server configuration before startup.
 * Refuses to start in production mode (DATABASE_URL set) while admin session-token
 * authentication is not implemented yet.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {{ databaseUrl: string, isDemoMode: boolean }}
 */
export function validateServerConfig(env = process.env) {
  const databaseUrl = (env.DATABASE_URL || '').trim();
  const apiSecret = (env.SHOPIFY_API_SECRET || '').trim();

  if (databaseUrl && !apiSecret) {
    throw new Error(
      'Production mode disabled: DATABASE_URL is set, but Shopify Admin session-token authentication is not implemented yet. Refusing to start in production mode without real admin auth.'
    );
  }

  if (databaseUrl && apiSecret) {
    return { databaseUrl, isDemoMode: false };
  }

  return { databaseUrl: '', isDemoMode: true };
}

/**
 * Converts node incoming request to a Web standard Request object.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Request>}
 */
async function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else if (v) {
      headers.set(k, v);
    }
  }

  const chunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      chunks.push(chunk);
    }
  }

  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(url, {
    method: req.method,
    headers,
    body,
  });
}

/**
 * Parses urlencoded form body from an IncomingMessage.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<URLSearchParams>}
 */
async function parseFormData(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf-8');
  return new URLSearchParams(body);
}

/**
 * Formats demo attribution report as RFC 4180 CSV.
 *
 * @param {string} [month]
 * @returns {string}
 */
function generateDemoAttributionCsv(month = DEMO_REPORT.month) {
  const headers = ['Month', 'Practice Name', 'Protocol', 'Orders', 'Units', 'Revenue'];
  const lines = [headers.join(',')];
  for (const item of DEMO_REPORT.items) {
    lines.push([
      `"${month || DEMO_REPORT.month}"`,
      `"${item.practiceName.replace(/"/g, '""')}"`,
      `"${item.protocolName.replace(/"/g, '""')}"`,
      item.orders,
      item.units,
      `"${item.revenueFormatted}"`,
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Creates request listener for the HTTP server.
 *
 * @param {{
 *   databaseUrl?: string,
 *   shopifyApiSecret?: string,
 *   shopifyApiKey?: string,
 *   pool?: any,
 *   tokenExchanger?: (params: { shop: string, code: string, apiKey: string, apiSecret: string }) => Promise<{ accessToken: string, scope?: string }>
 * }} [options={}]
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>}
 */
export function createRequestListener(options = {}) {
  const databaseUrl = (options.databaseUrl || process.env.DATABASE_URL || '').trim();
  const apiSecret = options.shopifyApiSecret ?? (process.env.SHOPIFY_API_SECRET || '');
  const apiKey = options.shopifyApiKey || (process.env.SHOPIFY_API_KEY || '');
  const pool = options.pool || null;
  const tokenExchanger = options.tokenExchanger || null;

  return async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
      const pathname = url.pathname;

      // Healthcheck endpoint for Railway / load balancer
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
        return;
      }

      // OAuth Install Initiation: /api/auth or /auth
      if (pathname === '/api/auth' || pathname === '/auth') {
        const shop = (url.searchParams.get('shop') || '').toLowerCase().trim();
        if (!shop || !SHOPIFY_DOMAIN_REGEX.test(shop)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing shop parameter' }));
          return;
        }

        const state = crypto.randomBytes(16).toString('hex');
        const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
        const proto = req.headers['x-forwarded-proto'] || (String(hostHeader).includes('localhost') ? 'http' : 'https');
        const redirectUri = encodeURIComponent(`${proto}://${hostHeader}/api/auth/callback`);
        const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(apiKey || 'demo-client-id')}&scope=read_orders&redirect_uri=${redirectUri}&state=${state}`;

        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      // OAuth Callback: /api/auth/callback or /auth/callback
      if (pathname === '/api/auth/callback' || pathname === '/auth/callback') {
        const shop = (url.searchParams.get('shop') || '').toLowerCase().trim();
        const code = url.searchParams.get('code');
        const hostParam = url.searchParams.get('host') || '';
        const state = url.searchParams.get('state') || '';

        if (!shop || !SHOPIFY_DOMAIN_REGEX.test(shop)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid shop parameter' }));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing code parameter' }));
          return;
        }

        const isHmacValid = verifyOAuthHmac(url.searchParams, apiSecret);
        if (!isHmacValid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid OAuth HMAC signature' }));
          return;
        }

        // In production mode with pool, exchange code for access token and persist offline session
        if (databaseUrl && pool) {
          let accessToken = '';
          let scope = 'read_orders';

          if (typeof tokenExchanger === 'function') {
            const tokenData = await tokenExchanger({ shop, code, apiKey, apiSecret });
            accessToken = tokenData.accessToken;
            scope = tokenData.scope || scope;
          } else {
            const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                client_id: apiKey,
                client_secret: apiSecret,
                code,
              }),
            });
            if (!tokenRes.ok) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to exchange OAuth code for access token' }));
              return;
            }
            const tokenData = await tokenRes.json();
            accessToken = tokenData.access_token;
            scope = tokenData.scope || scope;
          }

          await pool.query(
            `INSERT INTO "Session" ("id", "shop", "state", "isOnline", "scope", "accessToken")
             VALUES ($1, $2, $3, false, $4, $5)
             ON CONFLICT ("id") DO UPDATE SET
               "shop" = EXCLUDED."shop",
               "state" = EXCLUDED."state",
               "scope" = EXCLUDED."scope",
               "accessToken" = EXCLUDED."accessToken"`,
            [`offline_${shop}`, shop, state || 'authenticated', scope, accessToken]
          );
        }

        const targetUrl = `/admin?shop=${encodeURIComponent(shop)}${hostParam ? `&host=${encodeURIComponent(hostParam)}` : ''}`;
        res.writeHead(302, { Location: targetUrl });
        res.end();
        return;
      }

      // Admin Action Routes & Attribution CSV:
      // When DATABASE_URL is set (production mode), requests without session-token verification
      // return 501 Not Implemented. Never use a hard-coded adminUser.
      if (
        pathname === '/api/admin/practitioners/status' ||
        pathname === '/api/admin/practitioners/practice-name' ||
        pathname === '/api/admin/starters/create' ||
        pathname === '/api/admin/settings' ||
        pathname === '/api/admin/emergency/disable-all' ||
        pathname === '/api/admin/attribution.csv'
      ) {
        const hasSession = Boolean(
          req.headers.authorization ||
          url.searchParams.get('id_token') ||
          url.searchParams.get('session')
        );

        if (databaseUrl && !hasSession) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Not Implemented',
              message: 'Admin routes with database persistence require Shopify Admin session-token verification.',
            })
          );
          return;
        }

        if (databaseUrl && hasSession) {
          const webReq = await toWebRequest(req);
          let webRes;
          const handlerOpts = { apiSecret, expectedShop: url.searchParams.get('shop') || DEMO_SHOP };

          if (pathname === '/api/admin/practitioners/status') {
            webRes = await handleAdminPractitionerStatusRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/practitioners/practice-name') {
            webRes = await handleAdminPracticeNameRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/starters/create') {
            webRes = await handleAdminCreateStarterRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/settings') {
            webRes = await handleAdminUpdateSettingsRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/emergency/disable-all') {
            webRes = await handleAdminEmergencyDisableAllRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/attribution.csv') {
            webRes = await handleAdminAttributionCsvRequest(pool, webReq, handlerOpts);
          }

          if (webRes) {
            res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
            const text = await webRes.text();
            res.end(text);
            return;
          }
        }

        // Demo Mode (no DATABASE_URL configured): in-memory mutations only, zero adminUser
        if (pathname === '/api/admin/practitioners/status' && req.method === 'POST') {
          const formData = await parseFormData(req);
          const ownerGid = formData.get('ownerGid');
          const action = formData.get('action');
          const prof = DEMO_PROFILES.find((p) => p.ownerGid === ownerGid);
          if (prof) prof.isApproved = action === 'approve';
          res.writeHead(302, { Location: '/admin?tab=practitioners' });
          res.end();
          return;
        }

        if (pathname === '/api/admin/practitioners/practice-name' && req.method === 'POST') {
          const formData = await parseFormData(req);
          const ownerGid = formData.get('ownerGid');
          const practiceName = formData.get('practiceName');
          const prof = DEMO_PROFILES.find((p) => p.ownerGid === ownerGid);
          if (prof && practiceName) prof.practiceName = practiceName.trim();
          res.writeHead(302, { Location: '/admin?tab=practitioners' });
          res.end();
          return;
        }

        if (pathname === '/api/admin/starters/create' && req.method === 'POST') {
          const formData = await parseFormData(req);
          const name = formData.get('name');
          if (name) {
            DEMO_STARTERS.push({
              id: `starter_${Date.now()}`,
              name: name.trim(),
              status: 'active',
              linesCount: 1,
            });
          }
          res.writeHead(302, { Location: '/admin?tab=starters' });
          res.end();
          return;
        }

        if (pathname === '/api/admin/settings' && req.method === 'POST') {
          const formData = await parseFormData(req);
          DEMO_SETTINGS.mode = formData.get('mode') || 'tag';
          DEMO_SETTINGS.disclaimer = formData.get('disclaimer') || '';
          DEMO_SETTINGS.handoutText = formData.get('handoutText') || '';
          res.writeHead(302, { Location: '/admin?tab=settings' });
          res.end();
          return;
        }

        if (pathname === '/api/admin/emergency/disable-all' && req.method === 'POST') {
          DEMO_PROTOCOL.status = 'disabled';
          res.writeHead(302, { Location: '/admin?tab=settings' });
          res.end();
          return;
        }

        if (pathname === '/api/admin/attribution.csv') {
          const month = url.searchParams.get('month') || DEMO_REPORT.month;
          const csv = generateDemoAttributionCsv(month);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="attribution-${DEMO_SHOP}-${month}.csv"`,
          });
          res.end(csv);
          return;
        }
      }

      // 1. Merchant Admin UI (Shopify Polaris embedded admin - Demo Preview)
      if (pathname === '/' || pathname === '/admin' || pathname === '/app') {
        const shopParam = url.searchParams.get('shop') || DEMO_SHOP;
        const activeTab = url.searchParams.get('tab') || 'practitioners';
        const month = url.searchParams.get('month');
        if (month) {
          DEMO_REPORT.month = month;
        }
        const html = renderAdminHtml({
          shop: shopParam,
          profiles: DEMO_PROFILES,
          starters: DEMO_STARTERS,
          report: DEMO_REPORT,
          settings: DEMO_SETTINGS,
          activeTab,
        });

        // App Store security headers: Content-Security-Policy with frame-ancestors, nosniff, Referrer-Policy
        const frameAncestors = shopParam && shopParam !== DEMO_SHOP && SHOPIFY_DOMAIN_REGEX.test(shopParam)
          ? `https://${shopParam} https://admin.shopify.com`
          : `https://*.myshopify.com https://admin.shopify.com`;

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `frame-ancestors ${frameAncestors};`,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        });
        res.end(html);
        return;
      }

      // Demo search endpoint for local preview
      if (pathname === '/apps/protocols' && url.searchParams.get('action') === 'search') {
        const q = (url.searchParams.get('q') || '').toLowerCase().trim();
        const demoCatalog = [
          {
            id: 'gid://shopify/Product/101',
            title: 'Hydrating Daily Cleanser',
            variants: [
              { id: 'gid://shopify/ProductVariant/101', title: '200ml Bottle', displayTitle: 'Hydrating Daily Cleanser - 200ml Bottle', price: '34.00', priceFormatted: '$34.00' }
            ]
          },
          {
            id: 'gid://shopify/Product/102',
            title: 'Antioxidant Facial Serum',
            variants: [
              { id: 'gid://shopify/ProductVariant/102', title: '30ml Dropper', displayTitle: 'Antioxidant Facial Serum - 30ml Dropper', price: '48.50', priceFormatted: '$48.50' }
            ]
          },
          {
            id: 'gid://shopify/Product/103',
            title: 'Barrier Recovery Lip Balm',
            variants: [
              { id: 'gid://shopify/ProductVariant/103', title: '15ml Tube', displayTitle: 'Barrier Recovery Lip Balm - 15ml Tube', price: '28.00', priceFormatted: '$28.00' }
            ]
          },
          {
            id: 'gid://shopify/Product/104',
            title: 'Omega-3 EPA/DHA Pure',
            variants: [
              { id: 'gid://shopify/ProductVariant/104', title: '60 Softgels', displayTitle: 'Omega-3 EPA/DHA Pure - 60 Softgels', price: '32.00', priceFormatted: '$32.00' }
            ]
          },
          {
            id: 'gid://shopify/Product/105',
            title: 'Magnesium Glycinate Complex',
            variants: [
              { id: 'gid://shopify/ProductVariant/105', title: '120 Capsules', displayTitle: 'Magnesium Glycinate Complex - 120 Capsules', price: '26.50', priceFormatted: '$26.50' }
            ]
          }
        ];
        const matches = demoCatalog.filter(p => !q || p.title.toLowerCase().includes(q) || p.variants.some(v => v.displayTitle.toLowerCase().includes(q)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ products: matches }));
        return;
      }

      // 2. Practitioner Portal Preview
      if (pathname === '/portal' || pathname === '/portal/preview') {
        const isApproved = url.searchParams.get('approved') !== 'false';
        const isLoggedIn = url.searchParams.get('login') !== 'false';

        const liquid = renderPortalLiquid({
          shop: DEMO_SHOP,
          isLoggedIn,
          isApproved,
          practiceName: 'Apex Integrative Wellness',
          activeProtocols: [
            {
              id: DEMO_PROTOCOL.id,
              token: DEMO_PROTOCOL.token,
              name: DEMO_PROTOCOL.name,
              introNote: DEMO_PROTOCOL.introNote,
              lines: DEMO_PROTOCOL.lines,
              linesCount: DEMO_PROTOCOL.lines.length,
              retailTotal: '$110.50',
            },
          ],
          starterProtocols: DEMO_STARTERS,
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(liquid);
        return;
      }

      // 3. Client Protocol Landing Page Preview
      if (pathname.startsWith('/protocol') || pathname.startsWith('/p/')) {
        const liquid = renderProtocolLiquid({
          protocol: DEMO_PROTOCOL,
          practiceName: 'Apex Integrative Wellness',
          isLoggedInPractitioner: url.searchParams.get('preview') === 'practitioner',
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(liquid);
        return;
      }

      // 4. Printable Handout Preview (US Letter / A4 with Vector QR)
      if (pathname.startsWith('/handout')) {
        const shareUrl = `https://${DEMO_SHOP}/apps/protocols/${DEMO_PROTOCOL.token}`;
        const qrSvg = generateQrSvg(shareUrl, { size: 180 });
        const html = renderHandoutHtml({
          protocol: DEMO_PROTOCOL,
          practiceName: 'Apex Integrative Wellness',
          shareUrl,
          qrSvg,
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 5. Shopify App Proxy Endpoint (/api/proxy)
      if (pathname.startsWith('/api/proxy')) {
        const webReq = await toWebRequest(req);
        const webRes = await handleAppProxyRequest(pool, webReq, {
          apiSecret,
          variantResolver: createFakeVariantResolver({
            'gid://shopify/ProductVariant/101': {
              productTitle: 'Hydrating Daily Cleanser',
              variantTitle: '200ml Bottle',
              price: '34.00',
              currency: 'USD',
              availableForSale: true,
            },
          }),
        });

        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        const text = await webRes.text();
        res.end(text);
        return;
      }

      // 6. Webhooks
      if (pathname.startsWith('/webhooks')) {
        const webReq = await toWebRequest(req);
        const webRes = await handleWebhookRequest(pool, webReq, {
          apiSecret,
        });

        res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
        const text = await webRes.text();
        res.end(text);
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      console.error('Server error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  };
}

/**
 * Creates and starts the HTTP server.
 *
 * @param {{ port?: number, host?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {http.Server}
 */
export function startServer(options = {}) {
  const env = options.env || process.env;
  validateServerConfig(env);

  const port = options.port || parseInt(env.PORT || '3000', 10);
  const host = options.host || env.HOST || '0.0.0.0';

  if (!env.SHOPIFY_API_SECRET) {
    console.warn('[SECURITY WARNING] SHOPIFY_API_SECRET is unset. Proxy and webhook verification will fail closed (HTTP 500).');
  }

  const server = http.createServer(createRequestListener({
    databaseUrl: '',
    shopifyApiSecret: env.SHOPIFY_API_SECRET || '',
  }));

  server.listen(port, host, () => {
    console.log(`[Practitioner Protocols Demo Server] Running on http://${host}:${port}`);
    console.log(`  - Merchant Admin (Demo): http://localhost:${port}/admin`);
    console.log(`  - Practitioner Portal:   http://localhost:${port}/portal`);
    console.log(`  - Client Protocol Page:  http://localhost:${port}/protocol/demo`);
    console.log(`  - Printable Handout:     http://localhost:${port}/handout/demo`);
  });

  return server;
}

// Start server if executed directly via Node CLI
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    startServer();
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }
}
