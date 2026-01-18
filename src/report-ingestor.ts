import { WebSocket } from 'ws';
import { verifyEvent, type Event } from 'nostr-tools';
import type { RelayReport, ReportType, ReportFilterConfig, TrustAssertionProvider } from './types.js';
import type { DataStore } from './database.js';
import { getTrustScore } from './wot-client.js';
import { normalizeRelayUrl } from './prober.js';

// NIP-32 Label event kind
const KIND_LABEL = 1985;

/**
 * Validate that an unknown object has the structure of a Nostr Event
 * Performs thorough validation to prevent malformed data from causing issues
 */
function isValidEventShape(obj: unknown): obj is Event {
  if (!obj || typeof obj !== 'object') return false;
  const e = obj as Record<string, unknown>;

  // Basic type checks
  if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' ||
      typeof e.created_at !== 'number' || typeof e.kind !== 'number' ||
      !Array.isArray(e.tags) || typeof e.content !== 'string' ||
      typeof e.sig !== 'string') {
    return false;
  }

  // Validate hex string formats (64 chars for id/pubkey, 128 for sig)
  if (!/^[0-9a-f]{64}$/i.test(e.id) || !/^[0-9a-f]{64}$/i.test(e.pubkey) ||
      !/^[0-9a-f]{128}$/i.test(e.sig)) {
    return false;
  }

  // Validate created_at is a reasonable timestamp (after 2020, before 2100)
  if (e.created_at < 1577836800 || e.created_at > 4102444800) {
    return false;
  }

  // Validate kind is a non-negative integer
  if (!Number.isInteger(e.kind) || e.kind < 0) {
    return false;
  }

  // Validate tags are arrays of strings
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || !tag.every(item => typeof item === 'string')) {
      return false;
    }
  }

  return true;
}

// Label namespace for relay reports
const LABEL_NAMESPACE = 'relay-report';

// Valid report types as labels
const VALID_REPORT_TYPES: ReportType[] = ['spam', 'censorship', 'unreliable', 'malicious'];

// Default configuration
const DEFAULT_CONFIG: ReportFilterConfig = {
  minReporterTrust: 20,
  maxReportsPerPubkeyPerDay: 10,
  trustWeightExponent: 2,
  minWeightedReports: 3.0,
  reportHalfLifeDays: 30,
};

// Default relays to query for reports
const DEFAULT_SOURCE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/**
 * Parse a kind 1985 event into a RelayReport
 *
 * Expected structure (NIP-32):
 * - L tag: ["L", "relay-report"]
 * - l tag: ["l", "spam", "relay-report"] or ["l", "censorship", "relay-report"]
 * - r tag: ["r", "wss://relay.example.com"]
 *
 * @param event - The Nostr event to parse
 * @param skipVerification - Only set to true if signature was already verified
 */
export function parseRelayReport(event: Event, skipVerification = false): RelayReport | null {
  // Always verify signature unless explicitly skipped (caller already verified)
  if (!skipVerification && !verifyEvent(event)) {
    return null;
  }

  if (event.kind !== KIND_LABEL) return null;

  // Check for relay-report namespace
  const lNamespace = event.tags.find(
    (t) => t[0] === 'L' && t[1] === LABEL_NAMESPACE
  );
  if (!lNamespace) return null;

  // Get the label (report type)
  const labelTag = event.tags.find(
    (t) => t[0] === 'l' && t[2] === LABEL_NAMESPACE && VALID_REPORT_TYPES.includes(t[1] as ReportType)
  );
  if (!labelTag) return null;

  // Get the relay URL from r tag
  const relayTag = event.tags.find((t) => t[0] === 'r');
  if (!relayTag || !relayTag[1]) return null;

  // Validate relay URL
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(relayTag[1]);
  } catch {
    return null;
  }

  return {
    eventId: event.id,
    relayUrl,
    reporterPubkey: event.pubkey,
    reportType: labelTag[1] as ReportType,
    content: event.content,
    timestamp: event.created_at,
  };
}

/**
 * Calculate trust weight for a reporter
 * Uses quadratic weighting: (trust/100)^exponent
 */
export function calculateTrustWeight(
  trustScore: number,
  config: ReportFilterConfig = DEFAULT_CONFIG
): number {
  // Clamp trust score to 0-100
  const normalizedTrust = Math.max(0, Math.min(100, trustScore));

  // Apply quadratic weighting
  return Math.pow(normalizedTrust / 100, config.trustWeightExponent);
}

