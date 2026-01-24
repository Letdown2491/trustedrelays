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
 * Time decay constants for temporal weighting
 */
const TIME_DECAY = {
  HALF_LIFE_DAYS: 3,      // Weight halves every 3 days
  MIN_WEIGHT: 0.1,        // Minimum weight floor (old data still counts a bit)
} as const;

/**
 * Calculate time-based weight for a probe using exponential decay.
 * More recent probes are weighted more heavily.
 *
 * Formula: max(MIN_WEIGHT, e^(-age_days / HALF_LIFE_DAYS))
 *
 * With half-life of 3 days:
 * - Today: weight ≈ 1.0
 * - 3 days ago: weight ≈ 0.5
 * - 6 days ago: weight ≈ 0.25
 * - 30 days ago: weight ≈ 0.1 (floor)
 */
function getTimeWeight(timestamp: number, now: number = Date.now() / 1000): number {
  const ageSeconds = now - timestamp;
  const ageDays = ageSeconds / 86400;
  const decay = Math.exp(-ageDays / TIME_DECAY.HALF_LIFE_DAYS);
  return Math.max(TIME_DECAY.MIN_WEIGHT, decay);
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
 * Offline decay constants
 */
const OFFLINE_DECAY = {
  MAX_DAYS: 30,        // Full decay after 30 days
  MIN_FACTOR: 0.2,     // Floor at 20% of original score
  BASE_CAP: 50,        // Maximum reliability score when offline
} as const;

/**
 * Calculate reliability value for offline relays with gradual decay.
 *
 * Relays that just went offline get a higher score than those offline for weeks.
 * This reflects the likelihood of the relay coming back online.
 *
 * @param uptimePercent - Historical uptime percentage (0-100)
 * @param lastOnlineTimestamp - Unix timestamp of last successful probe
 * @param now - Current timestamp (optional, defaults to now)
 * @returns Decayed reliability value (0-50)
 */
export function calculateOfflineReliability(
  uptimePercent: number,
  lastOnlineTimestamp: number | undefined,
  now: number = Math.floor(Date.now() / 1000)
): number {
  // Start with capped uptime
  const baseScore = Math.min(OFFLINE_DECAY.BASE_CAP, uptimePercent);

  // If no last online timestamp, assume worst case
  if (!lastOnlineTimestamp) {
    return Math.round(baseScore * OFFLINE_DECAY.MIN_FACTOR);
  }

  // Calculate days since last online
  const daysSinceOnline = (now - lastOnlineTimestamp) / 86400;

  // Linear decay from 1.0 to MIN_FACTOR over MAX_DAYS
  const decayFactor = Math.max(
    OFFLINE_DECAY.MIN_FACTOR,
    1 - (daysSinceOnline / OFFLINE_DECAY.MAX_DAYS) * (1 - OFFLINE_DECAY.MIN_FACTOR)
  );

  return Math.round(baseScore * decayFactor);
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
 * Calculate uptime score from probe results with temporal weighting.
 * Recent probes are weighted more heavily than older ones.
 * Returns weighted percentage of probes where relay was reachable (0-100)
 */
export function computeUptimeScore(probes: ProbeResult[]): number {
  if (probes.length === 0) return 0;

  const now = Date.now() / 1000;
  let weightedReachable = 0;
  let totalWeight = 0;

  for (const probe of probes) {
    const weight = getTimeWeight(probe.timestamp, now);
    totalWeight += weight;
    if (probe.reachable) {
      weightedReachable += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return Math.round((weightedReachable / totalWeight) * 100);
}

/**
 * Calculate consistency score from probe results using IQR (Interquartile Range).
 *
 * Uses IQR-based scoring which is robust to outliers, unlike CV (coefficient of
 * variation). This is important because network probes often have bimodal
 * distributions with occasional multi-second outliers from TCP retries or
 * rate limiting, which would unfairly penalize otherwise excellent relays.
 *
 * Formula: score = 100 - (iqr_ratio * 50), where iqr_ratio = (P75 - P25) / P50
 *
 * Scoring scale:
 * - IQR ratio 0.0 → 100 (perfect consistency)
 * - IQR ratio 0.5 → 75 (good consistency)
 * - IQR ratio 1.0 → 50 (moderate consistency)
 * - IQR ratio 2.0+ → 0 (poor consistency)
 *
 * Note: Only uses connectTime (not readTime) because they measure different
 * operations with different baseline latencies.
 */
export function computeConsistencyScore(probes: ProbeResult[]): number {
  const reachableProbes = probes.filter(p => p.reachable);
  if (reachableProbes.length < 4) {
    // Need at least 4 samples for meaningful quartiles
    return 70;
  }

  // Get connect times
  const times: number[] = [];
  for (const probe of reachableProbes) {
    if (probe.connectTime !== undefined && probe.connectTime > 0) {
      times.push(probe.connectTime);
    }
  }

  if (times.length < 4) {
    return 70; // Not enough data
  }

  // Sort for percentile calculation
  times.sort((a, b) => a - b);

  // Calculate percentiles
  const p25 = percentile(times, 25);
  const p50 = percentile(times, 50);
  const p75 = percentile(times, 75);

  if (p50 === 0) return 100; // Perfect (no latency)

  // IQR ratio: how spread out is the middle 50% relative to median
  const iqrRatio = (p75 - p25) / p50;

  // Score: IQR ratio of 0 = 100, ratio of 2 = 0
  return clampScore(100 - (iqrRatio * 50));
}

/**
 * Calculate percentile value from sorted array.
 * Uses linear interpolation between closest ranks.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

/**
 * Recovery scoring constants
 */
const RECOVERY_FREQUENCY = {
  PENALTY_PER_OUTAGE: 3,  // Points deducted per outage
  MAX_PENALTY: 20,        // Maximum frequency penalty
} as const;

/**
 * Calculate recovery score from probe results with temporal weighting.
 * Measures how quickly relay recovers from outages.
 * Recent outages are weighted more heavily than older ones.
 *
 * Score combines two factors:
 * 1. Duration score: Based on weighted average outage duration
 * 2. Frequency penalty: Penalizes frequent outages (flapping)
 *
 * Duration scoring thresholds:
 * - No outages: 100 (perfect)
 * - < 10 minutes avg: 90-100 (excellent recovery)
 * - 10-30 minutes avg: 75-90 (good recovery)
 * - 30-120 minutes avg: 50-75 (moderate recovery)
 * - > 120 minutes avg: 0-50 (poor recovery)
 *
 * Frequency penalty: 3 points per weighted outage, max 20 points
 */
export function computeRecoveryScore(probes: ProbeResult[]): number {
  if (probes.length < 2) {
    return 80; // Not enough data - assume moderate
  }

  const now = Date.now() / 1000;

  // Sort probes by timestamp (oldest first)
  const sortedProbes = [...probes].sort((a, b) => a.timestamp - b.timestamp);

  // Find outage periods with their end timestamps for weighting
  const outages: Array<{ duration: number; endTimestamp: number }> = [];
  let outageStart: number | null = null;

  for (let i = 0; i < sortedProbes.length; i++) {
    const probe = sortedProbes[i];

    if (!probe.reachable && outageStart === null) {
      // Start of outage
      outageStart = probe.timestamp;
    } else if (probe.reachable && outageStart !== null) {
      // End of outage - calculate duration
      const duration = probe.timestamp - outageStart;
      outages.push({ duration, endTimestamp: probe.timestamp });
      outageStart = null;
    }
  }

  // If still in outage at end, count time until last probe
  if (outageStart !== null) {
    const lastProbe = sortedProbes[sortedProbes.length - 1];
    const duration = lastProbe.timestamp - outageStart;
    outages.push({ duration, endTimestamp: lastProbe.timestamp });
  }

  // No outages = perfect recovery
  if (outages.length === 0) {
    return 100;
  }

  // Calculate weighted average outage duration and weighted outage count
  // Weight by when the outage ended (recent outages matter more)
  let weightedDurationSum = 0;
  let totalWeight = 0;
  let weightedOutageCount = 0;

  for (const outage of outages) {
    const weight = getTimeWeight(outage.endTimestamp, now);
    weightedDurationSum += outage.duration * weight;
    totalWeight += weight;
    weightedOutageCount += weight; // Each outage contributes its weight to frequency
  }

  const avgDurationSec = weightedDurationSum / totalWeight;
  const avgDurationMin = avgDurationSec / 60;

  // Calculate duration-based score using thresholds
  let durationScore: number;
  if (avgDurationMin < RECOVERY_THRESHOLDS.EXCELLENT) {
    // Excellent: 90-100 (linear from 100 at 0 to 90 at threshold)
    durationScore = 100 - (avgDurationMin);
  } else if (avgDurationMin < RECOVERY_THRESHOLDS.GOOD) {
    // Good: 75-90 (linear from 90 at EXCELLENT to 75 at GOOD)
    durationScore = 90 - ((avgDurationMin - RECOVERY_THRESHOLDS.EXCELLENT) * 0.75);
  } else if (avgDurationMin < RECOVERY_THRESHOLDS.MODERATE) {
    // Moderate: 50-75 (linear from 75 at GOOD to 50 at MODERATE)
    durationScore = 75 - ((avgDurationMin - RECOVERY_THRESHOLDS.GOOD) * (25 / 90));
  } else {
    // Poor: 0-50 (linear from 50 at MODERATE to 0 at MAX)
    durationScore = 50 - ((avgDurationMin - RECOVERY_THRESHOLDS.MODERATE) * (50 / 240));
  }

  // Calculate frequency penalty (penalize flapping/frequent outages)
  // Uses weighted outage count so recent outages penalize more
  const frequencyPenalty = Math.min(
    RECOVERY_FREQUENCY.MAX_PENALTY,
    weightedOutageCount * RECOVERY_FREQUENCY.PENALTY_PER_OUTAGE
  );

  return clampScore(durationScore - frequencyPenalty);
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
 * For latency, we prefer the percentile-based score from NIP-66 monitors when available.
 * This removes geographic bias by ranking relays relative to other relays from each
 * monitor's perspective, rather than using raw latency values.
 *
 * @param probes - Direct probe results
 * @param nip66Stats - Aggregated NIP-66 monitor data (includes percentile-based latencyScore)
 */
export function computeCombinedReliabilityScore(
  probes: ProbeResult[],
  nip66Stats: Nip66Stats | null
): ReliabilityScore {
  const hasProbes = probes.length > 0;
  const hasNip66 = nip66Stats !== null && nip66Stats.metricCount > 0;
  const hasPercentileScore = nip66Stats?.latencyScore !== null && nip66Stats?.latencyScore !== undefined;

  // Calculate uptime from probes
  const uptimeScore = hasProbes ? computeUptimeScore(probes) : (hasNip66 ? 95 : 50);
  const uptimePercent = hasProbes ? uptimeScore : undefined;

  // Calculate recovery score from probes (how quickly relay recovers from outages)
  const recoveryScore = hasProbes ? computeRecoveryScore(probes) : 80;

  // Calculate consistency from probes
  const consistencyScore = hasProbes ? computeConsistencyScore(probes) : 70;

  // Calculate average latency for display (raw values)
  let avgLatencyMs: number | undefined;
  const probeLatency = hasProbes ? computeAverageLatency(probes) : undefined;
  const nip66Latency = hasNip66 && nip66Stats!.avgRttOpen !== null ? nip66Stats!.avgRttOpen : undefined;

  if (probeLatency !== undefined && nip66Latency !== undefined) {
    avgLatencyMs = (probeLatency * 0.3 + nip66Latency * 0.7);
  } else {
    avgLatencyMs = probeLatency ?? nip66Latency;
  }

  // Calculate latency score:
  // - Prefer percentile-based score from NIP-66 (removes geographic bias)
  // - Fall back to raw latency scoring if no percentile available
  let latencyScore: number;
  if (hasPercentileScore) {
    // Use percentile-based score directly (already 0-100)
    latencyScore = nip66Stats!.latencyScore!;
  } else {
    // Fall back to tiered scoring based on raw latency
    latencyScore = scoreLatency(avgLatencyMs);
  }

  // Calculate raw latency scores for display
  const connectScore = hasPercentileScore
    ? (nip66Stats!.connectPercentile ?? scoreLatency(probeLatency ?? nip66Latency))
    : scoreLatency(probeLatency ?? nip66Latency);
  const readScore = hasPercentileScore
    ? (nip66Stats!.readPercentile ?? scoreLatency(nip66Stats?.avgRttRead ?? undefined))
    : (hasProbes
      ? scoreLatency(probes.filter(p => p.reachable && p.readTime).map(p => p.readTime!).reduce((a, b) => a + b, 0) / probes.filter(p => p.readTime).length || undefined)
      : scoreLatency(nip66Stats?.avgRttRead ?? undefined));

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
