import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptAccessToken,
  decryptAccessToken,
  resolveEncryptionKey,
  _resetEncryptionKeyWarning
} from '../app/lib/protocols/crypto.js';

describe('Token Encryption at Rest (app/lib/protocols/crypto.js)', () => {
  const sampleKey32Bytes = crypto.randomBytes(32);
  const sampleKeyBase64 = sampleKey32Bytes.toString('base64');
  const sampleKeyHex = sampleKey32Bytes.toString('hex');

  beforeEach(() => {
    _resetEncryptionKeyWarning();
  });

  describe('Key Resolution', () => {
    it('resolves 32-byte base64 keys into buffers', () => {
      const buf = resolveEncryptionKey(sampleKeyBase64);
      assert.ok(buf);
      assert.equal(buf.length, 32);
      assert.deepEqual(buf, sampleKey32Bytes);
    });

    it('resolves 64-character hex keys into buffers', () => {
      const buf = resolveEncryptionKey(sampleKeyHex);
      assert.ok(buf);
      assert.equal(buf.length, 32);
      assert.deepEqual(buf, sampleKey32Bytes);
    });

    it('returns null for empty or undefined keys', () => {
      assert.equal(resolveEncryptionKey(''), null);
      assert.equal(resolveEncryptionKey(undefined), null);
      assert.equal(resolveEncryptionKey('   '), null);
    });

    it('throws error for invalid key lengths', () => {
      assert.throws(() => resolveEncryptionKey('too-short'), {
        message: /SESSION_ENCRYPTION_KEY must resolve to exactly 32 bytes/
      });
    });
  });

  describe('Encryption & Decryption Round-Trip', () => {
    const rawToken = 'mock_shpat_0123456789abcdef_test_offline_token';

    it('encrypts to enc:v1:<iv>:<tag>:<ciphertext> format and decrypts cleanly', () => {
      const encrypted = encryptAccessToken(rawToken, sampleKeyBase64);
      assert.match(encrypted, /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

      const decrypted = decryptAccessToken(encrypted, sampleKeyBase64);
      assert.equal(decrypted, rawToken);
    });

    it('works with hex key representations', () => {
      const encrypted = encryptAccessToken(rawToken, sampleKeyHex);
      const decrypted = decryptAccessToken(encrypted, sampleKeyHex);
      assert.equal(decrypted, rawToken);
    });

    it('generates different ciphertexts for identical tokens (unique IVs)', () => {
      const enc1 = encryptAccessToken(rawToken, sampleKeyBase64);
      const enc2 = encryptAccessToken(rawToken, sampleKeyBase64);
      assert.notEqual(enc1, enc2);
      assert.equal(decryptAccessToken(enc1, sampleKeyBase64), rawToken);
      assert.equal(decryptAccessToken(enc2, sampleKeyBase64), rawToken);
    });

    it('prevents double-encryption if input is already encrypted', () => {
      const enc1 = encryptAccessToken(rawToken, sampleKeyBase64);
      const enc2 = encryptAccessToken(enc1, sampleKeyBase64);
      assert.equal(enc1, enc2);
    });
  });

  describe('Plaintext Fallback & Missing Key Behavior', () => {
    const rawToken = 'mock_plaintext_existing_token_123';

    it('returns plaintext tokens as-is on decrypt (backward compatibility)', () => {
      const decrypted = decryptAccessToken(rawToken, sampleKeyBase64);
      assert.equal(decrypted, rawToken);
    });

    it('returns plaintext and warns once when SESSION_ENCRYPTION_KEY is missing', () => {
      const origWarn = console.warn;
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(' '));

      try {
        const res1 = encryptAccessToken(rawToken, '');
        assert.equal(res1, rawToken);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /SESSION_ENCRYPTION_KEY is not configured/);

        // Second call should not warn again
        const res2 = encryptAccessToken('another_token', '');
        assert.equal(res2, 'another_token');
        assert.equal(warnings.length, 1);
      } finally {
        console.warn = origWarn;
      }
    });

    it('throws error when attempting to decrypt enc:v1 token without key', () => {
      const encrypted = encryptAccessToken('secret', sampleKeyBase64);
      assert.throws(() => decryptAccessToken(encrypted, ''), {
        message: /SESSION_ENCRYPTION_KEY is required to decrypt/
      });
    });
  });

  describe('Tamper Detection & Key Mismatch Safeguards', () => {
    const rawToken = 'mock_shpat_super_secret_offline_token';

    it('rejects tampered ciphertext with clean error', () => {
      const encrypted = encryptAccessToken(rawToken, sampleKeyBase64);
      const parts = encrypted.split(':');
      // Tamper ciphertext
      parts[4] = parts[4].replace(/^[0-9a-f]/, c => (c === 'a' ? 'b' : 'a'));
      const tampered = parts.join(':');

      assert.throws(() => decryptAccessToken(tampered, sampleKeyBase64), {
        message: /Failed to decrypt access token: tampered data or invalid key/
      });
    });

    it('rejects tampered auth tag with clean error', () => {
      const encrypted = encryptAccessToken(rawToken, sampleKeyBase64);
      const parts = encrypted.split(':');
      // Tamper tag
      parts[3] = parts[3].slice(0, 30) + 'ff';
      const tampered = parts.join(':');

      assert.throws(() => decryptAccessToken(tampered, sampleKeyBase64), {
        message: /Failed to decrypt access token: tampered data or invalid key/
      });
    });

    it('rejects decryption with a different 32-byte key', () => {
      const otherKeyBase64 = crypto.randomBytes(32).toString('base64');
      const encrypted = encryptAccessToken(rawToken, sampleKeyBase64);

      assert.throws(() => decryptAccessToken(encrypted, otherKeyBase64), {
        message: /Failed to decrypt access token: tampered data or invalid key/
      });
    });

    it('strictly avoids leaking the secret or key in error messages', () => {
      const otherKeyBase64 = crypto.randomBytes(32).toString('base64');
      const encrypted = encryptAccessToken(rawToken, sampleKeyBase64);

      try {
        decryptAccessToken(encrypted, otherKeyBase64);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(!err.message.includes(rawToken));
        assert.ok(!err.message.includes(sampleKeyBase64));
        assert.ok(!err.message.includes(otherKeyBase64));
      }
    });
  });
});
