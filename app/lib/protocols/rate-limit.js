/**
 * Pure JavaScript Sliding Window Rate Limiter
 * Zero external dependencies. Zero client PII.
 * Designed for Shopify App Proxy and Storefront hardening (SPEC §11, BUILD_PLAN §M7).
 */

/**
 * Creates a sliding window rate limiter instance.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] - Window duration in milliseconds (default 60s)
 * @param {number} [options.maxRequests=60] - Maximum requests allowed per window (default 60)
 * @param {number} [options.pruneIntervalMs] - Auto-prune interval in milliseconds (defaults to windowMs capped at 60s)
 * @param {number} [options.maxKeys=10000] - Maximum active keys tracked before eviction (DoS protection)
 * @param {boolean} [options.autoPrune=true] - Whether to automatically prune expired keys
 * @param {() => number} [options.now] - Clock function returning timestamp in ms (defaults to Date.now)
 * @returns {RateLimiter}
 */
export function createRateLimiter(options = {}) {
  const {
    windowMs = 60000,
    maxRequests = 60,
    pruneIntervalMs = Math.min(windowMs, 60000),
    maxKeys = 10000,
    autoPrune = true,
    now = () => Date.now(),
  } = options;

  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive number');
  }
  if (typeof maxRequests !== 'number' || !Number.isInteger(maxRequests) || maxRequests <= 0) {
    throw new RangeError('maxRequests must be a positive integer');
  }
  if (typeof pruneIntervalMs !== 'number' || !Number.isFinite(pruneIntervalMs) || pruneIntervalMs <= 0) {
    throw new RangeError('pruneIntervalMs must be a positive number');
  }
  if (typeof maxKeys !== 'number' || !Number.isInteger(maxKeys) || maxKeys <= 0) {
    throw new RangeError('maxKeys must be a positive integer');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function returning current timestamp in milliseconds');
  }

  // Key -> Array<number> (monotonic timestamps of accepted requests within window)
  const store = new Map();
  let lastAutoPrune = now();
  let timer = null;

  /**
   * Prunes all expired timestamps across all keys in the store.
   * If a key has no remaining timestamps, it is removed from memory.
   * If memory exceeds maxKeys, oldest keys are evicted (LRU defense).
   *
   * @param {number} [currentTime]
   * @returns {number} Number of keys pruned/evicted
   */
  function prune(currentTime = now()) {
    const windowStart = currentTime - windowMs;
    let prunedCount = 0;

    for (const [k, timestamps] of store.entries()) {
      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        store.delete(k);
        prunedCount++;
      }
    }

    // DoS defense: evict oldest keys if memory limit exceeded
    if (store.size > maxKeys) {
      const excess = store.size - maxKeys;
      let evicted = 0;
      for (const k of store.keys()) {
        if (evicted >= excess) break;
        store.delete(k);
        evicted++;
        prunedCount++;
      }
    }

    return prunedCount;
  }

  if (autoPrune && typeof setInterval === 'function') {
    timer = setInterval(() => {
      prune();
    }, pruneIntervalMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function validateKey(key) {
    if (key === null || key === undefined) {
      throw new TypeError('Rate limit key must be provided');
    }
    const keyStr = String(key).trim();
    if (!keyStr) {
      throw new TypeError('Rate limit key cannot be empty');
    }
    return keyStr;
  }

  /**
   * Checks whether the request for the given key exceeds rate limits.
   * If allowed, records the request and decrements remaining quota.
   *
   * @param {string} rawKey - Identifier (IP, token, shop domain, or composite key)
   * @param {number} [cost=1] - Number of requests to consume (default 1)
   * @returns {{ limited: boolean, remaining: number, resetMs: number, retryAfterSeconds: number }}
   */
  function isRateLimited(rawKey, cost = 1) {
    const key = validateKey(rawKey);

    if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) {
      throw new RangeError('cost must be a positive integer');
    }

    const currentNow = now();

    // Opportunistic pruning check
    if (autoPrune && (currentNow - lastAutoPrune >= pruneIntervalMs || store.size >= maxKeys)) {
      prune(currentNow);
      lastAutoPrune = currentNow;
    }

    const windowStart = currentNow - windowMs;
    let timestamps = store.get(key);

    if (timestamps) {
      while (timestamps.length > 0 && timestamps[0] <= windowStart) {
        timestamps.shift();
      }
    } else {
      timestamps = [];
    }

    // Check capacity
    if (timestamps.length + cost <= maxRequests) {
      for (let i = 0; i < cost; i++) {
        timestamps.push(currentNow);
      }
      store.set(key, timestamps);

      // Enforce strict memory cap immediately upon insertion
      if (store.size > maxKeys) {
        const excess = store.size - maxKeys;
        let evicted = 0;
        for (const k of store.keys()) {
          if (evicted >= excess) break;
          if (k !== key) {
            store.delete(k);
            evicted++;
          }
        }
      }

      const remaining = maxRequests - timestamps.length;
      const resetMs = Math.max(0, (timestamps[0] + windowMs) - currentNow);

      return {
        limited: false,
        remaining,
        resetMs,
        retryAfterSeconds: 0,
      };
    }

    // Rate limited
    const oldestTimestamp = timestamps.length > 0 ? timestamps[0] : currentNow;
    const resetMs = Math.max(1, (oldestTimestamp + windowMs) - currentNow);
    const retryAfterSeconds = Math.max(1, Math.ceil(resetMs / 1000));

    return {
      limited: true,
      remaining: 0,
      resetMs,
      retryAfterSeconds,
    };
  }

  /**
   * Inspects current rate limit status without consuming quota.
   *
   * @param {string} rawKey
   * @returns {{ limited: boolean, remaining: number, resetMs: number, retryAfterSeconds: number }}
   */
  function check(rawKey) {
    const key = validateKey(rawKey);
    const currentNow = now();
    const windowStart = currentNow - windowMs;
    const timestamps = store.get(key);

    if (!timestamps) {
      return {
        limited: false,
        remaining: maxRequests,
        resetMs: 0,
        retryAfterSeconds: 0,
      };
    }

    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length === 0) {
      store.delete(key);
      return {
        limited: false,
        remaining: maxRequests,
        resetMs: 0,
        retryAfterSeconds: 0,
      };
    }

    const limited = timestamps.length >= maxRequests;
    const remaining = Math.max(0, maxRequests - timestamps.length);
    const resetMs = Math.max(1, (timestamps[0] + windowMs) - currentNow);
    const retryAfterSeconds = limited ? Math.max(1, Math.ceil(resetMs / 1000)) : 0;

    return {
      limited,
      remaining,
      resetMs,
      retryAfterSeconds,
    };
  }

  /**
   * Resets limit counter for a specific key, or clears all keys.
   *
   * @param {string} [rawKey]
   * @returns {boolean}
   */
  function reset(rawKey) {
    if (rawKey === undefined || rawKey === null) {
      store.clear();
      return true;
    }
    const key = String(rawKey).trim();
    return store.delete(key);
  }

  /**
   * Checks if an active (non-expired) entry exists for the key.
   *
   * @param {string} rawKey
   * @returns {boolean}
   */
  function has(rawKey) {
    if (rawKey === undefined || rawKey === null) return false;
    const key = String(rawKey).trim();
    if (!key) return false;

    const currentNow = now();
    const windowStart = currentNow - windowMs;
    const timestamps = store.get(key);
    if (!timestamps) return false;

    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length === 0) {
      store.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Cleans up background timers and resets state.
   */
  function destroy() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    store.clear();
  }

  return {
    isRateLimited,
    check,
    reset,
    prune,
    destroy,
    has,
    get size() {
      return store.size;
    },
    get windowMs() {
      return windowMs;
    },
    get maxRequests() {
      return maxRequests;
    },
  };
}

