import { describe, test, expect } from 'bun:test';
import {
  parseRelayReport,
  calculateTrustWeight,
  calculateTimeDecay,
} from './report-ingestor.js';
import type { Event } from 'nostr-tools';
import type { ReportType } from './types.js';

describe('calculateTrustWeight', () => {
  test('returns 1 for trust score of 100', () => {
    expect(calculateTrustWeight(100)).toBe(1);
  });

  test('returns 0.25 for trust score of 50', () => {
    // (50/100)^2 = 0.25
    expect(calculateTrustWeight(50)).toBe(0.25);
  });

  test('returns 0 for trust score of 0', () => {
    expect(calculateTrustWeight(0)).toBe(0);
  });

  test('clamps values above 100', () => {
    expect(calculateTrustWeight(150)).toBe(1);
  });

  test('clamps values below 0', () => {
    expect(calculateTrustWeight(-50)).toBe(0);
  });

  test('uses custom exponent', () => {
    // With exponent 1, weight = trust/100
    expect(calculateTrustWeight(50, { trustWeightExponent: 1 } as any)).toBe(0.5);
  });
});

describe('calculateTimeDecay', () => {
  test('returns 1 for current timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const decay = calculateTimeDecay(now);
    expect(decay).toBeGreaterThan(0.99);
    expect(decay).toBeLessThanOrEqual(1);
  });

  test('returns ~0.5 for half-life old report', () => {
    const halfLifeDays = 30;
    const now = Math.floor(Date.now() / 1000);
    const halfLifeAgo = now - (halfLifeDays * 86400);
    const decay = calculateTimeDecay(halfLifeAgo);
    expect(decay).toBeGreaterThan(0.45);
    expect(decay).toBeLessThan(0.55);
  });

  test('returns ~0.25 for two half-lives old report', () => {
    const halfLifeDays = 30;
    const now = Math.floor(Date.now() / 1000);
    const twoHalfLivesAgo = now - (2 * halfLifeDays * 86400);
    const decay = calculateTimeDecay(twoHalfLivesAgo);
    expect(decay).toBeGreaterThan(0.2);
    expect(decay).toBeLessThan(0.3);
  });
});

describe('parseRelayReport', () => {
  const validEvent: Event = {
    id: 'abc123',
    pubkey: 'def456',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1985,
    tags: [
      ['L', 'relay-report'],
      ['l', 'spam', 'relay-report'],
      ['r', 'wss://relay.example.com'],
    ],
    content: 'This relay has spam issues',
    sig: 'invalid-sig-for-testing',
  };

  test('returns null for non-1985 kind', () => {
    const event = { ...validEvent, kind: 1 };
    expect(parseRelayReport(event, true)).toBeNull();
  });

  test('returns null for missing L tag', () => {
    const event = {
      ...validEvent,
      tags: [
        ['l', 'spam', 'relay-report'],
        ['r', 'wss://relay.example.com'],
      ],
    };
    expect(parseRelayReport(event, true)).toBeNull();
  });

  test('returns null for wrong namespace', () => {
    const event = {
      ...validEvent,
      tags: [
        ['L', 'wrong-namespace'],
        ['l', 'spam', 'wrong-namespace'],
        ['r', 'wss://relay.example.com'],
      ],
    };
    expect(parseRelayReport(event, true)).toBeNull();
  });

  test('returns null for invalid report type', () => {
    const event = {
      ...validEvent,
      tags: [
        ['L', 'relay-report'],
        ['l', 'invalid-type', 'relay-report'],
        ['r', 'wss://relay.example.com'],
      ],
    };
    expect(parseRelayReport(event, true)).toBeNull();
  });

  test('returns null for missing r tag', () => {
    const event = {
      ...validEvent,
      tags: [
        ['L', 'relay-report'],
        ['l', 'spam', 'relay-report'],
      ],
    };
    expect(parseRelayReport(event, true)).toBeNull();
  });

  test('parses valid spam report', () => {
    const report = parseRelayReport(validEvent, true);
    expect(report).not.toBeNull();
    expect(report!.eventId).toBe('abc123');
    expect(report!.reporterPubkey).toBe('def456');
    expect(report!.reportType).toBe('spam');
    expect(report!.relayUrl).toBe('wss://relay.example.com');
    expect(report!.content).toBe('This relay has spam issues');
  });

  test('parses all valid report types', () => {
    const reportTypes: ReportType[] = ['spam', 'censorship', 'unreliable', 'malicious'];
    for (const reportType of reportTypes) {
      const event = {
        ...validEvent,
        tags: [
          ['L', 'relay-report'],
          ['l', reportType, 'relay-report'],
          ['r', 'wss://relay.example.com'],
        ],
      };
      const report = parseRelayReport(event, true);
      expect(report).not.toBeNull();
      expect(report!.reportType).toBe(reportType);
    }
  });

  test('normalizes relay URL', () => {
    const event = {
      ...validEvent,
      tags: [
        ['L', 'relay-report'],
        ['l', 'spam', 'relay-report'],
        ['r', 'wss://relay.example.com/'],
      ],
    };
    const report = parseRelayReport(event, true);
    expect(report!.relayUrl).toBe('wss://relay.example.com');
  });
});
