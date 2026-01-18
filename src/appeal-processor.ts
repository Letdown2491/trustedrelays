import { WebSocket } from 'ws';
import { verifyEvent, type Event } from 'nostr-tools';
import type { DataStore } from './database.js';
import { normalizeRelayUrl } from './prober.js';

// NIP-32 Label event kind
const KIND_LABEL = 1985;

// Label namespace for relay appeals
const LABEL_NAMESPACE_APPEAL = 'relay-appeal';

/**
 * Appeal type - what is being appealed
 */
export type AppealType =
  | 'spam'        // Disputing spam report
  | 'censorship'  // Disputing censorship report
  | 'score'       // Disputing overall score
  | 'policy'      // Clarifying policy classification
  | 'other';      // General appeal

/**
 * Appeal status
 */
export type AppealStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/**
 * Relay appeal (kind 1985 with L=relay-appeal)
 */
export interface RelayAppeal {
  eventId: string;
  relayUrl: string;
  appealerPubkey: string;
  appealType: AppealType;
  content: string;          // Explanation/justification
  evidence?: string[];      // Links to evidence
  timestamp: number;
  // Verification
  isOperator: boolean;      // Is appealer the verified operator?
  operatorConfidence?: number;
  // Processing
  status: AppealStatus;
  processedAt?: number;
  resolution?: string;
}

/**
 * Parse a kind 1985 appeal event into a RelayAppeal
 *
 * Expected structure (NIP-32):
 * - L tag: ["L", "relay-appeal"]
 * - l tag: ["l", "spam|censorship|score|policy|other", "relay-appeal"]
 * - r tag: ["r", "wss://relay.example.com"]
 * - Optional e tags for evidence (links to other events)
 */
export function parseRelayAppeal(event: Event): RelayAppeal | null {
  if (event.kind !== KIND_LABEL) return null;

  // Check for relay-appeal namespace
  const lNamespace = event.tags.find(
    (t) => t[0] === 'L' && t[1] === LABEL_NAMESPACE_APPEAL
  );
  if (!lNamespace) return null;

  // Get the label (appeal type)
  const validTypes: AppealType[] = ['spam', 'censorship', 'score', 'policy', 'other'];
  const labelTag = event.tags.find(
    (t) => t[0] === 'l' && t[2] === LABEL_NAMESPACE_APPEAL && validTypes.includes(t[1] as AppealType)
  );

  const appealType: AppealType = labelTag ? (labelTag[1] as AppealType) : 'other';

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

  // Get evidence links (e tags pointing to other events)
  const evidence = event.tags
    .filter((t) => t[0] === 'e' && t[1])
    .map((t) => t[1]);

  return {
    eventId: event.id,
    relayUrl,
    appealerPubkey: event.pubkey,
    appealType,
    content: event.content,
    evidence: evidence.length > 0 ? evidence : undefined,
    timestamp: event.created_at,
    isOperator: false, // Will be set after verification
    status: 'pending',
  };
}

/**
 * Verify if the appealer is the relay operator
 */
export async function verifyAppealerIsOperator(
  appeal: RelayAppeal,
  db: DataStore
): Promise<{ isOperator: boolean; confidence?: number }> {
  const operatorResolution = await db.getOperatorResolution(appeal.relayUrl);

  if (!operatorResolution || !operatorResolution.operatorPubkey) {
    return { isOperator: false };
  }

  const isOperator = operatorResolution.operatorPubkey.toLowerCase() ===
                     appeal.appealerPubkey.toLowerCase();

  return {
    isOperator,
    confidence: isOperator ? operatorResolution.confidence : undefined,
  };
}

/**
 * Process an appeal - determine if it should affect reports/scores
 *
 * Appeals from verified operators carry more weight.
 * Appeals with evidence are prioritized.
 */
