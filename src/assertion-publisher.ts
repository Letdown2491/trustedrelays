import { WebSocket } from 'ws';
import { finalizeEvent, getPublicKey, type Event, nip19 } from 'nostr-tools';
import type { RelayAssertion, UnsignedEvent } from './types.js';
import type { DataStore } from './database.js';
import { assertionToEvent } from './assertion.js';
import type { RelayPool, PoolPublishResult } from './relay-pool.js';

/**
 * Validate and normalize private key - accepts hex or nsec format, returns validated hex
 * @throws Error if key is invalid
 */
function normalizePrivateKey(key: string): string {
  let hexKey: string;

  if (key.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(key);
      if (decoded.type !== 'nsec') {
        throw new Error('Invalid nsec key - wrong type');
      }
      hexKey = Buffer.from(decoded.data).toString('hex');
    } catch (err) {
      if (err instanceof Error && err.message.includes('Invalid nsec')) {
        throw err;
      }
      throw new Error('Invalid nsec key - malformed bech32 encoding');
    }
  } else {
    hexKey = key.toLowerCase();
  }

  // Validate hex format and length (32 bytes = 64 hex chars)
  if (!/^[0-9a-f]{64}$/.test(hexKey)) {
    throw new Error('Invalid private key - must be 64 hex characters or valid nsec');
  }

  return hexKey;
}

/**
 * Configuration for the assertion publisher
 */
export interface PublisherConfig {
  // Provider's private key (hex or nsec format)
  privateKey: string;
  // Relays to publish assertions to (used when pool is not provided)
  publishRelays: string[];
  // Minimum score change to trigger republish (default: 5)
  materialChangeThreshold: number;
  // Database for tracking published assertions
  db: DataStore;
  // Optional: Use a shared connection pool instead of creating new connections
  pool?: RelayPool;
  // Callback when assertion is published
  onPublish?: (relayUrl: string, eventId: string) => void;
  // Callback on publish error
  onError?: (relayUrl: string, error: string) => void;
}

/**
 * Result of a publish attempt
 */
export interface PublishResult {
  relayUrl: string;
  eventId: string;
  success: boolean;
  publishedTo: string[];
  errors: Array<{ relay: string; error: string }>;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Check if an assertion has materially changed from the last published version
 *
 * Material changes:
 * - First time publishing (no previous)
 * - Confidence level changed
 * - Overall score changed by >= threshold
 * - Status changed
 * - Any component score changed by >= threshold
 */
export function hasMaterialChange(
  current: RelayAssertion,
  previous: {
    score?: number;
    reliability?: number;
    quality?: number;
    accessibility?: number;
    confidence: string;
  } | null,
  threshold: number = 5
): { changed: boolean; reason?: string } {
  // First time - always publish
  if (!previous) {
    return { changed: true, reason: 'first_publish' };
  }

  // Confidence level changed
  if (current.confidence !== previous.confidence) {
    return { changed: true, reason: `confidence_changed:${previous.confidence}->${current.confidence}` };
  }

  // Overall score changed significantly
  if (current.score !== undefined && previous.score !== undefined) {
    const scoreDiff = Math.abs(current.score - previous.score);
    if (scoreDiff >= threshold) {
      return { changed: true, reason: `score_changed:${previous.score}->${current.score}` };
    }
  }

  // Reliability changed significantly
  if (current.reliability !== undefined && previous.reliability !== undefined) {
    const relDiff = Math.abs(current.reliability - previous.reliability);
    if (relDiff >= threshold) {
      return { changed: true, reason: `reliability_changed:${previous.reliability}->${current.reliability}` };
    }
  }

  // Quality changed significantly
  if (current.quality !== undefined && previous.quality !== undefined) {
    const qualDiff = Math.abs(current.quality - previous.quality);
    if (qualDiff >= threshold) {
      return { changed: true, reason: `quality_changed:${previous.quality}->${current.quality}` };
    }
  }

  // Openness changed significantly
  if (current.accessibility !== undefined && previous.accessibility !== undefined) {
    const openDiff = Math.abs(current.accessibility - previous.accessibility);
    if (openDiff >= threshold) {
      return { changed: true, reason: `accessibility_changed:${previous.accessibility}->${current.accessibility}` };
    }
  }

  // New score appeared (was undefined, now has value)
  if (current.score !== undefined && previous.score === undefined) {
    return { changed: true, reason: 'score_appeared' };
  }
  if (current.quality !== undefined && previous.quality === undefined) {
    return { changed: true, reason: 'quality_appeared' };
  }
  if (current.accessibility !== undefined && previous.accessibility === undefined) {
    return { changed: true, reason: 'accessibility_appeared' };
  }

  return { changed: false };
}

/**
 * Sign an unsigned event with a private key
 */
export function signEvent(unsignedEvent: UnsignedEvent, privateKey: string): Event {
  // Convert hex private key to Uint8Array
  const privKeyBytes = hexToBytes(privateKey);

  // finalizeEvent adds id, pubkey, and sig
  const event = finalizeEvent(unsignedEvent, privKeyBytes);

  return event as Event;
}

/**
 * Publish a signed event to a relay
 */
async function publishToRelay(
  event: Event,
  relayUrl: string,
  timeout: number = 10000
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (result: { success: boolean; error?: string }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);

    const timeoutId = setTimeout(() => {
      safeResolve({ success: false, error: 'timeout' });
    }, timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });

