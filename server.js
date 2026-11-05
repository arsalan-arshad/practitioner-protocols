/**
 * @file Practitioner Protocols Server Entry (Node.js >= 22.12 ESM).
 * 
 * Serves the embedded Merchant Admin (Polaris), App Proxy portal/client pages,
 * printable handouts, and compliance webhooks on local dev / demo.
 * 
 * In production mode (DATABASE_URL set), serves the embedded Merchant Admin
 * authenticated via Shopify App Bridge session tokens (id_token).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { URL, URLSearchParams, fileURLToPath } from 'node:url';
import pg from 'pg';
import { getDatabaseSslConfig } from './scripts/migrate.js';
import { renderAdminHtml, renderAdminBootstrapHtml, formatAttributionCsv } from './app/lib/protocols/admin.js';
import { renderPortalLiquid } from './app/lib/protocols/portal.js';
import { renderProtocolLiquid, verifyAppProxyHmac, verifyOAuthHmac } from './app/lib/protocols/proxy.js';
import { renderHandoutHtml } from './app/lib/protocols/handout.js';
import { generateQrSvg } from './app/lib/protocols/qr.js';
import {
  handleAppProxyRequest,
  handleWebhookRequest,
  handleAdminPractitionersListRequest,
  handleAdminPractitionerStatusRequest,
  handleAdminPracticeNameRequest,
  handleAdminCreateStarterRequest,
  handleAdminUpdateSettingsRequest,
  handleAdminEmergencyDisableAllRequest,
  handleAdminAttributionCsvRequest,
  handleAdminDashboardRequest,
  handleAdminContactsCsvRequest,
  handleAdminDeleteContactRequest,
  handleAdminDeletePracticeContactsRequest,
  handleAdminCustomFeatureRequest
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
  summary: {
    totalOrders: 18,
    totalUnits: 46,
    totalRevenueMinor: 184550,
    totalRevenueFormatted: '$1,845.50',
    currency: 'USD',
  },
  rows: [
    {
      month: '2026-10',
      ownerId: 'gid://shopify/Customer/1001',
      practiceName: 'Apex Integrative Wellness',
      protocolId: 'proto_demo_1',
      protocolName: 'Daily Essentials Protocol',
      isStarter: false,
      orders: 12,
      units: 32,
      revenueMinor: 129000,
      revenueFormatted: '$1,290.00',
      currency: 'USD',
    },
    {
      month: '2026-10',
      ownerId: 'gid://shopify/Customer/1002',
      practiceName: 'Summit Performance Studio',
      protocolId: 'proto_demo_2',
      protocolName: 'Active Recovery Routine',
      isStarter: false,
      orders: 6,
      units: 14,
      revenueMinor: 55550,
      revenueFormatted: '$555.50',
      currency: 'USD',
    },
  ],
  byPractice: [
    {
      ownerId: 'gid://shopify/Customer/1001',
      practiceName: 'Apex Integrative Wellness',
      orders: 12,
      units: 32,
      revenueMinor: 129000,
      revenueFormatted: '$1,290.00',
      currency: 'USD',
    },
    {
      ownerId: 'gid://shopify/Customer/1002',
      practiceName: 'Summit Performance Studio',
      orders: 6,
      units: 14,
      revenueMinor: 55550,
      revenueFormatted: '$555.50',
      currency: 'USD',
    },
  ],
  byProtocol: [
    {
      protocolId: 'proto_demo_1',
      protocolName: 'Daily Essentials Protocol',
      isStarter: false,
      orders: 12,
      units: 32,
      revenueMinor: 129000,
      revenueFormatted: '$1,290.00',
      currency: 'USD',
    },
    {
      protocolId: 'proto_demo_2',
      protocolName: 'Active Recovery Routine',
      isStarter: false,
      orders: 6,
      units: 14,
      revenueMinor: 55550,
      revenueFormatted: '$555.50',
      currency: 'USD',
    },
  ],
  totalOrders: 18,
  totalUnits: 46,
  totalRevenueFormatted: '$1,845.50',
  items: [
    {
      month: '2026-10',
      ownerId: 'gid://shopify/Customer/1001',
      practiceName: 'Apex Integrative Wellness',
      protocolId: 'proto_demo_1',
      protocolName: 'Daily Essentials Protocol',
      isStarter: false,
      orders: 12,
      units: 32,
      revenueMinor: 129000,
      revenueFormatted: '$1,290.00',
      currency: 'USD',
    },
    {
      month: '2026-10',
      ownerId: 'gid://shopify/Customer/1002',
      practiceName: 'Summit Performance Studio',
      protocolId: 'proto_demo_2',
      protocolName: 'Active Recovery Routine',
      isStarter: false,
      orders: 6,
      units: 14,
      revenueMinor: 55550,
      revenueFormatted: '$555.50',
      currency: 'USD',
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
 * Parses demo attribution report as RFC 4180 CSV.
 *
 * @param {string} [month]
 * @returns {string}
 */
