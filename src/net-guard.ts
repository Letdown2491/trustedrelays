import { promises as dns } from 'dns';

/**
 * SSRF guard shared across the HTTP API, the prober, and operator resolution.
 *
 * `isBlockedHost` rejects hostnames/IP-literals that point at loopback,
 * private, link-local, CGNAT, multicast, or cloud-metadata ranges. It is a
 * NAME/literal check only — callers that resolve and then connect should also
 * re-check the resolved address (DNS-rebinding) where feasible.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Internal / loopback names
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;

  // IPv4 literal checks
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(n => n > 255)) return true; // malformed -> block
    const [a, b] = o;
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8 private
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                       // multicast / reserved
    return false;
  }

  // IPv6 literal checks
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;     // loopback / unspecified
    if (host.startsWith('fe80')) return true;             // link-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // ULA fc00::/7
    if (host.startsWith('::ffff:')) {                     // IPv4-mapped
      const mapped = host.slice(7);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mapped)) return isBlockedHost(mapped);
    }
    return false;
  }

  return false;
}

/**
 * True if a ws://, wss://, http://, or https:// URL targets a blocked host (or
 * is unparseable). Use this to gate any outbound connection driven by
 * untrusted (relay/event-supplied) URLs before fetch()/new WebSocket().
 */
export function isBlockedUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname) return true;
    return isBlockedHost(parsed.hostname);
  } catch {
    return true; // unparseable -> treat as blocked
  }
}

/**
 * DNS-rebinding mitigation: resolve a hostname and verify EVERY resolved
 * address is a public IP (defeats a public name that points at a private /
 * metadata address). Returns false if it can't be resolved or any address is
 * blocked. A TOCTOU window remains (the host could re-resolve at connect time),
 * but this catches the common rebinding case. Skip for non-DNS hosts (.onion).
 */
export async function resolvesToSafeHost(hostname: string): Promise<boolean> {
  // IP literals are already covered by isBlockedHost; resolution is a no-op.
  try {
    const results = await dns.lookup(hostname, { all: true });
    if (results.length === 0) return false;
    for (const r of results) {
      if (isBlockedHost(r.address)) return false;
    }
    return true;
  } catch {
    return false; // unresolvable -> treat as unsafe
  }
}
