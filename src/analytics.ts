/**
 * Advanced Analytics Module
 *
 * Provides statistical confidence intervals, time-series trend analysis,
 * and cross-relay comparison functions.
 */

import type {
  ConfidenceInterval,
  TrendAnalysis,
  TrendDirection,
  AnomalyResult,
  RelayRanking,
  ScoreSnapshot,
} from './types.js';

// =============================================================================
// Statistical Confidence
// =============================================================================

/**
 * Z-scores for common confidence levels
 */
const Z_SCORES = {
  '90%': 1.645,
  '95%': 1.96,
  '99%': 2.576,
} as const;

/**
 * Confidence level thresholds based on sample size and margin of error
 */
const CONFIDENCE_LEVEL_THRESHOLDS = {
  HIGH: { minSamples: 100, maxMargin: 5 },
  MEDIUM: { minSamples: 30, maxMargin: 10 },
} as const;

/**
 * Compute Wilson score interval for a proportion
 *
 * The Wilson score interval is better than the normal approximation for
 * proportions near 0 or 1, and for small sample sizes. It's the recommended
 * method for confidence intervals on uptime percentages.
 *
 * @param successes - Number of successes (e.g., reachable probes)
 * @param total - Total number of trials (e.g., total probes)
 * @param zScore - Z-score for desired confidence level (default: 95%)
 * @returns Lower and upper bounds of the confidence interval (0-1 scale)
 */
export function wilsonScoreInterval(
  successes: number,
  total: number,
  zScore: number = Z_SCORES['95%']
): { lower: number; upper: number } {
  if (total === 0) {
    return { lower: 0, upper: 1 };
  }

  const p = successes / total;
  const z2 = zScore * zScore;
  const n = total;

  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = zScore * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);

  const lower = Math.max(0, (center - margin) / denominator);
  const upper = Math.min(1, (center + margin) / denominator);

  return { lower, upper };
}

/**
 * Compute confidence interval for a score (0-100 scale)
 *
 * Uses a combination of sample size and score variance to estimate
 * the uncertainty in a score.
 *
 * @param score - Point estimate (0-100)
 * @param sampleSize - Number of observations
 * @param variance - Optional variance of observations (if available)
 */
export function computeScoreConfidenceInterval(
  score: number,
  sampleSize: number,
  variance?: number
): ConfidenceInterval {
  if (sampleSize === 0) {
    return {
      value: score,
      lower: 0,
      upper: 100,
      margin: 50,
      sampleSize: 0,
      level: 'low',
    };
  }

  // Estimate standard error
  // If variance is not provided, use a conservative estimate based on score
  // Scores near 50 have highest potential variance, scores near 0 or 100 have lower
  const estimatedVariance = variance ?? (score * (100 - score));
  const standardError = Math.sqrt(estimatedVariance / sampleSize);

  // 95% confidence interval
  const margin = Z_SCORES['95%'] * standardError;

  const lower = Math.max(0, Math.round(score - margin));
  const upper = Math.min(100, Math.round(score + margin));

  // Determine confidence level based on sample size and margin
  let level: 'low' | 'medium' | 'high';
  if (
    sampleSize >= CONFIDENCE_LEVEL_THRESHOLDS.HIGH.minSamples &&
    margin <= CONFIDENCE_LEVEL_THRESHOLDS.HIGH.maxMargin
  ) {
    level = 'high';
  } else if (
    sampleSize >= CONFIDENCE_LEVEL_THRESHOLDS.MEDIUM.minSamples &&
    margin <= CONFIDENCE_LEVEL_THRESHOLDS.MEDIUM.maxMargin
  ) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return {
    value: Math.round(score),
    lower,
    upper,
    margin: Math.round(margin),
    sampleSize,
    level,
  };
}

/**
 * Compute confidence interval for uptime (binary success/failure)
 *
 * Uses Wilson score interval which is more accurate for proportions.
 *
 * @param reachableCount - Number of successful probes
 * @param totalCount - Total number of probes
 */
