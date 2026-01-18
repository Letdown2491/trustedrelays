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
import { classifyPolicy } from './policy-classifier.js';
import { resolveJurisdiction } from './jurisdiction.js';
import { MonitorIngestor, discoverMonitors } from './ingestor.js';
import { ReportIngestor, queryRelayReports } from './report-ingestor.js';
import { AssertionPublisher, formatPublishResult } from './assertion-publisher.js';
import { normalizePrivateKey } from './key-utils.js';
import { startApiServer } from './api.js';
import { RelayPool } from './relay-pool.js';

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
export class RelayTrustService {
  private config: ServiceConfig;
  private db: DataStore;
  private publisher: AssertionPublisher | null = null;
  private publishPool: RelayPool | null = null;
  private monitorIngestor: MonitorIngestor | null = null;
  private reportIngestor: ReportIngestor | null = null;
  private apiServer: { stop: () => void } | null = null;

  private running = false;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private lastCleanupAt: number = 0;

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
    this.log('info', `Target relays: ${this.config.targets.relays.length}`);
    this.log('info', `Publish relays: ${this.config.publishing.relays.join(', ')}`);

    // Start API server early so dashboard is available during startup
    if (this.config.api?.enabled) {
      this.apiServer = startApiServer({
        port: this.config.api.port,
        host: this.config.api.host,
        db: this.db,
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

    // Set up periodic cycle (probe → publish)
    this.cycleTimer = setInterval(
      () => this.runCycle(),
      this.config.intervals.cycle * 1000
    );

    this.log('info', `Service started. Cycle interval: ${this.config.intervals.cycle}s (probe → publish)`);
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

    // Clear timer
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
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
    const allMonitors: string[] = [];

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
          if (!allMonitors.includes(m.pubkey)) {
            allMonitors.push(m.pubkey);
            this.log('debug', `Discovered monitor ${m.pubkey.slice(0, 8)}... from ${relay}`);
          }
        }
        if (monitors.length > 0) {
          this.log('info', `Discovered ${monitors.length} monitors from ${relay}`);
        }
      } catch (err) {
        this.log('warn', `Failed to discover monitors from ${relay}: ${err}`);
      }
    }

    // Add discovered monitors to trusted list
    for (const pubkey of allMonitors) {
      await this.db.addTrustedMonitor(pubkey);
    }

    const totalMonitors = await this.db.getTrustedMonitors();
    this.log('info', `Total trusted monitors: ${totalMonitors.length} (${allMonitors.length} newly discovered)`);
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
   * Run a complete cycle: probe all relays, then publish assertions
   */
  private async runCycle(): Promise<void> {
    this.log('info', 'Starting cycle: probe → publish');

    // Probe all relays
    this.log('info', 'Probing relays...');
    await this.probeAllRelays();

    // Publish assertions for relays with material changes
    this.log('info', 'Publishing assertions...');
    await this.publishAllAssertions();

    // Run database cleanup once per day
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - this.lastCleanupAt > oneDayMs) {
      await this.cleanupOldData();
    }

    this.log('info', 'Cycle complete');
  }

  /**
   * Clean up old data from the database
   */
  private async cleanupOldData(): Promise<void> {
    const retentionDays = this.config.database.retentionDays;
    this.log('info', `Cleaning up data older than ${retentionDays} days...`);

    try {
      const result = await this.db.cleanupOldData(retentionDays);
      const total = result.probes + result.nip66Metrics + result.reports + result.scoreHistory;

      if (total > 0) {
        this.log('info', `Cleaned up ${total} old records (probes: ${result.probes}, nip66: ${result.nip66Metrics}, reports: ${result.reports}, history: ${result.scoreHistory})`);
      } else {
        this.log('debug', 'No old data to clean up');
      }

      this.lastCleanupAt = Date.now();
    } catch (err) {
      this.log('warn', `Database cleanup failed: ${err}`);
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

          // Resolve and store operator if NIP-11 has pubkey
          if (probe.nip11?.pubkey) {
            try {
              const operatorResolution = await resolveOperator(url, probe.nip11);
              if (operatorResolution.operatorPubkey) {
                await this.db.storeOperatorResolution(operatorResolution);
                this.log('debug', `Resolved operator for ${url}: ${operatorResolution.verificationMethod}`);
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
    };

    // Process in batches with concurrency limit
    for (let i = 0; i < relays.length; i += concurrency) {
      if (!this.running) break;

      const batch = relays.slice(i, i + concurrency);
      await Promise.all(batch.map(processRelay));

      // Progress update every batch
      const progress = Math.round((completed / relays.length) * 100);
      this.log('info', `Probe progress: ${completed}/${relays.length} (${progress}%)`);

      // Small delay between batches
      if (i + concurrency < relays.length) {
        await sleep(200);
      }
    }

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
      allNip66Stats,
      allJurisdictions,
      allOperatorResolutions,
      allReportStats,
    ] = await Promise.all([
      this.db.getAllLatestProbes(),
      this.db.getAllProbeStats(30),
      this.db.getAllNip66Stats(365),
      this.db.getAllJurisdictions(),
      this.db.getAllOperatorResolutions(),
      this.db.getAllReportStats(90),
    ]);

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

        // For reliability scoring, we still need individual probes
        // This could be further optimized with a bulk probe history fetch
        const probes = await this.db.getProbes(url, 30);

        // Use cached operator resolution or resolve fresh
        let operatorResolution = allOperatorResolutions.get(url);
        if (!operatorResolution) {
          operatorResolution = await resolveOperator(url, latestProbe?.nip11, {
            fetchTrustScore: true,
            nip85Timeout: 10000,
          });
          if (operatorResolution.operatorPubkey) {
            await this.db.storeOperatorResolution(operatorResolution);
          }
        }

        // Use pre-fetched jurisdiction or resolve fresh
        let jurisdiction = allJurisdictions.get(url);
        if (!jurisdiction) {
          jurisdiction = await resolveJurisdiction(url);
          await this.db.storeJurisdiction(jurisdiction);
        }

        // Use pre-fetched report stats (we only need aggregates for scoring)
        const reportStats = allReportStats.get(url);
        const reports = reportStats ? await this.db.getReports(url, 90) : [];

        // Compute scores using pre-fetched NIP-66 stats
        const nip66StatsForScoring = nip66Stats ? {
          metricCount: nip66Stats.metricCount,
          monitorCount: nip66Stats.monitorCount,
          avgRttOpen: nip66Stats.avgRttOpen,
          avgRttRead: nip66Stats.avgRttRead,
          avgRttWrite: nip66Stats.avgRttWrite,
          firstSeen: nip66Stats.firstSeen,
          lastSeen: nip66Stats.lastSeen,
        } : null;

        const score = computeCombinedReliabilityScore(probes, nip66StatsForScoring);
        const qualityScore = computeQualityScore(latestProbe?.nip11, url, operatorResolution);
        const accessibilityScore = computeAccessibilityScore(latestProbe?.nip11, jurisdiction?.countryCode);

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
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
