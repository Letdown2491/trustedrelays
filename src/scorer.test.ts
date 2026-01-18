import { describe, test, expect } from 'bun:test';
import {
  calculateWeightedObservations,
  getConfidenceLevel,
  computeUptimeScore,
  computeConsistencyScore,
  computeRecoveryScore,
  computeLatencyPercentileScore,
  computeAverageLatency,
} from './scorer.js';
import type { ProbeResult } from './types.js';

// Helper to create probe objects with required fields
const probe = (p: Omit<ProbeResult, 'relayType'> & { relayType?: ProbeResult['relayType'] }): ProbeResult => ({
  relayType: 'general',
  ...p,
});

describe('calculateWeightedObservations', () => {
  test('returns probe count when no NIP-66 metrics', () => {
    const result = calculateWeightedObservations(100, 0, 0, 30);
    expect(result).toBe(100);
  });

  test('applies monitor diversity bonus', () => {
    // 1 monitor = 1.1x bonus
    const result1 = calculateWeightedObservations(0, 100, 1, 0);
    // 100 * 1.1 * 1.0 = 110
    expect(result1).toBe(110);

    // 10 monitors = 2.0x bonus
    const result10 = calculateWeightedObservations(0, 100, 10, 0);
    // 100 * 2.0 * 1.0 = 200
    expect(result10).toBe(200);
  });

  test('applies time factor', () => {
    // 0 days = 1.0x
    const result0 = calculateWeightedObservations(0, 100, 1, 0);
    expect(result0).toBe(110); // 100 * 1.1 * 1.0

    // 30 days = 2.0x
    const result30 = calculateWeightedObservations(0, 100, 1, 30);
    expect(result30).toBe(220); // 100 * 1.1 * 2.0
  });

  test('combines probes and NIP-66 metrics', () => {
    const result = calculateWeightedObservations(50, 100, 5, 15);
    // probes: 50
    // nip66: 100 * 1.5 (monitor) * 1.5 (time) = 225
    // total: 275
    expect(result).toBe(275);
  });
});

describe('getConfidenceLevel', () => {
  test('returns low for < 100 observations', () => {
    expect(getConfidenceLevel(0)).toBe('low');
    expect(getConfidenceLevel(50)).toBe('low');
    expect(getConfidenceLevel(99)).toBe('low');
  });

  test('returns medium for 100-499 observations', () => {
    expect(getConfidenceLevel(100)).toBe('medium');
    expect(getConfidenceLevel(300)).toBe('medium');
    expect(getConfidenceLevel(499)).toBe('medium');
  });

  test('returns high for >= 500 observations', () => {
    expect(getConfidenceLevel(500)).toBe('high');
    expect(getConfidenceLevel(1000)).toBe('high');
  });
});

describe('computeUptimeScore', () => {
  test('returns 0 for empty probes', () => {
    expect(computeUptimeScore([])).toBe(0);
  });

  test('returns 100 for all reachable', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true }),
      probe({ url: 'wss://test', timestamp: 2, reachable: true }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true }),
    ];
    expect(computeUptimeScore(probes)).toBe(100);
  });

  test('returns 0 for none reachable', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: false }),
      probe({ url: 'wss://test', timestamp: 2, reachable: false }),
    ];
    expect(computeUptimeScore(probes)).toBe(0);
  });

  test('returns correct percentage for mixed results', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true }),
      probe({ url: 'wss://test', timestamp: 2, reachable: false }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true }),
      probe({ url: 'wss://test', timestamp: 4, reachable: true }),
    ];
    expect(computeUptimeScore(probes)).toBe(75); // 3/4 = 75%
  });
});

