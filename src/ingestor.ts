import { WebSocket } from 'ws';
import { verifyEvent, type Event } from 'nostr-tools';
import { DataStore } from './database.js';
import { normalizeRelayUrl } from './prober.js';

// Polyfill WebSocket for nostr-tools in Node
(globalThis as any).WebSocket = WebSocket;

export interface Nip66Event extends Event {
  kind: 30166;
}

export interface MonitorIngestorConfig {
  // Relays to subscribe to for NIP-66 events
  sourceRelays: string[];
  // Only accept events from these monitors (empty = accept all)
  trustedMonitors: string[];
  // Database for storage
  db: DataStore;
  // Callback when new metric is received
  onMetric?: (relayUrl: string, metric: ParsedNip66Metric) => void;
  // Enable verbose logging (default: false)
  verbose?: boolean;
}

export interface ParsedNip66Metric {
  eventId: string;
  relayUrl: string;
  monitorPubkey: string;
  timestamp: number;
  rttOpen?: number;
  rttRead?: number;
  rttWrite?: number;
  network?: string;
  supportedNips?: number[];
  geohash?: string;
  // NIP-66 tags added upstream after the initial implementation:
  relayType?: string;          // 'T' tag: PascalCase relay type, e.g. "PrivateInbox"
  requirements?: string[];     // 'R' tag: NIP-11 limitation keys, '!'-prefixed when false (e.g. "auth", "!payment")
  topics?: string[];           // 't' tag: relay topics
  acceptedKinds?: number[];    // 'k' tag: kinds the relay accepts
  rejectedKinds?: number[];    // 'k' tag: kinds the relay rejects ('!'-prefixed upstream)
}

/**
 * Parse an integer with bounds validation
 * Returns undefined if invalid, NaN, or out of bounds
 */
function parseBoundedInt(value: string, min: number, max: number): number | undefined {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    return undefined;
  }
  return parsed;
}

// RTT bounds: 0ms to 60 seconds (60000ms) - anything outside is likely invalid
const RTT_MIN = 0;
const RTT_MAX = 60000;

// NIP number bounds: 1 to 65535 (reasonable upper bound)
const NIP_MIN = 1;
const NIP_MAX = 65535;

// Event kind bounds: 0 to 65535 (NIP-01 range)
const KIND_MIN = 0;
const KIND_MAX = 65535;

// Defensive caps on a single event's tag fan-out (the 512KB WebSocket frame
// cap already bounds total size; these bound per-field memory/array growth).
const MAX_TAGS = 1000;
const MAX_ARRAY_VALUES = 256;

/**
 * Parse a NIP-66 kind 30166 event into a structured metric
 */
export function parseNip66Event(event: Event): ParsedNip66Metric | null {
  if (event.kind !== 30166) return null;

  // Get relay URL from 'd' tag
  const dTag = event.tags.find((t) => t[0] === 'd');
  if (!dTag || !dTag[1]) return null;

  const relayUrl = normalizeRelayUrl(dTag[1]);

  const metric: ParsedNip66Metric = {
    eventId: event.id,
    relayUrl,
    monitorPubkey: event.pubkey,
    timestamp: event.created_at,
  };

  // Parse RTT tags with bounds validation (cap the number of tags processed).
  const tags = event.tags.length > MAX_TAGS ? event.tags.slice(0, MAX_TAGS) : event.tags;
  for (const tag of tags) {
    switch (tag[0]) {
      case 'rtt-open':
        metric.rttOpen = parseBoundedInt(tag[1], RTT_MIN, RTT_MAX);
        break;
      case 'rtt-read':
        metric.rttRead = parseBoundedInt(tag[1], RTT_MIN, RTT_MAX);
        break;
      case 'rtt-write':
        metric.rttWrite = parseBoundedInt(tag[1], RTT_MIN, RTT_MAX);
        break;
      case 'n':
        metric.network = tag[1];
        break;
      case 'N':
        // Supported NIPs - can be multiple tags or comma-separated
        if (!metric.supportedNips) metric.supportedNips = [];
        const nips = tag[1]
          .split(',')
          .map((n) => parseBoundedInt(n.trim(), NIP_MIN, NIP_MAX))
          .filter((n): n is number => n !== undefined);
        metric.supportedNips.push(...nips);
        break;
      case 'g':
        metric.geohash = tag[1];
        break;
      case 'T':
        // Relay type (PascalCase). Single value; last non-empty wins.
        if (tag[1]) metric.relayType = tag[1];
        break;
      case 'R':
        // Requirements mirroring NIP-11 limitations (auth/writes/pow/payment),
        // negated with a '!' prefix. Repeated per the spec; also tolerate
        // comma-separated for robustness. Raw tokens are preserved.
        if (tag[1]) {
          if (!metric.requirements) metric.requirements = [];
          metric.requirements.push(
            ...tag[1].split(',').map((r) => r.trim()).filter((r) => r.length > 0)
          );
        }
        break;
      case 't':
        // Relay topic. One topic per tag.
        if (tag[1]) {
          if (!metric.topics) metric.topics = [];
          metric.topics.push(tag[1].trim());
        }
        break;
      case 'k': {
        // Accepted/unaccepted kinds; unaccepted are '!'-prefixed.
        if (!tag[1]) break;
        for (const raw of tag[1].split(',').map((k) => k.trim())) {
          if (!raw) continue;
          const rejected = raw.startsWith('!');
          const kind = parseBoundedInt(rejected ? raw.slice(1) : raw, KIND_MIN, KIND_MAX);
          if (kind === undefined) continue;
          if (rejected) {
            (metric.rejectedKinds ??= []).push(kind);
          } else {
            (metric.acceptedKinds ??= []).push(kind);
          }
        }
        break;
      }
    }
  }

  // Cap each parsed array so a hostile/buggy event can't bloat memory or the DB.
  if (metric.supportedNips && metric.supportedNips.length > MAX_ARRAY_VALUES) metric.supportedNips.length = MAX_ARRAY_VALUES;
  if (metric.requirements && metric.requirements.length > MAX_ARRAY_VALUES) metric.requirements.length = MAX_ARRAY_VALUES;
  if (metric.topics && metric.topics.length > MAX_ARRAY_VALUES) metric.topics.length = MAX_ARRAY_VALUES;
  if (metric.acceptedKinds && metric.acceptedKinds.length > MAX_ARRAY_VALUES) metric.acceptedKinds.length = MAX_ARRAY_VALUES;
  if (metric.rejectedKinds && metric.rejectedKinds.length > MAX_ARRAY_VALUES) metric.rejectedKinds.length = MAX_ARRAY_VALUES;

  return metric;
}

