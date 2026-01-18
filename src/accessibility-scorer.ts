import type { NIP11Info, AccessibilityScore, EyesAlliance } from './types.js';
import { calculateFreedomPenalty } from './freedom-scores.js';

// =============================================================================
// Accessibility Scoring Constants
// =============================================================================

/**
 * Accessibility score component weights (must sum to 1.0)
 */
const ACCESSIBILITY_WEIGHTS = {
  BARRIER: 0.40,
  LIMIT: 0.20,
  JURISDICTION: 0.20,
  SURVEILLANCE: 0.20,
} as const;

/**
 * Access barrier penalties
 */
const BARRIER_PENALTIES = {
  AUTH_REQUIRED: 30,      // Authentication is a significant barrier
  PAYMENT_REQUIRED: 40,   // Payment is the biggest barrier
  RESTRICTED_WRITES: 10,  // Minor barrier
  MAX_POW_PENALTY: 15,    // Maximum PoW difficulty penalty
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Clamp a score to valid 0-100 range
 */
function clampScore(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Intelligence alliance membership mapping
 *
 * Five Eyes: Most extensive intelligence sharing (US, UK, CA, AU, NZ)
 * Nine Eyes: Five Eyes + DK, FR, NL, NO
 * Fourteen Eyes: Nine Eyes + DE, BE, IT, SE, ES
 * Privacy-friendly: Known for strong privacy laws and not in Eyes alliances
 * Non-aligned: Not in any known intelligence sharing alliance
 */
const EYES_ALLIANCE_MEMBERSHIP: Record<string, EyesAlliance> = {
  // Five Eyes - most extensive surveillance sharing
  'US': 'five_eyes',
  'GB': 'five_eyes',
  'CA': 'five_eyes',
  'AU': 'five_eyes',
  'NZ': 'five_eyes',

  // Nine Eyes - extended alliance
  'DK': 'nine_eyes',
  'FR': 'nine_eyes',
  'NL': 'nine_eyes',
  'NO': 'nine_eyes',

  // Fourteen Eyes - broadest known alliance
  'DE': 'fourteen_eyes',
  'BE': 'fourteen_eyes',
  'IT': 'fourteen_eyes',
  'SE': 'fourteen_eyes',
  'ES': 'fourteen_eyes',

  // Privacy-friendly countries (strong privacy laws, no Eyes membership)
  'IS': 'privacy_friendly',  // Iceland - strong press freedom, no Eyes
  'CH': 'privacy_friendly',  // Switzerland - strong privacy laws
  'RO': 'privacy_friendly',  // Romania - no data retention laws
  'PA': 'privacy_friendly',  // Panama - no data retention
  'MD': 'privacy_friendly',  // Moldova - outside surveillance alliances
};

/**
 * Get Eyes alliance membership for a country
 */
export function getEyesAlliance(countryCode?: string | null): EyesAlliance {
  if (!countryCode) return 'unknown';
  return EYES_ALLIANCE_MEMBERSHIP[countryCode.toUpperCase()] ?? 'non_aligned';
}

/**
 * Surveillance scores by alliance membership
 *
 * Higher score = less surveillance risk
 * - Privacy-friendly: 100 (no Eyes, strong privacy laws)
 * - Non-aligned: 90 (no known intelligence sharing)
 * - Fourteen Eyes: 80 (extended intelligence sharing)
 * - Nine Eyes: 75 (closer intelligence sharing)
 * - Five Eyes: 70 (most extensive surveillance sharing)
 * - Unknown: 85 (neutral assumption)
 */
const SURVEILLANCE_SCORES: Record<EyesAlliance, number> = {
  'privacy_friendly': 100,
  'non_aligned': 90,
  'fourteen_eyes': 80,
  'nine_eyes': 75,
  'five_eyes': 70,
  'unknown': 85,
};

/**
 * Score access barriers from NIP-11 document
 *
 * Evaluates barriers to entry:
 * - auth_required: Significant barrier (-30)
 * - payment_required: Major barrier (-40)
 * - restricted_writes: Minor barrier (-10)
 * - min_pow_difficulty: Minor barrier (-5 to -15)
 *
 * Returns 0-100 (100 = fully open, 0 = heavily restricted)
 */
export function scoreAccessBarriers(nip11?: NIP11Info): number {
  if (!nip11) {
    return 70; // Unknown - assume somewhat open
  }

  let score = 100;

  if (nip11.limitation) {
    const lim = nip11.limitation;

    // Authentication required is a significant barrier
    if (lim.auth_required) {
      score -= BARRIER_PENALTIES.AUTH_REQUIRED;
    }

    // Payment required is the biggest barrier
    if (lim.payment_required) {
      score -= BARRIER_PENALTIES.PAYMENT_REQUIRED;
    }

    // Restricted writes is a minor barrier
    if (lim.restricted_writes) {
      score -= BARRIER_PENALTIES.RESTRICTED_WRITES;
    }

    // PoW requirement is a minor barrier (scaled by difficulty)
    if (lim.min_pow_difficulty !== undefined && lim.min_pow_difficulty > 0) {
      const powPenalty = Math.min(BARRIER_PENALTIES.MAX_POW_PENALTY, lim.min_pow_difficulty);
      score -= powPenalty;
    }
  }

  return clampScore(score);
}

/**
 * Score limit restrictiveness from NIP-11 document
 *
 * Evaluates how restrictive the relay's limits are:
 * - Very low max_subscriptions: Limits usability
 * - Very low max_content_length: Limits content types
 * - Very low max_message_length: Limits event sizes
 * - Very low max_filters: Limits query capability
 *
 * Only penalizes VERY restrictive limits, not reasonable ones.
 * Returns 0-100 (100 = generous limits, lower = very restrictive)
 */
export function scoreLimitRestrictiveness(nip11?: NIP11Info): number {
  if (!nip11) {
    return 80; // Unknown - assume reasonable
  }

  let score = 100;

  if (nip11.limitation) {
    const lim = nip11.limitation;

    // Very low subscription limit (< 5 is problematic for multi-client use)
    if (lim.max_subscriptions !== undefined && lim.max_subscriptions < 5) {
      score -= 15;
    } else if (lim.max_subscriptions !== undefined && lim.max_subscriptions < 10) {
      score -= 5;
    }

    // Very low content length (< 1000 chars limits many use cases)
    if (lim.max_content_length !== undefined && lim.max_content_length < 1000) {
      score -= 15;
    } else if (lim.max_content_length !== undefined && lim.max_content_length < 5000) {
      score -= 5;
    }

    // Very low message length (< 10KB is restrictive)
    if (lim.max_message_length !== undefined && lim.max_message_length < 10000) {
      score -= 10;
    } else if (lim.max_message_length !== undefined && lim.max_message_length < 32000) {
      score -= 3;
    }

    // Very low filter limit (< 5 limits complex queries)
    if (lim.max_filters !== undefined && lim.max_filters < 5) {
      score -= 10;
    } else if (lim.max_filters !== undefined && lim.max_filters < 10) {
      score -= 3;
    }

    // Very low event tags limit (< 50 limits some event types)
    if (lim.max_event_tags !== undefined && lim.max_event_tags < 50) {
      score -= 5;
    }
  }

  return clampScore(score);
}

/**
 * Score jurisdiction based on internet freedom rating
 *
 * Uses Freedom House "Freedom on the Net" data:
 * - Free countries (70-100): No penalty
 * - Partly Free (40-69): 0-10 penalty
 * - Not Free (0-39): 10-20 penalty
 *
 * Returns 0-100 (100 = free internet country, lower = restricted)
 */
export function scoreJurisdiction(countryCode?: string | null): number {
  if (!countryCode) {
    return 75; // Unknown - assume moderately free
  }

  const penalty = calculateFreedomPenalty(countryCode);
  return Math.max(0, 100 - penalty);
}

/**
 * Score surveillance risk based on Eyes alliance membership
 *
 * Based on Five Eyes, Nine Eyes, Fourteen Eyes intelligence alliances.
 * These alliances share surveillance data between member countries.
 *
 * Returns 0-100 (100 = low surveillance risk, lower = higher risk)
 */
export function scoreSurveillance(countryCode?: string | null): number {
  const alliance = getEyesAlliance(countryCode);
  return SURVEILLANCE_SCORES[alliance];
}

/**
 * Compute overall accessibility score for a relay
 *
 * Components:
 * - barrierScore (40%): Auth, payment, PoW requirements
 * - limitScore (20%): How restrictive the relay limits are
 * - jurisdictionScore (20%): Internet freedom in relay's country (Freedom House)
 * - surveillanceScore (20%): Intelligence alliance membership (Five/Nine/Fourteen Eyes)
 *
 * Note: Censorship scoring was removed - no relay reporting mechanism exists.
 */
export function computeAccessibilityScore(
  nip11?: NIP11Info,
  countryCode?: string | null
): AccessibilityScore {
  const barrierScore = scoreAccessBarriers(nip11);
  const limitScore = scoreLimitRestrictiveness(nip11);
  const jurisdictionScore = scoreJurisdiction(countryCode);
  const surveillanceScore = scoreSurveillance(countryCode);

  // Weighted combination using configured weights
  const overall = clampScore(
    barrierScore * ACCESSIBILITY_WEIGHTS.BARRIER +
    limitScore * ACCESSIBILITY_WEIGHTS.LIMIT +
    jurisdictionScore * ACCESSIBILITY_WEIGHTS.JURISDICTION +
    surveillanceScore * ACCESSIBILITY_WEIGHTS.SURVEILLANCE
  );

  return {
    overall,
    barrierScore,
    limitScore,
    jurisdictionScore,
    surveillanceScore,
  };
}

/**
 * Format accessibility score for display
 */
export function formatAccessibilityScore(score: AccessibilityScore): string {
  const lines: string[] = [
    `Overall: ${score.overall}/100`,
    `Barrier score: ${score.barrierScore}/100`,
    `Limit score: ${score.limitScore}/100`,
    `Jurisdiction score: ${score.jurisdictionScore}/100`,
    `Surveillance score: ${score.surveillanceScore}/100`,
  ];
  return lines.join('\n');
}
