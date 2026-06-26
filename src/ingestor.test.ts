import { describe, test, expect } from 'bun:test';
import { parseNip66Event } from './ingestor.js';
import type { Event } from 'nostr-tools';

function makeEvent(tags: string[][]): Event {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: 30166,
    tags,
    content: '',
    sig: 'c'.repeat(128),
  };
}

describe('parseNip66Event extended tags (T/R/t/k)', () => {
  test('parses relay type, requirements, topics, and kinds', () => {
    const event = makeEvent([
      ['d', 'wss://relay.example.com'],
      ['T', 'PrivateInbox'],
      ['R', 'auth'],
      ['R', '!payment'],
      ['t', 'nostr'],
      ['t', 'dev'],
      ['k', '1'],
      ['k', '!4'],
    ]);
    const metric = parseNip66Event(event);
    expect(metric).not.toBeNull();
    expect(metric!.relayType).toBe('PrivateInbox');
    expect(metric!.requirements).toEqual(['auth', '!payment']);
    expect(metric!.topics).toEqual(['nostr', 'dev']);
    expect(metric!.acceptedKinds).toEqual([1]);
    expect(metric!.rejectedKinds).toEqual([4]);
  });

  test('tolerates comma-separated requirements and kinds', () => {
    const event = makeEvent([
      ['d', 'wss://relay.example.com'],
      ['R', 'auth, !pow'],
      ['k', '1, !4, 7'],
    ]);
    const metric = parseNip66Event(event);
    expect(metric!.requirements).toEqual(['auth', '!pow']);
    expect(metric!.acceptedKinds).toEqual([1, 7]);
    expect(metric!.rejectedKinds).toEqual([4]);
  });

  test('omits extended fields when tags are absent', () => {
    const event = makeEvent([['d', 'wss://relay.example.com']]);
    const metric = parseNip66Event(event);
    expect(metric!.relayType).toBeUndefined();
    expect(metric!.requirements).toBeUndefined();
    expect(metric!.topics).toBeUndefined();
    expect(metric!.acceptedKinds).toBeUndefined();
    expect(metric!.rejectedKinds).toBeUndefined();
  });

  test('ignores out-of-range kind values', () => {
    const event = makeEvent([
      ['d', 'wss://relay.example.com'],
      ['k', '999999'],
      ['k', '5'],
    ]);
    const metric = parseNip66Event(event);
    expect(metric!.acceptedKinds).toEqual([5]);
  });
});
