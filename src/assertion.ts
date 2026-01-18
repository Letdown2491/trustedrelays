import type { ProbeResult, ReliabilityScore, RelayAssertion, RelayPolicy, UnsignedEvent, OperatorResolution, QualityScore, AccessibilityScore, RelayReport } from './types.js';
import { normalizeRelayUrl } from './prober.js';
import { classifyPolicy, type PolicyClassification } from './policy-classifier.js';
import { calculateWeightedObservations, getConfidenceLevel } from './scorer.js';
import type { JurisdictionInfo } from './jurisdiction.js';

/**
 * Determine relay policy from relay type, NIP-11 info, and reports
 */
function determinePolicy(
  probes: ProbeResult[],
  reports?: RelayReport[]
): { policy: RelayPolicy | undefined; classification?: PolicyClassification } {
  const latestProbe = probes[probes.length - 1];

  // Use the policy classifier
  const classification = classifyPolicy(
    latestProbe.nip11,
    latestProbe.relayType,
    reports
  );

  return {
    policy: classification.policy,
    classification,
  };
}

// Default values (can be overridden via options)
const DEFAULT_ALGORITHM_VERSION = 'v0.1.1';
const DEFAULT_ALGORITHM_URL = 'https://github.com/Letdown2491/trustedrelays/blob/main/ALGORITHM.md';

/**
 * Options for building an assertion
 */
export interface BuildAssertionOptions {
  operatorResolution?: OperatorResolution;
  qualityScore?: QualityScore;
  accessibilityScore?: AccessibilityScore;
  reports?: RelayReport[];
  jurisdiction?: JurisdictionInfo;
  // Algorithm metadata (from config)
  algorithmVersion?: string;
  algorithmUrl?: string;
}

/**
 * Build a RelayAssertion from probe results, computed scores, and operator resolution
 */
export function buildAssertion(
  relayUrl: string,
  probes: ProbeResult[],
  score: ReliabilityScore,
  operatorResolution?: OperatorResolution,
  qualityScore?: QualityScore,
  accessibilityScore?: AccessibilityScore,
  options?: BuildAssertionOptions
): RelayAssertion {
  const url = normalizeRelayUrl(relayUrl);
  const latestProbe = probes[probes.length - 1];
  const firstProbe = probes[0];

  // Calculate historical uptime for offline penalty
  const reachableProbes = probes.filter(p => p.reachable).length;
  const uptimePercent = probes.length > 0 ? Math.round((reachableProbes / probes.length) * 100) : 0;

  // Calculate weighted observations for confidence
  // NIP-66 metrics are weighted by monitor diversity and observation time
  const nip66MetricCount = (score.observations ?? probes.length) - probes.length;
  const monitorCount = score.monitorCount ?? 0;
  const observationPeriodDays = score.observationPeriodDays ?? 0;
  const weightedObservations = calculateWeightedObservations(
    probes.length,
    Math.max(0, nip66MetricCount),
    monitorCount,
    observationPeriodDays
  );

  // Determine status based on latest probe (not historical data)
  let status: RelayAssertion['status'];
  if (!latestProbe.reachable) {
    status = 'unreachable';
  } else if (weightedObservations < 10) {
    status = 'insufficient_data';
  } else {
    status = 'evaluated';
  }

  // Determine confidence based on weighted observation count
  const confidence = getConfidenceLevel(weightedObservations);

  // Calculate observation period - use score metadata if available
  let observationPeriod: string;
  if (score.observationPeriodDays && score.observationPeriodDays > 0) {
    observationPeriod = `${score.observationPeriodDays}d`;
  } else {
    const periodSeconds = latestProbe.timestamp - firstProbe.timestamp;
    const periodDays = Math.floor(periodSeconds / 86400);
    observationPeriod = periodDays > 0 ? `${periodDays}d` : '<1d';
  }

  // Determine policy using classifier
  const { policy, classification } = determinePolicy(probes, options?.reports);

  // Compute overall score as weighted average: Reliability 40%, Quality 35%, Accessibility 25%
  // If currently offline: use historical uptime capped at 50 (offline relays can't score high on reliability)
  const reliabilityVal = latestProbe.reachable ? score.overall : Math.min(50, uptimePercent);
  const qualityVal = qualityScore?.overall ?? 50;
  const accessibilityVal = accessibilityScore?.overall ?? 50;
  const overallScore = Math.round(
    reliabilityVal * 0.40 +
    qualityVal * 0.35 +
    accessibilityVal * 0.25
  );

  const assertion: RelayAssertion = {
    relayUrl: url,
    status,
    score: overallScore,
    reliability: reliabilityVal,
    quality: qualityScore?.overall,
    accessibility: accessibilityScore?.overall,
    confidence,
    observations: weightedObservations,
    observationPeriod,
    firstSeen: firstProbe.timestamp,
    algorithm: options?.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION,
    algorithmUrl: options?.algorithmUrl ?? DEFAULT_ALGORITHM_URL,
  };

  // Set operator from resolution if available, otherwise fall back to NIP-11
  if (operatorResolution?.operatorPubkey) {
    assertion.operator = operatorResolution.operatorPubkey;
    assertion.operatorVerified = operatorResolution.verificationMethod ?? undefined;
    assertion.operatorConfidence = operatorResolution.confidence;
    // Include WoT trust score if available
    if (operatorResolution.trustScore !== undefined) {
      assertion.operatorTrust = operatorResolution.trustScore;
    }
  } else if (latestProbe.nip11?.pubkey) {
    assertion.operator = latestProbe.nip11.pubkey;
    assertion.operatorVerified = 'nip11';
    assertion.operatorConfidence = 70;
  }

  if (policy) {
    assertion.policy = policy;
    if (classification) {
      assertion.policyConfidence = classification.confidence;
    }
  }

  // Add jurisdiction info if available
  if (options?.jurisdiction) {
    const jur = options.jurisdiction;
    if (jur.countryCode) {
      assertion.countryCode = jur.countryCode;
    }
    if (jur.region) {
      assertion.region = jur.region;
    }
    if (jur.isHosting !== undefined) {
      assertion.isHosting = jur.isHosting;
    }
    // Set network type based on jurisdiction detection
    if (jur.isTor) {
      assertion.network = 'tor';
    } else if (jur.countryCode === 'XX') {
      // XX is used for I2P as well
      assertion.network = 'i2p';
    }
  }

  // Include relay type for transparency
  assertion.relayType = latestProbe.relayType;

  return assertion;
}