/**
 * Calculate time decay for a report
 * Exponential decay with half-life
 */
export function calculateTimeDecay(
  reportTimestamp: number,
  config: ReportFilterConfig = DEFAULT_CONFIG
): number {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - reportTimestamp;
  const ageDays = ageSeconds / 86400;

  // Exponential decay: 0.5^(age/halfLife)
  return Math.pow(0.5, ageDays / config.reportHalfLifeDays);
}

/**
 * Configuration for the report ingestor
 */
export interface ReportIngestorConfig {
  sourceRelays: string[];
  db: DataStore;
  filterConfig?: Partial<ReportFilterConfig>;
  trustedProviders?: TrustAssertionProvider[];
  nip85Relays?: string[];
  nip85Timeout?: number;
  fetchTrustScores?: boolean;
  onReport?: (report: RelayReport) => void;
  verbose?: boolean;
}

/**
 * Ingestor for kind 1985 relay reports
 */
export class ReportIngestor {
  private config: ReportIngestorConfig;
  private filterConfig: ReportFilterConfig;
  private sockets: Map<string, WebSocket> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private running = false;
  private reportCount = 0;
  private verbose: boolean;

  constructor(config: ReportIngestorConfig) {
    this.config = {
      ...config,
      sourceRelays: config.sourceRelays ?? DEFAULT_SOURCE_RELAYS,
      fetchTrustScores: config.fetchTrustScores ?? true,
      nip85Timeout: config.nip85Timeout ?? 10000,
    };
    this.filterConfig = { ...DEFAULT_CONFIG, ...config.filterConfig };
    this.verbose = config.verbose ?? false;
  }

  /**
   * Start ingesting reports
   */
  async start(): Promise<void> {
    this.running = true;

    for (const relay of this.config.sourceRelays) {
      this.connectToRelay(relay);
    }
  }

  /**
   * Stop ingesting
   */
  stop(): void {
    this.running = false;
    for (const ws of this.sockets.values()) {
      ws.close();
    }
    this.sockets.clear();
    this.reconnectAttempts.clear();
  }

  /**
   * Get count of reports ingested
   */
  getReportCount(): number {
    return this.reportCount;
  }

