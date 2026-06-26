import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ServiceConfig } from './config.js';
import { DataStore } from './database.js';
import { probeRelay } from './prober.js';
import { computeCombinedReliabilityScore } from './scorer.js';
import { buildAssertion } from './assertion.js';
import { resolveOperator } from './operator-resolver.js';
import { computeQualityScore } from './quality-scorer.js';
import { computeAccessibilityScore } from './accessibility-scorer.js';
import { resolveJurisdiction } from './jurisdiction.js';
import { MonitorIngestor, discoverMonitors } from './ingestor.js';
import { ReportIngestor } from './report-ingestor.js';
import { AssertionPublisher } from './assertion-publisher.js';
import { normalizePrivateKey } from './key-utils.js';
import { startApiServer, refreshPrecomputed } from './api.js';
import { RelayPool } from './relay-pool.js';
import { getTrustScore } from './wot-client.js';
import type { OperatorResolution } from './types.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Service statistics
 */
export interface ServiceStats {
  startedAt: number;
  probeCount: number;
  probeErrorCount: number;
  publishCount: number;
  publishSkipCount: number;
  relaysTracked: number;
  lastProbeAt: number | null;
  lastPublishAt: number | null;
}

/**
 * RelayTrustService - Main daemon service
 *
 * Orchestrates:
 * - Periodic relay probing
 * - NIP-66 data ingestion
 * - Report ingestion
 * - Score computation and publishing
 */

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once, using
 * a continuous pool (each finished worker grabs the next item) rather than
 * fixed batches — so one slow item never idles the other slots. Stops pulling
 * new items when `shouldStop()` returns true. Individual worker errors must be
 * handled by the worker; an unhandled throw aborts the pool.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (!shouldStop() && next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, run));
}

export class RelayTrustService {
  private config: ServiceConfig;
  private db: DataStore;
  private publisher: AssertionPublisher | null = null;
  private publishPool: RelayPool | null = null;
  private monitorIngestor: MonitorIngestor | null = null;
  private reportIngestor: ReportIngestor | null = null;
  private apiServer: { stop: () => void } | null = null;

  private running = false;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleInProgress = false;
  private checkpointInProgress = false;
  private lastCleanupAt: number = 0;
  private lastCheckpointAt: number = 0;

  private stats: ServiceStats = {
    startedAt: 0,
    probeCount: 0,
    probeErrorCount: 0,
    publishCount: 0,
    publishSkipCount: 0,
    relaysTracked: 0,
    lastProbeAt: null,
    lastPublishAt: null,
  };

  private logLevel: LogLevel;

  constructor(config: ServiceConfig) {
    this.config = config;
    this.logLevel = config.logging.level;

    // Ensure data directory exists
    mkdirSync(dirname(config.database.path), { recursive: true });

    // Initialize database
    this.db = new DataStore(config.database.path);
  }

