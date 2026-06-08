import { describe, test, expect } from 'bun:test';
import { calculateWeightedObservations } from './scorer.js';
import { getFreedomScore } from './freedom-scores.js';
import { scoreJurisdiction } from './accessibility-scorer.js';

// Tests locking in the scoring changes shipped in algorithm v0.3.0.

describe('monitorBonus cap (v0.3.0)', () => {
  // monitorBonus = min(2.8, 1 + monitorCount/10); timeFactor = 1 at 0 days.
  test('caps the diversity bonus at 2.8 for 18+ monitors', () => {
    const at18 = calculateWeightedObservations(0, 100, 18, 0);
    const at50 = calculateWeightedObservations(0, 100, 50, 0);
    const at500 = calculateWeightedObservations(0, 100, 500, 0);
    expect(at18).toBe(280); // 100 * 2.8 * 1
    expect(at50).toBe(280); // capped, identical to 18
    expect(at500).toBe(280); // capped, no unbounded growth
  });

  test('still scales linearly below the cap', () => {
    expect(calculateWeightedObservations(0, 100, 10, 0)).toBe(200); // 100 * 2.0
    expect(calculateWeightedObservations(0, 100, 1, 0)).toBe(110); // 100 * 1.1
  });
});

describe('freedom score for unlisted countries (v0.3.0)', () => {
  test('returns null for a country not in the Freedom House table', () => {
    expect(getFreedomScore('ZZ')).toBeNull();
    expect(getFreedomScore(undefined)).toBeNull();
    expect(getFreedomScore(null)).toBeNull();
  });

  test('returns a score for a listed country', () => {
    const us = getFreedomScore('US');
    expect(us).not.toBeNull();
    expect(typeof us!.score).toBe('number');
  });
});

describe('scoreJurisdiction unlisted handling (v0.3.0)', () => {
  test('treats an unlisted country the same as unknown (75)', () => {
    expect(scoreJurisdiction('ZZ')).toBe(75);
    expect(scoreJurisdiction(undefined)).toBe(75);
    expect(scoreJurisdiction(null)).toBe(75);
  });

  test('an unlisted country is not scored more leniently than unknown', () => {
    // Regression guard for the old behavior where unlisted -> 65 freedom ->
    // ~99 jurisdiction, beating truly-unknown (75).
    expect(scoreJurisdiction('ZZ')).toBeLessThanOrEqual(scoreJurisdiction(undefined));
  });
});