export function computeUptimeConfidenceInterval(
  reachableCount: number,
  totalCount: number
): ConfidenceInterval {
  if (totalCount === 0) {
    return {
      value: 0,
      lower: 0,
      upper: 100,
      margin: 50,
      sampleSize: 0,
      level: 'low',
    };
  }

  const { lower, upper } = wilsonScoreInterval(reachableCount, totalCount);

  // Convert to 0-100 scale
  const value = Math.round((reachableCount / totalCount) * 100);
  const lowerPercent = Math.round(lower * 100);
  const upperPercent = Math.round(upper * 100);
  const margin = Math.round((upper - lower) * 50); // Half-width of interval

  // Determine confidence level
  let level: 'low' | 'medium' | 'high';
  if (totalCount >= 100 && margin <= 5) {
    level = 'high';
  } else if (totalCount >= 30 && margin <= 10) {
    level = 'medium';
  } else {
    level = 'low';
  }

  return {
    value,
    lower: lowerPercent,
    upper: upperPercent,
    margin,
    sampleSize: totalCount,
    level,
  };
}

// =============================================================================
// Time-Series Analytics
// =============================================================================

/**
 * Compute rolling average from score history
 *
 * @param history - Array of score snapshots (must be sorted by timestamp ascending)
 * @param windowDays - Number of days for the rolling window
 */
export function computeRollingAverage(
  history: ScoreSnapshot[],
  windowDays: number
): number | null {
  if (history.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowDays * 86400;

  const windowScores = history
    .filter((h) => h.timestamp >= windowStart && h.score !== null)
    .map((h) => h.score!);

  if (windowScores.length === 0) return null;

  const sum = windowScores.reduce((a, b) => a + b, 0);
  return Math.round(sum / windowScores.length);
}

/**
 * Compute standard deviation
 */
function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;

  return Math.sqrt(variance);
}

/**
 * Compute linear regression slope
 *
 * @param points - Array of {x, y} points
 * @returns Slope (y change per unit x)
 */
function linearRegressionSlope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;

  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumX2 = points.reduce((a, p) => a + p.x * p.x, 0);

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Compute trend analysis from score history
 *
 * @param history - Array of score snapshots (sorted by timestamp ascending)
 * @param periodDays - Analysis period in days (default: 30)
 */
export function computeTrendAnalysis(
  history: ScoreSnapshot[],
  periodDays: number = 30
): TrendAnalysis {
  const now = Math.floor(Date.now() / 1000);
  const periodStart = now - periodDays * 86400;

  // Filter to period and valid scores
  const periodHistory = history.filter(
    (h) => h.timestamp >= periodStart && h.score !== null
  );

  if (periodHistory.length < 2) {
    return {
      direction: 'insufficient_data',
      magnitude: 0,
      percentChange: 0,
      periodDays,
      dataPoints: periodHistory.length,
      rolling7d: computeRollingAverage(history, 7),
      rolling30d: computeRollingAverage(history, 30),
      rolling90d: computeRollingAverage(history, 90),
      volatility: null,
      slope: null,
      significant: false,
    };
  }

  // Get first and last scores in period
  const firstScore = periodHistory[0].score!;
  const lastScore = periodHistory[periodHistory.length - 1].score!;

  // Calculate change metrics
  const magnitude = lastScore - firstScore;
  const percentChange =
    firstScore !== 0 ? Math.round((magnitude / firstScore) * 100) : 0;

  // Calculate volatility (standard deviation of scores)
  const scores = periodHistory.map((h) => h.score!);
  const volatility = Math.round(standardDeviation(scores) * 10) / 10;

  // Calculate linear regression slope (points per day)
  const points = periodHistory.map((h) => ({
    x: (h.timestamp - periodStart) / 86400, // Convert to days
    y: h.score!,
  }));
  const slope = Math.round(linearRegressionSlope(points) * 100) / 100;

  // Determine if trend is statistically significant
  // Use simple heuristic: significant if absolute slope > volatility/periodDays
  const significant =
    volatility !== null && volatility > 0
      ? Math.abs(slope) > volatility / Math.sqrt(periodDays)
      : Math.abs(magnitude) >= 5;

  // Classify trend direction
  let direction: TrendDirection;
  if (volatility !== null && volatility > 15) {
    direction = 'volatile';
  } else if (!significant || Math.abs(magnitude) < 3) {
    direction = 'stable';
  } else if (magnitude > 0) {
    direction = 'improving';
  } else {
    direction = 'degrading';
  }

  return {
    direction,
    magnitude: Math.round(magnitude),
    percentChange,
    periodDays,
    dataPoints: periodHistory.length,
    rolling7d: computeRollingAverage(history, 7),
    rolling30d: computeRollingAverage(history, 30),
    rolling90d: computeRollingAverage(history, 90),
    volatility,
    slope,
    significant,
  };
}

