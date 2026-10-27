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
import {
  createRateLimiter,
  createRateLimitKey,
  getClientIp,
  getRateLimitHeaders,
  renderRateLimitLiquid
} from './rate-limit.js';
import {
  resolveVariants,
  enrichProtocolLines,
  searchCatalogProducts
} from './catalog.js';
import { renderPortalLiquid } from './portal.js';
import {
  ProtocolAdminError,
  ADMIN_ERROR_CODES,
  assertNoPii,
  validatePracticeName,
  listPractitionerProfiles,
  getPractitionerProfile,
  updatePracticeName,
  setPractitionerApproval,
  listStarterTemplates,
  createStarterTemplate,
  updateStarterTemplate,
  emergencyDisableAllProtocols,
  emergencyDisableProtocol,
  restoreDisabledProtocol,
  getSettings,
  updateSettings,
  getAttributionReport,
  exportAttributionCsv,
  renderAdminHtml,
  extractAdminSession,
  verifyAdminSessionToken,
  createAdminSessionToken
} from './admin.js';

export {
  createRateLimiter,
  verifyAdminSessionToken,
  createAdminSessionToken,
  extractAdminSession,
  renderAdminHtml
};

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

export const DENIAL_STATUS_MAP = Object.freeze({
  [DENIAL_REASONS.UNAUTHENTICATED]: 401,
  [DENIAL_REASONS.UNAUTHORIZED_ROLE]: 403,
  [DENIAL_REASONS.INVALID_ACTION]: 400,
  [DENIAL_REASONS.PROTOCOL_NOT_FOUND]: 404,
  [DENIAL_REASONS.ADMIN_ONLY_DISABLED_PROTOCOL]: 403,
  [DENIAL_REASONS.STARTER_CREATION_ADMIN_ONLY]: 403,
  [DENIAL_REASONS.STARTER_MODIFICATION_FORBIDDEN]: 403,
  [DENIAL_REASONS.ARCHIVED_PROTOCOL_READ_ONLY]: 403,
  [DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH]: 404 // 404 prevents ID enumeration for cross-owner access
});

// Module-level default rate limiter (Fix 3)
let defaultProxyRateLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 60 });

export function setDefaultProxyRateLimiter(limiter) {
  defaultProxyRateLimiter = limiter;
}

