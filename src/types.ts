/**
 * NIP-11 Relay Information Document
 */
export interface NIP11Info {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    max_subid_length?: number;
    max_event_tags?: number;
    max_content_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    created_at_lower_limit?: number;
    created_at_upper_limit?: number;
  };
  fees?: {
    admission?: { amount: number; unit: string }[];
    subscription?: { amount: number; unit: string; period?: number }[];
    publication?: { kinds: number[]; amount: number; unit: string }[];
  };
  retention?: Array<{
    kinds?: number[];
    time?: number | null;  // seconds, null = forever
    count?: number;
  }>;
  relay_countries?: string[];  // ISO 3166-1 alpha-2 country codes
  payments_url?: string;
}

/**
 * Relay type classification based on NIP-11 and behavior
 */
export type RelayType =
  | 'general'      // Standard relay accepting most events
  | 'nip46'        // NIP-46 remote signing relay (kinds 24133, 24135 only)
  | 'specialized'  // Other specialized relay with restricted kinds
  | 'unknown';     // Could not determine

/**
 * Access level classification based on relay response to queries
 */
export type AccessLevel =
  | 'open'             // Accepts generic queries
  | 'restricted'       // Rejects broad filters (anti-scraping)
  | 'auth_required'    // Needs NIP-42 authentication
  | 'payment_required' // Needs payment (detected from CLOSED or NIP-11)
  | 'unknown';         // Could not determine

/**
 * Result of probing a relay
 */
export interface ProbeResult {
  url: string;
  timestamp: number;
  reachable: boolean;

  // Relay classification
  relayType: RelayType;

  // Access level (based on response to queries)
  accessLevel?: AccessLevel;
  closedReason?: string;  // Raw CLOSED message for debugging

  // Timing measurements (ms)
  connectTime?: number;
  nip11FetchTime?: number;
  readTime?: number;
  writeTime?: number;

  // NIP-11 data
  nip11?: NIP11Info;

  // Errors
  error?: string;
}

/**
 * Computed reliability score components
 *
 * Reliability = 40% uptime + 20% recovery + 20% consistency + 20% latency percentile
 * - Uptime: % of probes where relay was reachable
 * - Recovery: How quickly relay recovers from outages (short downtime = high)
 * - Consistency: Inverse of response time variance (stable = high)
 * - Latency Percentile: Rank vs other relays (removes geographic bias)
 */
export interface ReliabilityScore {
  overall: number;           // 0-100, weighted combination
  uptimeScore: number;       // 0-100, % of probes where relay was reachable
  recoveryScore: number;     // 0-100, how quickly relay recovers from outages
  consistencyScore: number;  // 0-100, inverse of response time variance
  latencyScore: number;      // 0-100, percentile rank vs other relays
  reachable: boolean;
  // Raw latency scores (for display/debugging)
  connectScore: number;      // 0-100, raw connect time score
  readScore: number;         // 0-100, raw read latency score
  // Observation metadata
  observations?: number;
  monitorCount?: number;
  observationPeriodDays?: number;
  // Raw metrics for display
  avgLatencyMs?: number;
  uptimePercent?: number;
}

/**
 * Aggregated NIP-66 metrics for a relay
 */
export interface Nip66Stats {
  metricCount: number;
  monitorCount: number;
  // Raw averages (kept for debugging/transparency)
  avgRttOpen: number | null;
  avgRttRead: number | null;
  avgRttWrite: number | null;
  // Percentile-based scores (0-100, removes geographic bias)
  latencyScore: number | null;       // Combined: 0.3 * connect + 0.7 * read
  connectPercentile: number | null;  // % of relays slower than this one (per monitor, then averaged)
  readPercentile: number | null;     // % of relays slower than this one (per monitor, then averaged)
  qualifyingMonitorCount: number;    // Monitors with ≥20 relays tracked
  firstSeen: number | null;
  lastSeen: number | null;
}