/**
 * Detect anomalies in score history
 *
 * Uses simple z-score method: flag if recent score deviates more than
 * 2 standard deviations from the rolling mean.
 *
 * @param history - Array of score snapshots (sorted by timestamp ascending)
 * @param lookbackDays - Days to use for baseline calculation (default: 30)
 */
export function detectAnomaly(
  history: ScoreSnapshot[],
  lookbackDays: number = 30
): AnomalyResult {
  if (history.length < 5) {
    return {
      detected: false,
      type: null,
      magnitude: null,
      timestamp: null,
      description: null,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const lookbackStart = now - lookbackDays * 86400;

  // Get baseline scores (excluding last day)
  const oneDayAgo = now - 86400;
  const baselineHistory = history.filter(
    (h) => h.timestamp >= lookbackStart && h.timestamp < oneDayAgo && h.score !== null
  );

  if (baselineHistory.length < 3) {
    return {
      detected: false,
      type: null,
      magnitude: null,
      timestamp: null,
      description: null,
    };
  }

  // Calculate baseline statistics
  const baselineScores = baselineHistory.map((h) => h.score!);
  const mean = baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length;
  const stddev = standardDeviation(baselineScores);

  if (stddev === 0) {
    return {
      detected: false,
      type: null,
      magnitude: null,
      timestamp: null,
      description: null,
    };
  }

  // Get most recent score
  const recentHistory = history.filter(
    (h) => h.timestamp >= oneDayAgo && h.score !== null
  );
  if (recentHistory.length === 0) {
    return {
      detected: false,
      type: null,
      magnitude: null,
      timestamp: null,
      description: null,
    };
  }

  const latestSnapshot = recentHistory[recentHistory.length - 1];
  const latestScore = latestSnapshot.score!;

  // Calculate z-score
  const zScore = (latestScore - mean) / stddev;
  const absZ = Math.abs(zScore);

  // Threshold for anomaly detection (2 standard deviations)
  const ANOMALY_THRESHOLD = 2.0;

  if (absZ < ANOMALY_THRESHOLD) {
    return {
      detected: false,
      type: null,
      magnitude: null,
      timestamp: null,
      description: null,
    };
  }

  // Determine anomaly type
  let type: 'spike' | 'drop' | 'outage' | 'recovery';
  let description: string;

  if (zScore > 0) {
    // Score increased significantly
    if (mean < 50 && latestScore >= 70) {
      type = 'recovery';
      description = `Score recovered from ${Math.round(mean)} to ${latestScore}`;
    } else {
      type = 'spike';
      description = `Score spiked to ${latestScore} (${Math.round(absZ)}σ above normal)`;
    }
  } else {
    // Score decreased significantly
    if (latestScore < 30) {
      type = 'outage';
      description = `Possible outage: score dropped to ${latestScore}`;
    } else {
      type = 'drop';
      description = `Score dropped to ${latestScore} (${Math.round(absZ)}σ below normal)`;
    }
  }

  return {
    detected: true,
    type,
    magnitude: Math.round(absZ * 10) / 10,
    timestamp: latestSnapshot.timestamp,
    description,
  };
}

// =============================================================================
// Cross-Relay Comparison
// =============================================================================

/**
 * Score data for ranking calculation
 */
export interface RelayScoreData {
  url: string;
  score: number | null;
  reliability: number | null;
  quality: number | null;
  accessibility: number | null;
}

/**
 * Compute rankings for all relays
 *
 * @param relayScores - Array of relay score data
 * @param previousRankings - Optional previous rankings for change calculation
 */
export function computeAllRankings(
  relayScores: RelayScoreData[],
  previousRankings?: Map<string, number>
): Map<string, RelayRanking> {
  const result = new Map<string, RelayRanking>();

  // Filter to relays with valid scores
  const validRelays = relayScores.filter((r) => r.score !== null);
  const totalRelays = validRelays.length;

  if (totalRelays === 0) {
    return result;
  }

  // Sort by each metric to compute ranks
  const byScore = [...validRelays].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const byReliability = [...validRelays].sort(
    (a, b) => (b.reliability ?? 0) - (a.reliability ?? 0)
  );
  const byQuality = [...validRelays].sort(
    (a, b) => (b.quality ?? 0) - (a.quality ?? 0)
  );
  const byAccessibility = [...validRelays].sort(
    (a, b) => (b.accessibility ?? 0) - (a.accessibility ?? 0)
  );

  // Build ranking maps
  const scoreRankMap = new Map<string, number>();
  const reliabilityRankMap = new Map<string, number>();
  const qualityRankMap = new Map<string, number>();
  const accessibilityRankMap = new Map<string, number>();

  byScore.forEach((r, i) => scoreRankMap.set(r.url, i + 1));
  byReliability.forEach((r, i) => reliabilityRankMap.set(r.url, i + 1));
  byQuality.forEach((r, i) => qualityRankMap.set(r.url, i + 1));
  byAccessibility.forEach((r, i) => accessibilityRankMap.set(r.url, i + 1));

  // Compute rankings for each relay
  for (const relay of validRelays) {
    const rank = scoreRankMap.get(relay.url)!;
    const reliabilityRank = reliabilityRankMap.get(relay.url)!;
    const qualityRank = qualityRankMap.get(relay.url)!;
    const accessibilityRank = accessibilityRankMap.get(relay.url)!;

    // Percentile: what percentage of relays are ranked lower (worse)
    const percentile = Math.round(((totalRelays - rank) / totalRelays) * 100);
    const reliabilityPercentile = Math.round(
      ((totalRelays - reliabilityRank) / totalRelays) * 100
    );
    const qualityPercentile = Math.round(
      ((totalRelays - qualityRank) / totalRelays) * 100
    );
    const accessibilityPercentile = Math.round(
      ((totalRelays - accessibilityRank) / totalRelays) * 100
    );

    // "Better than X% of relays" = percentile
    const betterThanPercent = percentile;

    // Rank change from previous period
    const previousRank = previousRankings?.get(relay.url) ?? null;
    const rankChange =
      previousRank !== null ? previousRank - rank : null; // Positive = improved

    result.set(relay.url, {
      rank,
      totalRelays,
      percentile,
      reliabilityRank,
      reliabilityPercentile,
      qualityRank,
      qualityPercentile,
      accessibilityRank,
      accessibilityPercentile,
      betterThanPercent,
      previousRank,
      rankChange,
    });
  }

  return result;
}

/**
 * Compute ranking for a single relay
 *
 * @param relayUrl - URL of the relay to rank
 * @param relayScores - Array of all relay scores
 * @param previousRank - Optional previous rank for change calculation
 */
export function computeRelayRanking(
  relayUrl: string,
  relayScores: RelayScoreData[],
  previousRank?: number
): RelayRanking | null {
  const rankings = computeAllRankings(
    relayScores,
    previousRank !== undefined ? new Map([[relayUrl, previousRank]]) : undefined
  );
  return rankings.get(relayUrl) ?? null;
}

/**
 * Get relays in the same percentile tier (for peer comparison)
 *
 * @param relayUrl - Target relay URL
 * @param allRankings - All relay rankings
 * @param tierSize - Percentile tier size (default: 10 = decile)
 */
export function getPeerRelays(
  relayUrl: string,
  allRankings: Map<string, RelayRanking>,
  tierSize: number = 10
): string[] {
  const targetRanking = allRankings.get(relayUrl);
  if (!targetRanking) return [];

  const targetTier = Math.floor(targetRanking.percentile / tierSize);

  const peers: string[] = [];
  for (const [url, ranking] of allRankings) {
    if (url === relayUrl) continue;

    const tier = Math.floor(ranking.percentile / tierSize);
    if (tier === targetTier) {
      peers.push(url);
    }
  }

  return peers;
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Format a confidence interval for display
 */
export function formatConfidenceInterval(ci: ConfidenceInterval): string {
  if (ci.margin === 0) {
    return `${ci.value}`;
  }
  return `${ci.value} (±${ci.margin})`;
}

/**
 * Format a trend for display
 */
export function formatTrend(trend: TrendAnalysis): string {
  switch (trend.direction) {
    case 'improving':
      return `↑ +${trend.magnitude} over ${trend.periodDays}d`;
    case 'degrading':
      return `↓ ${trend.magnitude} over ${trend.periodDays}d`;
    case 'stable':
      return `→ stable`;
    case 'volatile':
      return `↕ volatile (±${trend.volatility})`;
    case 'insufficient_data':
      return `? insufficient data`;
  }
}

/**
 * Format a ranking for display
 */
export function formatRanking(ranking: RelayRanking): string {
  const changeStr =
    ranking.rankChange !== null
      ? ranking.rankChange > 0
        ? ` (↑${ranking.rankChange})`
        : ranking.rankChange < 0
          ? ` (↓${Math.abs(ranking.rankChange)})`
          : ` (→)`
      : '';

  return `#${ranking.rank} of ${ranking.totalRelays}${changeStr} • Top ${100 - ranking.percentile}%`;
}