    ws.on('message', (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // Invalid JSON, wait for valid message
      }

      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
        if (msg[2] === true) {
          safeResolve({ success: true });
        } else {
          safeResolve({ success: false, error: String(msg[3] || 'rejected') });
        }
      }
    });

    ws.on('error', (err) => {
      safeResolve({ success: false, error: err.message });
    });

    ws.on('close', () => {
      safeResolve({ success: false, error: 'connection_closed' });
    });
  });
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * AssertionPublisher - Signs and publishes kind 30385 events
 */
export class AssertionPublisher {
  private config: PublisherConfig;
  private pubkey: string;

  constructor(config: PublisherConfig) {
    // Normalize private key (accepts hex or nsec)
    const normalizedKey = normalizePrivateKey(config.privateKey);

    this.config = {
      ...config,
      privateKey: normalizedKey,
      materialChangeThreshold: config.materialChangeThreshold ?? 5,
    };

    // Derive public key from private key
    const privKeyBytes = hexToBytes(normalizedKey);
    this.pubkey = getPublicKey(privKeyBytes);
  }

  /**
   * Get the publisher's public key
   */
  getPublicKey(): string {
    return this.pubkey;
  }

  /**
   * Publish an assertion if it has materially changed
   */
  async publish(assertion: RelayAssertion): Promise<PublishResult> {
    const result: PublishResult = {
      relayUrl: assertion.relayUrl,
      eventId: '',
      success: false,
      publishedTo: [],
      errors: [],
      skipped: false,
    };

    // Check for material change
    const previous = await this.config.db.getLastPublishedAssertion(assertion.relayUrl);
    const changeCheck = hasMaterialChange(
      assertion,
      previous,
      this.config.materialChangeThreshold
    );

    if (!changeCheck.changed) {
      result.skipped = true;
      result.skipReason = 'no_material_change';
      return result;
    }

    // Convert assertion to unsigned event
    const unsignedEvent = assertionToEvent(assertion);

    // Sign the event
    const signedEvent = signEvent(unsignedEvent, this.config.privateKey);
    result.eventId = signedEvent.id;

    // Publish using pool (preferred) or legacy per-event connections
    await this.publishEvent(signedEvent, assertion.relayUrl, result);

    // Store the published assertion if successful
    if (result.success) {
      await this.config.db.storePublishedAssertion({
        relayUrl: assertion.relayUrl,
        eventId: signedEvent.id,
        score: assertion.score,
        reliability: assertion.reliability,
        quality: assertion.quality,
        accessibility: assertion.accessibility,
        confidence: assertion.confidence,
        publishedAt: signedEvent.created_at,
      });
    }

    return result;
  }

