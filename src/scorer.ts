import type { ProbeResult, ReliabilityScore, Nip66Stats } from './types.js';

// =============================================================================
// Scoring Constants
// =============================================================================

/**
 * Reliability score component weights (must sum to 1.0)
 */
const RELIABILITY_WEIGHTS = {
  UPTIME: 0.40,
  RECOVERY: 0.20,
  CONSISTENCY: 0.20,
  LATENCY: 0.20,
} as const;

/**
 * Confidence level thresholds (based on weighted observations)
 */
const CONFIDENCE_THRESHOLDS = {
  HIGH: 500,    // >= 500 weighted observations
  MEDIUM: 100,  // >= 100 weighted observations
} as const;

/**
 * Recovery scoring thresholds (in minutes)
 */
const RECOVERY_THRESHOLDS = {
  EXCELLENT: 10,   // < 10 min avg outage = excellent (90-100)
  GOOD: 30,        // 10-30 min avg = good (75-90)
  MODERATE: 120,   // 30-120 min avg = moderate (50-75)
  MAX: 360,        // > 360 min = 0 score
} as const;

/**
 * Latency scoring tiers (in milliseconds)
 * Uses tiers instead of linear scale to reflect real-world usability:
 * - Users can't perceive differences under ~100ms
 * - 150-300ms is still "snappy" for most use cases
 * - Only >500ms starts feeling noticeably slow
 */
const LATENCY_TIERS = [
  { maxMs: 50,   score: 100 },  // Excellent - imperceptible
  { maxMs: 100,  score: 95 },   // Great - very fast
  { maxMs: 150,  score: 90 },   // Very good
  { maxMs: 200,  score: 85 },   // Good
  { maxMs: 300,  score: 75 },   // Acceptable
  { maxMs: 500,  score: 60 },   // Noticeable delay
  { maxMs: 750,  score: 40 },   // Slow
  { maxMs: 1000, score: 20 },   // Very slow
  { maxMs: Infinity, score: 0 }, // Unusable
] as const;

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
 * Calculate weighted observation count for confidence scoring
 *
 * NIP-66 metrics are weighted by:
 * - Monitor diversity: more monitors = more confidence (1.1 to 2.8x for 1-18 monitors)
 * - Time factor: longer observation period = more confidence (1.0 to 2.0x for 0-30 days)
 */
export function calculateWeightedObservations(
  probeCount: number,
  nip66MetricCount: number,
  monitorCount: number,
  observationPeriodDays: number
): number {
  // Base probe count
  const probeContribution = probeCount;

  // NIP-66 weighted contribution
  if (nip66MetricCount === 0) {
    return probeContribution;
  }

  // Monitor diversity bonus: 1 + (monitorCount / 10)
  // Range: 1.1 (1 monitor) to 2.8 (18 monitors)
  const monitorBonus = 1 + (Math.max(1, monitorCount) / 10);

  // Time factor: 1 + (days / 30), capped at 30 days
  // Range: 1.0 (0 days) to 2.0 (30+ days)
  const timeFactor = 1 + (Math.min(observationPeriodDays, 30) / 30);

  // Combined NIP-66 contribution
  const nip66Contribution = nip66MetricCount * monitorBonus * timeFactor;

  return Math.round(probeContribution + nip66Contribution);
}

/**
 * Determine confidence level from weighted observation count
 */
export function getConfidenceLevel(weightedObservations: number): 'low' | 'medium' | 'high' {
  if (weightedObservations >= CONFIDENCE_THRESHOLDS.HIGH) {
    return 'high';
  } else if (weightedObservations >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return 'medium';
  }
  return 'low';
}

/**
 * Score latency on a 0-100 scale using tiers
 * Reflects real-world usability rather than linear penalty
 */
function scoreLatency(ms: number | undefined): number {
  if (ms === undefined) return 0;

  // Find the appropriate tier
  for (const tier of LATENCY_TIERS) {
    if (ms <= tier.maxMs) {
      return tier.score;
    }
  }
  return 0;
}

/**
 * Calculate uptime score from probe results
 * Returns percentage of probes where relay was reachable (0-100)
 */
export function computeUptimeScore(probes: ProbeResult[]): number {
  if (probes.length === 0) return 0;
  const reachableCount = probes.filter(p => p.reachable).length;
  return Math.round((reachableCount / probes.length) * 100);
}