  /**
   * Start the service
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log('warn', 'Service already running');
      return;
    }

    this.running = true;
    this.stats.startedAt = Date.now();

    this.log('info', '='.repeat(60));
    this.log('info', 'Starting Relay Trust Service');
    this.log('info', '='.repeat(60));

    // Initialize publisher only if publishing is enabled
    if (this.config.publishing.enabled) {
      // Get private key (accepts hex or nsec format)
      const rawKey = this.config.provider.privateKey || process.env.NOSTR_PRIVATE_KEY;
      if (!rawKey) {
        throw new Error('No private key configured');
      }
      const privateKey = normalizePrivateKey(rawKey);

      // Initialize connection pool if enabled
      if (this.config.publishing.useConnectionPool) {
        this.log('info', 'Initializing persistent connection pool...');
        this.publishPool = new RelayPool(this.config.publishing.relays, {
          verbose: this.logLevel === 'debug',
        });
        await this.publishPool.connect();
        this.log('info', `Connection pool ready: ${this.publishPool.getConnectedCount()}/${this.config.publishing.relays.length} relays connected`);
      }

      // Initialize publisher
      this.publisher = new AssertionPublisher({
        privateKey,
        publishRelays: this.config.publishing.relays,
        materialChangeThreshold: this.config.publishing.materialChangeThreshold,
        db: this.db,
        pool: this.publishPool ?? undefined,
      });

      this.log('info', `Publisher pubkey: ${this.publisher.getPublicKey()}`);
      this.log('info', `Publish relays: ${this.config.publishing.relays.join(', ')}`);
    } else {
      this.log('info', 'Publishing disabled - running in probe-only mode');
    }

    this.log('info', `Target relays: ${this.config.targets.relays.length}`);

    // Start API server early so dashboard is available during startup
    if (this.config.api?.enabled) {
      this.apiServer = startApiServer({
        port: this.config.api.port,
        host: this.config.api.host,
        db: this.db,
        trustProxy: this.config.api.trustProxy ?? false,
        maxRequestedRelays: this.config.targets?.maxRelays,
        getMetrics: () => this.getMetrics(),
      });
      this.log('info', `API server started at http://${this.config.api.host}:${this.config.api.port}`);
    }

    // Add configured monitors to database
    for (const pubkey of this.config.sources.trustedMonitors) {
      await this.db.addTrustedMonitor(pubkey);
    }

    // Discover additional monitors from relay.nostr.watch
    this.log('info', 'Discovering NIP-66 monitors...');
    await this.discoverMonitors();

    // Start NIP-66 ingestion
    await this.startMonitorIngestion();

    // Start report ingestion
    await this.startReportIngestion();

    // Initial cycle: probe then publish
    await this.runCycle();

    // Set up periodic cycle (probe → publish) and WAL checkpoint using
    // self-rescheduling timers. Unlike setInterval, these never overlap a slow
    // run with the next one, and a thrown error never kills the loop.
    this.scheduleCycle();
    this.scheduleCheckpoint();

    this.log('info', `Service started. Cycle interval: ${this.config.intervals.cycle}s (probe → publish)`);
  }

  private scheduleCycle(): void {
    if (!this.running) return;
    this.cycleTimer = setTimeout(async () => {
      if (this.running && !this.cycleInProgress) {
        this.cycleInProgress = true;
        try {
          await this.runCycle();
        } catch (err) {
          this.log('error', `Cycle failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.cycleInProgress = false;
        }
      }
      this.scheduleCycle();
    }, this.config.intervals.cycle * 1000);
  }

  private scheduleCheckpoint(): void {
    if (!this.running) return;
    // Independent WAL checkpoint (every 5 minutes). Prevents WAL growth between
    // cycles while ingestors write continuously.
    this.checkpointTimer = setTimeout(async () => {
      if (this.running && !this.checkpointInProgress) {
        this.checkpointInProgress = true;
        try {
          await this.checkpointDatabase();
        } catch (err) {
          this.log('error', `Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.checkpointInProgress = false;
        }
      }
      this.scheduleCheckpoint();
    }, 5 * 60 * 1000);
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.log('info', 'Stopping service...');
    this.running = false;

    // Clear timers (running=false above already prevents rescheduling)
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }

    // Stop ingestors
    if (this.monitorIngestor) {
      this.monitorIngestor.stop();
      this.monitorIngestor = null;
    }
    if (this.reportIngestor) {
      this.reportIngestor.stop();
      this.reportIngestor = null;
    }

    // Close connection pool
    if (this.publishPool) {
      this.publishPool.close();
      this.publishPool = null;
    }

    // Stop API server
    if (this.apiServer) {
      this.apiServer.stop();
      this.apiServer = null;
    }

    // Close database
    await this.db.close();

    this.log('info', 'Service stopped');
    this.logStats();
  }

  /**
   * Get service statistics
   */
  getStats(): ServiceStats {
    return { ...this.stats };
  }

