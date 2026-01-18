import { describe, test, expect } from 'bun:test';
import {
  parseTrustAssertion,
  aggregateTrustScore,
} from './wot-client.js';
import type { Event } from 'nostr-tools';
import type { TrustAssertion, TrustAssertionProvider } from './types.js';

describe('parseTrustAssertion', () => {
  const validEvent: Event = {
    id: 'event123',
    pubkey: 'provider456',
    created_at: Math.floor(Date.now() / 1000),
    kind: 30382,
    tags: [
      ['d', 'subject789'],
      ['rank', '75'],
    ],
    content: '',
    sig: 'sig123',
  };

  test('returns null for wrong kind', () => {
    const event = { ...validEvent, kind: 1 };
    expect(parseTrustAssertion(event)).toBeNull();
  });

  test('returns null for missing d tag', () => {
    const event = {
      ...validEvent,
      tags: [['rank', '75']],
    };
    expect(parseTrustAssertion(event)).toBeNull();
  });

  test('returns null for missing rank tag', () => {
    const event = {
      ...validEvent,
      tags: [['d', 'subject789']],
    };
    expect(parseTrustAssertion(event)).toBeNull();
  });

  test('returns null for invalid rank', () => {
    const eventNaN = {
      ...validEvent,
      tags: [['d', 'subject789'], ['rank', 'abc']],
    };
    expect(parseTrustAssertion(eventNaN)).toBeNull();

    const eventNegative = {
      ...validEvent,
      tags: [['d', 'subject789'], ['rank', '-10']],
    };
    expect(parseTrustAssertion(eventNegative)).toBeNull();

    const eventOver100 = {
      ...validEvent,
      tags: [['d', 'subject789'], ['rank', '150']],
    };
    expect(parseTrustAssertion(eventOver100)).toBeNull();
  });

  test('parses valid assertion', () => {
    const assertion = parseTrustAssertion(validEvent);
    expect(assertion).not.toBeNull();
    expect(assertion!.eventId).toBe('event123');
    expect(assertion!.providerPubkey).toBe('provider456');
    expect(assertion!.subjectPubkey).toBe('subject789');
    expect(assertion!.rank).toBe(75);
  });

  test('parses optional zap amount tags', () => {
    const eventWithZaps: Event = {
      ...validEvent,
      tags: [
        ['d', 'subject789'],
        ['rank', '75'],
        ['zap_amt_sent', '10000'],
        ['zap_amt_received', '5000'],
      ],
    };
    const assertion = parseTrustAssertion(eventWithZaps);
    expect(assertion!.zapAmountSent).toBe(10000);
    expect(assertion!.zapAmountReceived).toBe(5000);
  });

  test('normalizes subject pubkey to lowercase', () => {
    const event = {
      ...validEvent,
      tags: [['d', 'SUBJECT789'], ['rank', '75']],
    };
    const assertion = parseTrustAssertion(event);
    expect(assertion!.subjectPubkey).toBe('subject789');
  });
});

describe('aggregateTrustScore', () => {
  const now = Math.floor(Date.now() / 1000);

  test('returns null for empty assertions', () => {
    expect(aggregateTrustScore([])).toBeNull();
  });

  test('returns single assertion score with low confidence', () => {
    const assertions: TrustAssertion[] = [
      {
        eventId: 'e1',
        providerPubkey: 'p1',
        subjectPubkey: 'subject',
        rank: 80,
        timestamp: now,
      },
    ];
    const result = aggregateTrustScore(assertions);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(80);
    expect(result!.confidence).toBe('low');
    expect(result!.providers).toHaveLength(1);
  });

  test('uses most recent assertion per provider', () => {
    const assertions: TrustAssertion[] = [
      {
        eventId: 'e1',
        providerPubkey: 'p1',
        subjectPubkey: 'subject',
        rank: 50,
        timestamp: now - 3600, // older
      },
      {
        eventId: 'e2',
        providerPubkey: 'p1',
        subjectPubkey: 'subject',
        rank: 80,
        timestamp: now, // newer
      },
    ];
    const result = aggregateTrustScore(assertions);
    expect(result!.score).toBe(80); // Uses newer assertion
    expect(result!.providers).toHaveLength(1);
  });

  test('averages scores from multiple providers', () => {
    const assertions: TrustAssertion[] = [
      {
        eventId: 'e1',
        providerPubkey: 'p1',
        subjectPubkey: 'subject',
        rank: 60,
        timestamp: now,
      },
      {
        eventId: 'e2',
        providerPubkey: 'p2',
        subjectPubkey: 'subject',
        rank: 80,
        timestamp: now,
      },
    ];
    const result = aggregateTrustScore(assertions);
    expect(result!.score).toBe(70); // (60 + 80) / 2
    expect(result!.confidence).toBe('medium');
    expect(result!.providers).toHaveLength(2);
  });

  test('returns high confidence for 3+ providers', () => {
    const assertions: TrustAssertion[] = [
      { eventId: 'e1', providerPubkey: 'p1', subjectPubkey: 'subject', rank: 70, timestamp: now },
      { eventId: 'e2', providerPubkey: 'p2', subjectPubkey: 'subject', rank: 80, timestamp: now },
      { eventId: 'e3', providerPubkey: 'p3', subjectPubkey: 'subject', rank: 90, timestamp: now },
    ];
    const result = aggregateTrustScore(assertions);
    expect(result!.confidence).toBe('high');
    expect(result!.providers).toHaveLength(3);
  });

  test('applies provider weights', () => {
    const assertions: TrustAssertion[] = [
      { eventId: 'e1', providerPubkey: 'p1', subjectPubkey: 'subject', rank: 60, timestamp: now },
      { eventId: 'e2', providerPubkey: 'p2', subjectPubkey: 'subject', rank: 80, timestamp: now },
    ];
    const providers: TrustAssertionProvider[] = [
      { pubkey: 'p1', weight: 2 },
      { pubkey: 'p2', weight: 1 },
    ];
    const result = aggregateTrustScore(assertions, providers);
    // (60 * 2 + 80 * 1) / (2 + 1) = 200 / 3 = 67
    expect(result!.score).toBe(67);
  });
});
