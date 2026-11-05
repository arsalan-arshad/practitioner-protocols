/**
 * @file Shopify Token Exchange Service (Shopify Managed Installation).
 * 
 * Implements RFC 8693 token exchange for Shopify embedded applications:
 * exchanges an App Bridge session token (id_token) for an offline access token
 * without running the interactive browser redirect OAuth flow.
 * 
 * Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
 */

import { encryptAccessToken } from './crypto.js';
import { syncShopProfile } from './contacts.js';

export const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
export const TOKEN_TYPE_OFFLINE_ACCESS = 'urn:shopify:params:oauth:token-type:offline-access-token';

/** In-flight exchange promises per shop to prevent concurrent exchange storms */
const inFlightExchanges = new Map();

/** Negative result cache: maps shop domain to timestamp (ms) of failure */
const negativeCache = new Map();

/** Negative cache TTL: 60 seconds */
export const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

/**
 * Resets token exchange in-memory caches (for unit and integration tests).
 */
export function _resetTokenExchangeCaches() {
  inFlightExchanges.clear();
  negativeCache.clear();
}

/**
 * Performs raw HTTP token exchange with Shopify Admin OAuth endpoint.
 * Strictly logs non-sensitive status lines on failure; never logs tokens,
 * id_tokens, client secrets, or response bodies.
 *
 * @param {{
 *   shop: string,
 *   idToken: string,
 *   apiKey: string,
 *   apiSecret: string,
 *   fetchFn?: typeof fetch
 * }} params
 * @returns {Promise<{ accessToken: string, scope: string } | null>}
 */
export async function performTokenExchange({
  shop,
  idToken,
  apiKey,
  apiSecret,
  fetchFn = fetch
}) {
  if (!shop || !idToken || !apiKey || !apiSecret) {
    return null;
  }

  const endpoint = `https://${shop}/admin/oauth/access_token`;
  const payload = {
    client_id: apiKey,
    client_secret: apiSecret,
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    requested_token_type: TOKEN_TYPE_OFFLINE_ACCESS,
    expiring: 1
  };

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller?.signal
    });

    if (timeoutId) clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[TokenExchange] failed shop=${shop} status=${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!data || !data.access_token) {
      console.warn(`[TokenExchange] failed shop=${shop} status=502`);
      return null;
    }

    return {
      accessToken: data.access_token,
      scope: data.scope || 'read_orders',
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
      refreshToken: data.refresh_token || null,
      refreshTokenExpiresIn: typeof data.refresh_token_expires_in === 'number' ? data.refresh_token_expires_in : null
    };
  } catch (err) {
    const status = err?.name === 'AbortError' ? 'timeout' : (err?.status || 'network_error');
    console.warn(`[TokenExchange] failed shop=${shop} status=${status}`);
    return null;
  }
}

/**
 * Ensures an offline session exists and is currently valid for the given shop.
 *
 * Expiring Offline Tokens Policy:
 * Shopify mandates expiring offline access tokens for public apps calling the Admin API.
 * A session is considered USABLE only if `expires` is NOT NULL and `expires > now + 5 minutes`.
 * If missing, NULL expires (legacy non-expiring token), or expiring within 5 minutes,
 * performs an RFC 8693 token exchange using the fresh `id_token` provided with the request.
 *
 * Zero Refresh Token Storage:
 * Refresh tokens are intentionally NOT stored in the database to minimize secrets at rest.
 * Because Practitioner Protocols executes Admin API calls strictly in response to merchant
 * embedded-admin actions (and never in offline background workers), acquiring a fresh token
 * via id_token exchange on admin request renders an asynchronous refresh flow unnecessary.
 *
 * Concurrency & Caching:
 * - Employs a per-shop in-flight lock to deduplicate concurrent exchange requests.
 * - Caches negative results for 60 seconds to protect Shopify rate limits.
 *
 * @param {any} db Database client
 * @param {{
 *   shop: string,
 *   idToken: string,
 *   apiKey: string,
 *   apiSecret: string,
 *   fetchFn?: typeof fetch
 * }} params
 * @returns {Promise<{ shop: string, success: boolean, existing?: boolean } | null>}
 */
