import type { NIP11Info, QualityScore, OperatorResolution } from './types.js';

// =============================================================================
// Quality Scoring Constants
// =============================================================================

/**
 * Quality score component weights (must sum to 1.0)
 */
const QUALITY_WEIGHTS = {
  POLICY: 0.60,
  SECURITY: 0.25,
  OPERATOR: 0.15,
} as const;

/**
 * Policy clarity score caps based on missing documentation
 */
const POLICY_CAPS = {
  NO_IDENTITY: 50,     // No name AND no description
  NO_CONTACT: 70,      // No accountability contact info
  NO_LIMITATIONS: 85,  // Rules not documented
  FULL: 100,           // All documentation present
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
 * Score policy clarity from NIP-11 document
 *
 * Evaluates:
 * - Has name/description (identity)
 * - Has contact info (accountability)
 * - Has content limitations documented (rules)
 * - Has clear payment/fees info if applicable
 *
 * Caps applied based on missing documentation:
 * - No name AND no description: cap at 50
 * - No contact: cap at 70
 * - No limitation object: cap at 85
 *
 * Returns 0-100
 */
export function scorePolicyClarity(nip11?: NIP11Info): number {
  if (!nip11) {
    return 50; // Unknown - neutral score
  }

  let score = 50; // Base score

  // Has name and description (+15)
  if (nip11.name && nip11.description) {
    score += 15;
  } else if (nip11.name || nip11.description) {
    score += 8;
  }

  // Has contact info (+15)
  if (nip11.contact) {
    score += 15;
  }

  // Has software/version info (+5)
  if (nip11.software || nip11.version) {
    score += 5;
  }

  // Has limitations documented (+10)
  if (nip11.limitation) {
    score += 10;

    // Extra for specific limits
    if (nip11.limitation.max_message_length !== undefined) score += 1;
    if (nip11.limitation.max_subscriptions !== undefined) score += 1;
    if (nip11.limitation.max_event_tags !== undefined) score += 1;
    if (nip11.limitation.max_content_length !== undefined) score += 1;
  }

  // Has fees documented if payment required (+5)
  if (nip11.limitation?.payment_required) {
    if (nip11.fees) {
      score += 5;
    } else {
      score -= 10; // Penalty for undocumented fees
    }
  }

  // Apply caps based on missing documentation
  const hasIdentity = !!(nip11.name || nip11.description);
  const hasContact = !!nip11.contact;
  const hasLimitations = !!nip11.limitation;

  let cap: number = POLICY_CAPS.FULL;
  if (!hasIdentity) {
    cap = Math.min(cap, POLICY_CAPS.NO_IDENTITY); // No identity = baseline only
  }
  if (!hasContact) {
    cap = Math.min(cap, POLICY_CAPS.NO_CONTACT); // No accountability
  }
  if (!hasLimitations) {
    cap = Math.min(cap, POLICY_CAPS.NO_LIMITATIONS); // Rules not documented
  }

  return Math.max(0, Math.min(cap, score));
}

/**
 * Score connection security
 *
 * Evaluates:
 * - TLS (wss://) vs unencrypted (ws://)
 *
 * ws:// is penalized because:
 * - Traffic can be intercepted (MITM attacks)
 * - No encryption - ISPs/governments can monitor
 * - User privacy at risk
 *
 * Returns 0-100 (100 = secure, lower = insecure)
 */
export function scoreConnectionSecurity(relayUrl?: string): number {
  if (!relayUrl) {
    return 50; // Unknown - neutral score
  }

  const url = relayUrl.toLowerCase();

  // ws:// is insecure - major penalty
  if (url.startsWith('ws://')) {
    return 0; // Completely insecure
  }

  // wss:// is secure
  if (url.startsWith('wss://')) {
    return 100;
  }

  // Unknown protocol
  return 50;
}

/**
 * Score operator accountability
 *
 * Combines:
 * - Verification confidence (0-100 based on method)
 * - WoT trust score (0-100 if available)
 *
 * If both available: 50% verification + 50% WoT
 * If only verification: 100% verification
 * If neither: neutral 50
 *
 * Returns 0-100 (100 = verified + trusted, lower = unknown/untrusted)
 */
export function scoreOperatorAccountability(
  operatorResolution?: OperatorResolution | null
): number {
  if (!operatorResolution || !operatorResolution.operatorPubkey) {
    return 50; // No operator info - neutral score
  }

  const verificationConfidence = operatorResolution.confidence ?? 0;
  const trustScore = operatorResolution.trustScore;

  // If we have both verification and WoT score, combine them
  if (trustScore !== undefined) {
    return clampScore(verificationConfidence * 0.5 + trustScore * 0.5);
  }

  // Only verification confidence available
  return clampScore(verificationConfidence);
}

/**
 * Compute overall quality score for a relay
 *
 * Components:
 * - policyScore (60%): NIP-11 documentation quality
 * - securityScore (25%): TLS encryption
 * - operatorScore (15%): Operator verification + WoT trust
 *
 * Note: Spam scoring was removed - relays don't create spam, users do.
 */
export function computeQualityScore(
  nip11?: NIP11Info,
  relayUrl?: string,
  operatorResolution?: OperatorResolution | null
): QualityScore {
  const policyScore = scorePolicyClarity(nip11);
  const securityScore = scoreConnectionSecurity(relayUrl);
  const operatorScore = scoreOperatorAccountability(operatorResolution);

  // Weighted combination using configured weights
  const overall = clampScore(
    policyScore * QUALITY_WEIGHTS.POLICY +
    securityScore * QUALITY_WEIGHTS.SECURITY +
    operatorScore * QUALITY_WEIGHTS.OPERATOR
  );

  return {
    overall,
    policyScore,
    securityScore,
    operatorScore,
  };
}

/**
 * Format quality score for display
 */
export function formatQualityScore(score: QualityScore): string {
  const lines: string[] = [
    `Overall: ${score.overall}/100`,
    `Policy score: ${score.policyScore}/100`,
    `Security score: ${score.securityScore}/100`,
    `Operator score: ${score.operatorScore}/100`,
  ];
  return lines.join('\n');
}