/**
 * Creates a sanitized composite rate limit key from multiple components.
 * Supports custom identifiers (client IP, token, shop domain).
 *
 * @param  {...unknown} parts
 * @returns {string}
 */
export function createRateLimitKey(...parts) {
  if (parts.length === 0) {
    throw new TypeError('At least one key component must be provided');
  }
  const cleanParts = parts.map((part) => {
    if (part === null || part === undefined) {
      throw new TypeError('Key component cannot be null or undefined');
    }
    const str = String(part).trim();
    if (!str) {
      throw new TypeError('Key component cannot be empty');
    }
    return str;
  });
  return cleanParts.join(':');
}

/**
 * Safely extracts client IP address from standard reverse proxy headers.
 * Extracts only technical network address with zero client PII.
 *
 * @param {Record<string, string | string[]> | Headers} [headers={}]
 * @param {{ remoteAddress?: string, socket?: { remoteAddress?: string } }} [connection={}]
 * @returns {string} Sanitized client IP address
 */
export function getClientIp(headers = {}, connection = {}) {
  const normalized = {};
  if (headers && typeof headers === 'object') {
    if (typeof headers.get === 'function') {
      // Standard Fetch Headers object
      for (const [k, v] of headers.entries()) {
        normalized[k.toLowerCase()] = v;
      }
    } else {
      for (const [k, v] of Object.entries(headers)) {
        normalized[k.toLowerCase()] = v;
      }
    }
  }

  const candidate =
    normalized['cf-connecting-ip'] ||
    normalized['x-real-ip'] ||
    normalized['x-forwarded-for'] ||
    connection.remoteAddress ||
    connection.socket?.remoteAddress ||
    '127.0.0.1';

  const rawIp = String(candidate).split(',')[0].trim();
  return rawIp.replace(/^::ffff:/, '') || '127.0.0.1';
}

