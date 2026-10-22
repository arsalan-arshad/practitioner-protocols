import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter,
  createRateLimitKey,
  getClientIp,
  getRateLimitHeaders,
  renderRateLimitLiquid,
} from '../app/lib/protocols/rate-limit.js';

describe('Sliding Window Rate Limiter (app/lib/protocols/rate-limit.js)', () => {
  describe('Rate Limiting Threshold', () => {
    it('allows requests up to maxRequests and blocks subsequent requests', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 60000,
        maxRequests: 3,
        autoPrune: false,
        now: () => virtualTime,
      });

      // 1st request
      const res1 = limiter.isRateLimited('client-ip-1');
      assert.equal(res1.limited, false);
      assert.equal(res1.remaining, 2);
      assert.equal(res1.retryAfterSeconds, 0);
      assert.equal(res1.resetMs, 60000);

      // 2nd request
      virtualTime += 1000;
      const res2 = limiter.isRateLimited('client-ip-1');
      assert.equal(res2.limited, false);
      assert.equal(res2.remaining, 1);
      assert.equal(res2.retryAfterSeconds, 0);

      // 3rd request (at threshold)
      virtualTime += 1000;
      const res3 = limiter.isRateLimited('client-ip-1');
      assert.equal(res3.limited, false);
      assert.equal(res3.remaining, 0);
      assert.equal(res3.retryAfterSeconds, 0);

      // 4th request (exceeds threshold)
      virtualTime += 500;
      const res4 = limiter.isRateLimited('client-ip-1');
      assert.equal(res4.limited, true);
      assert.equal(res4.remaining, 0);
      assert.ok(res4.resetMs > 0);
      assert.ok(res4.retryAfterSeconds >= 1);

      // Independent keys do not affect each other
      const resOther = limiter.isRateLimited('client-ip-2');
      assert.equal(resOther.limited, false);
      assert.equal(resOther.remaining, 2);
    });

    it('check() inspects status without consuming quota', () => {
      let virtualTime = 5000;
      const limiter = createRateLimiter({
        windowMs: 30000,
        maxRequests: 2,
        now: () => virtualTime,
      });

      // Initially full remaining
      const status0 = limiter.check('token-abc');
      assert.equal(status0.limited, false);
      assert.equal(status0.remaining, 2);

      // Consume 1 request
      limiter.isRateLimited('token-abc');

      // Check should show remaining 1 without decrementing
      const status1 = limiter.check('token-abc');
      assert.equal(status1.limited, false);
      assert.equal(status1.remaining, 1);

      const status2 = limiter.check('token-abc');
      assert.equal(status2.remaining, 1);
    });

    it('supports custom request cost increments', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 60000,
        maxRequests: 5,
        now: () => virtualTime,
      });

      const res1 = limiter.isRateLimited('shop-batch', 3);
      assert.equal(res1.limited, false);
      assert.equal(res1.remaining, 2);

      // Consuming 3 more would exceed remaining 2
      const res2 = limiter.isRateLimited('shop-batch', 3);
      assert.equal(res2.limited, true);
      assert.equal(res2.remaining, 0);

      // Consuming 2 still fits within capacity
      const res3 = limiter.isRateLimited('shop-batch', 2);
      assert.equal(res3.limited, false);
      assert.equal(res3.remaining, 0);
    });
  });

  describe('Sliding Window Expiration', () => {
    it('restores capacity progressively as timestamps slide out of the window', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 10000, // 10s window
        maxRequests: 2,
        autoPrune: false,
        now: () => virtualTime,
      });

      // Request 1 at t=1000
      limiter.isRateLimited('user-key');
      // Request 2 at t=3000
      virtualTime = 3000;
      limiter.isRateLimited('user-key');

      // Blocked at t=5000
      virtualTime = 5000;
      const blocked = limiter.isRateLimited('user-key');
      assert.equal(blocked.limited, true);

      // Advance to t=11001 (Request 1 at t=1000 expired since 11001 - 10000 = 1001 > 1000)
      virtualTime = 11001;
      const allowed = limiter.isRateLimited('user-key');
      assert.equal(allowed.limited, false);
      assert.equal(allowed.remaining, 0); // Request 2 (t=3000) and current request (t=11001) are active

      // Blocked again at t=11500
      virtualTime = 11500;
      assert.equal(limiter.isRateLimited('user-key').limited, true);

      // Advance past t=3000 + 10000 = 13000 -> at t=13001, Request 2 has expired
      virtualTime = 13001;
      const nextAllowed = limiter.isRateLimited('user-key');
      assert.equal(nextAllowed.limited, false);
    });

    it('completely clears counter when all requests slide past the full window', () => {
      let virtualTime = 10000;
      const limiter = createRateLimiter({
        windowMs: 5000,
        maxRequests: 2,
        now: () => virtualTime,
      });

      limiter.isRateLimited('shop-store');
      limiter.isRateLimited('shop-store');
      assert.equal(limiter.isRateLimited('shop-store').limited, true);

      // Jump 10 seconds into the future
      virtualTime += 10000;

      const fresh = limiter.isRateLimited('shop-store');
      assert.equal(fresh.limited, false);
      assert.equal(fresh.remaining, 1);
    });
  });

  describe('Custom Limits & Configuration', () => {
    it('applies custom windowMs and maxRequests', () => {
      const limiter = createRateLimiter({
        windowMs: 500,
        maxRequests: 10,
      });

      assert.equal(limiter.windowMs, 500);
      assert.equal(limiter.maxRequests, 10);

      for (let i = 0; i < 10; i++) {
        const res = limiter.isRateLimited('test-custom');
        assert.equal(res.limited, false);
      }
      assert.equal(limiter.isRateLimited('test-custom').limited, true);
      limiter.destroy();
    });

    it('validates configuration parameters strictly', () => {
      assert.throws(() => createRateLimiter({ windowMs: 0 }), /windowMs must be a positive number/);
      assert.throws(() => createRateLimiter({ windowMs: -100 }), /windowMs must be a positive number/);
      assert.throws(() => createRateLimiter({ windowMs: '60000' }), /windowMs must be a positive number/);
      assert.throws(() => createRateLimiter({ maxRequests: 0 }), /maxRequests must be a positive integer/);
      assert.throws(() => createRateLimiter({ maxRequests: 2.5 }), /maxRequests must be a positive integer/);
      assert.throws(() => createRateLimiter({ pruneIntervalMs: -1 }), /pruneIntervalMs must be a positive number/);
      assert.throws(() => createRateLimiter({ maxKeys: 0 }), /maxKeys must be a positive integer/);
      assert.throws(() => createRateLimiter({ now: 'not-a-fn' }), /now must be a function/);
    });

    it('validates rate limit key and cost inputs', () => {
      const limiter = createRateLimiter();
      assert.throws(() => limiter.isRateLimited(null), /Rate limit key must be provided/);
      assert.throws(() => limiter.isRateLimited(undefined), /Rate limit key must be provided/);
      assert.throws(() => limiter.isRateLimited(''), /Rate limit key cannot be empty/);
      assert.throws(() => limiter.isRateLimited('   '), /Rate limit key cannot be empty/);
      assert.throws(() => limiter.isRateLimited('valid', 0), /cost must be a positive integer/);
      assert.throws(() => limiter.isRateLimited('valid', -1), /cost must be a positive integer/);
      assert.throws(() => limiter.isRateLimited('valid', 1.5), /cost must be a positive integer/);
      limiter.destroy();
    });
  });

  describe('Retry-After Calculations', () => {
    it('accurately computes resetMs and retryAfterSeconds when rate limited', () => {
      let virtualTime = 10000;
      const windowMs = 30000;
      const limiter = createRateLimiter({
        windowMs,
        maxRequests: 2,
        autoPrune: false,
        now: () => virtualTime,
      });

      // Request 1 at t=10000 (expires at t=40000)
      limiter.isRateLimited('client-token');
      // Request 2 at t=15000 (expires at t=45000)
      virtualTime = 15000;
      limiter.isRateLimited('client-token');

      // Request 3 at t=20000 is rejected
      virtualTime = 20000;
      const blocked = limiter.isRateLimited('client-token');
      assert.equal(blocked.limited, true);

      // Oldest timestamp is t=10000. Reset occurs at t=40000.
      // Expected resetMs = 40000 - 20000 = 20000ms
      assert.equal(blocked.resetMs, 20000);
      assert.equal(blocked.retryAfterSeconds, 20);

      // Advance by 1500ms (t=21500)
      virtualTime = 21500;
      const blocked2 = limiter.isRateLimited('client-token');
      assert.equal(blocked2.resetMs, 18500);
      // Math.ceil(18500 / 1000) = 19 seconds
      assert.equal(blocked2.retryAfterSeconds, 19);
    });

    it('ensures retryAfterSeconds is at least 1 second when limited and resetMs is fractional', () => {
      let virtualTime = 10000;
      const limiter = createRateLimiter({
        windowMs: 5000,
        maxRequests: 1,
        autoPrune: false,
        now: () => virtualTime,
      });

      limiter.isRateLimited('key-fast');
      // Advance to 50ms before reset
      virtualTime = 14950;
      const blocked = limiter.isRateLimited('key-fast');
      assert.equal(blocked.limited, true);
      assert.equal(blocked.resetMs, 50);
      assert.equal(blocked.retryAfterSeconds, 1);
    });
  });

  describe('Memory Cleanup and Leak Prevention', () => {
    it('manually and opportunistically prunes expired keys to zero memory footprint', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 5000,
        maxRequests: 2,
        autoPrune: false,
        now: () => virtualTime,
      });

      limiter.isRateLimited('client-1');
      limiter.isRateLimited('client-2');
      limiter.isRateLimited('client-3');

      assert.equal(limiter.size, 3);
      assert.equal(limiter.has('client-1'), true);

      // Advance past windowMs (t = 1000 + 5001 = 6001)
      virtualTime = 6001;

      // Manual prune cleans expired keys
      const pruned = limiter.prune();
      assert.equal(pruned, 3);
      assert.equal(limiter.size, 0);
      assert.equal(limiter.has('client-1'), false);
    });

    it('opportunistic auto-pruning runs during active operations', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 2000,
        maxRequests: 2,
        pruneIntervalMs: 1500,
        autoPrune: true,
        now: () => virtualTime,
      });

      limiter.isRateLimited('old-key');
      assert.equal(limiter.has('old-key'), true);

      // Advance time beyond pruneIntervalMs + windowMs
      virtualTime = 4000;

      // Next operation on any key triggers opportunistic prune of expired keys
      limiter.isRateLimited('new-key');
      assert.equal(limiter.has('old-key'), false);
      assert.equal(limiter.has('new-key'), true);
      assert.equal(limiter.size, 1);

      limiter.destroy();
    });

    it('caps memory via maxKeys eviction under high volume / DoS attacks', () => {
      let virtualTime = 1000;
      const limiter = createRateLimiter({
        windowMs: 60000,
        maxRequests: 5,
        maxKeys: 5, // Strict max capacity
        autoPrune: true,
        now: () => virtualTime,
      });

      // Insert 8 distinct keys rapidly
      for (let i = 1; i <= 8; i++) {
        limiter.isRateLimited(`client-burst-${i}`);
      }

      // Memory must be capped at maxKeys
      assert.ok(limiter.size <= 5, `Store size ${limiter.size} must not exceed maxKeys 5`);

      limiter.destroy();
    });

    it('reset() clears specific keys or the entire store', () => {
      const limiter = createRateLimiter({ autoPrune: false });
      limiter.isRateLimited('key-a');
      limiter.isRateLimited('key-b');
      assert.equal(limiter.size, 2);

      // Reset specific key
      limiter.reset('key-a');
      assert.equal(limiter.size, 1);
      assert.equal(limiter.has('key-a'), false);
      assert.equal(limiter.has('key-b'), true);

      // Reset all keys
      limiter.reset();
      assert.equal(limiter.size, 0);
      limiter.destroy();
    });

    it('destroy() halts timers and cleans up store completely', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
      limiter.isRateLimited('test');
      assert.equal(limiter.size, 1);

      limiter.destroy();
      assert.equal(limiter.size, 0);
    });
  });

  describe('Identifier Support (IP, Token, Shop, Composite)', () => {
    it('supports direct IP addresses, share tokens, and shop domains as keys', () => {
      const limiter = createRateLimiter({ maxRequests: 2 });

      assert.equal(limiter.isRateLimited('192.168.1.100').limited, false);
      assert.equal(limiter.isRateLimited('2001:0db8:85a3:0000:0000:8a2e:0370:7334').limited, false);
      assert.equal(limiter.isRateLimited('tok_shareable16char').limited, false);
      assert.equal(limiter.isRateLimited('wellness-brand.myshopify.com').limited, false);

      limiter.destroy();
    });

    it('createRateLimitKey formats sanitized composite keys', () => {
      const key1 = createRateLimitKey('ip', '10.0.0.1');
      assert.equal(key1, 'ip:10.0.0.1');

      const key2 = createRateLimitKey('proxy', 'my-shop.myshopify.com', 'tok_abc', '10.0.0.1');
      assert.equal(key2, 'proxy:my-shop.myshopify.com:tok_abc:10.0.0.1');

      assert.throws(() => createRateLimitKey(), /At least one key component/);
      assert.throws(() => createRateLimitKey('ip', null), /Key component cannot be null/);
      assert.throws(() => createRateLimitKey('ip', '  '), /Key component cannot be empty/);
    });

    it('getClientIp extracts IP safely across proxy headers with zero client PII', () => {
      // Cloudflare header
      assert.equal(getClientIp({ 'cf-connecting-ip': '203.0.113.195' }), '203.0.113.195');

      // Nginx Real-IP
      assert.equal(getClientIp({ 'x-real-ip': '198.51.100.17' }), '198.51.100.17');

      // Multi-hop X-Forwarded-For: uses RIGHTMOST entry appended by trusted reverse proxy, preventing client spoofing
      assert.equal(
        getClientIp({ 'x-forwarded-for': '192.0.2.1, 10.0.0.1, 172.16.0.1' }),
        '172.16.0.1',
        'Must use rightmost X-Forwarded-For entry from trusted proxy'
      );

      // Forging leftmost XFF does not change bucket (both resolve to rightmost 172.16.0.1)
      const forged1 = getClientIp({ 'x-forwarded-for': 'attacker1.ip, 172.16.0.1' });
      const forged2 = getClientIp({ 'x-forwarded-for': 'attacker2.ip, 172.16.0.1' });
      assert.equal(forged1, '172.16.0.1');
      assert.equal(forged2, '172.16.0.1');
      assert.equal(forged1, forged2, 'Forging leftmost XFF must not change rate limit bucket');

      // Requests with no headers or connection share 'unknown' bucket
      assert.equal(getClientIp({}), 'unknown', 'Requests with no headers must share unknown bucket');
      assert.equal(getClientIp(), 'unknown');

      // Connection socket fallback
      assert.equal(getClientIp({}, { remoteAddress: '127.0.0.1' }), '127.0.0.1');

      // Strips IPv6-mapped IPv4 prefix
      assert.equal(getClientIp({ 'x-real-ip': '::ffff:192.168.1.5' }), '192.168.1.5');

      // Standard Fetch Headers instance
      const fetchHeaders = new Headers();
      fetchHeaders.set('X-Forwarded-For', '203.0.113.88');
      assert.equal(getClientIp(fetchHeaders), '203.0.113.88');
    });

    it('getClientIp supports configurable trusted proxy hops via TRUSTED_PROXY_HOPS (Item 2)', () => {
      const headers = { 'x-forwarded-for': 'client.ip, proxy1.ip, proxy2.ip' };

      // Default (hop count 1): rightmost entry (proxy2.ip)
      assert.equal(getClientIp(headers), 'proxy2.ip');

      // Hop count 1 explicitly via env var:
      process.env.TRUSTED_PROXY_HOPS = '1';
      assert.equal(getClientIp(headers), 'proxy2.ip');

      // Hop count 2 via env var: second from right (proxy1.ip)
      process.env.TRUSTED_PROXY_HOPS = '2';
      assert.equal(getClientIp(headers), 'proxy1.ip');

      delete process.env.TRUSTED_PROXY_HOPS;
    });
  });

  describe('HTTP Headers and App Proxy Liquid Markup', () => {
    it('getRateLimitHeaders constructs standard HTTP rate limit response headers', () => {
      const allowedResult = {
        limited: false,
        remaining: 45,
        resetMs: 12000,
        retryAfterSeconds: 0,
      };
      const allowedHeaders = getRateLimitHeaders(allowedResult, 60);
      assert.equal(allowedHeaders['X-RateLimit-Limit'], '60');
      assert.equal(allowedHeaders['X-RateLimit-Remaining'], '45');
      assert.equal(allowedHeaders['X-RateLimit-Reset'], '12');
      assert.equal(allowedHeaders['Retry-After'], undefined);

      const limitedResult = {
        limited: true,
        remaining: 0,
        resetMs: 14500,
        retryAfterSeconds: 15,
      };
      const limitedHeaders = getRateLimitHeaders(limitedResult, 60);
      assert.equal(limitedHeaders['X-RateLimit-Limit'], '60');
      assert.equal(limitedHeaders['X-RateLimit-Remaining'], '0');
      assert.equal(limitedHeaders['X-RateLimit-Reset'], '15');
      assert.equal(limitedHeaders['Retry-After'], '15');
    });

    it('renderRateLimitLiquid includes robots noindex and retry-after notice', () => {
      const liquid = renderRateLimitLiquid({ retryAfterSeconds: 30 });
      assert.ok(liquid.includes('<meta name="robots" content="noindex, nofollow">'));
      assert.ok(liquid.includes('Too Many Requests'));
      assert.ok(liquid.includes('30 seconds'));

      const liquidSingular = renderRateLimitLiquid({ retryAfterSeconds: 1 });
      assert.ok(liquidSingular.includes('1 second'));
      assert.ok(!liquidSingular.includes('1 seconds'));
    });
  });
});
