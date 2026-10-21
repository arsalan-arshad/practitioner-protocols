import {
  listProtocols,
  getProtocolByToken,
  getProtocolById,
  createProtocol,
  updateProtocol,
  duplicateProtocol,
  archiveProtocol,
  restoreProtocol,
  ProtocolServiceError
} from './service.js';
import { ProtocolValidationError } from './validation.js';
import { DENIAL_REASONS } from './permissions.js';
import {
  verifyAppProxyHmac,
  getLoggedInCustomerGid,
  renderProtocolLiquid
} from './proxy.js';
import {
  verifyWebhookHmac,
  extractShopDomain,
  handleCustomersDataRequest,
  handleCustomersRedact,
  handleShopRedact,
  handleAppUninstalled,
  handleOrdersPaid
} from './webhooks.js';

/**
 * Standard in-memory sliding window rate limiter.
 */
export class InMemoryRateLimiter {
  /**
   * @param {{ windowMs?: number, maxRequests?: number }} [options]
   */
  constructor({ windowMs = 60000, maxRequests = 100 } = {}) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  /**
   * Checks if an identifier is within the rate limit.
   * @param {string} key
   * @returns {boolean}
   */
  isAllowed(key) {
    const now = Date.now();
    const timestamps = (this.requests.get(key) || []).filter(
      (t) => now - t < this.windowMs
    );
    if (timestamps.length >= this.maxRequests) {
      this.requests.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
  }

  /**
   * Alias for isAllowed.
   * @param {string} key
   * @returns {boolean}
   */
  check(key) {
    return this.isAllowed(key);
  }

  /**
   * Clears all recorded rate limiting entries.
   */
  reset() {
    this.requests.clear();
  }
}

/**
 * Factory for creating an in-memory rate limiter.
 * @param {{ windowMs?: number, maxRequests?: number }} [options]
 * @returns {InMemoryRateLimiter}
 */
export function createRateLimiter(options) {
  return new InMemoryRateLimiter(options);
}

/**
 * Safely extracts a named header from a Request or header container.
 * @param {any} req
 * @param {string} headerName
 * @returns {string | null}
 */
export function getHeader(req, headerName) {
  if (!req) return null;
  const target = headerName.toLowerCase();
  if (req.headers) {
    if (typeof req.headers.get === 'function') {
      return req.headers.get(target) || req.headers.get(headerName) || null;
    }
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === target) {
        return Array.isArray(v) ? v[0] : String(v);
      }
    }
  }
  return null;
}

/**
 * Converts domain/service errors into appropriate HTTP JSON responses.
 * @param {any} err
 * @returns {Response}
 */
export function handleErrorResponse(err) {
  if (err instanceof ProtocolValidationError || err?.name === 'ProtocolValidationError') {
    return Response.json(
      {
        error: err.message,
        code: err.code || 'VALIDATION_FAILED',
        field: err.field || null
      },
      { status: 400 }
    );
  }

  if (err instanceof ProtocolServiceError || err?.name === 'ProtocolServiceError') {
    let status = 400;
    if (err.code === DENIAL_REASONS.UNAUTHENTICATED) {
      status = 401;
    } else if (
      err.code === DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH ||
      err.code === DENIAL_REASONS.STARTER_READ_ONLY ||
      err.code === DENIAL_REASONS.STARTER_CANNOT_BE_MODIFIED ||
      err.code === DENIAL_REASONS.DISABLED_PROTOCOL_INACCESSIBLE
    ) {
      status = 403;
    } else if (err.code === 'NOT_FOUND') {
      status = 404;
    }

    return Response.json(
      {
        error: err.message,
        code: err.code,
        details: err.details || null
      },
      { status }
    );
  }

  return Response.json(
    {
      error: err?.message || 'Internal Server Error'
    },
    { status: 500 }
  );
}

/**
 * Handles Shopify App Proxy storefront requests.
 * Verifies HMAC signature, checks rate limiting, resolves protocol by token,
 * renders Liquid markup, and returns Content-Type: application/liquid.
 *
 * @param {any} db Database client
 * @param {Request | any} request Web Request or request-like object
 * @param {{ apiSecret?: string, rateLimiter?: any }} [options]
 * @returns {Promise<Response>}
 */