/**
 * Relay policy classification
 */
export type RelayPolicy = 'open' | 'moderated' | 'curated' | 'specialized';

/**
 * Operator verification methods (in order of confidence)
 */
export type VerificationMethod =
  | 'nip11_signed'  // NIP-11 pubkey + relay signs challenge (100% confidence)
  | 'dns'           // TXT record at _nostr.<domain> (80% confidence)
  | 'wellknown'     // /.well-known/nostr.json on relay domain (75% confidence)
  | 'nip11'         // NIP-11 pubkey field present, no challenge (70% confidence)
  | 'vouched'       // Other verified operators vouch (50% confidence, scaled)
  | 'claimed';      // Found somewhere but unverified (20% confidence)

/**
 * Confidence scores for each verification method (single source)
 */
export const VERIFICATION_CONFIDENCE: Record<VerificationMethod, number> = {
  'nip11_signed': 100,
  'dns': 80,
  'wellknown': 75,
  'nip11': 70,
  'vouched': 50,
  'claimed': 20,
};

/**
 * Corroborated confidence scores when multiple sources agree on the same pubkey
 * Higher confidence when independent verification methods confirm each other
 */
export const CORROBORATED_CONFIDENCE = {
  // Single source (fallback to VERIFICATION_CONFIDENCE)
  'nip11_only': 70,
  'dns_only': 80,
  'wellknown_only': 75,
  // Two sources agreeing
  'nip11_wellknown': 85,
  'nip11_dns': 90,
  'dns_wellknown': 90,
  // All three sources agreeing
  'nip11_dns_wellknown': 95,
} as const;

/**
 * Result of operator resolution for a relay
 */
export interface OperatorResolution {
  relayUrl: string;
  operatorPubkey: string | null;
  verificationMethod: VerificationMethod | null;
  verifiedAt: number;
  confidence: number;  // 0-100
  // Additional metadata from verification
  nip11Pubkey?: string;
  dnsPubkey?: string;
  wellknownPubkey?: string;
  // Corroboration tracking
  corroboratedSources?: VerificationMethod[];  // Which sources agreed on the pubkey
  sourcesDisagree?: boolean;  // True if sources provided conflicting pubkeys
  // WoT trust score from NIP-85 assertions
  trustScore?: number;  // 0-100
  trustConfidence?: 'low' | 'medium' | 'high';
  trustProviderCount?: number;
}

/**
 * Kind 30385 Trusted Relay Assertion
 */
export interface RelayAssertion {
  relayUrl: string;
  status: 'evaluated' | 'insufficient_data' | 'unreachable' | 'blocked';
  score?: number;
  reliability?: number;
  quality?: number;        // 0-100, operator accountability and policy
  accessibility?: number;  // 0-100, access barriers, limits, and jurisdiction
  confidence: 'low' | 'medium' | 'high';
  observations: number;
  observationPeriod: string;
  firstSeen: number;
  operator?: string;
  operatorVerified?: VerificationMethod;
  operatorConfidence?: number;
  operatorTrust?: number;  // WoT trust score from NIP-85 assertions
  policy?: RelayPolicy;
  policyConfidence?: number;  // Confidence in policy classification
  relayType?: RelayType;
  algorithm: string;
  algorithmUrl?: string;
  // Jurisdiction info
  countryCode?: string;    // ISO 3166-1 alpha-2
  region?: string;
  isHosting?: boolean;     // Running in datacenter
  // Network type (tor/i2p hidden services vs clearnet)
  network?: 'clearnet' | 'tor' | 'i2p';
}

/**
 * Unsigned Nostr event structure
 */
export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * NIP-85 Trust Assertion (kind 30382)
 * Published by trust assertion providers like relatr
 */
export interface TrustAssertion {
  eventId: string;
  providerPubkey: string;
  subjectPubkey: string;
  rank: number;  // 0-100
  timestamp: number;
  // Optional additional metrics
  zapAmountSent?: number;
  zapAmountReceived?: number;
}