/**
 * Monitor ingestor - subscribes to NIP-66 events and stores them
 */
export class MonitorIngestor {
  private config: MonitorIngestorConfig;
  private connections: Map<string, WebSocket> = new Map();
  private subscriptionIds: Map<string, string> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private running = false;
  private eventCount = 0;
  private trustedSet: Set<string>;
  private verbose: boolean;
  // Monitor stats (last_seen/event_count) are approximate and were written
  // once per ingested event. Buffer them and flush periodically to avoid a
  // second DB write per event during reconnect bursts (P-M2).
  private monitorStatBuffer: Map<string, { count: number; lastSeen: number }> = new Map();
  private statsFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MonitorIngestorConfig) {
    this.config = config;
    this.trustedSet = new Set(config.trustedMonitors);
    this.verbose = config.verbose ?? false;
  }

  /**
   * Start ingesting from all source relays
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.verbose) {
      console.log(`Starting NIP-66 ingestor with ${this.config.sourceRelays.length} source relay(s)`);
      if (this.trustedSet.size > 0) {
        console.log(`Filtering to ${this.trustedSet.size} trusted monitor(s)`);
      } else {
        console.log('Accepting events from all monitors');
      }
    }

    // Periodically flush buffered monitor stats (every 15s).
    this.statsFlushTimer = setInterval(() => { void this.flushMonitorStats(); }, 15000);
    this.statsFlushTimer.unref?.();

    for (const relayUrl of this.config.sourceRelays) {
      this.connectToRelay(relayUrl);
    }
  }

  /** Drain the buffered monitor-stat counters into the DB in one batch. */
  private async flushMonitorStats(): Promise<void> {
    if (this.monitorStatBuffer.size === 0) return;
    const batch = this.monitorStatBuffer;
    this.monitorStatBuffer = new Map();
    try {
      await this.config.db.flushMonitorStats(batch);
    } catch (err) {
      if (this.verbose) console.error('Failed to flush monitor stats:', err);
    }
  }

  /**
   * Stop all subscriptions
   */
  stop(): void {
    this.running = false;

    if (this.statsFlushTimer) {
      clearInterval(this.statsFlushTimer);
      this.statsFlushTimer = null;
    }
    // Best-effort final flush of buffered monitor stats.
    void this.flushMonitorStats();

    for (const [url, ws] of this.connections) {
      const subId = this.subscriptionIds.get(url);
      if (subId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(['CLOSE', subId]));
      }
      ws.close();
    }

    this.connections.clear();
    this.subscriptionIds.clear();
    if (this.verbose) {
      console.log(`Ingestor stopped. Total events received: ${this.eventCount}`);
    }
  }

  private connectToRelay(relayUrl: string): void {
    const url = normalizeRelayUrl(relayUrl);
    if (this.verbose) console.log(`Connecting to ${url}...`);

    const ws = new WebSocket(url, { maxPayload: 512 * 1024 });

    ws.on('open', () => {
      if (this.verbose) console.log(`Connected to ${url}`);
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts.set(url, 0);
      this.subscribe(url, ws);
    });

    ws.on('message', (data) => {
      this.handleMessage(url, data.toString());
    });

    ws.on('error', (err) => {
      if (this.verbose) console.error(`Error on ${url}:`, err.message);
    });

    ws.on('close', () => {
      if (this.verbose) console.log(`Disconnected from ${url}`);
      this.connections.delete(url);
      this.subscriptionIds.delete(url);

      // Reconnect with exponential backoff if still running
      if (this.running) {
        const attempts = this.reconnectAttempts.get(url) ?? 0;
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, max 60s
        const delay = Math.min(1000 * Math.pow(2, attempts), 60000);
        this.reconnectAttempts.set(url, attempts + 1);
        if (this.verbose) console.log(`Reconnecting to ${url} in ${delay}ms (attempt ${attempts + 1})`);
        setTimeout(() => this.connectToRelay(relayUrl), delay);
      }
    });

    this.connections.set(url, ws);
  }

  private subscribe(url: string, ws: WebSocket): void {
    const subId = `nip66-${crypto.randomUUID()}`;
    this.subscriptionIds.set(url, subId);

    // Subscribe to kind 30166 events
    // If we have trusted monitors, filter by their pubkeys
    const filter: any = {
      kinds: [30166],
      limit: 1000, // Get recent events on connect
    };

    if (this.trustedSet.size > 0) {
      filter.authors = Array.from(this.trustedSet);
    }

    ws.send(JSON.stringify(['REQ', subId, filter]));
    if (this.verbose) console.log(`Subscribed to kind 30166 on ${url} (subId: ${subId})`);
  }

  private async handleMessage(relayUrl: string, message: string): Promise<void> {
    try {
      const msg = JSON.parse(message);

      if (msg[0] === 'EVENT') {
        const event = msg[2] as Event;
        await this.handleEvent(relayUrl, event);
      } else if (msg[0] === 'EOSE') {
        if (this.verbose) console.log(`End of stored events from ${relayUrl}`);
      } else if (msg[0] === 'NOTICE') {
        if (this.verbose) console.log(`Notice from ${relayUrl}: ${msg[1]}`);
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  private async handleEvent(_relayUrl: string, event: Event): Promise<void> {
    // Verify event signature
    if (!verifyEvent(event)) {
      if (this.verbose) console.warn(`Invalid event signature: ${event.id}`);
      return;
    }

    // Check if from trusted monitor (if filtering)
    if (this.trustedSet.size > 0 && !this.trustedSet.has(event.pubkey)) {
      return;
    }

    // Parse the NIP-66 event
    const metric = parseNip66Event(event);
    if (!metric) return;

    // Store in database
    try {
      await this.config.db.storeNip66Metric(metric);
      // Buffer the monitor-stat update (flushed periodically) instead of a
      // second synchronous write per event.
      const existing = this.monitorStatBuffer.get(event.pubkey);
      const now = Math.floor(Date.now() / 1000);
      if (existing) { existing.count++; existing.lastSeen = now; }
      else this.monitorStatBuffer.set(event.pubkey, { count: 1, lastSeen: now });
      this.eventCount++;

      // Call callback if provided
      if (this.config.onMetric) {
        this.config.onMetric(metric.relayUrl, metric);
      }

      // Log periodically
      if (this.verbose && this.eventCount % 100 === 0) {
        console.log(`Ingested ${this.eventCount} events...`);
      }
    } catch (err) {
      if (this.verbose) console.error(`Error storing metric:`, err);
    }
  }

  getEventCount(): number {
    return this.eventCount;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

/**
 * Discover NIP-66 monitors by querying for kind 10166 events
 */
export async function discoverMonitors(
  relayUrl: string,
  timeout = 10000
): Promise<Array<{ pubkey: string; frequency?: number }>> {
  return new Promise((resolve, reject) => {
    const monitors: Array<{ pubkey: string; frequency?: number }> = [];
    const ws = new WebSocket(normalizeRelayUrl(relayUrl), { maxPayload: 512 * 1024 });
    const subId = `discover-${crypto.randomUUID()}`;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve(monitors);
    }, timeout);

    ws.on('open', () => {
      // Query for kind 10166 (monitor announcements)
      ws.send(JSON.stringify(['REQ', subId, { kinds: [10166], limit: 100 }]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'EVENT' && msg[2]?.kind === 10166) {
          const event = msg[2] as Event;
          // Verify the signature before trusting the announced pubkey — without
          // this, anyone can forge a kind-10166 for an arbitrary pubkey and get
          // it enrolled as a "monitor" whose metrics feed relay scoring.
          // (Malformed events make verifyEvent throw → caught below → skipped.)
          if (!verifyEvent(event)) {
            return;
          }
          const freqTag = event.tags.find((t) => t[0] === 'frequency');
          monitors.push({
            pubkey: event.pubkey,
            frequency: freqTag ? parseInt(freqTag[1], 10) : undefined,
          });
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeoutId);
          ws.close();
          resolve(monitors);
        }
      } catch {
        // Ignore
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}