  /**
   * Operational metrics snapshot for the /api/metrics endpoint. In-memory
   * counters only (no DB queries), safe to scrape frequently.
   */
  getMetrics(): object {
    const now = Date.now();
    const probeTotal = this.stats.probeCount + this.stats.probeErrorCount;
    return {
      running: this.running,
      uptimeSeconds: this.stats.startedAt ? Math.floor((now - this.stats.startedAt) / 1000) : 0,
      relaysTracked: this.stats.relaysTracked,
      probe: {
        success: this.stats.probeCount,
        errors: this.stats.probeErrorCount,
        successRate: probeTotal > 0 ? Math.round((this.stats.probeCount / probeTotal) * 100) : null,
        lastAt: this.stats.lastProbeAt,
        ageSeconds: this.stats.lastProbeAt ? Math.floor((now - this.stats.lastProbeAt) / 1000) : null,
      },
      publish: {
        published: this.stats.publishCount,
        skipped: this.stats.publishSkipCount,
        lastAt: this.stats.lastPublishAt,
        ageSeconds: this.stats.lastPublishAt ? Math.floor((now - this.stats.lastPublishAt) / 1000) : null,
      },
      ingest: {
        nip66Events: this.monitorIngestor?.getEventCount() ?? 0,
        nip66Connections: this.monitorIngestor?.getConnectionCount() ?? 0,
        reports: this.reportIngestor?.getReportCount() ?? 0,
      },
    };
  }

  /**
   * Check if service is healthy
   */
  isHealthy(): boolean {
    if (!this.running) return false;

    // Check if we've probed recently
    const probeAge = this.stats.lastProbeAt
      ? Date.now() - this.stats.lastProbeAt
      : Infinity;

    // Unhealthy if no probe in 2x the cycle interval
    return probeAge < this.config.intervals.cycle * 2000;
  }

  /**
   * Discover NIP-66 monitors
   * Prioritizes relay.nostr.watch as the primary source for monitor announcements
   */
  private async discoverMonitors(): Promise<void> {
    // Track which source relays announced each monitor pubkey, so we can require
    // cross-source corroboration before auto-trusting a NEW monitor (Sybil
    // resistance — a kind-10166 is a public event anyone can sign, so a single
    // appearance is not sufficient evidence of a legitimate monitor).
    const monitorSources = new Map<string, Set<string>>();

    // Prioritize relay.nostr.watch for monitor discovery
    const priorityRelays = this.config.sources.sourceRelays.filter(r =>
      r.includes('nostr.watch')
    );
    const otherRelays = this.config.sources.sourceRelays.filter(r =>
      !r.includes('nostr.watch')
    );
    const orderedRelays = [...priorityRelays, ...otherRelays];

    for (const relay of orderedRelays) {
      try {
        const monitors = await discoverMonitors(relay, 10000);
        for (const m of monitors) {
          let sources = monitorSources.get(m.pubkey);
          if (!sources) { sources = new Set(); monitorSources.set(m.pubkey, sources); }
          sources.add(relay);
        }
        if (monitors.length > 0) {
          this.log('info', `Discovered ${monitors.length} monitors from ${relay}`);
        }
      } catch (err) {
        this.log('warn', `Failed to discover monitors from ${relay}: ${err}`);
      }
    }

    const minSources = this.config.sources.minMonitorSources ?? 2;
    const maxMonitors = this.config.sources.maxMonitors ?? 200;
    const configTrusted = new Set(this.config.sources.trustedMonitors ?? []);
    // Already-trusted monitors are kept (never dropped here); corroboration +
    // cap only gate ENROLLING new ones.
    const existing = new Set((await this.db.getTrustedMonitors()).map(m => m.pubkey));

    let trustedCount = existing.size;
    let added = 0, skippedUncorroborated = 0, skippedCap = 0;
    for (const [pubkey, sources] of monitorSources) {
      if (existing.has(pubkey)) continue;
      const corroborated = sources.size >= minSources || configTrusted.has(pubkey);
      if (!corroborated) { skippedUncorroborated++; continue; }
      if (trustedCount >= maxMonitors) { skippedCap++; continue; }
      await this.db.addTrustedMonitor(pubkey);
      trustedCount++; added++;
    }

    this.log('info',
      `Monitor discovery: ${added} newly trusted (≥${minSources} sources), ` +
      `${skippedUncorroborated} uncorroborated skipped, ${skippedCap} over cap (${maxMonitors}). ` +
      `Total trusted: ${trustedCount}`);
  }

