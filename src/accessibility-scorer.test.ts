import { describe, test, expect } from 'bun:test';
import {
  getEyesAlliance,
  scoreAccessBarriers,
  scoreLimitRestrictiveness,
  scoreJurisdiction,
  scoreSurveillance,
  computeAccessibilityScore,
} from './accessibility-scorer.js';
import type { NIP11Info } from './types.js';

describe('getEyesAlliance', () => {
  test('returns unknown for undefined country', () => {
    expect(getEyesAlliance(undefined)).toBe('unknown');
    expect(getEyesAlliance(null)).toBe('unknown');
  });

  test('identifies Five Eyes countries', () => {
    expect(getEyesAlliance('US')).toBe('five_eyes');
    expect(getEyesAlliance('GB')).toBe('five_eyes');
    expect(getEyesAlliance('CA')).toBe('five_eyes');
    expect(getEyesAlliance('AU')).toBe('five_eyes');
    expect(getEyesAlliance('NZ')).toBe('five_eyes');
  });

  test('identifies Nine Eyes countries', () => {
    expect(getEyesAlliance('DK')).toBe('nine_eyes');
    expect(getEyesAlliance('FR')).toBe('nine_eyes');
    expect(getEyesAlliance('NL')).toBe('nine_eyes');
    expect(getEyesAlliance('NO')).toBe('nine_eyes');
  });

  test('identifies Fourteen Eyes countries', () => {
    expect(getEyesAlliance('DE')).toBe('fourteen_eyes');
    expect(getEyesAlliance('BE')).toBe('fourteen_eyes');
    expect(getEyesAlliance('IT')).toBe('fourteen_eyes');
  });

  test('identifies privacy-friendly countries', () => {
    expect(getEyesAlliance('IS')).toBe('privacy_friendly');
    expect(getEyesAlliance('CH')).toBe('privacy_friendly');
  });

  test('returns non_aligned for other countries', () => {
    expect(getEyesAlliance('JP')).toBe('non_aligned');
    expect(getEyesAlliance('BR')).toBe('non_aligned');
  });

  test('is case insensitive', () => {
    expect(getEyesAlliance('us')).toBe('five_eyes');
    expect(getEyesAlliance('Us')).toBe('five_eyes');
  });
});

describe('scoreAccessBarriers', () => {
  test('returns 70 for undefined NIP-11', () => {
    expect(scoreAccessBarriers(undefined)).toBe(70);
  });

  test('returns 100 for open relay', () => {
    const nip11: NIP11Info = { name: 'Open Relay' };
    expect(scoreAccessBarriers(nip11)).toBe(100);
  });

  test('penalizes auth_required', () => {
    const nip11: NIP11Info = { limitation: { auth_required: true } };
    expect(scoreAccessBarriers(nip11)).toBe(70); // 100 - 30
  });

  test('penalizes payment_required', () => {
    const nip11: NIP11Info = { limitation: { payment_required: true } };
    expect(scoreAccessBarriers(nip11)).toBe(60); // 100 - 40
  });

  test('does not penalize restricted_writes (specialization, not exclusion)', () => {
    const nip11: NIP11Info = { limitation: { restricted_writes: true } };
    expect(scoreAccessBarriers(nip11)).toBe(100); // No penalty for kind restrictions
  });

  test('penalizes PoW requirement', () => {
    const nip11Low: NIP11Info = { limitation: { min_pow_difficulty: 5 } };
    const nip11High: NIP11Info = { limitation: { min_pow_difficulty: 20 } };

    expect(scoreAccessBarriers(nip11Low)).toBe(95); // 100 - 5
    expect(scoreAccessBarriers(nip11High)).toBe(85); // 100 - 15 (capped)
  });

  test('combines multiple barriers with diminishing returns', () => {
    const nip11: NIP11Info = {
      limitation: {
        auth_required: true,
        payment_required: true,
      },
    };
    // Diminishing returns: 40 × 1.0 + 30 × 0.5 = 55 penalty
    expect(scoreAccessBarriers(nip11)).toBe(45);
  });

  test('applies diminishing returns to all barriers', () => {
    const nip11: NIP11Info = {
      limitation: {
        auth_required: true,
        payment_required: true,
        min_pow_difficulty: 20,
      },
    };
    // Diminishing returns: 40 × 1.0 + 30 × 0.5 + 15 × 0.3 = 59.5 penalty
    expect(scoreAccessBarriers(nip11)).toBe(41);
  });
});

