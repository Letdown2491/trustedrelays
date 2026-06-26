import { WebSocket } from 'ws';
import { isBlockedHost, resolvesToSafeHost } from './net-guard.js';
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
const NIP11_MAX_BYTES = 256 * 1024; // 256 KB cap on NIP-11 documents

async function fetchNIP11(relayUrl: string, timeout = 5000): Promise<{ info: NIP11Info; fetchTime: number }> {
  const httpUrl = wsToHttps(relayUrl);
  const start = performance.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(httpUrl, {
      headers: { 'Accept': 'application/nostr+json' },
      signal: controller.signal,
      // Do not follow redirects: a relay could redirect to an internal host
      // (SSRF) or to an unrelated large resource.
      redirect: 'manual',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Reject non-JSON content types early to avoid parsing arbitrary bodies.
    const contentType = response.headers.get('content-type') || '';
    if (!/json/i.test(contentType)) {
      throw new Error(`Unexpected content-type: ${contentType || 'none'}`);
    }

    // Enforce a hard size cap, honoring Content-Length when present and
    // streaming-counting otherwise, so a malicious relay cannot exhaust memory.
    const declaredLen = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > NIP11_MAX_BYTES) {
      throw new Error('NIP-11 document too large');
    }

    const text = await readCapped(response, NIP11_MAX_BYTES);
    const info = JSON.parse(text) as NIP11Info;
    const fetchTime = performance.now() - start;

    return { info, fetchTime };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read a response body as text, aborting once a byte cap is exceeded.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > maxBytes) {
          throw new Error('NIP-11 document too large');
        }
        chunks.push(value);
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
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
    let settled = false;

    const ws = new WebSocket(relayUrl, { maxPayload: 512 * 1024 });
    const timeoutId = setTimeout(() => fail(new Error('Connection timeout')), timeout);

    // Single teardown path used by every resolve/reject branch so we never leak
    // the socket, its timer, or its listeners.
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      ws.removeAllListeners();
      // terminate() on a still-CONNECTING socket makes ws emit an async 'error'
      // ("closed before the connection is established"); the try/catch only
      // catches sync throws, so keep a no-op error handler or that late event
      // crashes the process (ws throws on unhandled 'error').
      ws.on('error', () => {});
      try { ws.terminate(); } catch { /* already closed */ }
      reject(err);
    };
    const succeed = (res: WebSocketTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      ws.removeAllListeners();
      // The caller closes the returned socket; keep a no-op error handler so a
      // late error event in the meantime does not throw (ws throws on
      // unhandled 'error').
      ws.on('error', () => {});
      resolve(res);
    };

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
        succeed({ connectTime, readTime, accessLevel: 'open', ws });
        return;
      }

      // CLOSED = relay responded but rejected the query (restricted access)
      // This is still "reachable" - the relay is online and functioning
      if (msg[0] === 'CLOSED') {
        const reason = typeof msg[2] === 'string' ? msg[2] : '';
        const accessLevel = parseClosedReason(reason);
        succeed({ connectTime, readTime, accessLevel, closedReason: reason, ws });
        return;
      }

      // AUTH = relay needs authentication, continue waiting for CLOSED
      // (relay will typically send CLOSED after AUTH if we don't authenticate)
    });

    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));

    // A clean close before EOSE/CLOSED means we never got a usable response;
    // fail fast instead of waiting for the full timeout.
    ws.on('close', () => fail(new Error('Connection closed before response')));
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
    let settled = false;

    const ws = new WebSocket(relayUrl, { maxPayload: 512 * 1024 });
    const timeoutId = setTimeout(() => fail(new Error('Connection timeout')), timeout);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      ws.removeAllListeners();
      // See testWebSocket.fail: keep a no-op error handler so the async 'error'
      // emitted by terminate() on a CONNECTING socket doesn't crash the process.
      ws.on('error', () => {});
      try { ws.terminate(); } catch { /* already closed */ }
      reject(err);
    };

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      const connectTime = performance.now() - start;
      clearTimeout(timeoutId);
      ws.removeAllListeners();
      ws.on('error', () => {}); // caller closes the socket; swallow late errors
      resolve({ connectTime, ws });
    });

    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => fail(new Error('Connection closed before open')));
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

  // SSRF guard: relay URLs originate from untrusted Nostr events. Refuse to
  // probe loopback/private/link-local/metadata hosts before any outbound
  // HTTP (NIP-11) or WebSocket connection. This is the single chokepoint for
  // the probe pipeline.
  let probeHost = '';
  try { probeHost = new URL(url).hostname; } catch { /* malformed handled below */ }
  if (!probeHost || isBlockedHost(probeHost)) {
    result.error = 'blocked or invalid host';
    result.accessLevel = 'unknown';
    return result;
  }
  // DNS-rebinding mitigation: a public name could resolve to a private/metadata
  // IP. Verify resolved addresses are public before any fetch/WebSocket. Skip
  // for Tor (.onion is not DNS-resolvable and can't reach an internal host).
  if (!isTor && !(await resolvesToSafeHost(probeHost))) {
    result.error = 'host resolves to a blocked or unresolvable address';
    result.accessLevel = 'unknown';
    return result;
  }

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