  /**
   * Start NIP-66 monitor ingestion
   */
  private async startMonitorIngestion(): Promise<void> {
    const trustedMonitors = await this.db.getTrustedMonitors();

    if (trustedMonitors.length === 0) {
      this.log('warn', 'No trusted monitors, skipping NIP-66 ingestion');
      return;
    }

    this.monitorIngestor = new MonitorIngestor({
      sourceRelays: this.config.sources.sourceRelays,
      trustedMonitors: trustedMonitors.map(m => m.pubkey),
      db: this.db,
      verbose: this.logLevel === 'debug',
      onMetric: (relayUrl) => {
        this.log('debug', `NIP-66 metric for ${relayUrl}`);
      },
    });

    await this.monitorIngestor.start();
    this.log('info', `Started NIP-66 ingestion from ${trustedMonitors.length} monitors`);
  }

  /**
   * Start report ingestion
   */
  private async startReportIngestion(): Promise<void> {
    this.reportIngestor = new ReportIngestor({
      sourceRelays: this.config.sources.sourceRelays,
      db: this.db,
      fetchTrustScores: true,
      verbose: this.logLevel === 'debug',
      onReport: (report) => {
        this.log('debug', `Report for ${report.relayUrl}: ${report.reportType}`);
      },
    });

    await this.reportIngestor.start();
    this.log('info', 'Started report ingestion');
  }

  /**
   * Run a complete cycle: probe all relays, then publish assertions (if enabled)
   */
  private async runCycle(): Promise<void> {
    const mode = this.config.publishing.enabled ? 'probe → publish' : 'probe only';
    this.log('info', `Starting cycle: ${mode}`);
    this.logMemoryUsage();

    // Probe all relays
    this.log('info', 'Probing relays...');
    await this.probeAllRelays();

    // Refresh stale WoT scores (runs regardless of publishing mode)
    await this.refreshStaleWotScoresStandalone();

    // Publish assertions for relays with material changes (if publishing enabled)
    if (this.config.publishing.enabled) {
      this.log('info', 'Publishing assertions...');
      await this.publishAllAssertions();
    }

    // Run database cleanup once per day
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - this.lastCleanupAt > oneDayMs) {
      await this.cleanupOldData();
    }

    // Refresh the API read-model snapshots off the request path, using the
    // fresh probe/score data from this cycle. A failure here must not abort the
    // cycle.
    if (this.config.api?.enabled) {
      try {
        await refreshPrecomputed(this.db);
        this.log('debug', 'Refreshed API read-model snapshots');
      } catch (err) {
        this.log('warn', `Failed to refresh API snapshots: ${err}`);
      }
    }