  /**
   * Internal: Publish a signed event using pool or legacy mode
   */
  private async publishEvent(
    signedEvent: Event,
    relayUrl: string,
    result: PublishResult
  ): Promise<void> {
    if (this.config.pool) {
      // Use connection pool (preferred)
      const poolResult = await this.config.pool.publish(signedEvent);

      for (const r of poolResult.results) {
        if (r.success) {
          result.publishedTo.push(r.relay);
          if (this.config.onPublish) {
            this.config.onPublish(relayUrl, signedEvent.id);
          }
        } else {
          result.errors.push({ relay: r.relay, error: r.error || 'unknown' });
          if (this.config.onError) {
            this.config.onError(relayUrl, r.error || 'unknown');
          }
        }
      }

      result.success = poolResult.successCount > 0;
    } else {
      // Legacy: Create new connections for each publish
      const publishPromises = this.config.publishRelays.map(async (relay) => {
        const publishResult = await publishToRelay(signedEvent, relay);

        if (publishResult.success) {
          result.publishedTo.push(relay);
          if (this.config.onPublish) {
            this.config.onPublish(relayUrl, signedEvent.id);
          }
        } else {
          result.errors.push({ relay, error: publishResult.error || 'unknown' });
          if (this.config.onError) {
            this.config.onError(relayUrl, publishResult.error || 'unknown');
          }
        }

        return publishResult;
      });

      // Use allSettled to ensure all publishes complete even if some fail
      await Promise.allSettled(publishPromises);
      result.success = result.publishedTo.length > 0;
    }
  }

  /**
   * Force publish an assertion (bypass material change check)
   */
  async forcePublish(assertion: RelayAssertion): Promise<PublishResult> {
    const result: PublishResult = {
      relayUrl: assertion.relayUrl,
      eventId: '',
      success: false,
      publishedTo: [],
      errors: [],
      skipped: false,
    };

    // Convert assertion to unsigned event
    const unsignedEvent = assertionToEvent(assertion);

    // Sign the event
    const signedEvent = signEvent(unsignedEvent, this.config.privateKey);
    result.eventId = signedEvent.id;

    // Publish using pool (preferred) or legacy per-event connections
    await this.publishEvent(signedEvent, assertion.relayUrl, result);

    // Store the published assertion if successful
    if (result.success) {
      await this.config.db.storePublishedAssertion({
        relayUrl: assertion.relayUrl,
        eventId: signedEvent.id,
        score: assertion.score,
        reliability: assertion.reliability,
        quality: assertion.quality,
        accessibility: assertion.accessibility,
        confidence: assertion.confidence,
        publishedAt: signedEvent.created_at,
      });
    }

    return result;
  }

  /**
   * Publish multiple assertions
   */
  async publishBatch(
    assertions: RelayAssertion[],
    options: { force?: boolean } = {}
  ): Promise<PublishResult[]> {
    const results: PublishResult[] = [];

    for (const assertion of assertions) {
      const result = options.force
        ? await this.forcePublish(assertion)
        : await this.publish(assertion);
      results.push(result);
    }

    return results;
  }
}

/**
 * Format a publish result for display
 */
export function formatPublishResult(result: PublishResult): string {
  const lines: string[] = [
    `Relay: ${result.relayUrl}`,
  ];

  if (result.skipped) {
    lines.push(`Status: Skipped (${result.skipReason})`);
    return lines.join('\n');
  }

  lines.push(`Event ID: ${result.eventId}`);
  lines.push(`Success: ${result.success}`);

  if (result.publishedTo.length > 0) {
    lines.push(`Published to: ${result.publishedTo.join(', ')}`);
  }

  if (result.errors.length > 0) {
    lines.push(`Errors:`);
    for (const err of result.errors) {
      lines.push(`  ${err.relay}: ${err.error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate a new random private key (for testing)
 */
export function generatePrivateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
