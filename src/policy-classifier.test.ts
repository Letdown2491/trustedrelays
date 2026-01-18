import { describe, test, expect } from 'bun:test';
import {
  classifyPolicy,
  isPaidRelay,
  requiresAuth,
} from './policy-classifier.js';
import type { NIP11Info } from './types.js';

describe('classifyPolicy', () => {
  test('returns specialized for NIP-46 relay type', () => {
    const result = classifyPolicy(undefined, 'nip46');
    expect(result.policy).toBe('specialized');
    expect(result.confidence).toBe(95);
  });

  test('returns specialized for specialized relay type', () => {
    const result = classifyPolicy(undefined, 'specialized');
    expect(result.policy).toBe('specialized');
  });

  test('returns open with low confidence for no NIP-11', () => {
    const result = classifyPolicy(undefined);
    expect(result.policy).toBe('open');
    expect(result.confidence).toBe(30);
  });

  test('returns curated for auth_required', () => {
    const nip11: NIP11Info = { limitation: { auth_required: true } };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('curated');
    expect(result.indicators.authRequired).toBe(true);
  });

  test('returns curated for payment_required', () => {
    const nip11: NIP11Info = { limitation: { payment_required: true } };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('curated');
    expect(result.indicators.paymentRequired).toBe(true);
  });

  test('returns curated with high confidence for both auth and payment', () => {
    const nip11: NIP11Info = {
      limitation: { auth_required: true, payment_required: true },
    };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('curated');
    expect(result.confidence).toBe(95);
  });

  test('returns moderated for restricted_writes', () => {
    const nip11: NIP11Info = { limitation: { restricted_writes: true } };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('moderated');
    expect(result.indicators.restrictedWrites).toBe(true);
  });

  test('returns moderated for PoW requirement', () => {
    const nip11: NIP11Info = { limitation: { min_pow_difficulty: 10 } };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('moderated');
    expect(result.indicators.powRequired).toBe(true);
  });

  test('detects moderation from description', () => {
    const nip11: NIP11Info = {
      description: 'A moderated relay with strict rules against spam',
    };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('moderated');
    expect(result.indicators.hasModeration).toBe(true);
  });

  test('returns open for relay with no restrictions', () => {
    const nip11: NIP11Info = {
      name: 'Open Relay',
      description: 'Welcome everyone!',
      limitation: {
        max_message_length: 1000000,
      },
    };
    const result = classifyPolicy(nip11);
    expect(result.policy).toBe('open');
  });

  test('reduces confidence when no limitation object', () => {
    const nip11: NIP11Info = { name: 'Test Relay' };
    const result = classifyPolicy(nip11);
    expect(result.confidence).toBeLessThan(75);
  });
});

describe('isPaidRelay', () => {
  test('returns false for undefined NIP-11', () => {
    expect(isPaidRelay(undefined)).toBe(false);
  });

  test('returns false for free relay', () => {
    const nip11: NIP11Info = { name: 'Free Relay' };
    expect(isPaidRelay(nip11)).toBe(false);
  });

  test('returns true for payment_required', () => {
    const nip11: NIP11Info = { limitation: { payment_required: true } };
    expect(isPaidRelay(nip11)).toBe(true);
  });

  test('returns true when admission fees exist', () => {
    const nip11: NIP11Info = {
      fees: {
        admission: [{ amount: 1000, unit: 'sats' }],
      },
    };
    expect(isPaidRelay(nip11)).toBe(true);
  });

  test('returns true when subscription fees exist', () => {
    const nip11: NIP11Info = {
      fees: {
        subscription: [{ amount: 500, unit: 'sats', period: 2592000 }],
      },
    };
    expect(isPaidRelay(nip11)).toBe(true);
  });
});

describe('requiresAuth', () => {
  test('returns false for undefined NIP-11', () => {
    expect(requiresAuth(undefined)).toBe(false);
  });

  test('returns false when auth not required', () => {
    const nip11: NIP11Info = { limitation: { auth_required: false } };
    expect(requiresAuth(nip11)).toBe(false);
  });

  test('returns true when auth required', () => {
    const nip11: NIP11Info = { limitation: { auth_required: true } };
    expect(requiresAuth(nip11)).toBe(true);
  });
});