    this.logMemoryUsage();
    this.log('info', 'Cycle complete');
  }

  /**
   * Clean up old data from the database
   */
  private async cleanupOldData(): Promise<void> {
    const { retentionDays, probeRetentionDays, nip66RetentionDays } = this.config.database;
    const probeDays = probeRetentionDays ?? 45;
    const nip66Days = nip66RetentionDays ?? 45;
    this.log('info', `Cleaning up data (score_history/reports ${retentionDays}d, probes ${probeDays}d, nip66 ${nip66Days}d)...`);

    try {
      const result = await this.db.cleanupOldData({
        scoreHistoryDays: retentionDays,
        reportDays: retentionDays,
        probeDays,
        nip66Days,
      });
      const total = result.probes + result.nip66Metrics + result.reports + result.scoreHistory;

      if (total > 0) {
        this.log('info', `Cleaned up ${total} old records (probes: ${result.probes}, nip66: ${result.nip66Metrics}, reports: ${result.reports}, history: ${result.scoreHistory})`);
      } else {
        this.log('debug', 'No old data to clean up');
      }

      this.lastCleanupAt = Date.now();

      // Checkpoint after cleanup to flush deleted data
      await this.checkpointDatabase();
    } catch (err) {
      this.log('warn', `Database cleanup failed: ${err}`);
    }
  }

  /**
   * Checkpoint the database WAL to keep it from growing unbounded.
   * Uses a TRUNCATE checkpoint to fold committed pages into the main DB file
   * and reset the WAL.
   *
   * WAL size threshold: 100MB - if exceeded after checkpoint, logs a warning.
   */
  private async checkpointDatabase(): Promise<void> {
    const WAL_SIZE_THRESHOLD_MB = 100;

    // Check WAL size before checkpoint
    const walSizeBefore = this.db.getWalFileSizeMB();
    if (walSizeBefore > 10) {
      this.log('debug', `WAL size before checkpoint: ${walSizeBefore}MB`);
    }

    // Perform force checkpoint
    const success = await this.db.checkpoint(true);
    this.lastCheckpointAt = Date.now();

    if (success) {
      const walSizeAfter = this.db.getWalFileSizeMB();
      if (walSizeAfter > WAL_SIZE_THRESHOLD_MB) {
        this.log('warn', `WAL file still large after checkpoint: ${walSizeAfter}MB (threshold: ${WAL_SIZE_THRESHOLD_MB}MB)`);
      } else if (walSizeBefore > 10) {
        this.log('debug', `Checkpoint completed, WAL size: ${walSizeBefore}MB -> ${walSizeAfter}MB`);
      } else {
        this.log('debug', 'Database checkpoint completed');
      }
    } else {
      this.log('warn', 'Database checkpoint failed');
    }
  }

  /**
   * Probe all target relays
   */
  private async probeAllRelays(): Promise<void> {
    const relays = [...this.config.targets.relays];

    // Add requested relays (on-demand tracking) - always include these
    const requestedRelays = await this.db.getRequestedRelays();
    for (const url of requestedRelays) {
      if (!relays.includes(url)) {
        relays.push(url);
      }
    }

    // Add relays discovered from NIP-66 monitors (seen by 2+ monitors)
    if (this.config.targets.discoverFromMonitors) {
      const nip66Relays = await this.db.getNip66RelayUrls(2); // 2+ monitors
      for (const url of nip66Relays) {
        if (!relays.includes(url)) {
          relays.push(url);
        }
      }
      this.log('debug', `Found ${nip66Relays.length} relays from NIP-66 with 2+ monitors`);
    }

    // Clean up requested relays that have been unreachable for 14+ days
    const unreachableRelays = await this.db.getRelaysUnreachableFor(14, 3);
    for (const url of unreachableRelays) {
      const isRequested = await this.db.isRequestedRelay(url);
      if (isRequested) {
        await this.db.removeRequestedRelay(url);
        this.log('info', `Removed unreachable relay from tracking: ${url}`);
      }
    }

    this.stats.relaysTracked = relays.length;
    const concurrency = this.config.probing?.concurrency ?? 30;
    this.log('info', `Probing ${relays.length} relays (concurrency: ${concurrency})...`);

    let successCount = 0;
    let errorCount = 0;
    let completed = 0;

    // Process a single relay
    const processRelay = async (url: string): Promise<void> => {
      if (!this.running) return;

      try {
        const probe = await probeRelay(url);
        await this.db.storeProbe(probe);

        if (probe.reachable) {
          successCount++;

          // Resolve and store operator if NIP-11 has pubkey. TTL-gate it: the
          // DNS-TXT + well-known fetch are expensive per-relay-per-cycle, and
          // operator pubkeys rarely change. Skip if we resolved this relay in
          // the last 7 days (WoT freshness is handled separately by
          // refreshStaleWotScoresStandalone()).
          const existingResolution = probe.nip11?.pubkey ? await this.db.getOperatorResolution(url) : null;
          const resolveTtl = 7 * 86400;
          const resolutionFresh = !!existingResolution?.verifiedAt &&
            existingResolution.verifiedAt > (Math.floor(Date.now() / 1000) - resolveTtl);
          if (probe.nip11?.pubkey && !resolutionFresh) {
            try {
              // First resolve operator WITHOUT fetching WoT
              const operatorResolution = await resolveOperator(url, probe.nip11, {
                fetchTrustScore: false,
              });

              if (operatorResolution.operatorPubkey) {
                // Check if operator already has fresh WoT data (< 1 day old)
                const existingWot = await this.db.getOperatorWot(operatorResolution.operatorPubkey);
                const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
                const needsWotFetch = !existingWot || !existingWot.wotUpdatedAt || existingWot.wotUpdatedAt < oneDayAgo;

                if (needsWotFetch) {
                  // Fetch WoT for this operator
                  try {
                    const trustScore = await getTrustScore(operatorResolution.operatorPubkey, { timeout: 10000 });
                    if (trustScore) {
                      operatorResolution.trustScore = trustScore.score;
                      operatorResolution.trustConfidence = trustScore.confidence;
                      operatorResolution.trustProviderCount = trustScore.providers.length;
                    }
                  } catch {
                    // WoT fetch failure is not fatal
                  }
                } else {
                  // Use existing WoT data
                  if (existingWot.wotScore != null) {
                    operatorResolution.trustScore = existingWot.wotScore;
                    operatorResolution.trustConfidence = existingWot.wotConfidence ?? undefined;
                    operatorResolution.trustProviderCount = existingWot.wotProviderCount ?? undefined;
                  }
                }

                await this.db.storeOperatorResolution(operatorResolution);
                this.log('debug', `Resolved operator for ${url}: ${operatorResolution.verificationMethod}${needsWotFetch ? ' (fetched WoT)' : ' (used cached WoT)'}`);
              }
            } catch {
              // Operator resolution failure is not fatal
            }
          }

          // Resolve jurisdiction if not cached
          const cachedJurisdiction = await this.db.getJurisdiction(url);
          if (!cachedJurisdiction) {
            try {
              const jurisdiction = await resolveJurisdiction(url);
              await this.db.storeJurisdiction(jurisdiction);
              this.log('debug', `Resolved jurisdiction for ${url}: ${jurisdiction.countryCode || 'unknown'}`);
            } catch {
              // Jurisdiction resolution failure is not fatal
            }
          }
        } else {
          errorCount++;
        }

        this.stats.probeCount++;
        this.log('debug', `Probed ${url}: ${probe.reachable ? 'OK' : 'FAIL'}`);
      } catch (err) {
        errorCount++;
        this.stats.probeErrorCount++;
        this.log('warn', `Probe error for ${url}: ${err}`);
      }

      completed++;
      if (completed % concurrency === 0 || completed === relays.length) {
        const progress = Math.round((completed / relays.length) * 100);
        this.log('info', `Probe progress: ${completed}/${relays.length} (${progress}%)`);
      }
    };

    // Continuous worker pool: `concurrency` workers drain a shared queue, so a
    // slow/dead relay only ties up its own worker (no fixed-batch head-of-line
    // blocking where one relay idles the rest of the slots).
    await runPool(relays, concurrency, processRelay, () => !this.running);

    this.stats.lastProbeAt = Date.now();
    this.log('info', `Probe cycle complete: ${successCount} success, ${errorCount} failed`);
  }

  /**
   * Compute and publish assertions for all relays
   * Uses bulk queries to minimize database round-trips
   */
  private async publishAllAssertions(): Promise<void> {
    if (!this.publisher) {
      this.log('error', 'Publisher not initialized');
      return;
    }

    const relays = await this.db.getRelayUrls();
    this.log('info', `Publishing assertions for ${relays.length} relays...`);

    // Pre-fetch all data using bulk queries to avoid N+1 problem
    this.log('debug', 'Pre-fetching data with bulk queries...');
    const [
      allLatestProbes,
      allProbeStats,
      allProbes,
      allNip66Stats,
      allNip66Signals,
      allJurisdictions,
      allOperatorResolutions,
      allReportStats,
      allReports,
    ] = await Promise.all([
      this.db.getAllLatestProbes(),
      this.db.getAllProbeStats(30),
      this.db.getAllProbes(30),
      this.db.getAllNip66Stats(90),
      this.db.getAllNip66PolicySignals(90),
      this.db.getAllJurisdictions(),
      this.db.getAllOperatorResolutions(),
      this.db.getAllReportStats(90),
      this.db.getAllReports(90),
    ]);

    // Note: WoT scores are refreshed in runCycle() before this method is called

    let publishCount = 0;
    let skipCount = 0;

    for (const url of relays) {
      if (!this.running) break;

      try {
        // Use pre-fetched data where available
        const latestProbe = allLatestProbes.get(url) ?? null;
        const probeStats = allProbeStats.get(url);
        const nip66Stats = allNip66Stats.get(url);

        // Need at least some data to evaluate
        const totalObs = (probeStats?.probeCount ?? 0) + (nip66Stats?.metricCount ?? 0);
        if (totalObs === 0) {
          this.log('debug', `No data for ${url}, skipping`);
          continue;
        }

        // Individual probes for reliability scoring, from the bulk pre-fetch.
        const probes = allProbes.get(url) ?? (latestProbe ? [latestProbe] : []);

        // Use cached operator resolution or resolve fresh
        let operatorResolution = allOperatorResolutions.get(url);
        if (!operatorResolution) {
          // First resolve WITHOUT WoT
          operatorResolution = await resolveOperator(url, latestProbe?.nip11, {
            fetchTrustScore: false,
            nip85Timeout: 10000,
          });

          if (operatorResolution.operatorPubkey) {
            // Check if operator already has fresh WoT data
            const existingWot = await this.db.getOperatorWot(operatorResolution.operatorPubkey);
            const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
            const needsWotFetch = !existingWot || !existingWot.wotUpdatedAt || existingWot.wotUpdatedAt < oneDayAgo;

            if (needsWotFetch) {
              try {
                const trustScore = await getTrustScore(operatorResolution.operatorPubkey, { timeout: 10000 });
                if (trustScore) {
                  operatorResolution.trustScore = trustScore.score;
                  operatorResolution.trustConfidence = trustScore.confidence;
                  operatorResolution.trustProviderCount = trustScore.providers.length;
                }
              } catch {
                // WoT fetch failure is not fatal
              }
            } else if (existingWot?.wotScore != null) {
              operatorResolution.trustScore = existingWot.wotScore;
              operatorResolution.trustConfidence = existingWot.wotConfidence ?? undefined;
              operatorResolution.trustProviderCount = existingWot.wotProviderCount ?? undefined;
            }

            await this.db.storeOperatorResolution(operatorResolution);
          }
        }

        // Use pre-fetched jurisdiction or resolve fresh
        let jurisdiction = allJurisdictions.get(url);
        if (!jurisdiction) {
          jurisdiction = await resolveJurisdiction(url);
          await this.db.storeJurisdiction(jurisdiction);
        }

        // Use pre-fetched report stats + reports (bulk, no per-relay query)
        const reportStats = allReportStats.get(url);
        const reports = reportStats ? (allReports.get(url) ?? []) : [];

        // Compute scores using pre-fetched NIP-66 stats
        const nip66StatsForScoring = nip66Stats ? {
          metricCount: nip66Stats.metricCount,
          monitorCount: nip66Stats.monitorCount,
          avgRttOpen: nip66Stats.avgRttOpen,
          avgRttRead: nip66Stats.avgRttRead,
          avgRttWrite: nip66Stats.avgRttWrite,
          latencyScore: nip66Stats.latencyScore,
          connectPercentile: nip66Stats.connectPercentile,
          readPercentile: nip66Stats.readPercentile,
          qualifyingMonitorCount: nip66Stats.qualifyingMonitorCount,
          firstSeen: nip66Stats.firstSeen,
          lastSeen: nip66Stats.lastSeen,
        } : null;

        const score = computeCombinedReliabilityScore(probes, nip66StatsForScoring);
        const qualityScore = computeQualityScore(latestProbe?.nip11, url, operatorResolution);
        const accessibilityScore = computeAccessibilityScore(latestProbe?.nip11, jurisdiction?.countryCode);
        const nip66Signals = allNip66Signals.get(url);

        // Build assertion
        const assertion = buildAssertion(
          url,
          probes,
          score,
          operatorResolution,
          qualityScore,
          accessibilityScore,
          {
            reports,
            jurisdiction,
            nip66Signals,
            algorithmVersion: this.config.provider.algorithmVersion,
            algorithmUrl: this.config.provider.algorithmUrl,
          }
        );

        // Store score snapshot
        await this.db.storeScoreSnapshot(assertion);

        // Publish (will check for material change)
        const result = await this.publisher.publish(assertion);

        if (result.skipped) {
          skipCount++;
          this.stats.publishSkipCount++;
        } else if (result.success) {
          publishCount++;
          this.stats.publishCount++;
          this.log('info', `Published ${url}: score=${assertion.score}`);

          // Delay between successful publishes to avoid rate limiting
          const delayMs = this.config.publishing.minPublishDelayMs ?? 2000;
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        } else {
          this.log('warn', `Publish failed for ${url}: ${result.errors.map(e => e.error).join(', ')}`);

          // Also delay after failed publish to avoid hammering rate-limited relays
          await sleep(1000);
        }

      } catch (err) {
        this.log('warn', `Error processing ${url}: ${err}`);
      }
    }

    this.stats.lastPublishAt = Date.now();
    this.log('info', `Publish cycle complete: ${publishCount} published, ${skipCount} skipped (no material change)`);
  }

  /**
   * Log a message
   */
  private log(level: LogLevel, message: string): void {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex < currentLevelIndex) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    console.log(`${prefix} ${message}`);
  }

  /**
   * Log service statistics
   */
  private logStats(): void {
    const uptimeMs = Date.now() - this.stats.startedAt;
    const uptimeHours = (uptimeMs / 3600000).toFixed(1);

    this.log('info', '--- Service Statistics ---');
    this.log('info', `Uptime: ${uptimeHours} hours`);
    this.log('info', `Relays tracked: ${this.stats.relaysTracked}`);
    this.log('info', `Probes: ${this.stats.probeCount} (${this.stats.probeErrorCount} errors)`);
    this.log('info', `Published: ${this.stats.publishCount} (${this.stats.publishSkipCount} skipped)`);
    this.logMemoryUsage();
  }

  private logMemoryUsage(): void {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const externalMB = Math.round(mem.external / 1024 / 1024);
    const walMB = this.db.getWalFileSizeMB();
    this.log('info', `Memory: heap=${heapMB}MB rss=${rssMB}MB external=${externalMB}MB wal=${walMB}MB`);
  }

  /**
   * Standalone WoT refresh (called from runCycle, doesn't need in-memory cache)
   * Uses parallel lookups with concurrency limit for efficiency
   * Now works with normalized schema where WoT scores are stored per operator pubkey
   */
  private async refreshStaleWotScoresStandalone(): Promise<void> {
    const stalePubkeys = await this.db.getOperatorsNeedingWotRefresh(1); // 1 day max age
    if (stalePubkeys.length === 0) {
      this.log('debug', 'No stale WoT scores to refresh');
      return;
    }

    this.log('info', `Refreshing WoT scores for ${stalePubkeys.length} operators...`);

    let refreshed = 0;
    let failed = 0;
    let done = 0;
    const concurrency = 20;

    // Continuous pool (no fixed-batch head-of-line blocking on a slow NIP-85
    // lookup). Each worker handles its own errors so the pool isn't aborted.
    await runPool(stalePubkeys, concurrency, async (pubkey) => {
      try {
        const trustScore = await getTrustScore(pubkey, { timeout: 10000 });
        if (trustScore) {
          await this.db.storeOperatorWot(
            pubkey,
            trustScore.score,
            trustScore.confidence,
            trustScore.providers.length
          );
        } else {
          // Store with null score but updated timestamp to avoid re-fetching
          await this.db.storeOperatorWot(pubkey, 0, null, 0);
        }
        refreshed++;
      } catch {
        failed++;
      }
      done++;
      if (done % 100 === 0 && done < stalePubkeys.length) {
        this.log('info', `WoT refresh progress: ${done}/${stalePubkeys.length}`);
      }
    }, () => !this.running);

    this.log('info', `WoT refresh complete: ${refreshed} updated, ${failed} failed`);
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
