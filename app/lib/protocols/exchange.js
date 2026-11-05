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
  const bodyParams = new URLSearchParams({
    client_id: apiKey,
    client_secret: apiSecret,
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    subject_token: idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    requested_token_type: TOKEN_TYPE_OFFLINE_ACCESS,
    expiring: '0'
  });

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: bodyParams.toString(),
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
      scope: data.scope || 'read_orders'
    };
  } catch (err) {
    const status = err?.name === 'AbortError' ? 'timeout' : (err?.status || 'network_error');
    console.warn(`[TokenExchange] failed shop=${shop} status=${status}`);
    return null;
  }
}

/**
 * Ensures an offline session exists for the given shop.
 * If missing and valid credentials exist, performs token exchange, upserts Session,
 * and synchronizes ShopProfile via GraphQL (non-blocking on failure).
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
 * @returns {Promise<{ shop: string, success: boolean } | null>}
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

  // 1. Check if offline session already exists in DB
  try {
    const existing = await db.query(
      'SELECT "id" FROM "Session" WHERE "shop" = $1 AND "isOnline" = false LIMIT 1',
      [shop]
    );
    if (existing?.rows?.length > 0) {
      return { shop, success: true, existing: true };
    }
  } catch (err) {
    // If DB check fails, continue or return null
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

      // Upsert Session with encrypted access token
      const encryptedToken = encryptAccessToken(exchangeResult.accessToken);
      await db.query(
        `INSERT INTO "Session" ("id", "shop", "state", "isOnline", "scope", "accessToken")
         VALUES ($1, $2, $3, false, $4, $5)
         ON CONFLICT ("id") DO UPDATE SET
           "shop" = EXCLUDED."shop",
           "state" = EXCLUDED."state",
           "scope" = EXCLUDED."scope",
           "accessToken" = EXCLUDED."accessToken"`,
        [`offline_${shop}`, shop, 'authenticated', exchangeResult.scope, encryptedToken]
      );

      // Synchronize ShopProfile (awaited, non-blocking on failure)
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
