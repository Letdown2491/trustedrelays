import { describe, test, expect } from 'bun:test';
import {
  scorePolicyClarity,
  scoreConnectionSecurity,
  scoreOperatorAccountability,
  computeQualityScore,
} from './quality-scorer.js';
import type { NIP11Info, OperatorResolution } from './types.js';

describe('scorePolicyClarity', () => {
  test('returns 50 for undefined NIP-11', () => {
    expect(scorePolicyClarity(undefined)).toBe(50);
  });

  test('returns 50 for empty NIP-11', () => {
    expect(scorePolicyClarity({})).toBe(50);
  });

  test('adds points for name and description', () => {
    const withBoth: NIP11Info = { name: 'Test Relay', description: 'A test relay' };
    const withName: NIP11Info = { name: 'Test Relay' };
    const withDesc: NIP11Info = { description: 'A test relay' };

    expect(scorePolicyClarity(withBoth)).toBeGreaterThan(scorePolicyClarity(withName));
    expect(scorePolicyClarity(withName)).toBeGreaterThan(scorePolicyClarity({}));
    expect(scorePolicyClarity(withDesc)).toBeGreaterThan(scorePolicyClarity({}));
  });

  test('adds points for contact', () => {
    const withContact: NIP11Info = { name: 'Test', contact: 'admin@test.com' };
    const withoutContact: NIP11Info = { name: 'Test' };

    expect(scorePolicyClarity(withContact)).toBeGreaterThan(scorePolicyClarity(withoutContact));
  });

  test('adds points for limitations', () => {
    const withLimits: NIP11Info = {
      name: 'Test',
      limitation: { max_message_length: 1024 },
    };
    const withoutLimits: NIP11Info = { name: 'Test' };

    expect(scorePolicyClarity(withLimits)).toBeGreaterThan(scorePolicyClarity(withoutLimits));
  });

  test('applies cap for missing identity', () => {
    const noIdentity: NIP11Info = {
      contact: 'admin@test.com',
      limitation: { max_message_length: 1024 },
    };
    expect(scorePolicyClarity(noIdentity)).toBeLessThanOrEqual(50);
  });

  test('applies cap for missing contact', () => {
    const noContact: NIP11Info = {
      name: 'Test Relay',
      description: 'Full description',
      limitation: { max_message_length: 1024 },
    };
    expect(scorePolicyClarity(noContact)).toBeLessThanOrEqual(70);
  });

  test('penalizes undocumented payment', () => {
    const withFees: NIP11Info = {
      name: 'Test',
      limitation: { payment_required: true },
      fees: { subscription: [{ amount: 1000, unit: 'sats' }] },
    };
    const withoutFees: NIP11Info = {
      name: 'Test',
      limitation: { payment_required: true },
    };

    expect(scorePolicyClarity(withFees)).toBeGreaterThan(scorePolicyClarity(withoutFees));
  });
});

describe('scoreConnectionSecurity', () => {
  test('returns 50 for undefined URL', () => {
    expect(scoreConnectionSecurity(undefined)).toBe(50);
  });

  test('returns 100 for wss:// URLs', () => {
    expect(scoreConnectionSecurity('wss://relay.example.com')).toBe(100);
    expect(scoreConnectionSecurity('WSS://RELAY.EXAMPLE.COM')).toBe(100);
  });

  test('returns 0 for ws:// URLs', () => {
    expect(scoreConnectionSecurity('ws://relay.example.com')).toBe(0);
    expect(scoreConnectionSecurity('WS://RELAY.EXAMPLE.COM')).toBe(0);
  });

  test('returns 50 for unknown protocols', () => {
    expect(scoreConnectionSecurity('http://relay.example.com')).toBe(50);
  });
});

describe('scoreOperatorAccountability', () => {
  test('returns 50 for undefined operator', () => {
    expect(scoreOperatorAccountability(undefined)).toBe(50);
    expect(scoreOperatorAccountability(null)).toBe(50);
  });

  test('returns 50 for operator without pubkey', () => {
    const op: OperatorResolution = {
      relayUrl: 'wss://test.relay',
      operatorPubkey: null,
      verificationMethod: null,
      verifiedAt: Date.now(),
      confidence: 0,
    };
    expect(scoreOperatorAccountability(op)).toBe(50);
  });

  test('returns verification confidence when no WoT score', () => {
    const op: OperatorResolution = {
      relayUrl: 'wss://test.relay',
      operatorPubkey: 'abc123',
      verificationMethod: 'nip11',
      verifiedAt: Date.now(),
      confidence: 70,
    };
    expect(scoreOperatorAccountability(op)).toBe(70);
  });

  test('combines verification and WoT score', () => {
    const op: OperatorResolution = {
      relayUrl: 'wss://test.relay',
      operatorPubkey: 'abc123',
      verificationMethod: 'nip11',
      verifiedAt: Date.now(),
      confidence: 80,
      trustScore: 60,
    };
    // 80 * 0.5 + 60 * 0.5 = 70
    expect(scoreOperatorAccountability(op)).toBe(70);
  });
});

describe('computeQualityScore', () => {
  test('returns neutral score for no data', () => {
    const score = computeQualityScore();
    // 50 * 0.6 + 50 * 0.25 + 50 * 0.15 = 50
    expect(score.overall).toBe(50);
  });

  test('weights components correctly', () => {
    const nip11: NIP11Info = {
      name: 'Test Relay',
      description: 'Description',
      contact: 'admin@test.com',
      limitation: { max_message_length: 1024 },
    };
    const url = 'wss://relay.example.com';
    const op: OperatorResolution = {
      relayUrl: url,
      operatorPubkey: 'abc123',
      verificationMethod: 'nip11_signed',
      verifiedAt: Date.now(),
      confidence: 100,
      trustScore: 100,
    };

    const score = computeQualityScore(nip11, url, op);

    // All components should be high
    expect(score.policyScore).toBeGreaterThan(70);
    expect(score.securityScore).toBe(100);
    expect(score.operatorScore).toBe(100);
    expect(score.overall).toBeGreaterThan(80);
  });

  test('penalizes insecure connections', () => {
    const nip11: NIP11Info = { name: 'Test' };

    const secureScore = computeQualityScore(nip11, 'wss://relay.example.com');
    const insecureScore = computeQualityScore(nip11, 'ws://relay.example.com');

    expect(secureScore.overall).toBeGreaterThan(insecureScore.overall);
    expect(secureScore.securityScore).toBe(100);
    expect(insecureScore.securityScore).toBe(0);
  });
});
