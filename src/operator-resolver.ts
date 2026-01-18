import { promises as dns } from 'dns';
import type { OperatorResolution, VerificationMethod, NIP11Info, TrustAssertionProvider } from './types.js';
import { VERIFICATION_CONFIDENCE, CORROBORATED_CONFIDENCE } from './types.js';
import { normalizeRelayUrl } from './prober.js';
import { getTrustScore } from './wot-client.js';

/**
 * Sanitize error for safe logging - extract only the error code/type
 * Prevents leaking sensitive information like file paths, credentials, etc.
 */
function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    // Only include error name/code, not full message which could contain sensitive data
    const name = err.name || 'Error';
    const code = (err as any).code;
    if (code) {
      return `${name}: ${code}`;
    }
    // For common network errors, include a generic message
    if (name === 'AbortError') return 'Request timeout';
    if (name === 'TypeError' && err.message.includes('fetch')) return 'Network error';
    return name;
  }
  return 'Unknown error';
}

/**
 * Extract domain from relay URL
 * wss://relay.example.com -> relay.example.com
 * wss://relay.example.com:8080 -> relay.example.com
 */
function extractDomain(relayUrl: string): string {
  const url = new URL(normalizeRelayUrl(relayUrl));
  return url.hostname;
}

/**
 * Check DNS TXT record for operator pubkey
 * Looks for: _nostr.<domain> TXT "pubkey=<hex>"
 */
async function checkDnsTxt(domain: string): Promise<string | null> {
  const dnsName = `_nostr.${domain}`;

  try {
    const records = await dns.resolveTxt(dnsName);

    for (const record of records) {
      // TXT records can be chunked, join them
      const txt = record.join('');

      // Look for pubkey=<hex>
      const match = txt.match(/pubkey=([0-9a-fA-F]{64})/);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    return null;
  } catch (err: any) {
    // ENOTFOUND, ENODATA are expected for domains without the record
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'ESERVFAIL') {
      return null;
    }
    // Log unexpected errors but don't throw (sanitized for security)
    console.warn(`DNS lookup failed for ${dnsName}: ${sanitizeError(err)}`);
    return null;
  }
}

/**
 * Check .well-known/nostr.json for operator pubkey
 * Looks for: { "relay": { "pubkey": "<hex>" } }
 */
async function checkWellKnown(domain: string): Promise<string | null> {
  const url = `https://${domain}/.well-known/nostr.json`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const json = await response.json();

    // Check for relay.pubkey
    if (json?.relay?.pubkey && typeof json.relay.pubkey === 'string') {
      const pubkey = json.relay.pubkey.toLowerCase();
      // Validate it's a 64-char hex string
      if (/^[0-9a-f]{64}$/.test(pubkey)) {
        return pubkey;
      }
    }

    return null;
  } catch (err: any) {
    // Network errors, timeouts, parse errors are expected
    return null;
  }
}

/**
 * Validate a pubkey is a valid 64-char hex string
 */
function isValidPubkey(pubkey: string | undefined): pubkey is string {
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey);
}

/**
 * Options for operator resolution
 */
export interface ResolveOperatorOptions {
  // Fetch WoT trust score via NIP-85 assertions
  fetchTrustScore?: boolean;
  // Relays to query for NIP-85 assertions
  nip85Relays?: string[];
  // Trusted assertion providers (for weighted aggregation)
  trustedProviders?: TrustAssertionProvider[];
  // Timeout for NIP-85 queries
  nip85Timeout?: number;
}

/**
 * Calculate corroborated confidence based on which sources agree
 */