describe('scoreLimitRestrictiveness', () => {
  test('returns 80 for undefined NIP-11', () => {
    expect(scoreLimitRestrictiveness(undefined)).toBe(80);
  });

  test('returns 100 for no limitations', () => {
    const nip11: NIP11Info = { name: 'Relay' };
    expect(scoreLimitRestrictiveness(nip11)).toBe(100);
  });

  test('returns 100 for generous limits', () => {
    const nip11: NIP11Info = {
      limitation: {
        max_subscriptions: 100,
        max_content_length: 100000,
        max_message_length: 1000000,
      },
    };
    expect(scoreLimitRestrictiveness(nip11)).toBe(100);
  });

  test('penalizes very low subscription limit', () => {
    const veryLow: NIP11Info = { limitation: { max_subscriptions: 3 } };
    const low: NIP11Info = { limitation: { max_subscriptions: 7 } };
    const ok: NIP11Info = { limitation: { max_subscriptions: 20 } };

    expect(scoreLimitRestrictiveness(veryLow)).toBe(85); // 100 - 15
    expect(scoreLimitRestrictiveness(low)).toBe(95); // 100 - 5
    expect(scoreLimitRestrictiveness(ok)).toBe(100);
  });

  test('penalizes very low content length', () => {
    const veryLow: NIP11Info = { limitation: { max_content_length: 500 } };
    const low: NIP11Info = { limitation: { max_content_length: 3000 } };

    expect(scoreLimitRestrictiveness(veryLow)).toBe(85); // 100 - 15
    expect(scoreLimitRestrictiveness(low)).toBe(95); // 100 - 5
  });
});

describe('scoreJurisdiction', () => {
  test('returns 75 for unknown country', () => {
    expect(scoreJurisdiction(undefined)).toBe(75);
    expect(scoreJurisdiction(null)).toBe(75);
  });

  test('returns high score for free countries', () => {
    // These should have little to no penalty
    const scoreUS = scoreJurisdiction('US');
    const scoreDE = scoreJurisdiction('DE');

    expect(scoreUS).toBeGreaterThanOrEqual(80);
    expect(scoreDE).toBeGreaterThanOrEqual(80);
  });
});

describe('scoreSurveillance', () => {
  test('returns 85 for unknown country', () => {
    expect(scoreSurveillance(undefined)).toBe(85);
  });

  test('returns 100 for privacy-friendly countries', () => {
    expect(scoreSurveillance('IS')).toBe(100);
    expect(scoreSurveillance('CH')).toBe(100);
  });

  test('returns 70 for Five Eyes countries', () => {
    expect(scoreSurveillance('US')).toBe(70);
    expect(scoreSurveillance('GB')).toBe(70);
  });

  test('returns 90 for non-aligned countries', () => {
    expect(scoreSurveillance('JP')).toBe(90);
    expect(scoreSurveillance('BR')).toBe(90);
  });
});

describe('computeAccessibilityScore', () => {
  test('returns neutral score for no data', () => {
    const score = computeAccessibilityScore();
    // Should be around 70-80 (neutral assumptions)
    expect(score.overall).toBeGreaterThan(60);
    expect(score.overall).toBeLessThan(90);
  });

  test('returns high score for open relay in free country', () => {
    const nip11: NIP11Info = {
      name: 'Open Relay',
      limitation: {
        max_subscriptions: 100,
        max_message_length: 1000000,
      },
    };

    const score = computeAccessibilityScore(nip11, 'IS'); // Iceland - privacy friendly

    expect(score.barrierScore).toBe(100);
    expect(score.surveillanceScore).toBe(100);
    expect(score.overall).toBeGreaterThan(90);
  });

  test('returns lower score for restricted relay', () => {
    const nip11: NIP11Info = {
      limitation: {
        auth_required: true,
        payment_required: true,
      },
    };

    const score = computeAccessibilityScore(nip11, 'US');

    // Diminishing returns: 40 × 1.0 + 30 × 0.5 = 55 penalty → 45 score
    expect(score.barrierScore).toBe(45);
    // barrierScore 45 * 0.4 + limitScore 100 * 0.2 + jurisdiction ~95 * 0.2 + surveillance 70 * 0.2
    // = 18 + 20 + 19 + 14 = ~71
    expect(score.overall).toBeLessThan(75);
  });
});