/**
 * Aggregated trust score from multiple providers
 */
export interface AggregatedTrustScore {
  pubkey: string;
  score: number;  // 0-100, weighted average
  assertionCount: number;
  providers: string[];
  confidence: 'low' | 'medium' | 'high';
  computedAt: number;
}

/**
 * Trusted assertion provider configuration
 */
export interface TrustAssertionProvider {
  pubkey: string;
  name?: string;
  weight: number;  // 0-1, how much we trust this provider
}

/**
 * Relay report type (NIP-32 label-based)
 */
export type ReportType = 'spam' | 'censorship' | 'unreliable' | 'malicious';

/**
 * User-submitted relay report (kind 1985)
 */
export interface RelayReport {
  eventId: string;
  relayUrl: string;
  reporterPubkey: string;
  reportType: ReportType;
  content: string;
  timestamp: number;
  // Computed after ingestion via WoT
  reporterTrustWeight?: number;
}

/**
 * Configuration for report filtering/weighting
 */
export interface ReportFilterConfig {
  // Minimum WoT score for reporter to count
  minReporterTrust: number;           // default: 20
  // Rate limiting per pubkey
  maxReportsPerPubkeyPerDay: number;  // default: 10
  // Quadratic trust weighting exponent
  trustWeightExponent: number;        // default: 2
  // Minimum weighted sum to affect score
  minWeightedReports: number;         // default: 3.0
  // Time decay half-life in days
  reportHalfLifeDays: number;         // default: 30
}

/**
 * Aggregated report stats for a relay
 */
export interface RelayReportStats {
  relayUrl: string;
  reportCount: number;
  weightedReportCount: number;  // Sum of trust-weighted reports
  reporterCount: number;        // Unique reporters
  byType: Record<ReportType, {
    count: number;
    weightedCount: number;
  }>;
  firstReport: number | null;
  lastReport: number | null;
}

/**
 * Quality score components
 */
export interface QualityScore {
  overall: number;         // 0-100
  policyScore: number;     // 0-100 (clear policy = higher)
  securityScore: number;   // 0-100 (TLS, secure connection = higher)
  operatorScore: number;   // 0-100 (verified operator + WoT = higher)
}

/**
 * Accessibility score components
 */
export interface AccessibilityScore {
  overall: number;             // 0-100
  barrierScore: number;        // 0-100 (fewer auth/payment barriers = higher)
  limitScore: number;          // 0-100 (less restrictive limits = higher)
  jurisdictionScore: number;   // 0-100 (higher internet freedom = higher)
  surveillanceScore: number;   // 0-100 (less surveillance/Eyes alliance = higher)
}

/**
 * Intelligence alliance classification for surveillance scoring
 */
export type EyesAlliance = 'five_eyes' | 'nine_eyes' | 'fourteen_eyes' | 'non_aligned' | 'privacy_friendly' | 'unknown';

// =============================================================================
// Advanced Analytics Types
// =============================================================================

/**
 * Statistical confidence interval
 * Used for expressing uncertainty in scores
 */
export interface ConfidenceInterval {
  value: number;       // Point estimate (0-100)
  lower: number;       // Lower bound (0-100)
  upper: number;       // Upper bound (0-100)
  margin: number;      // Margin of error (value - lower)
  sampleSize: number;  // Number of observations
  level: 'low' | 'medium' | 'high';  // Qualitative confidence level
}

/**
 * Score with statistical confidence bounds
 */
export interface ConfidentScore {
  score: number;                    // Point estimate
  confidence: ConfidenceInterval;   // Statistical confidence
}

/**
 * Trend direction classification
 */
export type TrendDirection = 'improving' | 'stable' | 'degrading' | 'volatile' | 'insufficient_data';

/**
 * Time-series trend analysis
 */