function calculateCorroboratedConfidence(
  agreeSources: VerificationMethod[]
): { confidence: number; method: VerificationMethod } {
  const hasNip11 = agreeSources.includes('nip11');
  const hasDns = agreeSources.includes('dns');
  const hasWellknown = agreeSources.includes('wellknown');

  // All three agree - highest confidence
  if (hasNip11 && hasDns && hasWellknown) {
    return { confidence: CORROBORATED_CONFIDENCE['nip11_dns_wellknown'], method: 'dns' };
  }

  // Two sources agree
  if (hasDns && hasWellknown) {
    return { confidence: CORROBORATED_CONFIDENCE['dns_wellknown'], method: 'dns' };
  }
  if (hasNip11 && hasDns) {
    return { confidence: CORROBORATED_CONFIDENCE['nip11_dns'], method: 'dns' };
  }
  if (hasNip11 && hasWellknown) {
    return { confidence: CORROBORATED_CONFIDENCE['nip11_wellknown'], method: 'wellknown' };
  }

  // Single source - use standard confidence
  if (hasDns) {
    return { confidence: VERIFICATION_CONFIDENCE['dns'], method: 'dns' };
  }
  if (hasWellknown) {
    return { confidence: VERIFICATION_CONFIDENCE['wellknown'], method: 'wellknown' };
  }
  if (hasNip11) {
    return { confidence: VERIFICATION_CONFIDENCE['nip11'], method: 'nip11' };
  }

  return { confidence: 0, method: 'claimed' };
}

/**
 * Resolve operator pubkey for a relay using multiple verification methods
 *
 * Fetches ALL sources and uses corroborated evidence for higher confidence:
 * - Single source: Uses standard confidence (DNS 80%, well-known 75%, NIP-11 70%)
 * - NIP-11 + well-known agree: 85% confidence
 * - NIP-11 + DNS agree: 90% confidence
 * - DNS + well-known agree: 90% confidence
 * - All three agree: 95% confidence
 *
 * If sources disagree, uses the highest-confidence source but flags the disagreement.
 *
 * Optionally fetches WoT trust score via NIP-85 assertions.
 */
export async function resolveOperator(
  relayUrl: string,
  nip11?: NIP11Info,
  options: ResolveOperatorOptions = {}
): Promise<OperatorResolution> {
  const url = normalizeRelayUrl(relayUrl);
  const domain = extractDomain(url);
  const now = Math.floor(Date.now() / 1000);

  const resolution: OperatorResolution = {
    relayUrl: url,
    operatorPubkey: null,
    verificationMethod: null,
    verifiedAt: now,
    confidence: 0,
  };

  // Extract NIP-11 pubkey
  const nip11Pubkey = isValidPubkey(nip11?.pubkey) ? nip11.pubkey.toLowerCase() : undefined;
  if (nip11Pubkey) {
    resolution.nip11Pubkey = nip11Pubkey;
  }

  // Fetch DNS and well-known in parallel for efficiency
  const [dnsPubkey, wellknownPubkey] = await Promise.all([
    checkDnsTxt(domain),
    checkWellKnown(domain),
  ]);

  if (dnsPubkey) {
    resolution.dnsPubkey = dnsPubkey;
  }
  if (wellknownPubkey) {
    resolution.wellknownPubkey = wellknownPubkey;
  }

  // Collect all discovered pubkeys with their sources
  const pubkeySources: Map<string, VerificationMethod[]> = new Map();

  if (dnsPubkey) {
    const sources = pubkeySources.get(dnsPubkey) || [];
    sources.push('dns');
    pubkeySources.set(dnsPubkey, sources);
  }
  if (wellknownPubkey) {
    const sources = pubkeySources.get(wellknownPubkey) || [];
    sources.push('wellknown');
    pubkeySources.set(wellknownPubkey, sources);
  }
  if (nip11Pubkey) {
    const sources = pubkeySources.get(nip11Pubkey) || [];
    sources.push('nip11');
    pubkeySources.set(nip11Pubkey, sources);
  }

  // Check for disagreement (multiple different pubkeys found)
  const uniquePubkeys = Array.from(pubkeySources.keys());
  if (uniquePubkeys.length > 1) {
    resolution.sourcesDisagree = true;
    // Log warning about conflicting pubkeys
    console.warn(`Operator verification conflict for ${url}: ${uniquePubkeys.length} different pubkeys found`);
  }

  // Find the pubkey with the most corroboration (most sources agreeing)
  // In case of tie, prefer higher-confidence sources (DNS > well-known > NIP-11)
  let bestPubkey: string | null = null;
  let bestSources: VerificationMethod[] = [];
  let bestConfidence = 0;

  for (const [pubkey, sources] of pubkeySources) {
    const { confidence } = calculateCorroboratedConfidence(sources);
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestPubkey = pubkey;
      bestSources = sources;
    }
  }

  if (bestPubkey) {
    const { confidence, method } = calculateCorroboratedConfidence(bestSources);
    resolution.operatorPubkey = bestPubkey;
    resolution.verificationMethod = method;
    resolution.confidence = confidence;
    resolution.corroboratedSources = bestSources;
  }

  // Fetch WoT trust score if enabled and we found an operator
  if (options.fetchTrustScore && resolution.operatorPubkey) {
    try {
      const trustScore = await getTrustScore(resolution.operatorPubkey, {
        relays: options.nip85Relays,
        trustedProviders: options.trustedProviders,
        timeout: options.nip85Timeout ?? 10000,
      });

      if (trustScore) {
        resolution.trustScore = trustScore.score;
        resolution.trustConfidence = trustScore.confidence;
        resolution.trustProviderCount = trustScore.providers.length;
      }
    } catch (err) {
      // WoT lookup failed, continue without it (sanitized for security)
      console.warn(`WoT trust score lookup failed: ${sanitizeError(err)}`);
    }
  }

  return resolution;
}

