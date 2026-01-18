import { WebSocket } from 'ws';
import type { Event } from 'nostr-tools';

/**
 * Result of publishing to a single relay
 */
interface RelayPublishResult {
  relay: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
}

/**
 * Persistent connection to a single relay
 * Handles reconnection, rate limiting, and event queuing
 */
class RelayConnection {
  private ws: WebSocket | null = null;
  private url: string;
  private connected = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;

  // Pending event callbacks waiting for OK response
  private pendingEvents: Map<string, {
    resolve: (result: RelayPublishResult) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  // Rate limit tracking
  private rateLimitedUntil = 0;
  private eventsSentThisMinute = 0;
  private minuteResetTimer: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  private onConnect?: () => void;
  private onDisconnect?: () => void;

  constructor(url: string, options?: {
    onConnect?: () => void;
    onDisconnect?: () => void;
  }) {
    this.url = url;
    this.onConnect = options?.onConnect;
    this.onDisconnect = options?.onDisconnect;
  }

  /**
   * Get the relay URL
   */
  getUrl(): string {
    return this.url;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Check if currently rate limited
   */
  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /**
   * Connect to the relay
   */
  async connect(): Promise<void> {
    if (this.connected || this.connecting) {
      return;
    }

    this.connecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        const connectTimeout = setTimeout(() => {
          if (!this.connected) {
            this.ws?.close();
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.connected = true;
          this.connecting = false;
          this.reconnectAttempts = 0;
          this.startMinuteResetTimer();
          this.onConnect?.();
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('error', (err) => {
          // Store the error for the close handler to use
          // (errors are often followed by close events)
          this.lastError = err.message || 'WebSocket error';
        });

        this.ws.on('close', () => {
          clearTimeout(connectTimeout);
          const wasConnected = this.connected;
          this.connected = false;
          this.connecting = false;

          // Use stored error from error handler if available
          const storedError = this.lastError;
          const errorMessage = storedError ? `connection_closed: ${storedError}` : 'connection_closed';
          this.lastError = null; // Clear after use

          // Reject all pending events
          for (const [eventId, pending] of this.pendingEvents) {
            clearTimeout(pending.timeout);
            pending.resolve({
              relay: this.url,
              success: false,
              error: errorMessage,
            });
          }
          this.pendingEvents.clear();

          if (wasConnected) {
            this.onDisconnect?.();
            this.scheduleReconnect();
          } else {
            reject(new Error(storedError || 'Connection failed'));
          }
        });
      } catch (err) {
        this.connecting = false;
        reject(err);
      }
    });
  }

  /**
   * Send an event to the relay
   */
  async send(event: Event, timeout = 10000): Promise<RelayPublishResult> {
    // Check rate limit
    if (this.isRateLimited()) {
      return {
        relay: this.url,
        success: false,
        error: 'rate_limited',
        rateLimited: true,
      };
    }

    // Ensure connected
    if (!this.isConnected()) {
      try {
        await this.connect();
      } catch (err) {
        return {
          relay: this.url,
          success: false,
          error: err instanceof Error ? err.message : 'connection_failed',
        };
      }
    }

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingEvents.delete(event.id);
        resolve({
          relay: this.url,
          success: false,
          error: 'timeout',
        });
      }, timeout);

      this.pendingEvents.set(event.id, { resolve, timeout: timeoutId });

      try {
        this.ws?.send(JSON.stringify(['EVENT', event]));
        this.eventsSentThisMinute++;
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingEvents.delete(event.id);
        resolve({
          relay: this.url,
          success: false,
          error: err instanceof Error ? err.message : 'send_failed',
        });
      }
    });
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.minuteResetTimer) {
      clearTimeout(this.minuteResetTimer);
      this.minuteResetTimer = null;
    }

    // Reject all pending events
    for (const [eventId, pending] of this.pendingEvents) {
      clearTimeout(pending.timeout);
      pending.resolve({
        relay: this.url,
        success: false,
        error: 'connection_closed',
      });
    }
    this.pendingEvents.clear();

    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(data: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (!Array.isArray(msg)) return;

    if (msg[0] === 'OK') {
      const eventId = msg[1] as string;
      const success = msg[2] as boolean;
      const message = msg[3] as string | undefined;

      const pending = this.pendingEvents.get(eventId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingEvents.delete(eventId);

        // Check for rate limit in error message
        const isRateLimited = message?.toLowerCase().includes('rate') ||
                              message?.toLowerCase().includes('too many') ||
                              message?.toLowerCase().includes('slow down');

        if (isRateLimited) {
          // Back off for 60 seconds
          this.rateLimitedUntil = Date.now() + 60000;
        }

        pending.resolve({
          relay: this.url,
          success,
          error: success ? undefined : (message || 'rejected'),
          rateLimited: isRateLimited,
        });
      }
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Will retry via close handler
      });
    }, delay);
  }

  /**
   * Reset events-per-minute counter
   */
  private startMinuteResetTimer(): void {
    if (this.minuteResetTimer) {
      clearTimeout(this.minuteResetTimer);
    }
    this.minuteResetTimer = setTimeout(() => {
      this.eventsSentThisMinute = 0;
      if (this.connected) {
        this.startMinuteResetTimer();
      }
    }, 60000);
  }
}

