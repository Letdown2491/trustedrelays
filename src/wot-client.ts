import { WebSocket } from 'ws';
import { verifyEvent, type Event } from 'nostr-tools';
import type { TrustAssertion, AggregatedTrustScore, TrustAssertionProvider } from './types.js';

// NIP-85 kind for trust assertions
const KIND_TRUST_ASSERTION = 30382;

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

// Default relays known to have NIP-85 assertions
const DEFAULT_NIP85_RELAYS = [
  'wss://nip85.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

/**
 * Parse a NIP-85 kind 30382 event into a TrustAssertion
 */
export function parseTrustAssertion(event: Event): TrustAssertion | null {
  if (event.kind !== KIND_TRUST_ASSERTION) return null;

  // Get subject pubkey from 'd' tag
  const dTag = event.tags.find((t) => t[0] === 'd');
  if (!dTag || !dTag[1]) return null;

  // Get rank from 'rank' tag
  const rankTag = event.tags.find((t) => t[0] === 'rank');
  if (!rankTag || !rankTag[1]) return null;

  const rank = parseInt(rankTag[1], 10);
  if (isNaN(rank) || rank < 0 || rank > 100) return null;

  const assertion: TrustAssertion = {
    eventId: event.id,
    providerPubkey: event.pubkey,
    subjectPubkey: dTag[1].toLowerCase(),
    rank,
    timestamp: event.created_at,
  };

  // Parse optional tags
  const zapSentTag = event.tags.find((t) => t[0] === 'zap_amt_sent');
  if (zapSentTag) {
    assertion.zapAmountSent = parseInt(zapSentTag[1], 10) || undefined;
  }

  const zapRecvTag = event.tags.find((t) => t[0] === 'zap_amt_received');
  if (zapRecvTag) {
    assertion.zapAmountReceived = parseInt(zapRecvTag[1], 10) || undefined;
  }

  return assertion;
}

/**
 * Query relays for NIP-85 trust assertions about a pubkey
 */
export async function queryTrustAssertions(
  subjectPubkey: string,
  options: {
    relays?: string[];
    trustedProviders?: TrustAssertionProvider[];
    timeout?: number;
  } = {}
): Promise<TrustAssertion[]> {
  const relays = options.relays ?? DEFAULT_NIP85_RELAYS;
  const timeout = options.timeout ?? 10000;
  const trustedProviderSet = options.trustedProviders
    ? new Set(options.trustedProviders.map((p) => p.pubkey))
    : null;

  const assertions: TrustAssertion[] = [];
  const seenEventIds = new Set<string>();

  // Query all relays in parallel
  const promises = relays.map((relayUrl) =>
    queryRelayForAssertions(relayUrl, subjectPubkey, timeout)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const assertion of result.value) {
        // Dedupe by event ID
        if (seenEventIds.has(assertion.eventId)) continue;
        seenEventIds.add(assertion.eventId);

        // Filter by trusted providers if specified
        if (trustedProviderSet && !trustedProviderSet.has(assertion.providerPubkey)) {
          continue;
        }

        assertions.push(assertion);
      }
    }
  }

  return assertions;
}

/**
 * Query a single relay for trust assertions
 */
async function queryRelayForAssertions(
  relayUrl: string,
  subjectPubkey: string,
  timeout: number
): Promise<TrustAssertion[]> {
  return new Promise((resolve) => {
    const assertions: TrustAssertion[] = [];
    const ws = new WebSocket(relayUrl);
    const subId = `nip85-${crypto.randomUUID()}`;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve(assertions);
    }, timeout);

    ws.on('open', () => {
      // Query for kind 30382 with d tag matching the subject pubkey
      const filter = {
        kinds: [KIND_TRUST_ASSERTION],
        '#d': [subjectPubkey.toLowerCase()],
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

          // Verify signature
          if (!verifyEvent(event)) return;

          const assertion = parseTrustAssertion(event);
          if (assertion) {
            assertions.push(assertion);
          }
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeoutId);
          ws.close();
          resolve(assertions);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', () => {
      clearTimeout(timeoutId);
      resolve(assertions);
    });

    ws.on('close', () => {
      clearTimeout(timeoutId);
      resolve(assertions);
    });
  });
}

/**
 * Aggregate trust assertions from multiple providers into a single score
 *
 * Weighting strategy:
 * - If trustedProviders is specified, use their weights
 * - Otherwise, equal weight for all providers
 * - More recent assertions weighted slightly higher
 */
export function aggregateTrustScore(
  assertions: TrustAssertion[],
  trustedProviders?: TrustAssertionProvider[]
): AggregatedTrustScore | null {
  if (assertions.length === 0) return null;

  const subjectPubkey = assertions[0].subjectPubkey;
  const providerWeights = new Map<string, number>();

  if (trustedProviders) {
    for (const provider of trustedProviders) {
      providerWeights.set(provider.pubkey, provider.weight);
    }
  }

  // Group by provider, keep most recent assertion per provider
  const byProvider = new Map<string, TrustAssertion>();
  for (const assertion of assertions) {
    const existing = byProvider.get(assertion.providerPubkey);
    if (!existing || assertion.timestamp > existing.timestamp) {
      byProvider.set(assertion.providerPubkey, assertion);
    }
  }

  // Calculate weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  const providers: string[] = [];

  for (const [providerPubkey, assertion] of byProvider) {
    const weight = providerWeights.get(providerPubkey) ?? 1;
    weightedSum += assertion.rank * weight;
    totalWeight += weight;
    providers.push(providerPubkey);
  }

  if (totalWeight === 0) return null;

  const score = Math.round(weightedSum / totalWeight);

  // Determine confidence based on provider count
  let confidence: 'low' | 'medium' | 'high';
  if (providers.length >= 3) {
    confidence = 'high';
  } else if (providers.length >= 2) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    pubkey: subjectPubkey,
    score,
    assertionCount: assertions.length,
    providers,
    confidence,
    computedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get trust score for a pubkey by querying NIP-85 assertions
 */
export async function getTrustScore(
  pubkey: string,
  options: {
    relays?: string[];
    trustedProviders?: TrustAssertionProvider[];
    timeout?: number;
  } = {}
): Promise<AggregatedTrustScore | null> {
  const assertions = await queryTrustAssertions(pubkey, options);
  return aggregateTrustScore(assertions, options.trustedProviders);
}

/**
 * Format trust score for display
 */
export function formatTrustScore(score: AggregatedTrustScore): string {
  const lines: string[] = [
    `Pubkey: ${score.pubkey.slice(0, 16)}...`,
    `Trust Score: ${score.score}/100`,
    `Confidence: ${score.confidence}`,
    `Assertions: ${score.assertionCount} from ${score.providers.length} provider(s)`,
  ];
  return lines.join('\n');
}