export function processAppeal(
  appeal: RelayAppeal,
  options: {
    autoAcceptOperatorAppeals?: boolean;  // Auto-accept appeals from verified operators
    minOperatorConfidence?: number;        // Min confidence to auto-accept (default: 70)
  } = {}
): { status: AppealStatus; resolution: string } {
  const {
    autoAcceptOperatorAppeals = true,
    minOperatorConfidence = 70,
  } = options;

  // Check if appeal has expired (older than 90 days)
  const ageSeconds = Math.floor(Date.now() / 1000) - appeal.timestamp;
  if (ageSeconds > 90 * 86400) {
    return { status: 'expired', resolution: 'Appeal expired (>90 days old)' };
  }

  // Auto-accept appeals from verified operators with sufficient confidence
  if (autoAcceptOperatorAppeals && appeal.isOperator) {
    if (appeal.operatorConfidence && appeal.operatorConfidence >= minOperatorConfidence) {
      return {
        status: 'accepted',
        resolution: `Auto-accepted: Verified operator (${appeal.operatorConfidence}% confidence)`,
      };
    }
  }

  // Appeals with evidence are marked for review
  if (appeal.evidence && appeal.evidence.length > 0) {
    return {
      status: 'pending',
      resolution: `Pending review: ${appeal.evidence.length} evidence item(s) provided`,
    };
  }

  // Default: pending manual review
  return {
    status: 'pending',
    resolution: 'Pending manual review',
  };
}

/**
 * Query relays for appeals about a specific relay
 */
export async function queryRelayAppeals(
  relayUrl: string,
  options: {
    sourceRelays?: string[];
    timeout?: number;
  } = {}
): Promise<RelayAppeal[]> {
  const sourceRelays = options.sourceRelays ?? [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];
  const timeout = options.timeout ?? 10000;

  const normalizedUrl = normalizeRelayUrl(relayUrl);
  const appeals: RelayAppeal[] = [];
  const seenEventIds = new Set<string>();

  const promises = sourceRelays.map((relay) =>
    queryRelayForAppeals(relay, normalizedUrl, timeout)
  );

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const appeal of result.value) {
        if (!seenEventIds.has(appeal.eventId)) {
          seenEventIds.add(appeal.eventId);
          appeals.push(appeal);
        }
      }
    }
  }

  return appeals;
}

/**
 * Query a single relay for appeals
 */
async function queryRelayForAppeals(
  sourceRelay: string,
  targetRelayUrl: string,
  timeout: number
): Promise<RelayAppeal[]> {
  return new Promise((resolve) => {
    const appeals: RelayAppeal[] = [];
    const ws = new WebSocket(sourceRelay);
    const subId = `appeal-${crypto.randomUUID()}`;

    const timeoutId = setTimeout(() => {
      ws.close();
      resolve(appeals);
    }, timeout);

    ws.on('open', () => {
      const filter = {
        kinds: [KIND_LABEL],
        '#L': [LABEL_NAMESPACE_APPEAL],
        '#r': [targetRelayUrl],
        since: Math.floor(Date.now() / 1000) - (90 * 86400), // Last 90 days
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg[0] === 'EVENT' && msg[2]) {
          const event = msg[2] as Event;

          if (!verifyEvent(event)) return;

          const appeal = parseRelayAppeal(event);
          if (appeal) {
            appeals.push(appeal);
          }
        } else if (msg[0] === 'EOSE') {
          clearTimeout(timeoutId);
          ws.close();
          resolve(appeals);
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('error', () => {
      clearTimeout(timeoutId);
      resolve(appeals);
    });

    ws.on('close', () => {
      clearTimeout(timeoutId);
      resolve(appeals);
    });
  });
}

/**
 * Format an appeal for display
 */
export function formatAppeal(appeal: RelayAppeal): string {
  const lines: string[] = [
    `Appeal: ${appeal.appealType}`,
    `Relay: ${appeal.relayUrl}`,
    `Appealer: ${appeal.appealerPubkey.slice(0, 16)}...`,
    `Is Operator: ${appeal.isOperator ? `Yes (${appeal.operatorConfidence}% confidence)` : 'No'}`,
    `Status: ${appeal.status}`,
    `Date: ${new Date(appeal.timestamp * 1000).toISOString()}`,
  ];

  if (appeal.content) {
    const truncated = appeal.content.length > 200
      ? appeal.content.slice(0, 200) + '...'
      : appeal.content;
    lines.push(`Content: ${truncated}`);
  }

  if (appeal.evidence && appeal.evidence.length > 0) {
    lines.push(`Evidence: ${appeal.evidence.length} item(s)`);
  }

  if (appeal.resolution) {
    lines.push(`Resolution: ${appeal.resolution}`);
  }

  return lines.join('\n');
}