export async function handleAppProxyRequest(db, request, { apiSecret, rateLimiter } = {}) {
  let urlObj;
  if (typeof request === 'string') {
    urlObj = new URL(request, 'https://proxy.test');
  } else if (request instanceof URL) {
    urlObj = request;
  } else if (request && typeof request.url === 'string') {
    urlObj = new URL(request.url, 'https://proxy.test');
  } else {
    urlObj = new URL('https://proxy.test');
  }

  const queryParams = request?.query || urlObj.searchParams;

  // 1. Verify HMAC signature if apiSecret provided
  if (apiSecret) {
    const isValidSignature = verifyAppProxyHmac(queryParams, apiSecret);
    if (!isValidSignature) {
      return new Response('Unauthorized: Invalid HMAC signature', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }

  // 2. Check Rate Limit if configured
  if (rateLimiter) {
    const clientKey =
      getHeader(request, 'x-forwarded-for')?.split(',')[0]?.trim() ||
      getHeader(request, 'x-real-ip') ||
      urlObj.searchParams.get('shop') ||
      'unknown_client';

    let isAllowed = true;
    if (typeof rateLimiter === 'function') {
      isAllowed = await rateLimiter(clientKey, request);
    } else if (typeof rateLimiter.isAllowed === 'function') {
      isAllowed = await rateLimiter.isAllowed(clientKey);
    } else if (typeof rateLimiter.check === 'function') {
      isAllowed = await rateLimiter.check(clientKey);
    } else if (typeof rateLimiter.consume === 'function') {
      isAllowed = await rateLimiter.consume(clientKey);
    }

    if (
      isAllowed === false ||
      (typeof isAllowed === 'object' && isAllowed !== null && isAllowed.allowed === false)
    ) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: {
          'Content-Type': 'text/plain',
          'Retry-After': '60'
        }
      });
    }
  }

  // 3. Extract shop and share token
  const shop = urlObj.searchParams.get('shop') || request?.shop || '';
  let token = urlObj.searchParams.get('token') || request?.token || '';

  if (!token) {
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !['protocols', 'apps', 'tools', 'proxy'].includes(last.toLowerCase())) {
      token = last;
    }
  }

  // 4. Resolve protocol
  let protocol = null;
  if (token && shop) {
    protocol = await getProtocolByToken(db, { shop, token: token.trim() });
  }

  // 5. Check if logged-in practitioner previewing protocol
  const customerGid = getLoggedInCustomerGid(queryParams);
  let isLoggedInPractitioner = false;

  if (customerGid) {
    if (protocol && (protocol.createdBy === customerGid || protocol.ownerId === customerGid)) {
      isLoggedInPractitioner = true;
    } else if (db && typeof db.query === 'function') {
      try {
        const numericId = String(customerGid).replace(/^gid:\/\/shopify\/Customer\//, '');
        const profileRes = await db.query(
          'SELECT "id" FROM "PractitionerProfile" WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)',
          [shop, customerGid, numericId]
        );
        if (profileRes?.rows?.length > 0) {
          isLoggedInPractitioner = true;
        }
      } catch {
        // Non-fatal fallback
      }
    }
  }

  // 6. Render Liquid template
  const liquid = renderProtocolLiquid({
    protocol,
    practiceName: protocol?.practiceName || '',
    isLoggedInPractitioner
  });

  return new Response(liquid, {
    status: protocol ? 200 : 404,
    headers: {
      'Content-Type': 'application/liquid; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  });
}

/**
 * Handles requests to list protocols for the authenticated user context.
 *
 * @param {any} db Database client
 * @param {{ id: string, role: string, ownerType: string, ownerId: string, shop?: string } | null} user
 * @param {string | URL | Request} url
 * @returns {Promise<Response>}
 */
export async function handleListProtocolsRequest(db, user, url) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  let urlObj;
  if (typeof url === 'string') {
    urlObj = new URL(url, 'https://localhost');
  } else if (url instanceof URL) {
    urlObj = url;
  } else if (url && typeof url.url === 'string') {
    urlObj = new URL(url.url, 'https://localhost');
  } else {
    urlObj = new URL('https://localhost');
  }

  const shop = urlObj.searchParams.get('shop') || user.shop;
  if (!shop) {
    return Response.json(
      { error: 'Shop domain is required', code: 'MISSING_SHOP' },
      { status: 400 }
    );
  }

  const statusParam = urlObj.searchParams.get('status');
  const search = urlObj.searchParams.get('search') || urlObj.searchParams.get('q') || '';
  const statusFilter = statusParam === 'all' ? null : (statusParam || 'active');

  try {
    let protocols = await listProtocols(db, {
      shop,
      user,
      status: statusFilter,
      includeStarters: true
    });

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      protocols = protocols.filter((p) => {
        const nameMatch = p.name && p.name.toLowerCase().includes(q);
        const introMatch = p.introNote && p.introNote.toLowerCase().includes(q);
        const displayMatch = p.displayName && p.displayName.toLowerCase().includes(q);
        return Boolean(nameMatch || introMatch || displayMatch);
      });
    }

    return Response.json({ protocols, count: protocols.length }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Parses request body from various input types.
 * @param {any} body
 * @returns {Promise<any>}
 */
async function parseRequestBody(body) {
  if (body && typeof body.json === 'function') {
    return await body.json();
  }
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  return body || {};
}

/**
 * Handles creation of a new protocol.
 * Returns 201 Created JSON.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {any} body Request body or Request object
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleCreateProtocolRequest(db, user, body, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  let input;
  try {
    input = await parseRequestBody(body);
  } catch {
    return Response.json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' }, { status: 400 });
  }

  const targetShop = shop || user.shop || input.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const created = await createProtocol(db, { shop: targetShop, user, input });
    return Response.json({ ...created, protocol: created }, { status: 201 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles fetching a single protocol by its ID.
 * Returns 200 OK JSON or 404/403/401.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {string} protocolId Protocol ID
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleGetProtocolRequest(db, user, protocolId, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  if (!protocolId) {
    return Response.json({ error: 'Protocol ID is required', code: 'MISSING_ID' }, { status: 400 });
  }

  const targetShop = shop || user.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const protocol = await getProtocolById(db, {
      shop: targetShop,
      user,
      protocolId,
      action: 'read'
    });

    if (!protocol) {
      return Response.json({ error: 'Protocol not found', code: 'NOT_FOUND' }, { status: 404 });
    }

    return Response.json({ ...protocol, protocol }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles updating an existing protocol.
 * Returns 200 OK JSON.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {string} protocolId Protocol ID
 * @param {any} body Request body or Request object
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleUpdateProtocolRequest(db, user, protocolId, body, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  if (!protocolId) {
    return Response.json({ error: 'Protocol ID is required', code: 'MISSING_ID' }, { status: 400 });
  }

  let input;
  try {
    input = await parseRequestBody(body);
  } catch {
    return Response.json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' }, { status: 400 });
  }

  const targetShop = shop || user.shop || input.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const updated = await updateProtocol(db, {
      shop: targetShop,
      user,
      protocolId,
      input
    });

    return Response.json({ ...updated, protocol: updated }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles duplicating a protocol into the user's library.
 * Returns 201 Created JSON.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {string} protocolId Protocol ID to duplicate
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleDuplicateProtocolRequest(db, user, protocolId, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  if (!protocolId) {
    return Response.json({ error: 'Protocol ID is required', code: 'MISSING_ID' }, { status: 400 });
  }

  const targetShop = shop || user.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const duplicated = await duplicateProtocol(db, {
      shop: targetShop,
      user,
      protocolId
    });

    return Response.json({ ...duplicated, protocol: duplicated }, { status: 201 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles archiving a protocol.
 * Returns 200 OK JSON.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {string} protocolId Protocol ID to archive
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleArchiveProtocolRequest(db, user, protocolId, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  if (!protocolId) {
    return Response.json({ error: 'Protocol ID is required', code: 'MISSING_ID' }, { status: 400 });
  }

  const targetShop = shop || user.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const archived = await archiveProtocol(db, {
      shop: targetShop,
      user,
      protocolId
    });

    return Response.json({ ...archived, protocol: archived }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles restoring an archived protocol.
 * Returns 200 OK JSON.
 *
 * @param {any} db Database client
 * @param {any} user Authenticated user
 * @param {string} protocolId Protocol ID to restore
 * @param {{ shop?: string }} [options]
 * @returns {Promise<Response>}
 */
export async function handleRestoreProtocolRequest(db, user, protocolId, { shop } = {}) {
  if (!user || !user.id) {
    return Response.json(
      { error: 'Unauthorized: User is unauthenticated', code: DENIAL_REASONS.UNAUTHENTICATED },
      { status: 401 }
    );
  }

  if (!protocolId) {
    return Response.json({ error: 'Protocol ID is required', code: 'MISSING_ID' }, { status: 400 });
  }

  const targetShop = shop || user.shop;
  if (!targetShop) {
    return Response.json({ error: 'Shop domain is required', code: 'MISSING_SHOP' }, { status: 400 });
  }

  try {
    const restored = await restoreProtocol(db, {
      shop: targetShop,
      user,
      protocolId
    });

    return Response.json({ ...restored, protocol: restored }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles incoming Shopify webhooks.
 * Extracts topic header (`X-Shopify-Topic`), verifies HMAC signature,
 * dispatches to corresponding handler in `webhooks.js`, and returns 200 OK.
 *
 * @param {any} db Database client
 * @param {Request | any} request HTTP Request or request-like object
 * @param {{ apiSecret: string }} options
 * @returns {Promise<Response>}
 */
export async function handleWebhookRequest(db, request, { apiSecret } = {}) {
  if (!apiSecret) {
    return Response.json({ error: 'Webhook API secret is required' }, { status: 500 });
  }

  const topic = getHeader(request, 'x-shopify-topic');
  if (!topic) {
    return Response.json({ error: 'Missing X-Shopify-Topic header' }, { status: 400 });
  }

  const hmacHeader = getHeader(request, 'x-shopify-hmac-sha256');
  if (!hmacHeader) {
    return new Response('Unauthorized: Missing X-Shopify-Hmac-Sha256 header', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  let rawBody = '';
  let payload = null;

  if (request && typeof request.text === 'function') {
    rawBody = await request.text();
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = {};
    }
  } else if (typeof request?.rawBody === 'string') {
    rawBody = request.rawBody;
    payload = request.body || (rawBody ? JSON.parse(rawBody) : {});
  } else if (typeof request?.body === 'string') {
    rawBody = request.body;
    payload = JSON.parse(rawBody);
  } else if (request?.body && typeof request.body === 'object') {
    payload = request.body;
    rawBody = JSON.stringify(request.body);
  }

  // Verify HMAC signature
  const isValidHmac = verifyWebhookHmac(rawBody, hmacHeader, apiSecret);
  if (!isValidHmac) {
    return new Response('Unauthorized: Webhook HMAC verification failed', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // Ensure shop domain from header if not in payload
  const shopHeader = getHeader(request, 'x-shopify-shop-domain');
  if (shopHeader && payload && !extractShopDomain(payload)) {
    payload.shop_domain = shopHeader;
  }

  const normalizedTopic = topic.toLowerCase().trim();
  let result;

  switch (normalizedTopic) {
    case 'customers/data_request':
      result = await handleCustomersDataRequest(db, payload);
      break;
    case 'customers/redact':
      result = await handleCustomersRedact(db, payload);
      break;
    case 'shop/redact':
      result = await handleShopRedact(db, payload);
      break;
    case 'app/uninstalled':
      result = await handleAppUninstalled(db, payload);
      break;
    case 'orders/paid':
      result = await handleOrdersPaid(db, payload, { shop: shopHeader || undefined });
      break;
    default:
      result = {
        handled: false,
        topic,
        message: `Unhandled topic: ${topic}`
      };
      break;
  }

  return Response.json({ success: true, topic, result }, { status: 200 });
}