export interface TrendAnalysis {
  direction: TrendDirection;
  magnitude: number;           // Absolute change over period
  percentChange: number;       // Relative change as percentage
  periodDays: number;          // Analysis period
  dataPoints: number;          // Number of observations in period
  // Rolling averages
  rolling7d: number | null;    // 7-day rolling average
  rolling30d: number | null;   // 30-day rolling average
  rolling90d: number | null;   // 90-day rolling average
  // Volatility (standard deviation of daily scores)
  volatility: number | null;
  // Linear regression slope (points per day)
  slope: number | null;
  // Is trend statistically significant?
  significant: boolean;
}

/**
 * Anomaly detection result
 */
export interface AnomalyResult {
  detected: boolean;
  type: 'spike' | 'drop' | 'outage' | 'recovery' | null;
  magnitude: number | null;    // How many standard deviations from mean
  timestamp: number | null;    // When anomaly was detected
  description: string | null;
}

/**
 * Relay ranking within the network
 */
export interface RelayRanking {
  // Overall ranking
  rank: number;                // Absolute rank (1 = best)
  totalRelays: number;         // Total relays in ranking
  percentile: number;          // Percentile (0-100, higher = better)
  // Category rankings
  reliabilityRank: number;
  reliabilityPercentile: number;
  qualityRank: number;
  qualityPercentile: number;
  accessibilityRank: number;
  accessibilityPercentile: number;
  // Peer comparison
  betterThanPercent: number;   // "Better than X% of relays"
  // Rank change
  previousRank: number | null; // Rank in previous period
  rankChange: number | null;   // Positive = improved, negative = dropped
}

/**
 * Extended relay assertion with analytics
 */
export interface RelayAssertionWithAnalytics extends RelayAssertion {
  // Statistical confidence
  scoreConfidence?: ConfidenceInterval;
  reliabilityConfidence?: ConfidenceInterval;
  // Trend analysis
  trend?: TrendAnalysis;
  anomaly?: AnomalyResult;
  // Network ranking
  ranking?: RelayRanking;
}

/**
 * Snapshot of relay scores for historical tracking
 */
export interface ScoreSnapshot {
  relayUrl: string;
  timestamp: number;
  score: number | null;
  reliability: number | null;
  quality: number | null;
  accessibility: number | null;
  observations: number;
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Network-wide statistics for aggregate analytics
 */
export interface NetworkStats {
  computedAt: number;
  periodDays: number;
  summary: {
    totalRelays: number;
    avgScore: number;
    medianScore: number;
    p25Score: number;
    p75Score: number;
    stddev: number;
    healthyCount: number;
    healthyPercent: number;
    degradedCount: number;
    poorCount: number;
    avgReliability: number;
    avgQuality: number;
    avgAccessibility: number;
  };
  comparison: {
    avgScoreChange: number | null;
    relayCountChange: number;
    healthyPercentChange: number | null;
  };
  distribution: Array<{
    bucket: string;
    count: number;
    percent: number;
  }>;
  trend: Array<{
    timestamp: number;
    avgScore: number;
    medianScore: number;
    relayCount: number;
  }>;
  geographic: Array<{
    countryCode: string;
    countryName: string;
    relayCount: number;
    avgScore: number;
    avgReliability: number;
  }>;
  topMovers: {
    improving: Array<{
      relayUrl: string;
      change: number;
      fromScore: number;
      toScore: number;
    }>;
    declining: Array<{
      relayUrl: string;
      change: number;
      fromScore: number;
      toScore: number;
    }>;
  };
  churn: {
    newRelays: number;
    wentOffline: number;
    zombieRelays: number;
  };
  relayTypes?: Array<{
    type: string;
    count: number;
    percent: number;
  }>;
  operatorTrust?: Array<{
    type: string;
    label: string;
    count: number;
    percent: number;
  }>;
  dataAgeDays?: number;
}