/**
 * Result of publishing an event to multiple relays
 */
export interface PoolPublishResult {
  eventId: string;
  results: RelayPublishResult[];
  successCount: number;
  failureCount: number;
}

/**
 * Connection pool for publishing to multiple relays
 * Maintains persistent connections and handles publishing with rate awareness
 */
export class RelayPool {
  private connections: Map<string, RelayConnection> = new Map();
  private relayUrls: string[];
  private verbose: boolean;

  constructor(relayUrls: string[], options?: { verbose?: boolean }) {
    this.relayUrls = relayUrls;
    this.verbose = options?.verbose ?? false;

    for (const url of relayUrls) {
      const conn = new RelayConnection(url, {
        onConnect: () => {
          if (this.verbose) console.log(`[RelayPool] Connected to ${url}`);
        },
        onDisconnect: () => {
          if (this.verbose) console.log(`[RelayPool] Disconnected from ${url}`);
        },
      });
      this.connections.set(url, conn);
    }
  }

  /**
   * Connect to all relays in the pool
   */
  async connect(): Promise<void> {
    const connectPromises = Array.from(this.connections.values()).map(conn =>
      conn.connect().catch(err => {
        if (this.verbose) {
          console.warn(`[RelayPool] Failed to connect to ${conn.getUrl()}: ${err.message}`);
        }
      })
    );
    await Promise.all(connectPromises);
  }

  /**
   * Check if any relay is connected
   */
  hasConnections(): boolean {
    return Array.from(this.connections.values()).some(conn => conn.isConnected());
  }

  /**
   * Get count of connected relays
   */
  getConnectedCount(): number {
    return Array.from(this.connections.values()).filter(conn => conn.isConnected()).length;
  }

  /**
   * Publish an event to all connected relays
   */
  async publish(event: Event): Promise<PoolPublishResult> {
    const results: RelayPublishResult[] = [];

    // Send to all relays in parallel
    const publishPromises = Array.from(this.connections.values()).map(async conn => {
      // Skip rate-limited relays
      if (conn.isRateLimited()) {
        return {
          relay: conn.getUrl(),
          success: false,
          error: 'rate_limited',
          rateLimited: true,
        };
      }

      return conn.send(event);
    });

    const allResults = await Promise.all(publishPromises);
    results.push(...allResults);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    return {
      eventId: event.id,
      results,
      successCount,
      failureCount,
    };
  }

  /**
   * Close all connections
   */
  close(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

/**
 * Item in the publish queue
 */
interface QueuedPublish {
  event: Event;
  relayUrl: string;
  priority: number; // Higher = more urgent
  addedAt: number;
  resolve: (result: PoolPublishResult) => void;
}

/**
 * Publish scheduler that paces event publishing across an interval
 * Prevents rate limiting by spreading events evenly over time
 */
export class PublishScheduler {
  private pool: RelayPool;
  private queue: QueuedPublish[] = [];
  private processing = false;
  private minDelayMs: number;
  private lastPublishTime = 0;
  private verbose: boolean;

  // Statistics
  private stats = {
    published: 0,
    failed: 0,
    rateLimited: 0,
  };

  constructor(pool: RelayPool, options?: {
    // Minimum delay between publishes in milliseconds
    minDelayMs?: number;
    verbose?: boolean;
  }) {
    this.pool = pool;
    this.minDelayMs = options?.minDelayMs ?? 2000; // Default 2 seconds between events
    this.verbose = options?.verbose ?? false;
  }

  /**
   * Queue an event for publishing
   * Returns a promise that resolves when the event is published
   */
  async schedule(event: Event, relayUrl: string, priority = 0): Promise<PoolPublishResult> {
    return new Promise((resolve) => {
      this.queue.push({
        event,
        relayUrl,
        priority,
        addedAt: Date.now(),
        resolve,
      });

      // Sort by priority (descending), then by addedAt (ascending)
      this.queue.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.addedAt - b.addedAt;
      });

      this.processQueue();
    });
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      // Respect minimum delay
      const now = Date.now();
      const timeSinceLastPublish = now - this.lastPublishTime;
      if (timeSinceLastPublish < this.minDelayMs) {
        await sleep(this.minDelayMs - timeSinceLastPublish);
      }

      const item = this.queue.shift();
      if (!item) break;

      try {
        const result = await this.pool.publish(item.event);
        this.lastPublishTime = Date.now();

        if (result.successCount > 0) {
          this.stats.published++;
        } else {
          this.stats.failed++;
          if (result.results.some(r => r.rateLimited)) {
            this.stats.rateLimited++;
          }
        }

        if (this.verbose) {
          console.log(`[Scheduler] Published ${item.relayUrl}: ${result.successCount}/${result.results.length} success`);
        }

        item.resolve(result);
      } catch (err) {
        this.stats.failed++;
        item.resolve({
          eventId: item.event.id,
          results: [],
          successCount: 0,
          failureCount: 0,
        });
      }
    }

    this.processing = false;
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