/**
 * Resolve operators for multiple relays in parallel
 */
export async function resolveOperators(
  relays: Array<{ url: string; nip11?: NIP11Info }>
): Promise<Map<string, OperatorResolution>> {
  const results = new Map<string, OperatorResolution>();

  const resolutions = await Promise.all(
    relays.map(({ url, nip11 }) => resolveOperator(url, nip11))
  );

  for (const resolution of resolutions) {
    results.set(resolution.relayUrl, resolution);
  }

  return results;
}

/**
 * Format operator resolution for display
 */
export function formatOperatorResolution(resolution: OperatorResolution): string {
  const lines: string[] = [
    `Relay: ${resolution.relayUrl}`,
  ];

  if (resolution.operatorPubkey) {
    lines.push(`Operator: ${resolution.operatorPubkey}`);

    // Show corroboration details
    if (resolution.corroboratedSources && resolution.corroboratedSources.length > 1) {
      lines.push(`Verified via: ${resolution.corroboratedSources.join(' + ')} (${resolution.confidence}% confidence, corroborated)`);
    } else {
      lines.push(`Verified via: ${resolution.verificationMethod} (${resolution.confidence}% confidence)`);
    }

    // Warn about source disagreement
    if (resolution.sourcesDisagree) {
      lines.push(`Warning: Multiple sources provided different pubkeys`);
    }
  } else {
    lines.push(`Operator: Not found`);
  }

  // Show all discovered pubkeys
  const sources: string[] = [];
  if (resolution.nip11Pubkey) sources.push(`NIP-11: ${resolution.nip11Pubkey.slice(0, 16)}...`);
  if (resolution.dnsPubkey) sources.push(`DNS: ${resolution.dnsPubkey.slice(0, 16)}...`);
  if (resolution.wellknownPubkey) sources.push(`Well-known: ${resolution.wellknownPubkey.slice(0, 16)}...`);

  if (sources.length > 1) {
    lines.push(`Sources: ${sources.join(', ')}`);
  }

  // Show WoT trust score if available
  if (resolution.trustScore !== undefined) {
    lines.push(`WoT Trust: ${resolution.trustScore}/100 (${resolution.trustConfidence}, ${resolution.trustProviderCount} provider(s))`);
  }

  return lines.join('\n');
}
