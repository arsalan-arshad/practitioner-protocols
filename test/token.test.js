import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateShareToken, isValidShareToken } from '../app/lib/protocols/token.js';

describe('Share Token Generator (app/lib/protocols/token.js)', () => {
  it('generates a 16-character alphanumeric token by default', () => {
    const token = generateShareToken();
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 16);
    assert.match(token, /^[A-Za-z0-9]{16}$/);
    assert.equal(isValidShareToken(token), true);
  });

  it('generates tokens with custom valid lengths', () => {
    for (const len of [16, 20, 32, 48, 64]) {
      const token = generateShareToken(len);
      assert.equal(token.length, len);
      assert.equal(isValidShareToken(token), true);
    }
  });

  it('rejects invalid token lengths', () => {
    assert.throws(() => generateShareToken(15), /integer between 16 and 64/);
    assert.throws(() => generateShareToken(65), /integer between 16 and 64/);
    assert.throws(() => generateShareToken(-1), /integer between 16 and 64/);
    assert.throws(() => generateShareToken(16.5), /integer between 16 and 64/);
    assert.throws(() => generateShareToken('16'), /integer between 16 and 64/);
    assert.throws(() => generateShareToken(null), /integer between 16 and 64/);
  });

  it('ensures high entropy with zero collisions across 1,000 generations', () => {
    const tokens = new Set();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      tokens.add(generateShareToken());
    }
    assert.equal(tokens.size, count);
  });

  describe('isValidShareToken', () => {
    it('accepts valid alphanumeric tokens of length 16 to 64', () => {
      assert.equal(isValidShareToken('A1b2C3d4E5f6G7h8'), true);
      assert.equal(isValidShareToken('abcdefghijklmnop12345678'), true);
      assert.equal(isValidShareToken('1234567890123456_a-b'), true);
    });

    it('rejects short tokens (<16 chars)', () => {
      assert.equal(isValidShareToken('short12345'), false);
      assert.equal(isValidShareToken('123456789012345'), false); // 15 chars
    });

    it('rejects overly long tokens (>64 chars)', () => {
      assert.equal(isValidShareToken('a'.repeat(65)), false);
    });

    it('rejects invalid characters (spaces, special symbols, newlines)', () => {
      assert.equal(isValidShareToken('123456789012345!'), false);
      assert.equal(isValidShareToken('12345678 9012345'), false);
      assert.equal(isValidShareToken('12345678\n90123456'), false);
      assert.equal(isValidShareToken('12345678@example'), false);
    });

    it('rejects non-string inputs safely', () => {
      assert.equal(isValidShareToken(null), false);
      assert.equal(isValidShareToken(undefined), false);
      assert.equal(isValidShareToken(1234567890123456), false);
      assert.equal(isValidShareToken({}), false);
      assert.equal(isValidShareToken([]), false);
    });
  });
});
