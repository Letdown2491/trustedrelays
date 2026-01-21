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

  // Parse RTT tags with bounds validation
  for (const tag of event.tags) {
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
    }
  }

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

    for (const relayUrl of this.config.sourceRelays) {
      this.connectToRelay(relayUrl);
    }
  }

  /**
   * Stop all subscriptions
   */
  stop(): void {
    this.running = false;

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

    const ws = new WebSocket(url);

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
      await this.config.db.updateMonitorStats(event.pubkey);
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
    const ws = new WebSocket(normalizeRelayUrl(relayUrl));
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