/**
 * Convert a RelayAssertion to an unsigned kind 30385 event
 */
export function assertionToEvent(assertion: RelayAssertion): UnsignedEvent {
  const tags: string[][] = [
    ['d', assertion.relayUrl],
    ['status', assertion.status],
    ['algorithm', assertion.algorithm],
  ];

  if (assertion.algorithmUrl) {
    tags.push(['algorithm_url', assertion.algorithmUrl]);
  }

  if (assertion.score !== undefined) {
    tags.push(['score', assertion.score.toString()]);
  }

  if (assertion.reliability !== undefined) {
    tags.push(['reliability', assertion.reliability.toString()]);
  }

  if (assertion.quality !== undefined) {
    tags.push(['quality', assertion.quality.toString()]);
  }

  if (assertion.accessibility !== undefined) {
    tags.push(['accessibility', assertion.accessibility.toString()]);
  }

  tags.push(['confidence', assertion.confidence]);
  tags.push(['observations', assertion.observations.toString()]);
  tags.push(['observation_period', assertion.observationPeriod]);
  tags.push(['first_seen', assertion.firstSeen.toString()]);

  if (assertion.operator) {
    tags.push(['operator', assertion.operator]);
  }

  if (assertion.operatorVerified) {
    tags.push(['operator_verified', assertion.operatorVerified]);
  }

  if (assertion.operatorConfidence !== undefined) {
    tags.push(['operator_confidence', assertion.operatorConfidence.toString()]);
  }

  if (assertion.operatorTrust !== undefined) {
    tags.push(['operator_trust', assertion.operatorTrust.toString()]);
  }

  if (assertion.policy) {
    tags.push(['policy', assertion.policy]);
  }

  if (assertion.policyConfidence !== undefined) {
    tags.push(['policy_confidence', assertion.policyConfidence.toString()]);
  }

  // Jurisdiction tags
  if (assertion.countryCode) {
    tags.push(['country_code', assertion.countryCode]);
  }

  if (assertion.region) {
    tags.push(['region', assertion.region]);
  }

  if (assertion.isHosting !== undefined) {
    tags.push(['is_hosting', assertion.isHosting.toString()]);
  }

  if (assertion.network) {
    tags.push(['network', assertion.network]);
  }

  return {
    kind: 30385,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
}

/**
 * Format an assertion for human-readable display
 */
export function formatAssertion(assertion: RelayAssertion): string {
  const lines: string[] = [
    `Relay: ${assertion.relayUrl}`,
    `Status: ${assertion.status}`,
  ];

  if (assertion.relayType) {
    lines.push(`Type: ${assertion.relayType}`);
  }

  if (assertion.policy) {
    const policyConf = assertion.policyConfidence ? ` (${assertion.policyConfidence}% confidence)` : '';
    lines.push(`Policy: ${assertion.policy}${policyConf}`);
  }

  // Jurisdiction
  if (assertion.countryCode) {
    let location = assertion.countryCode;
    if (assertion.region) {
      location = `${assertion.region}, ${location}`;
    }
    const hostingInfo = assertion.isHosting ? ' (datacenter)' : '';
    lines.push(`Location: ${location}${hostingInfo}`);
  }

  if (assertion.score !== undefined) {
    lines.push(`Score: ${assertion.score}/100`);
  }

  if (assertion.reliability !== undefined) {
    lines.push(`Reliability: ${assertion.reliability}/100`);
  }

  if (assertion.quality !== undefined) {
    lines.push(`Quality: ${assertion.quality}/100`);
  }

  if (assertion.accessibility !== undefined) {
    lines.push(`Accessibility: ${assertion.accessibility}/100`);
  }

  lines.push(`Confidence: ${assertion.confidence}`);
  lines.push(`Observations: ${assertion.observations} over ${assertion.observationPeriod}`);

  if (assertion.operator) {
    lines.push(`Operator: ${assertion.operator}`);
    const verifyInfo = assertion.operatorConfidence !== undefined
      ? `${assertion.operatorVerified} (${assertion.operatorConfidence}% confidence)`
      : assertion.operatorVerified;
    lines.push(`Operator verified: ${verifyInfo}`);
    if (assertion.operatorTrust !== undefined) {
      lines.push(`Operator trust: ${assertion.operatorTrust}/100`);
    }
  }

  lines.push(`Algorithm: ${assertion.algorithm}`);

  return lines.join('\n');
}
