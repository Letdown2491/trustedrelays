import { Database } from 'duckdb-async';
import type { ProbeResult, RelayType, OperatorResolution, VerificationMethod, RelayReport, ReportType, RelayReportStats, RelayAssertion } from './types.js';
import type { JurisdictionInfo } from './jurisdiction.js';
import { normalizeRelayUrl } from './prober.js';

/**
 * Safely parse JSON, returning undefined on error
 * Prevents crashes from corrupted database data
 */
function safeJsonParse<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS probes (
    url VARCHAR NOT NULL,
    timestamp BIGINT NOT NULL,
    reachable BOOLEAN NOT NULL,
    relay_type VARCHAR,
    access_level VARCHAR,
    closed_reason VARCHAR,
    connect_time DOUBLE,
    read_time DOUBLE,
    write_time DOUBLE,
    nip11_fetch_time DOUBLE,
    nip11_json VARCHAR,
    error VARCHAR,
    PRIMARY KEY (url, timestamp)
  );

  CREATE INDEX IF NOT EXISTS idx_probes_url ON probes(url);
  CREATE INDEX IF NOT EXISTS idx_probes_timestamp ON probes(timestamp);

  CREATE TABLE IF NOT EXISTS nip66_metrics (
    event_id VARCHAR PRIMARY KEY,
    relay_url VARCHAR NOT NULL,
    monitor_pubkey VARCHAR NOT NULL,
    timestamp BIGINT NOT NULL,
    rtt_open INTEGER,
    rtt_read INTEGER,
    rtt_write INTEGER,
    network VARCHAR,
    supported_nips VARCHAR,
    geohash VARCHAR
  );

  CREATE INDEX IF NOT EXISTS idx_nip66_relay ON nip66_metrics(relay_url);
  CREATE INDEX IF NOT EXISTS idx_nip66_monitor ON nip66_metrics(monitor_pubkey);
  CREATE INDEX IF NOT EXISTS idx_nip66_timestamp ON nip66_metrics(timestamp);

  CREATE TABLE IF NOT EXISTS trusted_monitors (
    pubkey VARCHAR PRIMARY KEY,
    name VARCHAR,
    added_at BIGINT NOT NULL,
    last_seen BIGINT,
    event_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS operator_mappings (
    relay_url VARCHAR PRIMARY KEY,
    operator_pubkey VARCHAR,
    verification_method VARCHAR,
    verified_at BIGINT NOT NULL,
    confidence INTEGER NOT NULL,
    nip11_pubkey VARCHAR,
    dns_pubkey VARCHAR,
    wellknown_pubkey VARCHAR
  );

  CREATE INDEX IF NOT EXISTS idx_operator_pubkey ON operator_mappings(operator_pubkey);

  CREATE TABLE IF NOT EXISTS relay_reports (
    event_id VARCHAR PRIMARY KEY,
    relay_url VARCHAR NOT NULL,
    reporter_pubkey VARCHAR NOT NULL,
    report_type VARCHAR NOT NULL,
    content TEXT,
    timestamp BIGINT NOT NULL,
    reporter_trust_weight DOUBLE
  );

  CREATE INDEX IF NOT EXISTS idx_reports_relay ON relay_reports(relay_url);
  CREATE INDEX IF NOT EXISTS idx_reports_reporter ON relay_reports(reporter_pubkey);
  CREATE INDEX IF NOT EXISTS idx_reports_type ON relay_reports(report_type);
  CREATE INDEX IF NOT EXISTS idx_reports_timestamp ON relay_reports(timestamp);

  CREATE TABLE IF NOT EXISTS published_assertions (
    relay_url VARCHAR PRIMARY KEY,
    event_id VARCHAR NOT NULL,
    score INTEGER,
    reliability INTEGER,
    quality INTEGER,
    accessibility INTEGER,
    confidence VARCHAR,
    published_at BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_published_at ON published_assertions(published_at);

  CREATE TABLE IF NOT EXISTS score_history (
    relay_url VARCHAR NOT NULL,
    timestamp BIGINT NOT NULL,
    score INTEGER,
    reliability INTEGER,
    quality INTEGER,
    accessibility INTEGER,
    operator_trust INTEGER,
    confidence VARCHAR,
    observations INTEGER,
    PRIMARY KEY (relay_url, timestamp)
  );

  CREATE INDEX IF NOT EXISTS idx_score_history_relay ON score_history(relay_url);
  CREATE INDEX IF NOT EXISTS idx_score_history_timestamp ON score_history(timestamp);

  CREATE TABLE IF NOT EXISTS relay_jurisdictions (
    relay_url VARCHAR PRIMARY KEY,
    ip VARCHAR,
    country_code VARCHAR,
    country_name VARCHAR,
    region VARCHAR,
    city VARCHAR,
    isp VARCHAR,
    asn VARCHAR,
    as_org VARCHAR,
    is_hosting BOOLEAN,
    is_tor BOOLEAN,
    resolved_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requested_relays (
    url VARCHAR PRIMARY KEY,
    requested_at BIGINT NOT NULL,
    requested_by VARCHAR
  );
`;

export class DataStore {
  private db: Database | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;

  constructor(dbPath: string = './data/trustedrelays.db') {
    this.dbPath = dbPath;
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    this.db = await Database.create(this.dbPath);
    // Run migrations first to rename columns in existing tables
    await this.runMigrations();
    // Then create/update schema (IF NOT EXISTS won't affect migrated tables)
    await this.db.exec(SCHEMA);
  }

  /**
   * Run database migrations for schema changes
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    // Migration 1: Rename 'openness' column to 'accessibility'
    // Use table recreation to avoid dependency issues with indexes
    await this.migrateOpennessToAccessibility();

    // Migration 2: Add access_level and closed_reason columns to probes
    await this.migrateProbesAccessLevel();
  }

  /**
   * Add access_level and closed_reason columns to probes table
   */
  private async migrateProbesAccessLevel(): Promise<void> {
    if (!this.db) return;

    // Check if access_level column already exists
    try {
      await this.db.all(`SELECT access_level FROM probes LIMIT 1`);
      // Column exists, no migration needed
    } catch {
      // Column doesn't exist, add it
      try {
        await this.db.exec(`ALTER TABLE probes ADD COLUMN access_level VARCHAR`);
        await this.db.exec(`ALTER TABLE probes ADD COLUMN closed_reason VARCHAR`);
      } catch {
        // Ignore errors if columns already exist
      }
    }
  }

  /**
   * Migrate 'openness' column to 'accessibility' using table recreation
   * This avoids DuckDB's dependency errors from indexes
   */
  private async migrateOpennessToAccessibility(): Promise<void> {
    if (!this.db) return;

    // Check if published_assertions has openness column (indicates old schema)
    try {
      // Try to select from openness - if it works, we need to migrate
      await this.db.all(`SELECT openness FROM published_assertions LIMIT 1`);

      // Old column exists - recreate table with new schema
      await this.db.exec(`
        CREATE TABLE published_assertions_new AS
        SELECT
          relay_url,
          event_id,
          score,
          reliability,
          quality,
          openness AS accessibility,
          confidence,
          published_at
        FROM published_assertions;

        DROP TABLE published_assertions;

        ALTER TABLE published_assertions_new RENAME TO published_assertions;

        CREATE INDEX IF NOT EXISTS idx_published_at ON published_assertions(published_at);
      `);
    } catch {
      // Column doesn't exist or table doesn't exist - no migration needed
    }

    // Same for score_history
    try {
      await this.db.all(`SELECT openness FROM score_history LIMIT 1`);

      await this.db.exec(`
        CREATE TABLE score_history_new AS
        SELECT
          relay_url,
          timestamp,
          score,
          reliability,
          quality,
          openness AS accessibility,
          operator_trust,
          confidence,
          observations
        FROM score_history;

        DROP TABLE score_history;

        ALTER TABLE score_history_new RENAME TO score_history;

        CREATE INDEX IF NOT EXISTS idx_score_history_relay ON score_history(relay_url);
        CREATE INDEX IF NOT EXISTS idx_score_history_timestamp ON score_history(timestamp);
      `);
    } catch {
      // Column doesn't exist or table doesn't exist - no migration needed
    }

    // Add WoT fields to operator_mappings if they don't exist
    try {
      await this.db.all(`SELECT wot_score FROM operator_mappings LIMIT 1`);
      // Column exists, no migration needed
    } catch {
      // Columns don't exist, add them
      try {
        await this.db.exec(`ALTER TABLE operator_mappings ADD COLUMN wot_score INTEGER`);
        await this.db.exec(`ALTER TABLE operator_mappings ADD COLUMN wot_confidence VARCHAR`);
        await this.db.exec(`ALTER TABLE operator_mappings ADD COLUMN wot_provider_count INTEGER`);
        await this.db.exec(`ALTER TABLE operator_mappings ADD COLUMN wot_updated_at BIGINT`);
      } catch {
        // Ignore errors if columns already exist
      }
    }
  }

  private async ensureReady(): Promise<Database> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  // ============================================================================
  // PROBE METHODS - Direct relay probing results
  // ============================================================================

  /**
   * Store a probe result
   */
  async storeProbe(probe: ProbeResult): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO probes
       (url, timestamp, reachable, relay_type, access_level, closed_reason, connect_time, read_time, write_time, nip11_fetch_time, nip11_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      probe.url,
      probe.timestamp,
      probe.reachable,
      probe.relayType,
      probe.accessLevel ?? null,
      probe.closedReason ?? null,
      probe.connectTime ?? null,
      probe.readTime ?? null,
      probe.writeTime ?? null,
      probe.nip11FetchTime ?? null,
      probe.nip11 ? JSON.stringify(probe.nip11) : null,
      probe.error ?? null
    );
  }

  /**
   * Get all probes for a relay within a time range
   */
  async getProbes(url: string, sinceDays: number = 30): Promise<ProbeResult[]> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM probes WHERE url = ? AND timestamp >= ? ORDER BY timestamp ASC`,
      url,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      url: row.url,
      timestamp: Number(row.timestamp),
      reachable: row.reachable,
      relayType: row.relay_type as RelayType,
      accessLevel: row.access_level ?? undefined,
      closedReason: row.closed_reason ?? undefined,
      connectTime: row.connect_time ?? undefined,
      readTime: row.read_time ?? undefined,
      writeTime: row.write_time ?? undefined,
      nip11FetchTime: row.nip11_fetch_time ?? undefined,
      nip11: safeJsonParse(row.nip11_json),
      error: row.error ?? undefined,
    }));
  }

  /**
   * Get the latest probe for a relay
   */
  async getLatestProbe(url: string): Promise<ProbeResult | null> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT * FROM probes WHERE url = ? ORDER BY timestamp DESC LIMIT 1`,
      url
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    return {
      url: row.url,
      timestamp: Number(row.timestamp),
      reachable: row.reachable,
      relayType: row.relay_type as RelayType,
      accessLevel: row.access_level ?? undefined,
      closedReason: row.closed_reason ?? undefined,
      connectTime: row.connect_time ?? undefined,
      readTime: row.read_time ?? undefined,
      writeTime: row.write_time ?? undefined,
      nip11FetchTime: row.nip11_fetch_time ?? undefined,
      nip11: safeJsonParse(row.nip11_json),
      error: row.error ?? undefined,
    };
  }

  /**
   * Get all known relay URLs
   */
  async getRelayUrls(): Promise<string[]> {
    const db = await this.ensureReady();
    // Order by probe count DESC - relays we've probed more are established/prioritized
    const rows = await db.all(
      `SELECT url, COUNT(*) as probe_count
       FROM probes
       GROUP BY url
       ORDER BY probe_count DESC`
    );
    return rows.map((row: any) => row.url);
  }

  /**
   * Get probe count for a relay
   */
  async getProbeCount(url: string, sinceDays: number = 30): Promise<number> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT COUNT(*) as count FROM probes WHERE url = ? AND timestamp >= ?`,
      url,
      sinceTimestamp
    );

    return Number((rows[0] as any)?.count ?? 0);
  }

  /**
   * Get summary stats for a relay
   */
  async getRelayStats(url: string, sinceDays: number = 30): Promise<{
    probeCount: number;
    successCount: number;
    avgConnectTime: number | null;
    avgReadTime: number | null;
    firstSeen: number | null;
    lastSeen: number | null;
  }> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT
        COUNT(*) as probe_count,
        SUM(CASE WHEN reachable THEN 1 ELSE 0 END) as success_count,
        AVG(CASE WHEN reachable THEN connect_time END) as avg_connect_time,
        AVG(CASE WHEN reachable THEN read_time END) as avg_read_time,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM probes
      WHERE url = ? AND timestamp >= ?`,
      url,
      sinceTimestamp
    );

    const row = (rows[0] as any) || {};
    return {
      probeCount: Number(row.probe_count ?? 0),
      successCount: Number(row.success_count ?? 0),
      avgConnectTime: row.avg_connect_time ?? null,
      avgReadTime: row.avg_read_time ?? null,
      firstSeen: row.first_seen ? Number(row.first_seen) : null,
      lastSeen: row.last_seen ? Number(row.last_seen) : null,
    };
  }

  // ============================================================================
  // NIP-66 METHODS - External monitor data from nostr.watch
  // ============================================================================

  /**
   * Store a NIP-66 metric event
   */
  async storeNip66Metric(metric: {
    eventId: string;
    relayUrl: string;
    monitorPubkey: string;
    timestamp: number;
    rttOpen?: number;
    rttRead?: number;
    rttWrite?: number;
    network?: string;
    supportedNips?: number[];
    geohash?: string;
  }): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO nip66_metrics
       (event_id, relay_url, monitor_pubkey, timestamp, rtt_open, rtt_read, rtt_write, network, supported_nips, geohash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         relay_url = excluded.relay_url,
         monitor_pubkey = excluded.monitor_pubkey,
         timestamp = excluded.timestamp,
         rtt_open = excluded.rtt_open,
         rtt_read = excluded.rtt_read,
         rtt_write = excluded.rtt_write,
         network = excluded.network,
         supported_nips = excluded.supported_nips,
         geohash = excluded.geohash`,
      metric.eventId,
      metric.relayUrl,
      metric.monitorPubkey,
      metric.timestamp,
      metric.rttOpen ?? null,
      metric.rttRead ?? null,
      metric.rttWrite ?? null,
      metric.network ?? null,
      metric.supportedNips ? JSON.stringify(metric.supportedNips) : null,
      metric.geohash ?? null
    );
  }

  /**
   * Get NIP-66 metrics for a relay
   */
  async getNip66Metrics(relayUrl: string, sinceDays: number = 30): Promise<Array<{
    eventId: string;
    relayUrl: string;
    monitorPubkey: string;
    timestamp: number;
    rttOpen?: number;
    rttRead?: number;
    rttWrite?: number;
    network?: string;
    supportedNips?: number[];
    geohash?: string;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM nip66_metrics WHERE relay_url = ? AND timestamp >= ? ORDER BY timestamp DESC`,
      relayUrl,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      eventId: row.event_id,
      relayUrl: row.relay_url,
      monitorPubkey: row.monitor_pubkey,
      timestamp: Number(row.timestamp),
      rttOpen: row.rtt_open ?? undefined,
      rttRead: row.rtt_read ?? undefined,
      rttWrite: row.rtt_write ?? undefined,
      network: row.network ?? undefined,
      supportedNips: safeJsonParse<number[]>(row.supported_nips),
      geohash: row.geohash ?? undefined,
    }));
  }

  /**
   * Get aggregated NIP-66 stats for a relay with percentile-based scoring.
   *
   * Percentile scoring removes geographic bias by ranking each relay relative
   * to other relays from each monitor's perspective, then averaging across monitors.
   * Only monitors tracking ≥20 relays contribute to percentile scores.
   */
  async getNip66Stats(relayUrl: string, sinceDays: number = 30): Promise<{
    metricCount: number;
    monitorCount: number;
    avgRttOpen: number | null;
    avgRttRead: number | null;
    avgRttWrite: number | null;
    latencyScore: number | null;
    connectPercentile: number | null;
    readPercentile: number | null;
    qualifyingMonitorCount: number;
    firstSeen: number | null;
    lastSeen: number | null;
  }> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    // Basic aggregation for raw metrics
    const basicRows = await db.all(
      `SELECT
        COUNT(*) as metric_count,
        COUNT(DISTINCT monitor_pubkey) as monitor_count,
        AVG(rtt_open) as avg_rtt_open,
        AVG(rtt_read) as avg_rtt_read,
        AVG(rtt_write) as avg_rtt_write,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM nip66_metrics
      WHERE relay_url = ? AND timestamp >= ?`,
      relayUrl,
      sinceTimestamp
    );

    const basicRow = (basicRows[0] as any) || {};

    // Percentile calculation using latest metrics only
    // Uses ROW_NUMBER to get most recent metric per monitor per relay
    const percentileRows = await db.all(
      `WITH latest_metrics AS (
        -- Get most recent metric from each monitor for each relay
        SELECT
          monitor_pubkey,
          relay_url,
          rtt_open,
          rtt_read,
          ROW_NUMBER() OVER (
            PARTITION BY monitor_pubkey, relay_url
            ORDER BY timestamp DESC
          ) as rn
        FROM nip66_metrics
        WHERE timestamp >= ?
      ),
      latest_only AS (
        SELECT monitor_pubkey, relay_url, rtt_open, rtt_read
        FROM latest_metrics
        WHERE rn = 1
      ),
      qualifying_monitors AS (
        -- Only monitors tracking ≥20 relays
        SELECT monitor_pubkey
        FROM latest_only
        GROUP BY monitor_pubkey
        HAVING COUNT(DISTINCT relay_url) >= 20
      ),
      monitor_percentiles AS (
        -- For each qualifying monitor, calculate percentile for target relay
        SELECT
          target.monitor_pubkey,
          target.rtt_open as target_rtt_open,
          target.rtt_read as target_rtt_read,
          -- Count relays with HIGHER rtt (slower) as percentage
          (SUM(CASE WHEN other.rtt_open > target.rtt_open THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) as connect_pct,
          (SUM(CASE WHEN other.rtt_read > target.rtt_read THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) as read_pct
        FROM latest_only target
        JOIN latest_only other ON other.monitor_pubkey = target.monitor_pubkey
        WHERE target.relay_url = ?
          AND target.monitor_pubkey IN (SELECT monitor_pubkey FROM qualifying_monitors)
          AND target.rtt_open IS NOT NULL
          AND other.rtt_open IS NOT NULL
        GROUP BY target.monitor_pubkey, target.rtt_open, target.rtt_read
      )
      SELECT
        AVG(connect_pct) as connect_percentile,
        AVG(read_pct) as read_percentile,
        AVG(connect_pct * 0.3 + read_pct * 0.7) as latency_score,
        COUNT(*) as qualifying_monitor_count
      FROM monitor_percentiles`,
      sinceTimestamp,
      relayUrl
    );

    const percentileRow = (percentileRows[0] as any) || {};

    return {
      metricCount: Number(basicRow.metric_count ?? 0),
      monitorCount: Number(basicRow.monitor_count ?? 0),
      avgRttOpen: basicRow.avg_rtt_open ?? null,
      avgRttRead: basicRow.avg_rtt_read ?? null,
      avgRttWrite: basicRow.avg_rtt_write ?? null,
      latencyScore: percentileRow.latency_score != null ? Math.round(percentileRow.latency_score) : null,
      connectPercentile: percentileRow.connect_percentile != null ? Math.round(percentileRow.connect_percentile) : null,
      readPercentile: percentileRow.read_percentile != null ? Math.round(percentileRow.read_percentile) : null,
      qualifyingMonitorCount: Number(percentileRow.qualifying_monitor_count ?? 0),
      firstSeen: basicRow.first_seen ? Number(basicRow.first_seen) : null,
      lastSeen: basicRow.last_seen ? Number(basicRow.last_seen) : null,
    };
  }

  /**
   * Get all relay URLs from NIP-66 metrics, prioritized by observation count
   * Relays with more observations (from more monitors) are returned first
   * @param minMonitors - Only return relays seen by at least this many monitors (default: 1)
   * @param limit - Maximum number of relays to return (optional)
   */
  async getNip66RelayUrls(minMonitors: number = 1, limit?: number): Promise<string[]> {
    const db = await this.ensureReady();
    // Order by monitor count DESC - relays tracked by more monitors are prioritized
    // This naturally surfaces widely-used relays without hardcoding lists
    const query = limit
      ? `SELECT relay_url, COUNT(*) as obs_count, COUNT(DISTINCT monitor_pubkey) as monitor_count
         FROM nip66_metrics
         GROUP BY relay_url
         HAVING monitor_count >= ?
         ORDER BY monitor_count DESC, obs_count DESC
         LIMIT ?`
      : `SELECT relay_url, COUNT(*) as obs_count, COUNT(DISTINCT monitor_pubkey) as monitor_count
         FROM nip66_metrics
         GROUP BY relay_url
         HAVING monitor_count >= ?
         ORDER BY monitor_count DESC, obs_count DESC`;

    const rows = limit
      ? await db.all(query, minMonitors, limit)
      : await db.all(query, minMonitors);
    return rows.map((row: any) => row.relay_url);
  }

  /**
   * Get relay URLs with their monitor counts
   */
  async getNip66RelayUrlsWithCounts(minMonitors: number = 1): Promise<Array<{ url: string; monitorCount: number }>> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT relay_url, COUNT(DISTINCT monitor_pubkey) as monitor_count
       FROM nip66_metrics
       GROUP BY relay_url
       HAVING monitor_count >= ?
       ORDER BY monitor_count DESC`,
      minMonitors
    );
    return rows.map((row: any) => ({ url: row.relay_url, monitorCount: Number(row.monitor_count) }));
  }

  // ============================================================================
  // REQUESTED RELAYS - User-submitted relays for tracking
  // ============================================================================

  /**
   * Add a relay to the requested/tracked list
   */
  async addRequestedRelay(url: string, requestedBy?: string): Promise<void> {
    const db = await this.ensureReady();
    const normalized = normalizeRelayUrl(url);
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO requested_relays (url, requested_at, requested_by)
       VALUES (?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET
         requested_at = excluded.requested_at,
         requested_by = excluded.requested_by`,
      normalized,
      now,
      requestedBy ?? null
    );
  }

  /**
   * Get all requested relay URLs
   */
  async getRequestedRelays(): Promise<string[]> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT url FROM requested_relays ORDER BY requested_at DESC`);
    return rows.map((row: any) => row.url);
  }

  /**
   * Check if a relay is in the requested list
   */
  async isRequestedRelay(url: string): Promise<boolean> {
    const db = await this.ensureReady();
    const normalized = normalizeRelayUrl(url);
    const rows = await db.all(`SELECT url FROM requested_relays WHERE url = ?`, normalized);
    return rows.length > 0;
  }

  /**
   * Remove a relay from the requested list
   */
  async removeRequestedRelay(url: string): Promise<void> {
    const db = await this.ensureReady();
    const normalized = normalizeRelayUrl(url);
    await db.run(`DELETE FROM requested_relays WHERE url = ?`, normalized);
  }

  /**
   * Get relays that have been unreachable for at least N days
   * Only considers relays that have at least `minProbes` recent probes
   */
  async getRelaysUnreachableFor(days: number, minProbes: number = 3): Promise<string[]> {
    const db = await this.ensureReady();
    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);

    // Find relays where ALL probes in the last N days are unreachable
    const rows = await db.all(
      `SELECT url
       FROM probes
       WHERE timestamp > ?
       GROUP BY url
       HAVING COUNT(*) >= ? AND SUM(CASE WHEN reachable THEN 1 ELSE 0 END) = 0`,
      cutoff,
      minProbes
    );
    return rows.map((row: any) => row.url);
  }

  // ============================================================================
  // MONITOR METHODS - Trusted NIP-66 monitor management
  // ============================================================================

  /**
   * Add or update a trusted monitor
   */
  async addTrustedMonitor(pubkey: string, name?: string): Promise<void> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO trusted_monitors (pubkey, name, added_at, last_seen, event_count)
       VALUES (?, ?, ?, NULL, 0)
       ON CONFLICT (pubkey) DO NOTHING`,
      pubkey,
      name ?? null,
      now
    );
  }

  /**
   * Get all trusted monitors
   */
  async getTrustedMonitors(): Promise<Array<{
    pubkey: string;
    name?: string;
    addedAt: number;
    lastSeen?: number;
    eventCount: number;
  }>> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT * FROM trusted_monitors ORDER BY added_at`);
    return rows.map((row: any) => ({
      pubkey: row.pubkey,
      name: row.name ?? undefined,
      addedAt: Number(row.added_at),
      lastSeen: row.last_seen ? Number(row.last_seen) : undefined,
      eventCount: Number(row.event_count ?? 0),
    }));
  }

  /**
   * Update monitor stats after receiving an event
   */
  async updateMonitorStats(pubkey: string): Promise<void> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `UPDATE trusted_monitors SET last_seen = ?, event_count = event_count + 1 WHERE pubkey = ?`,
      now,
      pubkey
    );
  }

  /**
   * Check if a pubkey is a trusted monitor
   */
  async isTrustedMonitor(pubkey: string): Promise<boolean> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT COUNT(*) as count FROM trusted_monitors WHERE pubkey = ?`,
      pubkey
    );
    return Number((rows[0] as any)?.count ?? 0) > 0;
  }

  // ============================================================================
  // OPERATOR METHODS - Relay operator identity and verification
  // ============================================================================

  /**
   * Store an operator resolution
   */
  async storeOperatorResolution(resolution: OperatorResolution): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO operator_mappings
       (relay_url, operator_pubkey, verification_method, verified_at, confidence, nip11_pubkey, dns_pubkey, wellknown_pubkey, wot_score, wot_confidence, wot_provider_count, wot_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (relay_url) DO UPDATE SET
         operator_pubkey = excluded.operator_pubkey,
         verification_method = excluded.verification_method,
         verified_at = excluded.verified_at,
         confidence = excluded.confidence,
         nip11_pubkey = excluded.nip11_pubkey,
         dns_pubkey = excluded.dns_pubkey,
         wellknown_pubkey = excluded.wellknown_pubkey,
         wot_score = excluded.wot_score,
         wot_confidence = excluded.wot_confidence,
         wot_provider_count = excluded.wot_provider_count,
         wot_updated_at = excluded.wot_updated_at`,
      resolution.relayUrl,
      resolution.operatorPubkey,
      resolution.verificationMethod,
      resolution.verifiedAt,
      resolution.confidence,
      resolution.nip11Pubkey ?? null,
      resolution.dnsPubkey ?? null,
      resolution.wellknownPubkey ?? null,
      resolution.trustScore ?? null,
      resolution.trustConfidence ?? null,
      resolution.trustProviderCount ?? null,
      resolution.trustScore != null ? Math.floor(Date.now() / 1000) : null
    );
  }

  /**
   * Get cached operator resolution for a relay
   */
  async getOperatorResolution(relayUrl: string): Promise<OperatorResolution | null> {
    const db = await this.ensureReady();
    const normalizedUrl = normalizeRelayUrl(relayUrl);
    const rows = await db.all(
      `SELECT * FROM operator_mappings WHERE relay_url = ?`,
      normalizedUrl
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    const resolution: OperatorResolution = {
      relayUrl: row.relay_url,
      operatorPubkey: row.operator_pubkey,
      verificationMethod: row.verification_method as VerificationMethod | null,
      verifiedAt: Number(row.verified_at),
      confidence: Number(row.confidence),
      nip11Pubkey: row.nip11_pubkey ?? undefined,
      dnsPubkey: row.dns_pubkey ?? undefined,
      wellknownPubkey: row.wellknown_pubkey ?? undefined,
    };

    // Add WoT fields if present
    if (row.wot_score != null) {
      resolution.trustScore = Number(row.wot_score);
      resolution.trustConfidence = row.wot_confidence as 'low' | 'medium' | 'high';
      resolution.trustProviderCount = Number(row.wot_provider_count);
    }

    return resolution;
  }

  /**
   * Get operator resolutions that need WoT score refresh
   * Returns operators with pubkey where wot_updated_at is null or older than maxAgeDays
   */
  async getOperatorsNeedingWotRefresh(maxAgeDays: number = 1): Promise<OperatorResolution[]> {
    const db = await this.ensureReady();
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);

    const rows = await db.all(
      `SELECT * FROM operator_mappings
       WHERE operator_pubkey IS NOT NULL
       AND (wot_updated_at IS NULL OR wot_updated_at < ?)`,
      cutoff
    );

    return rows.map((row: any) => ({
      relayUrl: row.relay_url,
      operatorPubkey: row.operator_pubkey,
      verificationMethod: row.verification_method as VerificationMethod | null,
      verifiedAt: Number(row.verified_at),
      confidence: Number(row.confidence),
      nip11Pubkey: row.nip11_pubkey ?? undefined,
      dnsPubkey: row.dns_pubkey ?? undefined,
      wellknownPubkey: row.wellknown_pubkey ?? undefined,
      trustScore: row.wot_score != null ? Number(row.wot_score) : undefined,
      trustConfidence: row.wot_confidence as 'low' | 'medium' | 'high' | undefined,
      trustProviderCount: row.wot_provider_count != null ? Number(row.wot_provider_count) : undefined,
    }));
  }

  /**
   * Get all relays operated by a specific pubkey
   */
  async getRelaysByOperator(operatorPubkey: string): Promise<string[]> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT relay_url FROM operator_mappings WHERE operator_pubkey = ?`,
      operatorPubkey
    );
    return rows.map((row: any) => row.relay_url);
  }

  // ============================================================================
  // REPORT METHODS - User-submitted relay reports (NIP-32)
  // ============================================================================

  /**
   * Store a relay report
   */
  async storeReport(report: RelayReport): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO relay_reports
       (event_id, relay_url, reporter_pubkey, report_type, content, timestamp, reporter_trust_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         relay_url = excluded.relay_url,
         reporter_pubkey = excluded.reporter_pubkey,
         report_type = excluded.report_type,
         content = excluded.content,
         timestamp = excluded.timestamp,
         reporter_trust_weight = excluded.reporter_trust_weight`,
      report.eventId,
      report.relayUrl,
      report.reporterPubkey,
      report.reportType,
      report.content,
      report.timestamp,
      report.reporterTrustWeight ?? null
    );
  }

  /**
   * Get reports for a relay
   */
  async getReports(relayUrl: string, sinceDays: number = 90): Promise<RelayReport[]> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM relay_reports WHERE relay_url = ? AND timestamp >= ? ORDER BY timestamp DESC`,
      relayUrl,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      eventId: row.event_id,
      relayUrl: row.relay_url,
      reporterPubkey: row.reporter_pubkey,
      reportType: row.report_type as ReportType,
      content: row.content ?? '',
      timestamp: Number(row.timestamp),
      reporterTrustWeight: row.reporter_trust_weight ?? undefined,
    }));
  }

  /**
   * Get reports by type for a relay
   */
  async getReportsByType(relayUrl: string, reportType: ReportType, sinceDays: number = 90): Promise<RelayReport[]> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM relay_reports WHERE relay_url = ? AND report_type = ? AND timestamp >= ? ORDER BY timestamp DESC`,
      relayUrl,
      reportType,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      eventId: row.event_id,
      relayUrl: row.relay_url,
      reporterPubkey: row.reporter_pubkey,
      reportType: row.report_type as ReportType,
      content: row.content ?? '',
      timestamp: Number(row.timestamp),
      reporterTrustWeight: row.reporter_trust_weight ?? undefined,
    }));
  }

  /**
   * Get aggregated report stats for a relay
   */
  async getReportStats(relayUrl: string, sinceDays: number = 90): Promise<RelayReportStats> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    // Get overall stats
    const overallRows = await db.all(
      `SELECT
        COUNT(*) as report_count,
        SUM(COALESCE(reporter_trust_weight, 1)) as weighted_count,
        COUNT(DISTINCT reporter_pubkey) as reporter_count,
        MIN(timestamp) as first_report,
        MAX(timestamp) as last_report
      FROM relay_reports
      WHERE relay_url = ? AND timestamp >= ?`,
      relayUrl,
      sinceTimestamp
    );

    // Get stats by type
    const typeRows = await db.all(
      `SELECT
        report_type,
        COUNT(*) as count,
        SUM(COALESCE(reporter_trust_weight, 1)) as weighted_count
      FROM relay_reports
      WHERE relay_url = ? AND timestamp >= ?
      GROUP BY report_type`,
      relayUrl,
      sinceTimestamp
    );

    const overall = (overallRows[0] as any) || {};

    const byType: Record<ReportType, { count: number; weightedCount: number }> = {
      spam: { count: 0, weightedCount: 0 },
      censorship: { count: 0, weightedCount: 0 },
      unreliable: { count: 0, weightedCount: 0 },
      malicious: { count: 0, weightedCount: 0 },
    };

    for (const row of typeRows as any[]) {
      const type = row.report_type as ReportType;
      if (type in byType) {
        byType[type] = {
          count: Number(row.count ?? 0),
          weightedCount: Number(row.weighted_count ?? 0),
        };
      }
    }

    return {
      relayUrl,
      reportCount: Number(overall.report_count ?? 0),
      weightedReportCount: Number(overall.weighted_count ?? 0),
      reporterCount: Number(overall.reporter_count ?? 0),
      byType,
      firstReport: overall.first_report ? Number(overall.first_report) : null,
      lastReport: overall.last_report ? Number(overall.last_report) : null,
    };
  }

  /**
   * Update reporter trust weight for a report
   */
  async updateReportTrustWeight(eventId: string, trustWeight: number): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `UPDATE relay_reports SET reporter_trust_weight = ? WHERE event_id = ?`,
      trustWeight,
      eventId
    );
  }

  /**
   * Check if a report already exists
   */
  async reportExists(eventId: string): Promise<boolean> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT COUNT(*) as count FROM relay_reports WHERE event_id = ?`,
      eventId
    );
    return Number((rows[0] as any)?.count ?? 0) > 0;
  }

  /**
   * Get all relay URLs that have reports
   */
  async getReportedRelayUrls(): Promise<string[]> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT DISTINCT relay_url FROM relay_reports ORDER BY relay_url`);
    return rows.map((row: any) => row.relay_url);
  }

  /**
   * Count reports per reporter per day (for rate limiting)
   */
  async getReporterDailyCount(reporterPubkey: string, relayUrl: string): Promise<number> {
    const db = await this.ensureReady();
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;

    const rows = await db.all(
      `SELECT COUNT(*) as count FROM relay_reports
       WHERE reporter_pubkey = ? AND relay_url = ? AND timestamp >= ?`,
      reporterPubkey,
      relayUrl,
      dayAgo
    );

    return Number((rows[0] as any)?.count ?? 0);
  }

  // ============================================================================
  // PUBLISHED ASSERTION METHODS - Kind 30385 event tracking
  // ============================================================================

  /**
   * Store a published assertion record
   */
  async storePublishedAssertion(record: {
    relayUrl: string;
    eventId: string;
    score?: number;
    reliability?: number;
    quality?: number;
    accessibility?: number;
    confidence: string;
    publishedAt: number;
  }): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO published_assertions
       (relay_url, event_id, score, reliability, quality, accessibility, confidence, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (relay_url) DO UPDATE SET
         event_id = excluded.event_id,
         score = excluded.score,
         reliability = excluded.reliability,
         quality = excluded.quality,
         accessibility = excluded.accessibility,
         confidence = excluded.confidence,
         published_at = excluded.published_at`,
      record.relayUrl,
      record.eventId,
      record.score ?? null,
      record.reliability ?? null,
      record.quality ?? null,
      record.accessibility ?? null,
      record.confidence,
      record.publishedAt
    );
  }

  /**
   * Get the last published assertion for a relay
   */
  async getLastPublishedAssertion(relayUrl: string): Promise<{
    relayUrl: string;
    eventId: string;
    score?: number;
    reliability?: number;
    quality?: number;
    accessibility?: number;
    confidence: string;
    publishedAt: number;
  } | null> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT * FROM published_assertions WHERE relay_url = ?`,
      relayUrl
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    return {
      relayUrl: row.relay_url,
      eventId: row.event_id,
      score: row.score ?? undefined,
      reliability: row.reliability ?? undefined,
      quality: row.quality ?? undefined,
      accessibility: row.accessibility ?? undefined,
      confidence: row.confidence,
      publishedAt: Number(row.published_at),
    };
  }

  /**
   * Get all published assertions
   */
  async getAllPublishedAssertions(): Promise<Array<{
    relayUrl: string;
    eventId: string;
    score?: number;
    confidence: string;
    publishedAt: number;
  }>> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT relay_url, event_id, score, confidence, published_at
       FROM published_assertions ORDER BY published_at DESC`
    );

    return rows.map((row: any) => ({
      relayUrl: row.relay_url,
      eventId: row.event_id,
      score: row.score ?? undefined,
      confidence: row.confidence,
      publishedAt: Number(row.published_at),
    }));
  }

  /**
   * Delete a published assertion record
   */
  async deletePublishedAssertion(relayUrl: string): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `DELETE FROM published_assertions WHERE relay_url = ?`,
      relayUrl
    );
  }

  // ============================================================================
  // SCORE HISTORY METHODS - Historical score snapshots and trends
  // ============================================================================

  /**
   * Store a score snapshot in history
   */
  async storeScoreSnapshot(assertion: RelayAssertion): Promise<void> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);

    await db.run(
      `INSERT INTO score_history
       (relay_url, timestamp, score, reliability, quality, accessibility, operator_trust, confidence, observations)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assertion.relayUrl,
      now,
      assertion.score ?? null,
      assertion.reliability ?? null,
      assertion.quality ?? null,
      assertion.accessibility ?? null,
      assertion.operatorTrust ?? null,
      assertion.confidence,
      assertion.observations
    );
  }

  /**
   * Get score history for a relay
   */
  async getScoreHistory(relayUrl: string, sinceDays: number = 90): Promise<Array<{
    timestamp: number;
    score?: number;
    reliability?: number;
    quality?: number;
    accessibility?: number;
    operatorTrust?: number;
    confidence: string;
    observations: number;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM score_history
       WHERE relay_url = ? AND timestamp >= ?
       ORDER BY timestamp ASC`,
      relayUrl,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      timestamp: Number(row.timestamp),
      score: row.score ?? undefined,
      reliability: row.reliability ?? undefined,
      quality: row.quality ?? undefined,
      accessibility: row.accessibility ?? undefined,
      operatorTrust: row.operator_trust ?? undefined,
      confidence: row.confidence,
      observations: Number(row.observations ?? 0),
    }));
  }

  /**
   * Get score trend (change over time)
   */
  async getScoreTrend(relayUrl: string, preferredPeriodDays: number = 30): Promise<{
    currentScore?: number;
    previousScore?: number;
    change?: number;
    periodDays?: number;
    trend: 'improving' | 'declining' | 'stable' | 'unknown';
  }> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    const preferredStart = now - (preferredPeriodDays * 86400);
    const minPeriodDays = 3;

    // Get most recent score with timestamp
    const recentRows = await db.all(
      `SELECT score, timestamp FROM score_history
       WHERE relay_url = ?
       ORDER BY timestamp DESC LIMIT 1`,
      relayUrl
    );

    // Get oldest score within preferred period, or absolute oldest if no data before period
    const oldRows = await db.all(
      `SELECT score, timestamp FROM score_history
       WHERE relay_url = ? AND timestamp < ?
       ORDER BY timestamp DESC LIMIT 1`,
      relayUrl,
      preferredStart
    );

    // If no old data before preferred period, get the absolute oldest
    let oldestRow = oldRows.length > 0 ? oldRows[0] as any : null;
    if (!oldestRow) {
      const absoluteOldest = await db.all(
        `SELECT score, timestamp FROM score_history
         WHERE relay_url = ?
         ORDER BY timestamp ASC LIMIT 1`,
        relayUrl
      );
      oldestRow = absoluteOldest.length > 0 ? absoluteOldest[0] as any : null;
    }

    const currentScore = recentRows.length > 0 ? (recentRows[0] as any).score : undefined;
    // Convert BigInt to Number if needed
    const currentTs = recentRows.length > 0 ? Number((recentRows[0] as any).timestamp) : undefined;
    const previousScore = oldestRow?.score;
    const previousTs = oldestRow?.timestamp != null ? Number(oldestRow.timestamp) : undefined;

    if (currentScore === undefined || previousScore === undefined || currentTs === previousTs) {
      return { currentScore, previousScore, trend: 'unknown' };
    }

    // Calculate actual span in days
    const spanDays = Math.round((currentTs! - previousTs!) / 86400);
    if (spanDays < minPeriodDays) {
      return { currentScore, previousScore, trend: 'unknown' };
    }

    const change = currentScore - previousScore;
    const periodDays = Math.min(spanDays, preferredPeriodDays);

    let trend: 'improving' | 'declining' | 'stable';
    if (change >= 5) {
      trend = 'improving';
    } else if (change <= -5) {
      trend = 'declining';
    } else {
      trend = 'stable';
    }

    return { currentScore, previousScore, change, periodDays, trend };
  }

  // ============================================================================
  // JURISDICTION METHODS - Relay geolocation and hosting info
  // ============================================================================

  /**
   * Store jurisdiction info for a relay
   */
  async storeJurisdiction(info: JurisdictionInfo): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO relay_jurisdictions
       (relay_url, ip, country_code, country_name, region, city, isp, asn, as_org, is_hosting, is_tor, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (relay_url) DO UPDATE SET
         ip = excluded.ip,
         country_code = excluded.country_code,
         country_name = excluded.country_name,
         region = excluded.region,
         city = excluded.city,
         isp = excluded.isp,
         asn = excluded.asn,
         as_org = excluded.as_org,
         is_hosting = excluded.is_hosting,
         is_tor = excluded.is_tor,
         resolved_at = excluded.resolved_at`,
      info.relayUrl,
      info.ip ?? null,
      info.countryCode ?? null,
      info.countryName ?? null,
      info.region ?? null,
      info.city ?? null,
      info.isp ?? null,
      info.asn ?? null,
      info.asOrg ?? null,
      info.isHosting ?? null,
      info.isTor ?? null,
      info.resolvedAt
    );
  }

  /**
   * Get jurisdiction info for a relay
   */
  async getJurisdiction(relayUrl: string): Promise<JurisdictionInfo | null> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT * FROM relay_jurisdictions WHERE relay_url = ?`,
      relayUrl
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    return {
      relayUrl: row.relay_url,
      ip: row.ip ?? undefined,
      countryCode: row.country_code ?? undefined,
      countryName: row.country_name ?? undefined,
      region: row.region ?? undefined,
      city: row.city ?? undefined,
      isp: row.isp ?? undefined,
      asn: row.asn ?? undefined,
      asOrg: row.as_org ?? undefined,
      isHosting: row.is_hosting ?? undefined,
      isTor: row.is_tor ?? undefined,
      resolvedAt: Number(row.resolved_at),
    };
  }

  /**
   * Get all relays in a specific country
   */
  async getRelaysByCountry(countryCode: string): Promise<string[]> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT relay_url FROM relay_jurisdictions WHERE country_code = ?`,
      countryCode.toUpperCase()
    );
    return rows.map((row: any) => row.relay_url);
  }

  /**
   * Get jurisdiction statistics
   */
  async getJurisdictionStats(): Promise<Array<{
    countryCode: string;
    countryName: string;
    relayCount: number;
  }>> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT country_code, country_name, COUNT(*) as relay_count
       FROM relay_jurisdictions
       WHERE country_code IS NOT NULL
       GROUP BY country_code, country_name
       ORDER BY relay_count DESC`
    );

    return rows.map((row: any) => ({
      countryCode: row.country_code,
      countryName: row.country_name || row.country_code,
      relayCount: Number(row.relay_count),
    }));
  }

  // ============================================================================
  // BULK QUERY METHODS - Optimized batch retrieval for API performance
  // ============================================================================

  /**
   * Get latest probe for ALL relays in a single query
   */
  async getAllLatestProbes(): Promise<Map<string, ProbeResult>> {
    const db = await this.ensureReady();

    const rows = await db.all(`
      SELECT p.*
      FROM probes p
      INNER JOIN (
        SELECT url, MAX(timestamp) as max_ts
        FROM probes
        GROUP BY url
      ) latest ON p.url = latest.url AND p.timestamp = latest.max_ts
    `);

    const result = new Map<string, ProbeResult>();
    for (const row of rows as any[]) {
      result.set(row.url, {
        url: row.url,
        timestamp: Number(row.timestamp),
        reachable: row.reachable,
        relayType: row.relay_type as RelayType,
        connectTime: row.connect_time ?? undefined,
        readTime: row.read_time ?? undefined,
        writeTime: row.write_time ?? undefined,
        nip11FetchTime: row.nip11_fetch_time ?? undefined,
        nip11: safeJsonParse(row.nip11_json),
        error: row.error ?? undefined,
      });
    }
    return result;
  }

  /**
   * Get ALL probes for ALL relays in a single query, grouped by URL
   * Used for computing accurate reliability scores in the list view
   */
  async getAllProbes(sinceDays: number = 30): Promise<Map<string, ProbeResult[]>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(`
      SELECT * FROM probes
      WHERE timestamp >= ?
      ORDER BY url, timestamp ASC
    `, sinceTimestamp);

    const result = new Map<string, ProbeResult[]>();
    for (const row of rows as any[]) {
      const probe: ProbeResult = {
        url: row.url,
        timestamp: Number(row.timestamp),
        reachable: row.reachable,
        relayType: row.relay_type ?? undefined,
        accessLevel: row.access_level ?? undefined,
        closedReason: row.closed_reason ?? undefined,
        connectTime: row.connect_time ?? undefined,
        readTime: row.read_time ?? undefined,
        writeTime: row.write_time ?? undefined,
        nip11FetchTime: row.nip11_fetch_time ?? undefined,
        nip11: safeJsonParse(row.nip11_json),
        error: row.error ?? undefined,
      };

      const existing = result.get(row.url);
      if (existing) {
        existing.push(probe);
      } else {
        result.set(row.url, [probe]);
      }
    }
    return result;
  }

  /**
   * Get probe stats for ALL relays in a single query
   */
  async getAllProbeStats(sinceDays: number = 30): Promise<Map<string, {
    probeCount: number;
    successCount: number;
    avgConnectTime: number | null;
    avgReadTime: number | null;
    firstSeen: number | null;
    lastSeen: number | null;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(`
      SELECT
        url,
        COUNT(*) as probe_count,
        SUM(CASE WHEN reachable THEN 1 ELSE 0 END) as success_count,
        AVG(CASE WHEN reachable THEN connect_time END) as avg_connect_time,
        AVG(CASE WHEN reachable THEN read_time END) as avg_read_time,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM probes
      WHERE timestamp >= ?
      GROUP BY url
    `, sinceTimestamp);

    const result = new Map();
    for (const row of rows as any[]) {
      result.set(row.url, {
        probeCount: Number(row.probe_count ?? 0),
        successCount: Number(row.success_count ?? 0),
        avgConnectTime: row.avg_connect_time ?? null,
        avgReadTime: row.avg_read_time ?? null,
        firstSeen: row.first_seen ? Number(row.first_seen) : null,
        lastSeen: row.last_seen ? Number(row.last_seen) : null,
      });
    }
    return result;
  }

  /**
   * Get NIP-66 stats for ALL relays in a single query with percentile-based scoring.
   */
  async getAllNip66Stats(sinceDays: number = 365): Promise<Map<string, {
    metricCount: number;
    monitorCount: number;
    avgRttOpen: number | null;
    avgRttRead: number | null;
    avgRttWrite: number | null;
    latencyScore: number | null;
    connectPercentile: number | null;
    readPercentile: number | null;
    qualifyingMonitorCount: number;
    firstSeen: number | null;
    lastSeen: number | null;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    // Basic aggregation for raw metrics
    const basicRows = await db.all(`
      SELECT
        relay_url,
        COUNT(*) as metric_count,
        COUNT(DISTINCT monitor_pubkey) as monitor_count,
        AVG(rtt_open) as avg_rtt_open,
        AVG(rtt_read) as avg_rtt_read,
        AVG(rtt_write) as avg_rtt_write,
        MIN(timestamp) as first_seen,
        MAX(timestamp) as last_seen
      FROM nip66_metrics
      WHERE timestamp >= ?
      GROUP BY relay_url
    `, sinceTimestamp);

    // Build map with basic stats first
    const result = new Map<string, {
      metricCount: number;
      monitorCount: number;
      avgRttOpen: number | null;
      avgRttRead: number | null;
      avgRttWrite: number | null;
      latencyScore: number | null;
      connectPercentile: number | null;
      readPercentile: number | null;
      qualifyingMonitorCount: number;
      firstSeen: number | null;
      lastSeen: number | null;
    }>();

    for (const row of basicRows as any[]) {
      result.set(row.relay_url, {
        metricCount: Number(row.metric_count ?? 0),
        monitorCount: Number(row.monitor_count ?? 0),
        avgRttOpen: row.avg_rtt_open ?? null,
        avgRttRead: row.avg_rtt_read ?? null,
        avgRttWrite: row.avg_rtt_write ?? null,
        latencyScore: null,
        connectPercentile: null,
        readPercentile: null,
        qualifyingMonitorCount: 0,
        firstSeen: row.first_seen ? Number(row.first_seen) : null,
        lastSeen: row.last_seen ? Number(row.last_seen) : null,
      });
    }

    // Percentile calculation for ALL relays in a single query
    const percentileRows = await db.all(`
      WITH latest_metrics AS (
        SELECT
          monitor_pubkey,
          relay_url,
          rtt_open,
          rtt_read,
          ROW_NUMBER() OVER (
            PARTITION BY monitor_pubkey, relay_url
            ORDER BY timestamp DESC
          ) as rn
        FROM nip66_metrics
        WHERE timestamp >= ?
      ),
      latest_only AS (
        SELECT monitor_pubkey, relay_url, rtt_open, rtt_read
        FROM latest_metrics
        WHERE rn = 1
      ),
      qualifying_monitors AS (
        SELECT monitor_pubkey
        FROM latest_only
        GROUP BY monitor_pubkey
        HAVING COUNT(DISTINCT relay_url) >= 20
      ),
      relay_percentiles_per_monitor AS (
        -- For each relay and qualifying monitor, calculate percentile
        SELECT
          target.relay_url,
          target.monitor_pubkey,
          (SUM(CASE WHEN other.rtt_open > target.rtt_open THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) as connect_pct,
          (SUM(CASE WHEN other.rtt_read > target.rtt_read THEN 1 ELSE 0 END) * 100.0 / COUNT(*)) as read_pct
        FROM latest_only target
        JOIN latest_only other ON other.monitor_pubkey = target.monitor_pubkey
        WHERE target.monitor_pubkey IN (SELECT monitor_pubkey FROM qualifying_monitors)
          AND target.rtt_open IS NOT NULL
          AND other.rtt_open IS NOT NULL
        GROUP BY target.relay_url, target.monitor_pubkey, target.rtt_open, target.rtt_read
      )
      SELECT
        relay_url,
        AVG(connect_pct) as connect_percentile,
        AVG(read_pct) as read_percentile,
        AVG(connect_pct * 0.3 + read_pct * 0.7) as latency_score,
        COUNT(*) as qualifying_monitor_count
      FROM relay_percentiles_per_monitor
      GROUP BY relay_url
    `, sinceTimestamp);

    // Merge percentile data into results (rounded to whole numbers)
    for (const row of percentileRows as any[]) {
      const existing = result.get(row.relay_url);
      if (existing) {
        existing.latencyScore = row.latency_score != null ? Math.round(row.latency_score) : null;
        existing.connectPercentile = row.connect_percentile != null ? Math.round(row.connect_percentile) : null;
        existing.readPercentile = row.read_percentile != null ? Math.round(row.read_percentile) : null;
        existing.qualifyingMonitorCount = Number(row.qualifying_monitor_count ?? 0);
      }
    }

    return result;
  }

  /**
   * Get ALL jurisdictions in a single query
   */
  async getAllJurisdictions(): Promise<Map<string, JurisdictionInfo>> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT * FROM relay_jurisdictions`);

    const result = new Map<string, JurisdictionInfo>();
    for (const row of rows as any[]) {
      result.set(row.relay_url, {
        relayUrl: row.relay_url,
        ip: row.ip ?? undefined,
        countryCode: row.country_code ?? undefined,
        countryName: row.country_name ?? undefined,
        region: row.region ?? undefined,
        city: row.city ?? undefined,
        isp: row.isp ?? undefined,
        asn: row.asn ?? undefined,
        asOrg: row.as_org ?? undefined,
        isHosting: row.is_hosting ?? undefined,
        isTor: row.is_tor ?? undefined,
        resolvedAt: Number(row.resolved_at),
      });
    }
    return result;
  }

  /**
   * Get ALL operator resolutions in a single query
   */
  async getAllOperatorResolutions(): Promise<Map<string, OperatorResolution>> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT * FROM operator_mappings`);

    const result = new Map<string, OperatorResolution>();
    for (const row of rows as any[]) {
      const resolution: OperatorResolution = {
        relayUrl: row.relay_url,
        operatorPubkey: row.operator_pubkey,
        verificationMethod: row.verification_method as VerificationMethod | null,
        verifiedAt: Number(row.verified_at),
        confidence: Number(row.confidence),
        nip11Pubkey: row.nip11_pubkey ?? undefined,
        dnsPubkey: row.dns_pubkey ?? undefined,
        wellknownPubkey: row.wellknown_pubkey ?? undefined,
      };

      // Add WoT fields if present
      if (row.wot_score != null) {
        resolution.trustScore = Number(row.wot_score);
        resolution.trustConfidence = row.wot_confidence as 'low' | 'medium' | 'high';
        resolution.trustProviderCount = Number(row.wot_provider_count);
      }

      result.set(row.relay_url, resolution);
    }
    return result;
  }

  /**
   * Get report stats for ALL relays in a single query
   */
  async getAllReportStats(sinceDays: number = 90): Promise<Map<string, {
    reportCount: number;
    weightedCount: number;
    reporterCount: number;
    spamCount: number;
    censorshipCount: number;
    unreliableCount: number;
    maliciousCount: number;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(`
      SELECT
        relay_url,
        COUNT(*) as report_count,
        SUM(COALESCE(reporter_trust_weight, 1)) as weighted_count,
        COUNT(DISTINCT reporter_pubkey) as reporter_count,
        SUM(CASE WHEN report_type = 'spam' THEN 1 ELSE 0 END) as spam_count,
        SUM(CASE WHEN report_type = 'censorship' THEN 1 ELSE 0 END) as censorship_count,
        SUM(CASE WHEN report_type = 'unreliable' THEN 1 ELSE 0 END) as unreliable_count,
        SUM(CASE WHEN report_type = 'malicious' THEN 1 ELSE 0 END) as malicious_count
      FROM relay_reports
      WHERE timestamp >= ?
      GROUP BY relay_url
    `, sinceTimestamp);

    const result = new Map();
    for (const row of rows as any[]) {
      result.set(row.relay_url, {
        reportCount: Number(row.report_count ?? 0),
        weightedCount: Number(row.weighted_count ?? 0),
        reporterCount: Number(row.reporter_count ?? 0),
        spamCount: Number(row.spam_count ?? 0),
        censorshipCount: Number(row.censorship_count ?? 0),
        unreliableCount: Number(row.unreliable_count ?? 0),
        maliciousCount: Number(row.malicious_count ?? 0),
      });
    }
    return result;
  }

  /**
   * Get latest cached scores for ALL relays in a single query
   * Returns the most recent score snapshot from score_history
   */
  async getAllLatestScores(): Promise<Map<string, {
    score: number | null;
    reliability: number | null;
    quality: number | null;
    accessibility: number | null;
    timestamp: number;
  }>> {
    const db = await this.ensureReady();

    // Get the most recent score snapshot for each relay using window functions
    const rows = await db.all(`
      WITH ranked AS (
        SELECT
          relay_url,
          score,
          reliability,
          quality,
          accessibility,
          timestamp,
          ROW_NUMBER() OVER (PARTITION BY relay_url ORDER BY timestamp DESC) as rn
        FROM score_history
      )
      SELECT relay_url, score, reliability, quality, accessibility, timestamp
      FROM ranked
      WHERE rn = 1
    `);

    const result = new Map();
    for (const row of rows as any[]) {
      result.set(row.relay_url, {
        score: row.score ?? null,
        reliability: row.reliability ?? null,
        quality: row.quality ?? null,
        accessibility: row.accessibility ?? null,
        timestamp: Number(row.timestamp),
      });
    }
    return result;
  }

  /**
   * Get score trends for ALL relays in a single query
   * Uses dynamic period - prefers 7 days but falls back to available data (min 3 days)
   */
  async getAllScoreTrends(preferredPeriodDays: number = 7): Promise<Map<string, {
    currentScore: number | null;
    previousScore: number | null;
    change: number | null;
    periodDays: number | null;
  }>> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    const preferredStart = now - (preferredPeriodDays * 86400);
    const minPeriodDays = 3;

    // Get latest score, oldest score, and timestamps for each relay
    const rows = await db.all(`
      WITH bounds AS (
        SELECT
          relay_url,
          MIN(timestamp) as oldest_ts,
          MAX(timestamp) as newest_ts
        FROM score_history
        GROUP BY relay_url
      ),
      latest AS (
        SELECT
          s.relay_url,
          s.score as current_score,
          s.timestamp as current_ts
        FROM score_history s
        INNER JOIN bounds b ON s.relay_url = b.relay_url AND s.timestamp = b.newest_ts
      ),
      oldest_in_period AS (
        SELECT
          s.relay_url,
          s.score as previous_score,
          s.timestamp as previous_ts,
          ROW_NUMBER() OVER (PARTITION BY s.relay_url ORDER BY s.timestamp ASC) as rn
        FROM score_history s
        WHERE s.timestamp <= ?
      )
      SELECT
        l.relay_url,
        l.current_score,
        l.current_ts,
        COALESCE(o.previous_score, (
          SELECT score FROM score_history
          WHERE relay_url = l.relay_url
          ORDER BY timestamp ASC LIMIT 1
        )) as previous_score,
        COALESCE(o.previous_ts, (
          SELECT timestamp FROM score_history
          WHERE relay_url = l.relay_url
          ORDER BY timestamp ASC LIMIT 1
        )) as previous_ts
      FROM latest l
      LEFT JOIN oldest_in_period o ON l.relay_url = o.relay_url AND o.rn = 1
    `, preferredStart);

    const result = new Map();
    for (const row of rows as any[]) {
      const current = row.current_score ?? null;
      const previous = row.previous_score ?? null;
      // Convert BigInt to Number if needed
      const currentTs = row.current_ts != null ? Number(row.current_ts) : null;
      const previousTs = row.previous_ts != null ? Number(row.previous_ts) : null;

      // Calculate actual span in days
      let periodDays: number | null = null;
      let change: number | null = null;

      if (currentTs && previousTs && currentTs !== previousTs) {
        const spanDays = Math.round((currentTs - previousTs) / 86400);
        if (spanDays >= minPeriodDays && current !== null && previous !== null) {
          periodDays = Math.min(spanDays, preferredPeriodDays);
          change = current - previous;
        }
      }

      result.set(row.relay_url, {
        currentScore: current,
        previousScore: previous,
        change,
        periodDays,
      });
    }
    return result;
  }

  /**
   * Clean up old data beyond retention period
   * @param retentionDays Number of days to retain (default 90)
   * @returns Number of rows deleted from each table
   */
  async cleanupOldData(retentionDays: number = 90): Promise<{
    probes: number;
    nip66Metrics: number;
    reports: number;
    scoreHistory: number;
  }> {
    const db = await this.ensureReady();
    const cutoff = Math.floor(Date.now() / 1000) - (retentionDays * 86400);

    // Get counts before deletion for reporting (parameterized queries)
    const [probesResult] = await db.all(`SELECT COUNT(*) as count FROM probes WHERE timestamp < ?`, cutoff);
    const [nip66Result] = await db.all(`SELECT COUNT(*) as count FROM nip66_metrics WHERE timestamp < ?`, cutoff);
    const [reportsResult] = await db.all(`SELECT COUNT(*) as count FROM relay_reports WHERE timestamp < ?`, cutoff);
    const [historyResult] = await db.all(`SELECT COUNT(*) as count FROM score_history WHERE timestamp < ?`, cutoff);

    // Delete old data (parameterized queries)
    await db.run(`DELETE FROM probes WHERE timestamp < ?`, cutoff);
    await db.run(`DELETE FROM nip66_metrics WHERE timestamp < ?`, cutoff);
    await db.run(`DELETE FROM relay_reports WHERE timestamp < ?`, cutoff);
    await db.run(`DELETE FROM score_history WHERE timestamp < ?`, cutoff);

    return {
      probes: Number((probesResult as any)?.count ?? 0),
      nip66Metrics: Number((nip66Result as any)?.count ?? 0),
      reports: Number((reportsResult as any)?.count ?? 0),
      scoreHistory: Number((historyResult as any)?.count ?? 0),
    };
  }

  // ============================================================================
  // ANALYTICS METHODS - Advanced analytics queries using DuckDB features
  // ============================================================================

  /**
   * Get complete score history for a relay (for trend analysis)
   */
  async getFullScoreHistory(relayUrl: string, sinceDays: number = 90): Promise<Array<{
    timestamp: number;
    score: number | null;
    reliability: number | null;
    quality: number | null;
    accessibility: number | null;
    observations: number;
    confidence: string;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT timestamp, score, reliability, quality, accessibility, observations, confidence
       FROM score_history
       WHERE relay_url = ? AND timestamp >= ?
       ORDER BY timestamp ASC`,
      relayUrl,
      sinceTimestamp
    );

    return rows.map((row: any) => ({
      timestamp: Number(row.timestamp),
      score: row.score ?? null,
      reliability: row.reliability ?? null,
      quality: row.quality ?? null,
      accessibility: row.accessibility ?? null,
      observations: Number(row.observations ?? 0),
      confidence: row.confidence,
    }));
  }

  /**
   * Get all relay scores for ranking calculations
   * Returns the most recent score for each relay
   */
  async getAllRelayScoresForRanking(): Promise<Array<{
    url: string;
    score: number | null;
    reliability: number | null;
    quality: number | null;
    accessibility: number | null;
    observations: number;
    lastUpdated: number;
  }>> {
    const db = await this.ensureReady();

    // Get the most recent score snapshot for each relay
    const rows = await db.all(`
      WITH ranked AS (
        SELECT
          relay_url,
          score,
          reliability,
          quality,
          accessibility,
          observations,
          timestamp,
          ROW_NUMBER() OVER (PARTITION BY relay_url ORDER BY timestamp DESC) as rn
        FROM score_history
      )
      SELECT relay_url as url, score, reliability, quality, accessibility, observations, timestamp as last_updated
      FROM ranked
      WHERE rn = 1
      ORDER BY score DESC NULLS LAST
    `);

    return rows.map((row: any) => ({
      url: row.url,
      score: row.score ?? null,
      reliability: row.reliability ?? null,
      quality: row.quality ?? null,
      accessibility: row.accessibility ?? null,
      observations: Number(row.observations ?? 0),
      lastUpdated: Number(row.last_updated),
    }));
  }

  /**
   * Get previous rankings from a specific time period
   * Used for calculating rank changes
   */
  async getPreviousRankings(daysAgo: number = 7): Promise<Map<string, number>> {
    const db = await this.ensureReady();
    const targetTime = Math.floor(Date.now() / 1000) - (daysAgo * 86400);
    const windowStart = targetTime - 86400; // 1-day window around target

    // Get scores from the target period, then rank them
    const rows = await db.all(`
      WITH period_scores AS (
        SELECT
          relay_url,
          score,
          ROW_NUMBER() OVER (PARTITION BY relay_url ORDER BY ABS(timestamp - ?) ASC) as rn
        FROM score_history
        WHERE timestamp BETWEEN ? AND ?
          AND score IS NOT NULL
      ),
      best_scores AS (
        SELECT relay_url, score
        FROM period_scores
        WHERE rn = 1
      )
      SELECT
        relay_url,
        RANK() OVER (ORDER BY score DESC) as rank
      FROM best_scores
    `, targetTime, windowStart, targetTime + 86400);

    const result = new Map<string, number>();
    for (const row of rows as any[]) {
      result.set(row.relay_url, Number(row.rank));
    }
    return result;
  }

  /**
   * Get rolling averages for all relays using DuckDB window functions
   * More efficient than computing in JavaScript for large datasets
   */
  async getAllRollingAverages(): Promise<Map<string, {
    rolling7d: number | null;
    rolling30d: number | null;
    rolling90d: number | null;
    volatility: number | null;
  }>> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    const days7 = now - 7 * 86400;
    const days30 = now - 30 * 86400;
    const days90 = now - 90 * 86400;

    const rows = await db.all(`
      WITH base AS (
        SELECT
          relay_url,
          score,
          timestamp
        FROM score_history
        WHERE score IS NOT NULL AND timestamp >= ?
      )
      SELECT
        relay_url,
        AVG(CASE WHEN timestamp >= ? THEN score END) as rolling_7d,
        AVG(CASE WHEN timestamp >= ? THEN score END) as rolling_30d,
        AVG(score) as rolling_90d,
        STDDEV_SAMP(CASE WHEN timestamp >= ? THEN score END) as volatility
      FROM base
      GROUP BY relay_url
    `, days90, days7, days30, days30);

    const result = new Map();
    for (const row of rows as any[]) {
      result.set(row.relay_url, {
        rolling7d: row.rolling_7d !== null ? Math.round(row.rolling_7d) : null,
        rolling30d: row.rolling_30d !== null ? Math.round(row.rolling_30d) : null,
        rolling90d: row.rolling_90d !== null ? Math.round(row.rolling_90d) : null,
        volatility: row.volatility !== null ? Math.round(row.volatility * 10) / 10 : null,
      });
    }
    return result;
  }

  /**
   * Get trend analysis data for all relays using DuckDB
   * Returns first/last scores and slope for trend detection
   */
  async getAllTrendData(periodDays: number = 30): Promise<Map<string, {
    firstScore: number | null;
    lastScore: number | null;
    firstTimestamp: number;
    lastTimestamp: number;
    dataPoints: number;
    slope: number | null;
  }>> {
    const db = await this.ensureReady();
    const periodStart = Math.floor(Date.now() / 1000) - (periodDays * 86400);

    // Get first and last scores, plus compute linear regression slope
    const rows = await db.all(`
      WITH period_data AS (
        SELECT
          relay_url,
          score,
          timestamp,
          ROW_NUMBER() OVER (PARTITION BY relay_url ORDER BY timestamp ASC) as rn_asc,
          ROW_NUMBER() OVER (PARTITION BY relay_url ORDER BY timestamp DESC) as rn_desc,
          COUNT(*) OVER (PARTITION BY relay_url) as total_count
        FROM score_history
        WHERE timestamp >= ? AND score IS NOT NULL
      ),
      first_last AS (
        SELECT
          relay_url,
          MAX(CASE WHEN rn_asc = 1 THEN score END) as first_score,
          MAX(CASE WHEN rn_desc = 1 THEN score END) as last_score,
          MAX(CASE WHEN rn_asc = 1 THEN timestamp END) as first_timestamp,
          MAX(CASE WHEN rn_desc = 1 THEN timestamp END) as last_timestamp,
          MAX(total_count) as data_points
        FROM period_data
        GROUP BY relay_url
      ),
      regression AS (
        SELECT
          relay_url,
          REGR_SLOPE(score, (timestamp - ?) / 86400.0) as slope
        FROM score_history
        WHERE timestamp >= ? AND score IS NOT NULL
        GROUP BY relay_url
        HAVING COUNT(*) >= 2
      )
      SELECT
        fl.relay_url,
        fl.first_score,
        fl.last_score,
        fl.first_timestamp,
        fl.last_timestamp,
        fl.data_points,
        r.slope
      FROM first_last fl
      LEFT JOIN regression r ON fl.relay_url = r.relay_url
    `, periodStart, periodStart, periodStart);

    const result = new Map();
    for (const row of rows as any[]) {
      result.set(row.relay_url, {
        firstScore: row.first_score ?? null,
        lastScore: row.last_score ?? null,
        firstTimestamp: Number(row.first_timestamp ?? 0),
        lastTimestamp: Number(row.last_timestamp ?? 0),
        dataPoints: Number(row.data_points ?? 0),
        slope: row.slope !== null ? Math.round(row.slope * 100) / 100 : null,
      });
    }
    return result;
  }

  /**
   * Get uptime statistics for confidence interval calculation
   */
  async getUptimeStats(relayUrl: string, sinceDays: number = 30): Promise<{
    totalProbes: number;
    reachableProbes: number;
    uptimePercent: number;
  }> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN reachable THEN 1 ELSE 0 END) as reachable
      FROM probes
      WHERE url = ? AND timestamp >= ?`,
      relayUrl,
      sinceTimestamp
    );

    const row = (rows[0] as any) || {};
    const total = Number(row.total ?? 0);
    const reachable = Number(row.reachable ?? 0);

    return {
      totalProbes: total,
      reachableProbes: reachable,
      uptimePercent: total > 0 ? Math.round((reachable / total) * 100) : 0,
    };
  }

  /**
   * Get uptime stats for all relays in a single query
   */
  async getAllUptimeStats(sinceDays: number = 30): Promise<Map<string, {
    totalProbes: number;
    reachableProbes: number;
    uptimePercent: number;
  }>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(`
      SELECT
        url,
        COUNT(*) as total,
        SUM(CASE WHEN reachable THEN 1 ELSE 0 END) as reachable
      FROM probes
      WHERE timestamp >= ?
      GROUP BY url
    `, sinceTimestamp);

    const result = new Map();
    for (const row of rows as any[]) {
      const total = Number(row.total ?? 0);
      const reachable = Number(row.reachable ?? 0);
      result.set(row.url, {
        totalProbes: total,
        reachableProbes: reachable,
        uptimePercent: total > 0 ? Math.round((reachable / total) * 100) : 0,
      });
    }
    return result;
  }

  /**
   * Checkpoint the WAL file to prevent stale WAL issues
   * Should be called periodically and before shutdown
   */
  async checkpoint(): Promise<void> {
    const db = await this.ensureReady();
    try {
      await db.run('CHECKPOINT');
    } catch (err) {
      // Ignore checkpoint errors - not critical
      console.error('Checkpoint failed:', err);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      // Checkpoint before closing to flush WAL
      try {
        await this.db.run('CHECKPOINT');
      } catch {
        // Ignore checkpoint errors during close
      }
      await this.db.close();
      this.db = null;
    }
  }
}