  private connectToRelay(relayUrl: string): void {
    const ws = new WebSocket(relayUrl);
    this.sockets.set(relayUrl, ws);

    const subId = `reports-${crypto.randomUUID()}`;

    ws.on('open', () => {
      if (this.verbose) console.log(`Connected to ${relayUrl} for reports`);
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts.set(relayUrl, 0);

      // Subscribe to kind 1985 events with relay-report label namespace
      const filter = {
        kinds: [KIND_LABEL],
        '#L': [LABEL_NAMESPACE],
        // Get reports from last 90 days
        since: Math.floor(Date.now() / 1000) - (90 * 86400),
      };

      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', async (data) => {
      if (!this.running) return;

      try {
        const msg = JSON.parse(data.toString());

        if (msg[0] === 'EVENT' && msg[2]) {
          // Validate event structure before processing
          if (!isValidEventShape(msg[2])) return;
          await this.handleEvent(msg[2]);
        } else if (msg[0] === 'EOSE') {
          if (this.verbose) console.log(`End of stored events from ${relayUrl}`);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      this.sockets.delete(relayUrl);

      // Reconnect with exponential backoff if still running
      if (this.running) {
        const attempts = this.reconnectAttempts.get(relayUrl) ?? 0;
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
        const delay = Math.min(1000 * Math.pow(2, attempts), 60000);
        this.reconnectAttempts.set(relayUrl, attempts + 1);
        if (this.verbose) console.log(`Reconnecting to ${relayUrl} in ${delay}ms (attempt ${attempts + 1})`);
        setTimeout(() => this.connectToRelay(relayUrl), delay);
      }
    });

    ws.on('error', (err) => {
      console.warn(`WebSocket error on ${relayUrl}:`, err.message);
    });
  }

  private async handleEvent(event: Event): Promise<void> {
    // Verify signature
    if (!verifyEvent(event)) {
      return;
    }

    // Parse the report (skip verification since we just verified)
    const report = parseRelayReport(event, true);
    if (!report) {
      return;
    }

    // Check if already stored
    const exists = await this.config.db.reportExists(report.eventId);
    if (exists) {
      return;
    }

    // Rate limiting: check reports per day per reporter for this relay
    const dailyCount = await this.config.db.getReporterDailyCount(
      report.reporterPubkey,
      report.relayUrl
    );
    if (dailyCount >= this.filterConfig.maxReportsPerPubkeyPerDay) {
      console.warn(`Rate limited reporter ${report.reporterPubkey.slice(0, 8)}... for ${report.relayUrl}`);
      return;
    }

    // Fetch and apply trust weight
    if (this.config.fetchTrustScores) {
      try {
        const trustScore = await getTrustScore(report.reporterPubkey, {
          relays: this.config.nip85Relays,
          trustedProviders: this.config.trustedProviders,
          timeout: this.config.nip85Timeout,
        });

        if (trustScore) {
          // Filter out reporters below minimum trust
          if (trustScore.score < this.filterConfig.minReporterTrust) {
            if (this.verbose) console.log(`Ignoring report from low-trust reporter ${report.reporterPubkey.slice(0, 8)}... (trust: ${trustScore.score})`);
            return;
          }

          report.reporterTrustWeight = calculateTrustWeight(trustScore.score, this.filterConfig);
        } else {
          // No trust data - use default weight of 0.5 (equivalent to 70 trust with exponent 2)
          report.reporterTrustWeight = 0.5;
        }
      } catch (err) {
        // WoT lookup failed, use default weight
        report.reporterTrustWeight = 0.5;
      }
    }

    // Store the report
    await this.config.db.storeReport(report);
    this.reportCount++;

    // Notify callback
    if (this.config.onReport) {
      this.config.onReport(report);
    }
  }
}

/**
 * Query relays for existing reports about a specific relay
 */
export async function queryRelayReports(
  relayUrl: string,
  options: {
    sourceRelays?: string[];
    timeout?: number;
  } = {}
): Promise<RelayReport[]> {
  const sourceRelays = options.sourceRelays ?? DEFAULT_SOURCE_RELAYS;
  const timeout = options.timeout ?? 10000;

  const normalizedUrl = normalizeRelayUrl(relayUrl);
  const reports: RelayReport[] = [];
  const seenEventIds = new Set<string>();

  const promises = sourceRelays.map((relay) =>
    queryRelayForReports(relay, normalizedUrl, timeout)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const report of result.value) {
        if (!seenEventIds.has(report.eventId)) {
          seenEventIds.add(report.eventId);
          reports.push(report);
        }
      }
    }
  }

  return reports;
}

/**
 * Query a single relay for reports
 */
async function queryRelayForReports(
  sourceRelay: string,
  targetRelayUrl: string,
  timeout: number
): Promise<RelayReport[]> {
  return new Promise((resolve) => {
    const reports: RelayReport[] = [];
    const ws = new WebSocket(sourceRelay);
    const subId = `rpt-${crypto.randomUUID()}`;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve(reports);
    }, timeout);

    ws.on('open', () => {
      // Query for kind 1985 with relay-report namespace and r tag for target relay
      const filter = {
        kinds: [KIND_LABEL],
        '#L': [LABEL_NAMESPACE],
        '#r': [targetRelayUrl],
        since: Math.floor(Date.now() / 1000) - (90 * 86400),
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg[0] === 'EVENT' && msg[2]) {
          // Validate event structure before processing
          if (!isValidEventShape(msg[2])) return;
          const event = msg[2];

          if (!verifyEvent(event)) return;

          const report = parseRelayReport(event, true);
          if (report) {
            reports.push(report);
          }
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeoutId);
          ws.close();
          resolve(reports);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', () => {
      clearTimeout(timeoutId);
      resolve(reports);
    });

    ws.on('close', () => {
      clearTimeout(timeoutId);
      resolve(reports);
    });
  });
}

/**
 * Format a relay report for display
 */
export function formatReport(report: RelayReport): string {
  const lines: string[] = [
    `Type: ${report.reportType}`,
    `Reporter: ${report.reporterPubkey.slice(0, 16)}...`,
    `Date: ${new Date(report.timestamp * 1000).toISOString()}`,
  ];

  if (report.reporterTrustWeight !== undefined) {
    lines.push(`Trust weight: ${(report.reporterTrustWeight * 100).toFixed(1)}%`);
  }

  if (report.content) {
    lines.push(`Content: ${report.content.slice(0, 100)}${report.content.length > 100 ? '...' : ''}`);
  }

  return lines.join('\n');
}
