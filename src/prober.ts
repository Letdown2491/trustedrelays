import { WebSocket } from 'ws';
import type { NIP11Info, ProbeResult, RelayType, AccessLevel } from './types.js';

/**
 * Known NIP-46 relay URL patterns
 */
const NIP46_RELAY_PATTERNS = [
  /relay\.nsec\.app/i,
  /relay\.nip46\./i,
  /nsecbunker/i,
];

/**
 * Timeouts for different relay types (ms)
 */
const TIMEOUTS = {
  DEFAULT: 10000,      // 10s for clearnet relays
  ONION: 30000,        // 30s for Tor hidden services
  NIP11_DEFAULT: 5000,
  NIP11_ONION: 15000,
};

/**
 * Check if URL is a Tor hidden service (.onion)
 */
export function isOnionRelay(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.endsWith('.onion');
  } catch {
    return false;
  }
}

/**
 * Detect relay type from NIP-11 info and URL
 */
function detectRelayType(url: string, nip11?: NIP11Info): RelayType {
  // Check URL patterns first
  for (const pattern of NIP46_RELAY_PATTERNS) {
    if (pattern.test(url)) {
      return 'nip46';
    }
  }

  if (!nip11) {
    return 'unknown';
  }

  const supportedNips = Array.isArray(nip11.supported_nips) ? nip11.supported_nips : [];

  // Check if it's a NIP-46 specialized relay
  // These typically support only NIPs 1 and 46 (and maybe 9 for deletion)
  if (supportedNips.includes(46)) {
    // If it only has a small set of NIPs and includes 46, it's likely specialized
    const basicNips = supportedNips.filter(n => [1, 9, 46].includes(n));
    if (basicNips.length === supportedNips.length) {
      return 'nip46';
    }
  }

  // Check for other specialized indicators
  // Relays with very few supported NIPs might be specialized
  if (supportedNips.length > 0 && supportedNips.length <= 3) {
    return 'specialized';
  }

  return 'general';
}

/**
 * Parse CLOSED message reason to determine access level
 */
function parseClosedReason(reason: string): AccessLevel {
  const r = reason.toLowerCase();
  if (r.includes('auth-required') || r.includes('authentication') || r.includes('unauthorized')) {
    return 'auth_required';
  }
  if (r.includes('payment') || r.includes('paid') || r.includes('subscribe')) {
    return 'payment_required';
  }
  if (r.includes('blocked') || r.includes('restricted') || r.includes('filter') || r.includes('empty')) {
    return 'restricted';
  }
  // Default for any CLOSED - relay has some restriction
  return 'restricted';
}

/**
 * Normalize relay URL to canonical form (lowercase, no trailing slash)
 */
export function normalizeRelayUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * Convert WebSocket URL to HTTPS for NIP-11 fetch
 */