export function getDefaultProxyRateLimiter() {
  return defaultProxyRateLimiter;
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
    const status = DENIAL_STATUS_MAP[err.code] || (err.code === 'NOT_FOUND' ? 404 : 400);

    // Cross-owner access maps to 404 NOT_FOUND to prevent protocol ID enumeration (Fix 6c)
    if (err.code === DENIAL_REASONS.FORBIDDEN_OWNERSHIP_MISMATCH) {
      return Response.json(
        {
          error: 'Protocol not found',
          code: 'NOT_FOUND',
          details: null
        },
        { status: 404 }
      );
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

  if (err instanceof ProtocolAdminError || err?.name === 'ProtocolAdminError') {
    let status = 400;
    if (err.code === ADMIN_ERROR_CODES.UNAUTHORIZED) status = 401;
    else if (err.code === ADMIN_ERROR_CODES.NOT_FOUND) status = 404;
    return Response.json(
      {
        error: err.message,
        code: err.code,
        field: err.field || null
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
export async function handleAppProxyRequest(db, request, options = {}) {
  const { apiSecret, rateLimiter, variantResolver, graphqlExecutor } = options;
  const activeRateLimiter = rateLimiter !== undefined ? rateLimiter : defaultProxyRateLimiter;
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

  // 1. Fail closed if apiSecret is missing or signature invalid. Never fail open.
  if (!apiSecret || typeof apiSecret !== 'string') {
    return new Response('Server configuration error: missing API secret', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  const isValidSignature = verifyAppProxyHmac(queryParams, apiSecret);
  if (!isValidSignature) {
    return new Response('Unauthorized: Invalid HMAC signature', {
      status: 401,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // 2. Extract shop and share token
  const shop = urlObj.searchParams.get('shop') || request?.shop || '';
  let token = urlObj.searchParams.get('token') || request?.token || '';

  if (!token) {
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !['protocols', 'apps', 'tools', 'proxy'].includes(last.toLowerCase())) {
      token = last;
    }
  }

  // 3. Check Rate Limit (defaults to module-level default limiter unless explicitly disabled with null/false)
  if (activeRateLimiter) {
    // TRUSTED PROXY ASSUMPTION:
    // We assume this application is deployed behind a trusted reverse proxy (such as Shopify App Proxy
    // or Cloudflare) which sanitizes incoming client headers. getClientIp uses CF-Connecting-IP (opt-in
    // via TRUST_CF_CONNECTING_IP) or the N-th from rightmost entry of X-Forwarded-For (configured
    // via TRUSTED_PROXY_HOPS, default 1).
    const clientIp = getClientIp(request?.headers);
    const clientKey = createRateLimitKey('proxy', shop || 'storefront', clientIp);

    let isLimited = false;
    let retryAfterSeconds = 60;
    let rateLimitResult = null;

    if (typeof activeRateLimiter.isRateLimited === 'function') {
      rateLimitResult = activeRateLimiter.isRateLimited(clientKey);
      isLimited = rateLimitResult.limited;
      retryAfterSeconds = rateLimitResult.retryAfterSeconds;
    } else if (typeof activeRateLimiter.isAllowed === 'function') {
      isLimited = !activeRateLimiter.isAllowed(clientKey);
    } else if (typeof activeRateLimiter.check === 'function') {
      const chk = activeRateLimiter.check(clientKey);
      if (typeof chk === 'boolean') {
        isLimited = !chk;
      } else if (chk && typeof chk === 'object') {
        isLimited = chk.limited === true;
        if (chk.retryAfterSeconds) retryAfterSeconds = chk.retryAfterSeconds;
      }
    } else if (typeof activeRateLimiter === 'function') {
      const res = await activeRateLimiter(clientKey, request);
      if (typeof res === 'boolean') {
        isLimited = !res;
      } else if (res && typeof res === 'object') {
        isLimited = res.limited === true || res.allowed === false;
        if (res.retryAfterSeconds) retryAfterSeconds = res.retryAfterSeconds;
      }
    }

    if (isLimited) {
      const liquidBody = renderRateLimitLiquid({ retryAfterSeconds });
      const headers = {
        'Content-Type': 'application/liquid; charset=utf-8',
        'Retry-After': String(retryAfterSeconds),
        'X-Robots-Tag': 'noindex, nofollow'
      };
      if (rateLimitResult) {
        Object.assign(headers, getRateLimitHeaders(rateLimitResult, activeRateLimiter.maxRequests || 60));
      }
      return new Response(liquidBody, {
        status: 429,
        headers
      });
    }
  }

  const customerGid = getLoggedInCustomerGid(queryParams);

  // 4. If no token provided on App Proxy root (/apps/protocols), render Practitioner Portal (M3)
  if (!token) {
    if (!customerGid) {
      const portalLiquid = renderPortalLiquid({ shop, isLoggedIn: false });
      return new Response(portalLiquid, {
        status: 200,
        headers: {
          'Content-Type': 'application/liquid; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow'
        }
      });
    }

    let isApproved = false;
    let practiceName = '';
    const numericId = String(customerGid).replace(/^gid:\/\/shopify\/Customer\//, '');

    if (db && typeof db.query === 'function') {
      try {
        const profRes = await db.query(
          'SELECT "id", "isApproved", "practiceName" FROM "PractitionerProfile" WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)',
          [shop, customerGid, numericId]
        );
        if (profRes?.rows?.[0]) {
          isApproved = Boolean(profRes.rows[0].isApproved);
          practiceName = profRes.rows[0].practiceName || '';
        }
      } catch {
        // Non-fatal fallback
      }
    }

    if (!isApproved) {
      const portalLiquid = renderPortalLiquid({
        shop,
        isLoggedIn: true,
        isApproved: false,
        practiceName
      });
      return new Response(portalLiquid, {
        status: 200,
        headers: {
          'Content-Type': 'application/liquid; charset=utf-8',
          'X-Robots-Tag': 'noindex, nofollow'
        }
      });
    }

    // Handle practitioner actions (product search, protocol creation, protocol update)
    const action = urlObj.searchParams.get('action');
    if (action === 'search') {
      const q = urlObj.searchParams.get('q') || '';
      return handleProductSearchRequest(shop, q, options);
    }

    if (action === 'create' || (request?.method === 'POST' && action !== 'search')) {
      try {
        let body = null;
        if (typeof request.json === 'function') {
          body = await request.json();
        } else if (typeof request.text === 'function') {
          const raw = await request.text();
          body = JSON.parse(raw);
        }
        const user = {
          id: customerGid,
          role: 'practitioner',
          ownerType: 'customer',
          ownerId: customerGid,
          shop
        };
        return handleCreateProtocolRequest(db, user, body, { shop });
      } catch (err) {
        return handleErrorResponse(err);
      }
    }

    if (action === 'update' || request?.method === 'PUT') {
      try {
        let body = null;
        if (typeof request.json === 'function') {
          body = await request.json();
        } else if (typeof request.text === 'function') {
          const raw = await request.text();
          body = JSON.parse(raw);
        }
        const protocolId = urlObj.searchParams.get('id');
        const user = {
          id: customerGid,
          role: 'practitioner',
          ownerType: 'customer',
          ownerId: customerGid,
          shop
        };
        return handleUpdateProtocolRequest(db, user, protocolId, body, { shop });
      } catch (err) {
        return handleErrorResponse(err);
      }
    }

    let activeProtocols = [];
    let starterProtocols = [];
    let archivedProtocols = [];

    if (db && typeof db.query === 'function') {
      try {
        const activeRes = await db.query(
          'SELECT * FROM "Protocol" WHERE "shop" = $1 AND ("ownerId" = $2 OR "createdBy" = $2) AND "status" = $3 ORDER BY "updatedAt" DESC',
          [shop, customerGid, 'active']
        );
        activeProtocols = activeRes?.rows || [];

        const startersRes = await db.query(
          'SELECT * FROM "Protocol" WHERE "shop" = $1 AND "isStarter" = true AND "status" = $2 ORDER BY "updatedAt" DESC',
          [shop, 'active']
        );
        starterProtocols = startersRes?.rows || [];

        const archivedRes = await db.query(
          'SELECT * FROM "Protocol" WHERE "shop" = $1 AND ("ownerId" = $2 OR "createdBy" = $2) AND "status" = $3 ORDER BY "updatedAt" DESC',
          [shop, customerGid, 'archived']
        );
        archivedProtocols = archivedRes?.rows || [];
      } catch {
        // Non-fatal fallback
      }
    }

    const portalLiquid = renderPortalLiquid({
      shop,
      isLoggedIn: true,
      isApproved: true,
      practiceName,
      activeProtocols,
      starterProtocols,
      archivedProtocols
    });

    return new Response(portalLiquid, {
      status: 200,
      headers: {
        'Content-Type': 'application/liquid; charset=utf-8',
        'X-Robots-Tag': 'noindex, nofollow'
      }
    });
  }

  // 5. Resolve protocol by token (Client Protocol Page)
  let protocol = null;
  if (token && shop) {
    protocol = await getProtocolByToken(db, { shop, token: token.trim() });
    if (protocol?.lines?.length) {
      if (options?.variantResolver && typeof options.variantResolver.resolveVariants === 'function') {
        const gids = protocol.lines.map((l) => l.variantGid).filter(Boolean);
        const catalogMap = await options.variantResolver.resolveVariants(shop, gids, options);
        protocol.lines = enrichProtocolLines(protocol.lines, catalogMap, { filterUnavailable: true });
      } else if (typeof options?.graphqlExecutor === 'function') {
        const gids = protocol.lines.map((l) => l.variantGid).filter(Boolean);
        const catalogMap = await resolveVariants(shop, gids, options);
        protocol.lines = enrichProtocolLines(protocol.lines, catalogMap, { filterUnavailable: true });
      }
    }
  }

  // 6. Check if logged-in practitioner previewing protocol (requires isApproved = true)
  let isLoggedInPractitioner = false;

  if (customerGid && db && typeof db.query === 'function') {
    try {
      const numericId = String(customerGid).replace(/^gid:\/\/shopify\/Customer\//, '');

      // In Company mode: if logged-in customer created or updated the protocol, check the company profile (protocol.ownerId)
      if (
        protocol?.ownerType === 'company' &&
        (protocol.createdBy === customerGid || protocol.updatedBy === customerGid || protocol.ownerId === customerGid)
      ) {
        const companyGid = protocol.ownerId;
        const companyNumeric = String(companyGid).replace(/^gid:\/\/shopify\/Company\//, '');
        const profileRes = await db.query(
          'SELECT "id", "isApproved" FROM "PractitionerProfile" WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)',
          [shop, companyGid, companyNumeric]
        );
        if (Boolean(profileRes?.rows?.[0]?.isApproved)) {
          isLoggedInPractitioner = true;
        }
      } else {
        // Tag mode (or direct customer profile check)
        const profileRes = await db.query(
          'SELECT "id", "isApproved" FROM "PractitionerProfile" WHERE "shop" = $1 AND ("ownerGid" = $2 OR "ownerGid" = $3)',
          [shop, customerGid, numericId]
        );
        const isApproved = Boolean(profileRes?.rows?.[0]?.isApproved);
        if (isApproved) {
          if (protocol && (protocol.createdBy === customerGid || protocol.ownerId === customerGid)) {
            isLoggedInPractitioner = true;
          } else if (!protocol) {
            isLoggedInPractitioner = true;
          }
        }
      }
    } catch {
      // Non-fatal fallback
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
 * Parses urlencoded form string into an object, supporting nested array syntax like lines[0][variantGid].
 * @param {string} str
 * @returns {Record<string, any>}
 */
export function parseFormEncoded(str) {
  if (!str) return {};
  const params = new URLSearchParams(str);
  const result = {};

  for (const [key, value] of params.entries()) {
    const match = key.match(/^([^\[]+)\[(\d+)\]\[([^\]]+)\]$/);
    if (match) {
      const [, arrName, idxStr, prop] = match;
      const idx = parseInt(idxStr, 10);
      result[arrName] = result[arrName] || [];
      result[arrName][idx] = result[arrName][idx] || {};
      result[arrName][idx][prop] = prop === 'quantity' ? parseInt(value, 10) || 1 : value;
    } else {
      result[key] = value;
    }
  }

  if (Array.isArray(result.lines)) {
    result.lines = result.lines.filter(Boolean);
  }

  return result;
}

/**
 * Parses request body from various input types.
 * @param {any} body
 * @returns {Promise<any>}
 */
export async function parseRequestBody(body) {
  if (body && typeof body.json === 'function') {
    const contentType = body.headers?.get?.('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await body.text();
      return parseFormEncoded(text);
    }
    return await body.json();
  }
  if (body instanceof URLSearchParams) {
    return parseFormEncoded(body.toString());
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return parseFormEncoded(body);
    }
  }
  return body || {};
}

/**
 * Handles product catalog search requests for practitioners curating protocols.
 *
 * @param {string} shop
 * @param {string} query
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleProductSearchRequest(shop, query, options = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return Response.json({ products: [] });
  }

  try {
    let products = [];
    if (options?.variantResolver && typeof options.variantResolver.searchProducts === 'function') {
      products = await options.variantResolver.searchProducts(shop, q);
    } else {
      products = await searchCatalogProducts(shop, q, options);
    }
    return Response.json({ products });
  } catch (err) {
    return Response.json({ error: err.message || 'Product search failed' }, { status: 500 });
  }
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

  // Fix 1b: orders/paid requires X-Shopify-Webhook-Id header for idempotency
  const webhookIdHeader = getHeader(request, 'x-shopify-webhook-id');
  if (normalizedTopic === 'orders/paid' && !webhookIdHeader) {
    return Response.json(
      { error: 'Missing X-Shopify-Webhook-Id header', code: 'MISSING_WEBHOOK_ID' },
      { status: 400 }
    );
  }

  // Fix 2: Wrap handler dispatch in try/catch to ensure errors propagate as retryable 500 JSON
  try {
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
        result = await handleOrdersPaid(db, payload, {
          shop: shopHeader || undefined,
          webhookId: webhookIdHeader
        });
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
  } catch (err) {
    // Non-sensitive error logging (no payloads, no secrets)
    console.error(`[Webhook] Error processing ${topic}: ${err?.message || 'Unknown error'}`);
    return Response.json(
      {
        error: 'Webhook processing failed',
        topic,
        retryable: true
      },
      { status: 500 }
    );
  }
}

// ==========================================
// Admin Route Handlers (Milestone M6)
// ==========================================

/**
 * Handles GET /admin or GET /app embedded Polaris admin dashboard request.
 *
 * @param {any} db Database client
 * @param {Request | any} request Web Request or request-like object
 * @param {{
 *   apiSecret?: string,
 *   apiKey?: string,
 *   expectedShop?: string,
 *   isDemoMode?: boolean,
 *   demoData?: { profiles?: any[], starters?: any[], report?: any, settings?: any }
 * }} [options={}]
 * @returns {Promise<Response>}
 */
export async function handleAdminDashboardRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';

    let urlObj = null;
    if (typeof request === 'string') {
      try { urlObj = new URL(request, 'https://admin.test'); } catch {}
    } else if (request?.url) {
      try { urlObj = new URL(request.url, 'https://admin.test'); } catch {}
    } else if (request instanceof URL) {
      urlObj = request;
    }

    const activeTab = urlObj?.searchParams?.get('tab') || request?.query?.tab || 'practitioners';
    const month = urlObj?.searchParams?.get('month') || request?.query?.month || new Date().toISOString().slice(0, 7);

    let profiles = options.demoData?.profiles || [];
    let starters = options.demoData?.starters || [];
    let report = options.demoData?.report || null;
    let settings = options.demoData?.settings || null;

    if (db && !session.isDemo) {
      const profilesRes = await listPractitionerProfiles(db, { shop });
      profiles = profilesRes.profiles;
      starters = await listStarterTemplates(db, { shop });
      report = await getAttributionReport(db, { shop, month });
      settings = await getSettings(db, { shop });
    }

    const html = renderAdminHtml({
      shop,
      profiles,
      starters,
      report,
      settings,
      activeTab
    });

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles GET /api/admin/practitioners list request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminPractitionersListRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';

    let isApproved = undefined;
    let urlObj = null;
    if (request?.url) {
      try { urlObj = new URL(request.url, 'https://admin.test'); } catch {}
    }
    const approvedParam = urlObj?.searchParams?.get('isApproved') ?? request?.query?.isApproved;
    if (approvedParam !== undefined && approvedParam !== null) {
      isApproved = approvedParam === 'true';
    }

    const result = await listPractitionerProfiles(db, { shop, isApproved });
    return Response.json(result, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles POST /api/admin/practitioners/status approval/revoke request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminPractitionerStatusRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';
    const body = await parseRequestBody(request);

    const ownerGid = body.ownerGid;
    if (!ownerGid) {
      return Response.json({ error: 'ownerGid is required', code: ADMIN_ERROR_CODES.INVALID_INPUT }, { status: 400 });
    }

    const isApproved = body.action ? body.action === 'approve' : Boolean(body.isApproved);
    const profile = await setPractitionerApproval(db, { shop, ownerGid, isApproved });

    // Handle form redirect vs JSON response
    const acceptHeader = getHeader(request, 'accept') || '';
    const contentType = getHeader(request, 'content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || acceptHeader.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin?tab=practitioners' }
      });
    }

    return Response.json({ ok: true, profile }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles POST /api/admin/practitioners/practice-name update request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminPracticeNameRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';
    const body = await parseRequestBody(request);

    const ownerGid = body.ownerGid;
    const practiceName = body.practiceName;

    if (!ownerGid) {
      return Response.json({ error: 'ownerGid is required', code: ADMIN_ERROR_CODES.INVALID_INPUT }, { status: 400 });
    }

    const profile = await updatePracticeName(db, { shop, ownerGid, practiceName });

    const acceptHeader = getHeader(request, 'accept') || '';
    const contentType = getHeader(request, 'content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || acceptHeader.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin?tab=practitioners' }
      });
    }

    return Response.json({ ok: true, profile }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles GET /api/admin/starters list request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminStartersListRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';
    const starters = await listStarterTemplates(db, { shop });
    return Response.json({ starters, count: starters.length }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles POST /api/admin/starters/create starter creation request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminCreateStarterRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';
    const body = await parseRequestBody(request);

    assertNoPii(body);

    const starter = await createStarterTemplate(db, {
      shop,
      adminUser: { id: session.userId, role: 'admin' },
      input: body
    });

    const acceptHeader = getHeader(request, 'accept') || '';
    const contentType = getHeader(request, 'content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || acceptHeader.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin?tab=starters' }
      });
    }

    return Response.json({ ok: true, starter }, { status: 201 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles POST /api/admin/settings update settings request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminUpdateSettingsRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';
    const body = await parseRequestBody(request);

    assertNoPii(body);

    const settings = await updateSettings(db, {
      shop,
      settings: body,
      adminUser: { id: session.userId, role: 'admin' }
    });

    const acceptHeader = getHeader(request, 'accept') || '';
    const contentType = getHeader(request, 'content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || acceptHeader.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin?tab=settings' }
      });
    }

    return Response.json({ ok: true, settings }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles POST /api/admin/emergency/disable-all emergency shutdown request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminEmergencyDisableAllRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';

    const result = await emergencyDisableAllProtocols(db, {
      shop,
      adminUser: { id: session.userId, role: 'admin' }
    });

    const acceptHeader = getHeader(request, 'accept') || '';
    const contentType = getHeader(request, 'content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || acceptHeader.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/admin?tab=settings' }
      });
    }

    return Response.json({ ok: true, disabledCount: result.disabledCount }, { status: 200 });
  } catch (err) {
    return handleErrorResponse(err);
  }
}

/**
 * Handles GET /api/admin/attribution.csv export request.
 *
 * @param {any} db Database client
 * @param {Request | any} request
 * @param {Record<string, any>} [options]
 * @returns {Promise<Response>}
 */
export async function handleAdminAttributionCsvRequest(db, request, options = {}) {
  try {
    const session = extractAdminSession(request, options);
    const shop = session.shop || options.expectedShop || '';

    let urlObj = null;
    if (request?.url) {
      try { urlObj = new URL(request.url, 'https://admin.test'); } catch {}
    }
    const month = urlObj?.searchParams?.get('month') || request?.query?.month || undefined;

    const csv = await exportAttributionCsv(db, { shop, month });
    const filenameMonth = month || 'all';

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attribution-${shop}-${filenameMonth}.csv"`
      }
    });
  } catch (err) {
    return handleErrorResponse(err);
  }
}