export function generateDemoAttributionCsv(month = DEMO_REPORT.month) {
  const rows = (DEMO_REPORT.rows || []).map(r => ({ ...r, month }));
  return formatAttributionCsv({ rows });
}

/**
 * Builds Content-Security-Policy header string for Shopify Admin embedded pages.
 * Preserves frame-ancestors, allows App Bridge from cdn.shopify.com, inline scripts and styles.
 *
 * @param {string} [shopParam]
 * @returns {string}
 */
export function buildAdminCsp(shopParam = '') {
  const frameAncestors = shopParam && shopParam !== DEMO_SHOP && SHOPIFY_DOMAIN_REGEX.test(shopParam)
    ? `https://${shopParam} https://admin.shopify.com`
    : `https://*.myshopify.com https://admin.shopify.com`;
  const connectShop = shopParam && SHOPIFY_DOMAIN_REGEX.test(shopParam) ? ` https://${shopParam}` : '';
  return `frame-ancestors ${frameAncestors}; default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.shopify.com https://cdn.shopifycdn.net; style-src 'self' 'unsafe-inline' https://cdn.shopify.com; img-src 'self' data: https:; connect-src 'self' https://admin.shopify.com${connectShop};`;
}

/**
 * Parses HTTP Cookie header string into a key-value dictionary.
 *
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

/**
 * Signs an OAuth state string with timestamp and HMAC-SHA256 signature using the app secret.
 * Format: `${state}.${timestamp}.${hmac}`
 *
 * @param {string} state
 * @param {string} secret
 * @returns {string}
 */
export function signOAuthState(state, secret) {
  const ts = Date.now().toString();
  const data = `${state}.${ts}`;
  const hmac = crypto.createHmac('sha256', secret || 'default-secret').update(data).digest('hex');
  return `${state}.${ts}.${hmac}`;
}

/**
 * Verifies that a signed OAuth state cookie matches the expected query state parameter,
 * has valid HMAC signature, and has not expired (Max-Age 600 seconds = 10 minutes).
 *
 * @param {string} cookieVal
 * @param {string} queryState
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyOAuthState(cookieVal, queryState, secret) {
  if (!cookieVal || !queryState || typeof cookieVal !== 'string' || typeof queryState !== 'string') {
    return false;
  }
  const parts = cookieVal.split('.');
  if (parts.length === 3) {
    const [cookieState, tsStr, hmac] = parts;
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts) || Date.now() - ts > 600 * 1000 || ts > Date.now() + 60 * 1000) {
      return false;
    }
    const expectedData = `${cookieState}.${tsStr}`;
    const expectedHmac = crypto.createHmac('sha256', secret || 'default-secret').update(expectedData).digest('hex');
    if (hmac.length !== expectedHmac.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(hmac, 'utf8'), Buffer.from(expectedHmac, 'utf8'))) {
      return false;
    }
    if (cookieState.length !== queryState.length) return false;
    return crypto.timingSafeEqual(Buffer.from(cookieState, 'utf8'), Buffer.from(queryState, 'utf8'));
  }
  if (parts.length === 2) {
    const [cookieState, hmac] = parts;
    const expectedHmac = crypto.createHmac('sha256', secret || 'default-secret').update(cookieState).digest('hex');
    if (hmac.length !== expectedHmac.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(hmac, 'utf8'), Buffer.from(expectedHmac, 'utf8'))) {
      return false;
    }
    if (cookieState.length !== queryState.length) return false;
    return crypto.timingSafeEqual(Buffer.from(cookieState, 'utf8'), Buffer.from(queryState, 'utf8'));
  }
  return false;
}

/**
 * Renders the clean, public HTML privacy policy page.
 * Strictly honest language, zero client PII stored, read_orders aggregate attribution only,
 * compliance webhooks, sub-processors, and optional contact email. Zero health claims.
 *
 * @param {{ contactEmail?: string }} [options]
 * @returns {string}
 */
