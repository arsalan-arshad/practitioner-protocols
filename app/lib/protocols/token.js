import crypto from 'node:crypto';

const URL_SAFE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_REGEX = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Generates an unguessable, cryptographically secure, URL-safe random token.
 * Default length is 16 characters.
 *
 * @param {number} [length=16]
 * @returns {string}
 */
export function generateShareToken(length = 16) {
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 16 || length > 64) {
    throw new TypeError('Token length must be an integer between 16 and 64');
  }

  const bytes = crypto.randomBytes(length);
  let result = '';
  const charsLen = URL_SAFE_CHARS.length;

  for (let i = 0; i < length; i++) {
    result += URL_SAFE_CHARS[bytes[i] % charsLen];
  }

  return result;
}

/**
 * Validates whether a token matches the expected URL-safe pattern.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
export function isValidShareToken(token) {
  if (typeof token !== 'string') {
    return false;
  }
  return TOKEN_REGEX.test(token.trim());
}