/**
 * Builds RFC-compliant and standard HTTP rate limit response headers.
 *
 * @param {{ limited: boolean, remaining: number, resetMs: number, retryAfterSeconds: number }} result
 * @param {number} [maxRequests=60]
 * @returns {Record<string, string>}
 */
export function getRateLimitHeaders(result, maxRequests = 60) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('Rate limit result object required');
  }
  const headers = {
    'X-RateLimit-Limit': String(maxRequests),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining ?? 0)),
    'X-RateLimit-Reset': String(Math.ceil((result.resetMs ?? 0) / 1000)),
  };
  if (result.limited) {
    headers['Retry-After'] = String(Math.max(1, result.retryAfterSeconds ?? 1));
  }
  return headers;
}

/**
 * Renders user-friendly Liquid markup when an App Proxy request is rate limited (HTTP 429).
 * Always includes `<meta name="robots" content="noindex, nofollow">`.
 *
 * @param {object} [options]
 * @param {number} [options.retryAfterSeconds=60]
 * @returns {string} Liquid markup string
 */
export function renderRateLimitLiquid({ retryAfterSeconds = 60 } = {}) {
  const retrySec = typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
    ? Math.ceil(retryAfterSeconds)
    : 60;

  return `<meta name="robots" content="noindex, nofollow">
<style>
  .protocol-container {
    max-width: 820px;
    margin: 2rem auto;
    padding: 0 1.25rem;
    font-family: inherit;
    color: #1f2937;
    line-height: 1.5;
  }
  .protocol-status-card {
    text-align: center;
    padding: 4rem 1.5rem;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    margin: 3rem auto;
    max-width: 540px;
  }
  .protocol-status-icon {
    margin-bottom: 1.25rem;
    color: #eab308;
  }
  .protocol-status-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
    margin: 0 0 0.75rem 0;
  }
  .protocol-status-message {
    font-size: 1rem;
    color: #6b7280;
    margin: 0 0 1rem 0;
    line-height: 1.6;
  }
  .protocol-retry-after {
    font-size: 0.875rem;
    font-weight: 600;
    color: #4b5563;
    background-color: #f3f4f6;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    display: inline-block;
  }
</style>
<div class="protocol-container">
  <div class="protocol-status-card protocol-rate-limited">
    <div class="protocol-status-icon">
      <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
    <h1 class="protocol-status-title">Too Many Requests</h1>
    <p class="protocol-status-message">You have made too many requests in a short period. Please wait a moment before trying again.</p>
    <div class="protocol-retry-after">Please retry in ${retrySec} second${retrySec === 1 ? '' : 's'}.</div>
  </div>
</div>`;
}