/**
 * Calculate consistency score from probe results
 * Low variance in connection times = high consistency
 * Uses coefficient of variation (CV): stddev / mean
 * CV of 0 = score 100, CV of 1+ = score 0
 *
 * Note: Only uses connectTime (not readTime) because they measure different
 * operations with different baseline latencies. Mixing them would create
 * artificial variance even if both are individually stable.
 */
export function computeConsistencyScore(probes: ProbeResult[]): number {
  const reachableProbes = probes.filter(p => p.reachable);
  if (reachableProbes.length < 2) {
    // Not enough data to measure consistency - assume moderate
    return 70;
  }

  // Get connect times only (not read times - they're different operations)
  const connectTimes: number[] = [];
  for (const probe of reachableProbes) {
    if (probe.connectTime !== undefined) {
      connectTimes.push(probe.connectTime);
    }
  }

  if (connectTimes.length < 2) {
    return 70; // Not enough data
  }

  // Calculate mean
  const mean = connectTimes.reduce((sum, v) => sum + v, 0) / connectTimes.length;
  if (mean === 0) return 100; // Perfect (no latency)

  // Calculate standard deviation
  const squaredDiffs = connectTimes.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / connectTimes.length;
  const stddev = Math.sqrt(variance);

  // Coefficient of variation
  const cv = stddev / mean;

  // Score: CV of 0 = 100, CV of 0.5 = 50, CV of 1+ = 0
  return clampScore(100 - (cv * 100));
}

/**
 * Calculate recovery score from probe results
 * Measures how quickly relay recovers from outages
 *
 * Scoring based on average outage duration:
 * - No outages: 100 (perfect)
 * - < 10 minutes avg: 90-100 (excellent recovery)
 * - 10-30 minutes avg: 75-90 (good recovery)
 * - 30-120 minutes avg: 50-75 (moderate recovery)
 * - > 120 minutes avg: 0-50 (poor recovery)
 */
export function computeRecoveryScore(probes: ProbeResult[]): number {
  if (probes.length < 2) {
    return 80; // Not enough data - assume moderate
  }

  // Sort probes by timestamp (oldest first)
  const sortedProbes = [...probes].sort((a, b) => a.timestamp - b.timestamp);

  // Find outage periods (consecutive unreachable probes)
  const outageDurations: number[] = [];
  let outageStart: number | null = null;

  for (let i = 0; i < sortedProbes.length; i++) {
    const probe = sortedProbes[i];
    const prevProbe = i > 0 ? sortedProbes[i - 1] : null;

    if (!probe.reachable && outageStart === null) {
      // Start of outage
      outageStart = probe.timestamp;
    } else if (probe.reachable && outageStart !== null) {
      // End of outage - calculate duration
      const duration = probe.timestamp - outageStart;
      outageDurations.push(duration);
      outageStart = null;
    }
  }

  // If still in outage at end, count time until last probe
  if (outageStart !== null) {
    const lastProbe = sortedProbes[sortedProbes.length - 1];
    const duration = lastProbe.timestamp - outageStart;
    outageDurations.push(duration);
  }

  // No outages = perfect recovery
  if (outageDurations.length === 0) {
    return 100;
  }

  // Calculate average outage duration in minutes
  const avgDurationSec = outageDurations.reduce((sum, d) => sum + d, 0) / outageDurations.length;
  const avgDurationMin = avgDurationSec / 60;

  // Score based on average outage duration using thresholds
  let score: number;
  if (avgDurationMin < RECOVERY_THRESHOLDS.EXCELLENT) {
    // Excellent: 90-100 (linear from 100 at 0 to 90 at threshold)
    score = 100 - (avgDurationMin);
  } else if (avgDurationMin < RECOVERY_THRESHOLDS.GOOD) {
    // Good: 75-90 (linear from 90 at EXCELLENT to 75 at GOOD)
    score = 90 - ((avgDurationMin - RECOVERY_THRESHOLDS.EXCELLENT) * 0.75);
  } else if (avgDurationMin < RECOVERY_THRESHOLDS.MODERATE) {
    // Moderate: 50-75 (linear from 75 at GOOD to 50 at MODERATE)
    score = 75 - ((avgDurationMin - RECOVERY_THRESHOLDS.GOOD) * (25 / 90));
  } else {
    // Poor: 0-50 (linear from 50 at MODERATE to 0 at MAX)
    score = 50 - ((avgDurationMin - RECOVERY_THRESHOLDS.MODERATE) * (50 / 240));
  }

  return clampScore(score);
}

/**
 * Calculate average latency from probes (in ms)
 * Combines connect and read times
 */
