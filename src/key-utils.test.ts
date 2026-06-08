import { describe, test, expect } from 'bun:test';
import { isValidPrivateKey, normalizePrivateKey } from './key-utils.js';

const ONE = '0000000000000000000000000000000000000000000000000000000000000001';
const ZERO = '0000000000000000000000000000000000000000000000000000000000000000';
const ALL_F = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
// secp256k1 curve order n (a 64-hex string that is NOT a valid scalar: must be < n).
const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

describe('isValidPrivateKey scalar range', () => {
  test('accepts a well-formed in-range hex key', () => {
    expect(isValidPrivateKey(ONE)).toBe(true);
  });

  test('rejects zero (not in [1, n-1])', () => {
    expect(isValidPrivateKey(ZERO)).toBe(false);
  });

  test('rejects values >= curve order', () => {
    expect(isValidPrivateKey(ALL_F)).toBe(false);
    expect(isValidPrivateKey(N)).toBe(false);
  });

  test('rejects non-hex / wrong-length input', () => {
    expect(isValidPrivateKey('abc')).toBe(false);
    expect(isValidPrivateKey('xyz')).toBe(false);
    expect(isValidPrivateKey('')).toBe(false);
  });
});

describe('normalizePrivateKey', () => {
  test('lowercases and returns a valid hex key', () => {
    expect(normalizePrivateKey(ONE.toUpperCase())).toBe(ONE);
  });

  test('throws on an out-of-range scalar', () => {
    expect(() => normalizePrivateKey(ZERO)).toThrow();
    expect(() => normalizePrivateKey(ALL_F)).toThrow();
  });
});