describe('computeConsistencyScore', () => {
  test('returns 70 for insufficient data', () => {
    expect(computeConsistencyScore([])).toBe(70);
    expect(computeConsistencyScore([
      probe({ url: 'wss://test', timestamp: 1, reachable: true, connectTime: 100 }),
    ])).toBe(70);
  });

  test('returns 100 for identical times', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true, connectTime: 100 }),
      probe({ url: 'wss://test', timestamp: 2, reachable: true, connectTime: 100 }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true, connectTime: 100 }),
    ];
    expect(computeConsistencyScore(probes)).toBe(100);
  });

  test('returns lower score for high variance', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true, connectTime: 50 }),
      probe({ url: 'wss://test', timestamp: 2, reachable: true, connectTime: 150 }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true, connectTime: 50 }),
      probe({ url: 'wss://test', timestamp: 4, reachable: true, connectTime: 150 }),
    ];
    const score = computeConsistencyScore(probes);
    expect(score).toBeLessThan(70);
    expect(score).toBeGreaterThan(0);
  });
});

describe('computeRecoveryScore', () => {
  test('returns 80 for insufficient data', () => {
    expect(computeRecoveryScore([])).toBe(80);
    expect(computeRecoveryScore([
      probe({ url: 'wss://test', timestamp: 1, reachable: true }),
    ])).toBe(80);
  });

  test('returns 100 for no outages', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true }),
      probe({ url: 'wss://test', timestamp: 2, reachable: true }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true }),
    ];
    expect(computeRecoveryScore(probes)).toBe(100);
  });

  test('returns high score for quick recovery', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 0, reachable: true }),
      probe({ url: 'wss://test', timestamp: 60, reachable: false }),    // 1 min outage
      probe({ url: 'wss://test', timestamp: 120, reachable: true }),   // recovered
      probe({ url: 'wss://test', timestamp: 180, reachable: true }),
    ];
    const score = computeRecoveryScore(probes);
    expect(score).toBeGreaterThan(90);
  });

  test('returns lower score for longer outages', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 0, reachable: true }),
      probe({ url: 'wss://test', timestamp: 60, reachable: false }),
      probe({ url: 'wss://test', timestamp: 3600, reachable: false }), // 1 hour outage
      probe({ url: 'wss://test', timestamp: 7200, reachable: true }),  // recovered after 2 hours
    ];
    const score = computeRecoveryScore(probes);
    expect(score).toBeLessThan(75);
    expect(score).toBeGreaterThan(40);
  });
});

describe('computeLatencyPercentileScore', () => {
  test('returns 50 for undefined latency', () => {
    expect(computeLatencyPercentileScore(undefined, [100, 200, 300])).toBe(50);
  });

  test('returns 50 for empty comparison array', () => {
    expect(computeLatencyPercentileScore(100, [])).toBe(50);
  });

  test('returns 100 for fastest relay', () => {
    const allLatencies = [100, 200, 300, 400, 500];
    // 50ms is faster than all
    expect(computeLatencyPercentileScore(50, allLatencies)).toBe(100);
  });

  test('returns 0 for slowest relay', () => {
    const allLatencies = [100, 200, 300, 400, 500];
    // 600ms is slower than all
    expect(computeLatencyPercentileScore(600, allLatencies)).toBe(0);
  });

  test('returns correct percentile for middle relay', () => {
    const allLatencies = [100, 200, 300, 400, 500];
    // 300ms is faster than 2 relays (400, 500) = 40th percentile
    expect(computeLatencyPercentileScore(300, allLatencies)).toBe(40);
  });
});

describe('computeAverageLatency', () => {
  test('returns undefined for empty probes', () => {
    expect(computeAverageLatency([])).toBeUndefined();
  });

  test('returns undefined for no reachable probes', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: false }),
      probe({ url: 'wss://test', timestamp: 2, reachable: false }),
    ];
    expect(computeAverageLatency(probes)).toBeUndefined();
  });

  test('calculates correct average', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true, connectTime: 100 }),
      probe({ url: 'wss://test', timestamp: 2, reachable: true, connectTime: 200 }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true, connectTime: 300 }),
    ];
    expect(computeAverageLatency(probes)).toBe(200);
  });

  test('ignores unreachable probes', () => {
    const probes: ProbeResult[] = [
      probe({ url: 'wss://test', timestamp: 1, reachable: true, connectTime: 100 }),
      probe({ url: 'wss://test', timestamp: 2, reachable: false, connectTime: 9999 }),
      probe({ url: 'wss://test', timestamp: 3, reachable: true, connectTime: 200 }),
    ];
    expect(computeAverageLatency(probes)).toBe(150);
  });
});