export function computeAverageLatency(probes: ProbeResult[]): number | undefined {
  const reachableProbes = probes.filter(p => p.reachable);
  if (reachableProbes.length === 0) return undefined;

  const latencies: number[] = [];
  for (const probe of reachableProbes) {
    // Prefer connect time as the primary latency measure
    if (probe.connectTime !== undefined) {
      latencies.push(probe.connectTime);
    }
  }

  if (latencies.length === 0) return undefined;
  return latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
}

/**
 * Calculate latency percentile score
 * @param avgLatencyMs - This relay's average latency
 * @param allRelayLatencies - Array of all relay latencies for comparison
 * @returns Score 0-100 where 100 = faster than all relays
 */
export function computeLatencyPercentileScore(
  avgLatencyMs: number | undefined,
  allRelayLatencies: number[]
): number {
  if (avgLatencyMs === undefined || allRelayLatencies.length === 0) {
    return 50; // Neutral score if no data
  }

  // Count how many relays are slower than this one
  const slowerCount = allRelayLatencies.filter(lat => lat > avgLatencyMs).length;

  // Percentile = (slower relays / total relays) * 100
  return clampScore((slowerCount / allRelayLatencies.length) * 100);
}

/**
 * Compute reliability score from probes and NIP-66 stats
 *
 * Reliability = 40% uptime + 20% recovery + 20% consistency + 20% latency percentile
 *
 * @param probes - Direct probe results
 * @param nip66Stats - Aggregated NIP-66 monitor data
 * @param allRelayLatencies - All relay latencies for percentile calculation (optional)
 */
export function computeCombinedReliabilityScore(
  probes: ProbeResult[],
  nip66Stats: Nip66Stats | null,
  allRelayLatencies?: number[]
): ReliabilityScore {
  const hasProbes = probes.length > 0;
  const hasNip66 = nip66Stats !== null && nip66Stats.metricCount > 0;

  // Calculate uptime from probes
  const uptimeScore = hasProbes ? computeUptimeScore(probes) : (hasNip66 ? 95 : 50);
  const uptimePercent = hasProbes ? uptimeScore : undefined;

  // Calculate recovery score from probes (how quickly relay recovers from outages)
  const recoveryScore = hasProbes ? computeRecoveryScore(probes) : 80;

  // Calculate consistency from probes
  const consistencyScore = hasProbes ? computeConsistencyScore(probes) : 70;

  // Calculate average latency (combine probe and NIP-66 data)
  let avgLatencyMs: number | undefined;
  const probeLatency = hasProbes ? computeAverageLatency(probes) : undefined;
  const nip66Latency = hasNip66 && nip66Stats!.avgRttOpen !== null ? nip66Stats!.avgRttOpen : undefined;

  if (probeLatency !== undefined && nip66Latency !== undefined) {
    // Average both sources
    avgLatencyMs = (probeLatency * 0.3 + nip66Latency * 0.7);
  } else {
    avgLatencyMs = probeLatency ?? nip66Latency;
  }

  // Calculate latency score using tiered approach (reflects real-world usability)
  const latencyScore = scoreLatency(avgLatencyMs);

  // Calculate raw latency scores for display
  const connectScore = scoreLatency(probeLatency ?? nip66Latency);
  const readScore = hasProbes
    ? scoreLatency(probes.filter(p => p.reachable && p.readTime).map(p => p.readTime!).reduce((a, b) => a + b, 0) / probes.filter(p => p.readTime).length || undefined)
    : scoreLatency(nip66Stats?.avgRttRead ?? undefined);

  // Compute overall reliability score using configured weights
  const overall = clampScore(
    uptimeScore * RELIABILITY_WEIGHTS.UPTIME +
    recoveryScore * RELIABILITY_WEIGHTS.RECOVERY +
    consistencyScore * RELIABILITY_WEIGHTS.CONSISTENCY +
    latencyScore * RELIABILITY_WEIGHTS.LATENCY
  );

  // Determine reachability
  const reachable = hasProbes
    ? probes.some(p => p.reachable)
    : hasNip66;

  // Calculate observation metadata
  const observations = probes.length + (nip66Stats?.metricCount ?? 0);
  const monitorCount = nip66Stats?.monitorCount ?? 0;

  let observationPeriodDays = 0;
  if (nip66Stats?.firstSeen && nip66Stats?.lastSeen) {
    observationPeriodDays = Math.max(1, Math.ceil((nip66Stats.lastSeen - nip66Stats.firstSeen) / 86400));
  }

  return {
    overall,
    uptimeScore,
    recoveryScore,
    consistencyScore,
    latencyScore,
    reachable,
    connectScore,
    readScore,
    observations,
    monitorCount,
    observationPeriodDays,
    avgLatencyMs: avgLatencyMs !== undefined ? Math.round(avgLatencyMs) : undefined,
    uptimePercent,
  };
}

