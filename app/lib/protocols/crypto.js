/**
 * @file Token and Session Cryptographic Primitives (app/lib/protocols/crypto.js)
 * 
 * Provides AES-256-GCM encryption at rest for sensitive platform credentials
 * (such as Shopify offline access tokens) using SESSION_ENCRYPTION_KEY.
 * 
 * Features:
 * - Format: "enc:v1:<iv>:<tag>:<ciphertext>" (hex encoded)
 * - Decrypt on read with automatic backward compatibility for plaintext rows
 * - Safe fallback: if SESSION_ENCRYPTION_KEY is missing, logs one warning, keeps plaintext, never crashes
 * - Tamper and authentication verification via GCM auth tag
 * - Strictly zero credential or key logging
 */

import crypto from 'node:crypto';

let hasWarnedMissingEncryptionKey = false;

/**
 * Resets the missing key warning flag (useful for testing).
 */
export function _resetEncryptionKeyWarning() {
  hasWarnedMissingEncryptionKey = false;
}

/**
 * Resolves a 32-byte Buffer from the raw session encryption key string.
 * Supports:
 * - 32-byte Base64-encoded string (standard Railway env)
 * - 64-character Hex-encoded string
 * - 32-byte UTF-8 string
 *
 * @param {string | undefined} rawKey
 * @returns {Buffer | null}
 */
export function resolveEncryptionKey(rawKey = process.env.SESSION_ENCRYPTION_KEY) {
  if (!rawKey || typeof rawKey !== 'string') {
    return null;
  }

  const trimmed = rawKey.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Try Base64 decode (standard 32 bytes = 44 base64 chars with padding)
  try {
    const b64Buf = Buffer.from(trimmed, 'base64');
    if (b64Buf.length === 32) {
      return b64Buf;
    }
  } catch {}

  // 2. Try Hex decode (64 hex characters = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // 3. Try UTF-8 string exactly 32 bytes
  const utf8Buf = Buffer.from(trimmed, 'utf8');
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  throw new Error('SESSION_ENCRYPTION_KEY must resolve to exactly 32 bytes (base64, hex, or 32-char utf8).');
}

/**
 * Encrypts an access token using AES-256-GCM.
 * If SESSION_ENCRYPTION_KEY is not configured, logs a single warning and returns the plaintext token without crashing.
 * If already encrypted ("enc:v1:..."), returns the token unchanged.
 *
 * @param {string} plaintextToken
 * @param {string | Buffer | undefined} [keyInput] - Optional override key (defaults to env SESSION_ENCRYPTION_KEY)
 * @returns {string} Encrypted string format "enc:v1:<iv>:<tag>:<ciphertext>" or plaintext fallback
 */
export function encryptAccessToken(plaintextToken, keyInput = process.env.SESSION_ENCRYPTION_KEY) {
  if (!plaintextToken || typeof plaintextToken !== 'string') {
    return plaintextToken;
  }

  // Prevent double-encryption
  if (plaintextToken.startsWith('enc:v1:')) {
    return plaintextToken;
  }

  let keyBuf = null;
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== 32) {
      throw new Error('Encryption key buffer must be exactly 32 bytes for AES-256-GCM.');
    }
    keyBuf = keyInput;
  } else {
    keyBuf = resolveEncryptionKey(keyInput);
  }

  if (!keyBuf) {
    if (!hasWarnedMissingEncryptionKey) {
      console.warn('[Security Notice] SESSION_ENCRYPTION_KEY is not configured; storing access tokens in plaintext.');
      hasWarnedMissingEncryptionKey = true;
    }
    return plaintextToken;
  }

  const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintextToken, 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag(); // 16 bytes

  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts an encrypted access token using AES-256-GCM.
 * Supports plaintext backward-compatibility: if the input does not start with "enc:v1:",
 * it is returned as-is.
 * Throws clean errors on tampered ciphertext, bad auth tag, or incorrect key, never leaking credentials.
 *
 * @param {string} storedToken
 * @param {string | Buffer | undefined} [keyInput] - Optional override key (defaults to env SESSION_ENCRYPTION_KEY)
 * @returns {string} Decrypted plaintext token
 */
export function decryptAccessToken(storedToken, keyInput = process.env.SESSION_ENCRYPTION_KEY) {
  if (!storedToken || typeof storedToken !== 'string') {
    return storedToken;
  }

  // Backward compatibility: plaintext tokens return as-is
  if (!storedToken.startsWith('enc:v1:')) {
    return storedToken;
  }

  let keyBuf = null;
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== 32) {
      throw new Error('Encryption key buffer must be exactly 32 bytes for AES-256-GCM.');
    }
    keyBuf = keyInput;
  } else {
    keyBuf = resolveEncryptionKey(keyInput);
  }

  if (!keyBuf) {
    throw new Error('SESSION_ENCRYPTION_KEY is required to decrypt access token.');
  }

  const parts = storedToken.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Invalid encrypted token format.');
  }

  const iv = Buffer.from(parts[2], 'hex');
  const tag = Buffer.from(parts[3], 'hex');
  const ciphertext = Buffer.from(parts[4], 'hex');

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid initialization vector or authentication tag length.');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt access token: tampered data or invalid key.');
  }
}