function wsToHttps(wsUrl: string): string {
  return wsUrl.replace(/^wss?:\/\//, 'https://');
}

/**
 * Fetch NIP-11 relay information document
 */
async function fetchNIP11(relayUrl: string, timeout = 5000): Promise<{ info: NIP11Info; fetchTime: number }> {
  const httpUrl = wsToHttps(relayUrl);
  const start = performance.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(httpUrl, {
      headers: { 'Accept': 'application/nostr+json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const info = await response.json() as NIP11Info;
    const fetchTime = performance.now() - start;

    return { info, fetchTime };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Result from WebSocket test for general relays
 */
interface WebSocketTestResult {
  connectTime: number;
  readTime?: number;
  accessLevel: AccessLevel;
  closedReason?: string;
  ws: WebSocket;
}

/**
 * Test WebSocket connection for general relays (with REQ test)
 * Handles CLOSED responses as "reachable but restricted" rather than failure
 */
async function testWebSocketGeneral(
  relayUrl: string,
  timeout = 10000
): Promise<WebSocketTestResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let connectTime: number | undefined;
    let readTime: number | undefined;
    let readStart: number | undefined;

    const ws = new WebSocket(relayUrl);
    const timeoutId = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, timeout);

    ws.on('open', () => {
      connectTime = performance.now() - start;

      // Send a REQ for a random event to test read
      const subId = crypto.randomUUID();
      readStart = performance.now();
      ws.send(JSON.stringify(['REQ', subId, { limit: 1 }]));
    });

    ws.on('message', (data) => {
      if (readStart && !readTime) {
        readTime = performance.now() - readStart;
      }

      let msg: unknown[];
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Invalid JSON, wait for valid message
      }

      if (!Array.isArray(msg) || connectTime === undefined) {
        return;
      }

      // EOSE = relay accepts generic queries (open access)
      if (msg[0] === 'EOSE') {
        clearTimeout(timeoutId);
        resolve({ connectTime, readTime, accessLevel: 'open', ws });
        return;
      }

      // CLOSED = relay responded but rejected the query (restricted access)
      // This is still "reachable" - the relay is online and functioning
      if (msg[0] === 'CLOSED') {
        clearTimeout(timeoutId);
        const reason = typeof msg[2] === 'string' ? msg[2] : '';
        const accessLevel = parseClosedReason(reason);
        resolve({ connectTime, readTime, accessLevel, closedReason: reason, ws });
        return;
      }

      // AUTH = relay needs authentication, continue waiting for CLOSED
      // (relay will typically send CLOSED after AUTH if we don't authenticate)
    });

    ws.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Test WebSocket connection for specialized relays (connect only, no REQ)
 * NIP-46 relays reject generic REQ filters, so we just test connectivity
 */
async function testWebSocketSpecialized(
  relayUrl: string,
  timeout = 10000
): Promise<{ connectTime: number; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();

    const ws = new WebSocket(relayUrl);
    const timeoutId = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, timeout);

    ws.on('open', () => {
      const connectTime = performance.now() - start;
      clearTimeout(timeoutId);
      resolve({ connectTime, ws });
    });

    ws.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Probe a relay and collect metrics
 */
export async function probeRelay(relayUrl: string): Promise<ProbeResult> {
  const url = normalizeRelayUrl(relayUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const isTor = isOnionRelay(url);

  // Use longer timeouts for Tor hidden services
  const wsTimeout = isTor ? TIMEOUTS.ONION : TIMEOUTS.DEFAULT;
  const nip11Timeout = isTor ? TIMEOUTS.NIP11_ONION : TIMEOUTS.NIP11_DEFAULT;

  const result: ProbeResult = {
    url,
    timestamp,
    reachable: false,
    relayType: 'unknown',
  };

  // Fetch NIP-11 first (needed to detect relay type)
  try {
    const { info, fetchTime } = await fetchNIP11(url, nip11Timeout);
    result.nip11 = info;
    result.nip11FetchTime = fetchTime;
  } catch {
    // NIP-11 fetch failure is not fatal - relay may still be reachable
  }

  // Detect relay type based on NIP-11 and URL
  result.relayType = detectRelayType(url, result.nip11);

  // Test WebSocket connection using appropriate strategy
  try {
    if (result.relayType === 'nip46' || result.relayType === 'specialized') {
      // For specialized relays, just test connectivity (no REQ)
      const { connectTime, ws } = await testWebSocketSpecialized(url, wsTimeout);
      result.reachable = true;
      result.connectTime = connectTime;
      // Specialized relays are inherently restricted (by design)
      result.accessLevel = 'restricted';
      // No readTime for specialized relays - they don't respond to generic REQ
      ws.close();
    } else {
      // For general relays, test with a REQ
      const { connectTime, readTime, accessLevel, closedReason, ws } = await testWebSocketGeneral(url, wsTimeout);
      result.reachable = true;
      result.connectTime = connectTime;
      result.readTime = readTime;
      result.accessLevel = accessLevel;
      result.closedReason = closedReason;
      ws.close();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.accessLevel = 'unknown';
  }

  return result;
}

/**
 * Probe multiple relays
 */
export async function probeRelays(relayUrls: string[]): Promise<ProbeResult[]> {
  return Promise.all(relayUrls.map(probeRelay));
}