/**
 * Compute reliability score from a single probe (simplified version)
 * Used when we don't have NIP-66 data or percentile data available
 */
export function computeReliabilityScore(probe: ProbeResult): ReliabilityScore {
  if (!probe.reachable) {
    return {
      overall: 0,
      uptimeScore: 0,
      recoveryScore: 0,
      consistencyScore: 0,
      latencyScore: 0,
      connectScore: 0,
      readScore: 0,
      reachable: false,
    };
  }

  const connectScore = scoreLatency(probe.connectTime);
  const readScore = scoreLatency(probe.readTime);

  // Single probe: uptime = 100 (it's reachable), recovery = 100 (no outages), consistency = 70 (unknown)
  const uptimeScore = 100;
  const recoveryScore = 100; // No outages observed
  const consistencyScore = 70;
  const latencyScore = connectScore; // Use raw score as fallback

  const overall = clampScore(
    uptimeScore * RELIABILITY_WEIGHTS.UPTIME +
    recoveryScore * RELIABILITY_WEIGHTS.RECOVERY +
    consistencyScore * RELIABILITY_WEIGHTS.CONSISTENCY +
    latencyScore * RELIABILITY_WEIGHTS.LATENCY
  );

  return {
    overall,
    uptimeScore,
    recoveryScore,
    consistencyScore,
    latencyScore,
    connectScore,
    readScore,
    reachable: true,
    avgLatencyMs: probe.connectTime !== undefined ? Math.round(probe.connectTime) : undefined,
    uptimePercent: 100,
  };
}

/**
 * Aggregate multiple probe results into a single reliability score
 * (Simplified version without percentile data)
 */
export function aggregateReliabilityScores(probes: ProbeResult[]): ReliabilityScore {
  if (probes.length === 0) {
    return {
      overall: 0,
      uptimeScore: 0,
      recoveryScore: 0,
      consistencyScore: 0,
      latencyScore: 0,
      connectScore: 0,
      readScore: 0,
      reachable: false,
    };
  }

  if (probes.length === 1) {
    return computeReliabilityScore(probes[0]);
  }

  return computeCombinedReliabilityScore(probes, null);
}

/**
 * Compute reliability score from NIP-66 aggregated stats only
 */
export function computeNip66ReliabilityScore(stats: Nip66Stats): ReliabilityScore {
  if (stats.metricCount === 0) {
    return {
      overall: 0,
      uptimeScore: 0,
      recoveryScore: 0,
      consistencyScore: 0,
      latencyScore: 0,
      connectScore: 0,
      readScore: 0,
      reachable: false,
      observations: 0,
      monitorCount: 0,
    };
  }

  // NIP-66 only reports reachable relays, so assume good uptime and recovery
  const uptimeScore = 95;
  const recoveryScore = 80; // Unknown from NIP-66 data - assume moderate
  const consistencyScore = 70; // Unknown from NIP-66 data

  const connectScore = scoreLatency(stats.avgRttOpen ?? undefined);
  const readScore = scoreLatency(stats.avgRttRead ?? undefined);
  const latencyScore = connectScore; // Use raw score as fallback

  const overall = clampScore(
    uptimeScore * RELIABILITY_WEIGHTS.UPTIME +
    recoveryScore * RELIABILITY_WEIGHTS.RECOVERY +
    consistencyScore * RELIABILITY_WEIGHTS.CONSISTENCY +
    latencyScore * RELIABILITY_WEIGHTS.LATENCY
  );

  let observationPeriodDays = 0;
  if (stats.firstSeen && stats.lastSeen) {
    observationPeriodDays = Math.max(1, Math.ceil((stats.lastSeen - stats.firstSeen) / 86400));
  }

  return {
    overall,
    uptimeScore,
    recoveryScore,
    consistencyScore,
    latencyScore,
    connectScore,
    readScore,
    reachable: true,
    observations: stats.metricCount,
    monitorCount: stats.monitorCount,
    observationPeriodDays,
    avgLatencyMs: stats.avgRttOpen !== null ? Math.round(stats.avgRttOpen) : undefined,
  };
}