export async function ensureOfflineSession(db, {
  shop,
  idToken,
  apiKey,
  apiSecret,
  fetchFn = fetch
}) {
  if (!db || !shop || !idToken || !apiKey || !apiSecret) {
    return null;
  }

  // 1. Check if offline session already exists in DB and is still usable (> 5 mins remaining)
  try {
    const existing = await db.query(
      'SELECT "id", "accessToken", "expires" FROM "Session" WHERE "shop" = $1 AND "isOnline" = false LIMIT 1',
      [shop]
    );
    const row = existing?.rows?.[0];
    if (row && row.expires) {
      const expiresAt = new Date(row.expires).getTime();
      const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
      if (expiresAt > fiveMinutesFromNow) {
        return { shop, success: true, existing: true };
      }
    }
  } catch (err) {
    // If DB check fails, continue to token exchange
  }

  // 2. Check 60-second negative cache
  const failedAt = negativeCache.get(shop);
  if (failedAt && Date.now() - failedAt < NEGATIVE_CACHE_TTL_MS) {
    return null;
  }

  // 3. Deduplicate concurrent requests with per-shop in-flight lock
  if (inFlightExchanges.has(shop)) {
    return await inFlightExchanges.get(shop);
  }

  const exchangePromise = (async () => {
    try {
      const exchangeResult = await performTokenExchange({
        shop,
        idToken,
        apiKey,
        apiSecret,
        fetchFn
      });

      if (!exchangeResult) {
        negativeCache.set(shop, Date.now());
        return null;
      }

      // Success: clear negative cache
      negativeCache.delete(shop);

      // Expiration timestamp: now + expiresIn seconds (~3600s)
      const expiresInSec = typeof exchangeResult.expiresIn === 'number' ? exchangeResult.expiresIn : 3600;
      const expiresDate = new Date(Date.now() + expiresInSec * 1000);

      // Upsert Session with encrypted access token and expires date.
      // Refresh token is intentionally NOT stored (fewer secrets at rest).
      // Every embedded admin request provides a fresh id_token, so re-exchange
      // on admin load is sufficient; no background refresh flow is required.
      const encryptedToken = encryptAccessToken(exchangeResult.accessToken);
      await db.query(
        `INSERT INTO "Session" ("id", "shop", "state", "isOnline", "scope", "accessToken", "expires", "refreshToken", "refreshTokenExpires")
         VALUES ($1, $2, $3, false, $4, $5, $6, NULL, NULL)
         ON CONFLICT ("id") DO UPDATE SET
           "shop" = EXCLUDED."shop",
           "state" = EXCLUDED."state",
           "scope" = EXCLUDED."scope",
           "accessToken" = EXCLUDED."accessToken",
           "expires" = EXCLUDED."expires",
           "refreshToken" = NULL,
           "refreshTokenExpires" = NULL`,
        [`offline_${shop}`, shop, 'authenticated', exchangeResult.scope, encryptedToken, expiresDate]
      );

      // Synchronize ShopProfile with NEW token in the same request (awaited, non-blocking on failure)
      try {
        await syncShopProfile(db, {
          shop,
          accessToken: exchangeResult.accessToken,
          apiKey,
          apiSecret,
          fetchFn
        });
      } catch (syncErr) {
        console.warn(`[ShopProfile] Failed to sync profile for ${shop} on token exchange: ${syncErr?.message || 'Unknown error'}`);
      }

      return { shop, success: true };
    } catch (err) {
      negativeCache.set(shop, Date.now());
      return null;
    } finally {
      inFlightExchanges.delete(shop);
    }
  })();

  inFlightExchanges.set(shop, exchangePromise);
  return await exchangePromise;
}
