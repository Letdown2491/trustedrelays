import { describe, test, expect } from 'bun:test';
import { assertionToEvent } from './assertion.js';
import type { RelayAssertion } from './types.js';

function baseAssertion(overrides: Partial<RelayAssertion> = {}): RelayAssertion {
  return {
    relayUrl: 'wss://relay.example.com',
    status: 'evaluated',
    confidence: 'high',
    observations: 1000,
    observationPeriod: '30d',
    firstSeen: 1700000000,
    algorithm: 'v0.3.0',
    policy: 'curated',
    policyConfidence: 90,
    ...overrides,
  };
}

describe('assertionToEvent policy_discrepancy tag', () => {
  test('emits policy_discrepancy=true when flagged', () => {
    const event = assertionToEvent(baseAssertion({ policyDiscrepancy: true }));
    const tag = event.tags.find((t) => t[0] === 'policy_discrepancy');
    expect(tag).toEqual(['policy_discrepancy', 'true']);
  });

  test('omits policy_discrepancy when not flagged', () => {
    const event = assertionToEvent(baseAssertion({ policyDiscrepancy: false }));
    expect(event.tags.find((t) => t[0] === 'policy_discrepancy')).toBeUndefined();
  });

  test('omits policy_discrepancy when undefined', () => {
    const event = assertionToEvent(baseAssertion());
    expect(event.tags.find((t) => t[0] === 'policy_discrepancy')).toBeUndefined();
  });
});