export function renderPrivacyHtml({ contactEmail = '' } = {}) {
  const safeContact = contactEmail
    ? `<p>If you have any questions about this Privacy Policy or data handling practices, please contact us at <a href="mailto:${contactEmail.replace(/"/g, '&quot;')}">${contactEmail.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a>.</p>`
    : `<p>If you have any questions about this Privacy Policy or data handling practices, please contact the store administrator.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy &mdash; Practitioner Protocols</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    :root {
      --color-bg: #f9fafb;
      --color-surface: #ffffff;
      --color-border: #e5e7eb;
      --color-text: #1f2937;
      --color-text-muted: #4b5563;
      --color-primary: #0f766e;
    }
    body {
      margin: 0;
      padding: 2rem 1rem;
      background: var(--color-bg);
      color: var(--color-text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
    }
    .privacy-container {
      max-width: 760px;
      margin: 0 auto;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 2.5rem;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
    h1 {
      margin-top: 0;
      font-size: 1.875rem;
      color: var(--color-text);
      border-bottom: 2px solid var(--color-primary);
      padding-bottom: 0.75rem;
    }
    h2 {
      margin-top: 2rem;
      font-size: 1.25rem;
      color: var(--color-primary);
    }
    p, li {
      color: var(--color-text-muted);
      font-size: 0.9375rem;
    }
    ul {
      padding-left: 1.5rem;
    }
    li {
      margin-bottom: 0.5rem;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      background: #ecfdf5;
      color: #065f46;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    a {
      color: var(--color-primary);
      text-decoration: underline;
    }
    .privacy-footer {
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--color-border);
      font-size: 0.8125rem;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="privacy-container">
    <div style="margin-bottom: 1rem;"><span class="badge">Privacy Policy</span></div>
    <h1>Practitioner Protocols Privacy Policy</h1>
    <p>Last updated: November 2026</p>

    <p>Practitioner Protocols is built with privacy by design. Our architecture ensures that shoppers and clients can receive recommendations and purchase retail products with zero personal or health data collected or stored by default. No shopper personal data is stored unless the shopper explicitly opts in.</p>

    <h2>1. What the App Stores</h2>
    <p>To operate recommendation workflows for direct-to-consumer and professional brands, the application stores only:</p>
    <ul>
      <li><strong>Shop Domain:</strong> The store domain (e.g. <code>example.myshopify.com</code>) to scope protocols and settings.</li>
      <li><strong>Offline Access Token:</strong> Stored securely to verify platform webhooks and authenticate merchant admin operations.</li>
      <li><strong>Practitioner Approval Records:</strong> Professional practice names and approval statuses as authorized by the merchant.</li>
      <li><strong>Protocols and Share Tokens:</strong> Protocol titles, intro messages, selected product variant identifiers (GIDs and handles), recommended quantities, usage directions, and unguessable cryptographic share tokens.</li>
      <li><strong>Aggregate Attribution Counts:</strong> Monthly aggregate order counts and attributed gross revenue per protocol and practice.</li>
      <li><strong>Opted-In Shopper Contacts:</strong> If and only if a shopper explicitly opts in via the "Stay in touch" form on a protocol recommendation page, the app stores their email address, optional first name, the exact consent text shown, consent version, timestamp, and the associated practice. Purpose: to enable the merchant or practice to send product recommendations and offers directly through their own communication tools (emails are never sent by this application). Legal basis: explicit consent. The app stores NO protocolId, NO order ID, NO purchased product data, NO IP address, and NO user agent with the contact.</li>
      <li><strong>Merchant Custom Feature Requests:</strong> When a merchant submits a feature request in the admin Settings tab, we store the message and optional reply email. This counts as consent to reply strictly to that inquiry and is never used for marketing.</li>
    </ul>

    <h2>2. What the App Does NOT Store</h2>
    <p>The application strictly enforces a privacy-first barrier:</p>
    <ul>
      <li><strong>No Shopper Identifying Data Without Consent:</strong> Browsing shoppers have zero personal data collected or stored. We never track shoppers across sessions, nor do we store browsing history, IP addresses, user agents, phone numbers, or physical addresses.</li>
      <li><strong>No Patient or Health Information:</strong> The application does not store diagnostic records, medical conditions, health notes, or patient charts. Protocols are general retail product recommendation lists.</li>
      <li><strong>Aggregate-Only Order Attribution:</strong> Orders are read with the <code>read_orders</code> permission solely to match the hidden line-item property (<code>_protocol_token</code>) against active protocols and increment aggregate monthly counters. Individual order IDs and customer identifiers are never retained.</li>
    </ul>

    <h2>3. Data Retention and Deletion</h2>
    <p>We comply fully with platform data protection standards and mandatory compliance webhooks:</p>
    <ul>
      <li><strong>How to Withdraw Consent or Request Deletion:</strong> Shoppers can withdraw consent or request deletion at any time by contacting the store or practice. Practitioners can delete contacts from their portal, merchants can delete individual contacts or entire practice contact lists in the admin dashboard, and platform data privacy requests are honored automatically.</li>
      <li><strong>Customer Data Requests (<code>customers/data_request</code>):</strong> Reports any matching practitioner profile records and opted-in shopper contact records.</li>
      <li><strong>Customer Redaction (<code>customers/redact</code>):</strong> Automatically and permanently deletes matching opted-in shopper contacts by email and removes practitioner profile records.</li>
      <li><strong>Shop Redaction (<code>shop/redact</code>):</strong> Immediately and permanently deletes all protocols, line items, practice profiles, settings, sessions, attribution records, shopper contacts, and merchant feedback rows associated with the store upon receipt.</li>
      <li><strong>App Uninstallation (<code>app/uninstalled</code>):</strong> Immediately revokes and removes all stored offline access tokens and merchant sessions. Store data is retained during the 48-hour platform grace period in case of reinstallation, then permanently deleted upon receipt of <code>shop/redact</code>.</li>
    </ul>

    <h2>4. Sub-Processors</h2>
    <p>The application relies on the following infrastructure sub-processors:</p>
    <ul>
      <li><strong>Railway:</strong> Application hosting, compute execution, and internal PostgreSQL database persistence.</li>
      <li><strong>Shopify:</strong> Core commerce platform, App Bridge embedded interface, storefront App Proxy, and webhook delivery.</li>
    </ul>

    <h2>5. Contact Us</h2>
    ${safeContact}

    <div class="privacy-footer">
      &copy; ${new Date().getFullYear()} Practitioner Protocols. Open-source software licensed under MIT.
    </div>
  </div>
</body>
</html>`;
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

      // Security: Strict-Transport-Security on all responses (max-age=31536000; includeSubDomains)
      if (typeof res.setHeader === 'function') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      const origWriteHead = res.writeHead;
      res.writeHead = function (status, ...args) {
        if (typeof this.setHeader === 'function') {
          this.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        let headersArg = args.find((a) => a && typeof a === 'object' && !Array.isArray(a));
        if (headersArg) {
          if (!headersArg['Strict-Transport-Security'] && !headersArg['strict-transport-security']) {
            headersArg['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
          }
        }
        return origWriteHead.apply(this, [status, ...args]);
      };

      // Healthcheck endpoint for Railway / load balancer
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
        return;
      }

      // Security: Add X-Robots-Tag: noindex, nofollow to every response except /health
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }

      // Public Privacy Policy Page: GET /privacy
      if (pathname === '/privacy' && req.method === 'GET') {
        const contactEmail = options.privacyContactEmail ?? process.env.PRIVACY_CONTACT_EMAIL ?? '';
        const html = renderPrivacyHtml({ contactEmail });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none';",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        });
        res.end(html);
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
        const signedCookie = signOAuthState(state, apiSecret);
        const cookiePath = pathname === '/auth' ? '/auth' : '/api/auth';
        const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
        const proto = req.headers['x-forwarded-proto'] || (String(hostHeader).includes('localhost') ? 'http' : 'https');
        const redirectUri = encodeURIComponent(`${proto}://${hostHeader}/api/auth/callback`);
        const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(apiKey || 'demo-client-id')}&scope=read_orders&redirect_uri=${redirectUri}&state=${state}`;

        res.writeHead(302, {
          Location: authUrl,
          'Set-Cookie': `shopify_oauth_state=${signedCookie}; Path=${cookiePath}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
        });
        res.end();
        return;
      }

      // OAuth Callback: /api/auth/callback or /auth/callback
      if (pathname === '/api/auth/callback' || pathname === '/auth/callback') {
        const shop = (url.searchParams.get('shop') || '').toLowerCase().trim();
        const code = url.searchParams.get('code');
        const hostParam = url.searchParams.get('host') || '';
        const queryState = url.searchParams.get('state');

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

        if (!queryState) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing state parameter' }));
          return;
        }

        const cookies = parseCookies(req.headers?.cookie);
        const cookieState = cookies.shopify_oauth_state || cookies.oauth_state;
        if (!cookieState) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing OAuth state cookie' }));
          return;
        }

        const isStateValid = verifyOAuthState(cookieState, queryState, apiSecret);
        if (!isStateValid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid OAuth state' }));
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

          // Do not store the state in Session.state; store "authenticated".
          await pool.query(
            `INSERT INTO "Session" ("id", "shop", "state", "isOnline", "scope", "accessToken")
             VALUES ($1, $2, $3, false, $4, $5)
             ON CONFLICT ("id") DO UPDATE SET
               "shop" = EXCLUDED."shop",
               "state" = EXCLUDED."state",
               "scope" = EXCLUDED."scope",
               "accessToken" = EXCLUDED."accessToken"`,
            [`offline_${shop}`, shop, 'authenticated', scope, accessToken]
          );
        }

        const targetUrl = `/admin?shop=${encodeURIComponent(shop)}${hostParam ? `&host=${encodeURIComponent(hostParam)}` : ''}`;
        const clearPath = pathname === '/auth/callback' ? '/auth' : '/api/auth';
        res.writeHead(302, {
          Location: targetUrl,
          'Set-Cookie': `shopify_oauth_state=; Path=${clearPath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        });
        res.end();
        return;
      }

      // Admin Action Routes & Attribution CSV:
      // When DATABASE_URL is set (production mode), requests require Shopify Admin session-token verification.
      // Missing session tokens return 401 with retry header.
      if (
        pathname === '/api/admin/practitioners' ||
        pathname === '/api/admin/practitioners/status' ||
        pathname === '/api/admin/practitioners/practice-name' ||
        pathname === '/api/admin/starters/create' ||
        pathname === '/api/admin/settings' ||
        pathname === '/api/admin/emergency/disable-all' ||
        pathname === '/api/admin/attribution.csv' ||
        pathname === '/api/admin/contacts.csv' ||
        pathname === '/api/admin/contacts/delete' ||
        pathname === '/api/admin/contacts/delete-practice' ||
        pathname === '/api/admin/feedback/custom-request'
      ) {
        const authHeader = req.headers?.authorization || req.headers?.Authorization;
        const hasSession = Boolean(
          authHeader ||
          url.searchParams.get('id_token') ||
          url.searchParams.get('session')
        );

        if (databaseUrl && !hasSession) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'X-Shopify-Retry-Invalid-Session-Request': '1',
          });
          res.end(
            JSON.stringify({
              error: 'Unauthorized',
              message: 'Admin routes with database persistence require Shopify Admin session-token verification.',
            })
          );
          return;
        }

        if (databaseUrl && hasSession) {
          const webReq = await toWebRequest(req);
          let webRes;
          const handlerOpts = { apiSecret, apiKey, isDemoMode: false };

          if (pathname === '/api/admin/practitioners') {
            webRes = await handleAdminPractitionersListRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/practitioners/status') {
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
          } else if (pathname === '/api/admin/contacts.csv') {
            webRes = await handleAdminContactsCsvRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/contacts/delete') {
            webRes = await handleAdminDeleteContactRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/contacts/delete-practice') {
            webRes = await handleAdminDeletePracticeContactsRequest(pool, webReq, handlerOpts);
          } else if (pathname === '/api/admin/feedback/custom-request') {
            webRes = await handleAdminCustomFeatureRequest(pool, webReq, handlerOpts);
          }

          if (webRes) {
            res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
            const text = await webRes.text();
            res.end(text);
            return;
          }
        }

        // Demo Mode (no DATABASE_URL configured): in-memory mutations only, zero adminUser
        if (pathname === '/api/admin/practitioners' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(DEMO_PROFILES));
          return;
        }

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

      // In production mode (DATABASE_URL configured), demo routes return 404, never demo content
      if (databaseUrl) {
        if (
          pathname === '/portal' ||
          pathname === '/portal/preview' ||
          pathname === '/protocol/demo' ||
          pathname === '/handout/demo' ||
          pathname.startsWith('/protocol') ||
          pathname.startsWith('/p/') ||
          pathname.startsWith('/handout') ||
          pathname === '/apps/protocols'
        ) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
      }

      // 1. Merchant Admin UI (Shopify Polaris embedded admin - Production & Demo Preview)
      if (pathname === '/' || pathname === '/admin' || pathname === '/app') {
        if (databaseUrl) {
          const authHeader = req.headers?.authorization || req.headers?.Authorization;
          const hasSession = Boolean(
            authHeader ||
            url.searchParams.get('id_token') ||
            url.searchParams.get('session')
          );

          const isEmbedded =
            url.searchParams.get('embedded') === '1' ||
            Boolean(url.searchParams.get('host'));

          const shopParam = (url.searchParams.get('shop') || '').toLowerCase().trim();

          if (hasSession) {
            const webReq = await toWebRequest(req);
            const webRes = await handleAdminDashboardRequest(pool, webReq, {
              apiSecret,
              apiKey,
              isDemoMode: false,
            });

            // If token is invalid/expired (401) and request is inside embedded iframe,
            // serve App Bridge bootstrap page to get a fresh token instead of raw JSON 401.
            // Mismatched shop (403 Forbidden) and non-embedded 401s are preserved.
            if (webRes.status === 401 && isEmbedded) {
              const bootstrapHtml = renderAdminBootstrapHtml({ apiKey, shop: shopParam });

              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': buildAdminCsp(shopParam),
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'strict-origin-when-cross-origin',
              });
              res.end(bootstrapHtml);
              return;
            }

            res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
            const text = await webRes.text();
            res.end(text);
            return;
          }

          // No session token present:
          // Check if embedded inside Shopify admin iframe

          if (isEmbedded) {
            // Embedded iframe: do NOT redirect to /api/auth. Serve App Bridge bootstrap page.
            const bootstrapHtml = renderAdminBootstrapHtml({ apiKey, shop: shopParam });

            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': buildAdminCsp(shopParam),
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'strict-origin-when-cross-origin',
            });
            res.end(bootstrapHtml);
            return;
          }

          // Top-level direct browser navigation (outside embedded iframe)
          if (shopParam && SHOPIFY_DOMAIN_REGEX.test(shopParam)) {
            res.writeHead(302, { Location: `/api/auth?shop=${encodeURIComponent(shopParam)}` });
            res.end();
            return;
          }

          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Authentication required: Missing shop or admin session');
          return;
        }

        // Demo Mode Preview (DATABASE_URL unset/empty)
        const shopParam = url.searchParams.get('shop') || DEMO_SHOP;
        const activeTab = url.searchParams.get('tab') || 'practitioners';
        const month = url.searchParams.get('month');
        if (month) {
          DEMO_REPORT.month = month;
        }
        const html = renderAdminHtml({
          shop: shopParam,
          apiKey,
          profiles: DEMO_PROFILES,
          starters: DEMO_STARTERS,
          report: DEMO_REPORT,
          settings: DEMO_SETTINGS,
          activeTab,
        });

        // App Store security headers: Content-Security-Policy with frame-ancestors, nosniff, Referrer-Policy
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': buildAdminCsp(shopParam),
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
          variantResolver: pool
            ? undefined
            : createFakeVariantResolver({
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
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
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

  const databaseUrl = (env.DATABASE_URL || '').trim();
  let pool = options.pool || null;
  if (!pool && databaseUrl) {
    const PgPool = pg.Pool || pg.default?.Pool;
    pool = new PgPool({
      connectionString: databaseUrl,
      max: parseInt(env.PGMAX || '10', 10),
      ssl: getDatabaseSslConfig(databaseUrl, env),
    });
    pool.on('error', (err) => {
      console.error('Unexpected idle PostgreSQL client error:', err.message);
    });
  }

  const server = http.createServer(createRequestListener({
    databaseUrl,
    shopifyApiSecret: env.SHOPIFY_API_SECRET || '',
    shopifyApiKey: env.SHOPIFY_API_KEY || '',
    pool,
  }));

  server.on('close', async () => {
    if (pool && typeof pool.end === 'function') {
      try {
        await pool.end();
      } catch (err) {
        console.error('Error closing database pool:', err.message);
      }
    }
  });

  server.listen(port, host, () => {
    const mode = databaseUrl ? 'Production (Postgres)' : 'Demo (In-Memory)';
    console.log(`[Practitioner Protocols Server] Running in ${mode} on http://${host}:${port}`);
    console.log(`  - Healthcheck:           http://${host}:${port}/health`);
    console.log(`  - Merchant Admin:        http://${host}:${port}/admin`);
    console.log(`  - Practitioner Portal:   http://${host}:${port}/portal`);
    console.log(`  - Client Protocol Page:  http://${host}:${port}/protocol/demo`);
    console.log(`  - Printable Handout:     http://${host}:${port}/handout/demo`);
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
