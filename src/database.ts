import { Database as SQLiteDatabase } from 'bun:sqlite';
import type { ProbeResult, RelayType, OperatorResolution, VerificationMethod, RelayReport, ReportType, RelayReportStats, RelayAssertion, NetworkStats, Nip66PolicySignals } from './types.js';
import type { JurisdictionInfo } from './jurisdiction.js';
import { normalizeRelayUrl } from './prober.js';

/**
 * Thin async-shaped adapter over bun:sqlite's synchronous API. Keeping the
 * `run`/`all`/`exec` surface (and the `Promise` return types) lets every
 * DataStore method keep its existing `await db.run(...)` / `await db.all(...)`
 * call shape, so the migration off DuckDB stays contained to this file.
 */
interface DbAdapter {
  run(sql: string, ...params: unknown[]): Promise<void>;
  all(sql: string, ...params: unknown[]): Promise<any[]>;
  exec(sql: string): Promise<void>;
}

/**
 * bun:sqlite rejects `undefined` bindings (DuckDB silently treated them as
 * NULL). Normalize so the many call sites that pass `value ?? null` — and the
 * occasional one that doesn't — both bind cleanly.
 */
function normalizeBindings(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

/**
 * Continuous percentile with linear interpolation, matching DuckDB's
 * QUANTILE_CONT / MEDIAN (q=0.5). Input must be sorted ascending. SQLite has no
 * percentile aggregate, so these are computed in JS over the (small, cached)
 * network-stats datasets.
 */
function percentileCont(sortedAsc: number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** Sample standard deviation (n−1 denominator), matching DuckDB STDDEV_SAMP. */
function sampleStddev(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return Math.sqrt(variance);
}

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

/**
 * Tally NIP-66 policy signals (R/k/T tags) from a set of latest-per-monitor
 * rows for a single relay. Each requirement is decided by majority among the
 * monitors that expressed an opinion; ties and no-votes yield `undefined` so
 * callers can distinguish "observed false" from "not observed". Shared by the
 * single-relay and bulk aggregation paths.
 */
function tallyNip66PolicySignals(
  rows: Array<{ requirements: unknown; relay_type: unknown; rejected_kinds: unknown; topics?: unknown }>
): Nip66PolicySignals {
  const reqKeys = ['auth', 'payment', 'writes', 'pow'] as const;
  const yes: Record<string, number> = { auth: 0, payment: 0, writes: 0, pow: 0 };
  const no: Record<string, number> = { auth: 0, payment: 0, writes: 0, pow: 0 };
  let kindRestrictYes = 0;
  let kindRestrictTotal = 0;
  const relayTypeVotes: Map<string, number> = new Map();
  // Distinct topics, deduped case-insensitively but preserving first-seen casing.
  const topicSeen = new Map<string, string>();
  const MAX_TOPICS = 25;

  for (const row of rows) {
    const requirements = safeJsonParse<string[]>(row.requirements as string) ?? [];
    const reqSet = new Set(requirements.map((r) => r.toLowerCase()));
    for (const key of reqKeys) {
      if (reqSet.has(key)) yes[key]++;
      else if (reqSet.has(`!${key}`)) no[key]++;
    }

    const rejectedKinds = safeJsonParse<number[]>(row.rejected_kinds as string);
    if (rejectedKinds !== undefined) {
      kindRestrictTotal++;
      if (rejectedKinds.length > 0) kindRestrictYes++;
    }

    if (row.relay_type) {
      const t = row.relay_type as string;
      relayTypeVotes.set(t, (relayTypeVotes.get(t) ?? 0) + 1);
    }

    const topics = safeJsonParse<string[]>(row.topics as string) ?? [];
    for (const topic of topics) {
      const trimmed = topic.trim();
      if (!trimmed || topicSeen.size >= MAX_TOPICS) continue;
      const k = trimmed.toLowerCase();
      if (!topicSeen.has(k)) topicSeen.set(k, trimmed);
    }
  }

  const majority = (key: typeof reqKeys[number]): boolean | undefined => {
    const total = yes[key] + no[key];
    if (total === 0) return undefined;
    if (yes[key] > no[key]) return true;
    if (no[key] > yes[key]) return false;
    return undefined; // tie: no clear verdict
  };

  let relayType: string | undefined;
  let bestVotes = 0;
  for (const [type, votes] of relayTypeVotes) {
    if (votes > bestVotes) {
      bestVotes = votes;
      relayType = type;
    }
  }

  return {
    monitorCount: rows.length,
    authRequired: majority('auth'),
    paymentRequired: majority('payment'),
    restrictedWrites: majority('writes'),
    powRequired: majority('pow'),
    kindRestrictions: kindRestrictTotal === 0 ? undefined : kindRestrictYes * 2 > kindRestrictTotal,
    relayType,
    topics: topicSeen.size > 0 ? Array.from(topicSeen.values()) : undefined,
  };
}

export const SCHEMA = `
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
    geohash VARCHAR,
    relay_type VARCHAR,
    requirements VARCHAR,
    topics VARCHAR,
    accepted_kinds VARCHAR,
    rejected_kinds VARCHAR
  );

  CREATE INDEX IF NOT EXISTS idx_nip66_timestamp ON nip66_metrics(timestamp);
  -- Composite covering indexes for the two hot query shapes over the ~1.4M-row
  -- table: latest-per-(monitor,relay) lookups, and the per-relay RTT aggregate.
  -- These supersede single-column relay_url / monitor_pubkey indexes (which were
  -- prefixes of these and are dropped in initInner).
  CREATE INDEX IF NOT EXISTS idx_nip66_monitor_relay_ts ON nip66_metrics(monitor_pubkey, relay_url, timestamp);
  CREATE INDEX IF NOT EXISTS idx_nip66_relay_ts_rtt ON nip66_metrics(relay_url, timestamp, monitor_pubkey, rtt_open, rtt_read, rtt_write);

  CREATE TABLE IF NOT EXISTS trusted_monitors (
    pubkey VARCHAR PRIMARY KEY,
    name VARCHAR,
    added_at BIGINT NOT NULL,
    last_seen BIGINT,
    event_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS operators (
    pubkey VARCHAR PRIMARY KEY,
    wot_score INTEGER,
    wot_confidence VARCHAR,
    wot_provider_count INTEGER,
    wot_updated_at BIGINT
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
  -- Covering index for the per-relay rolling-average / trend analytics: lets
  -- GROUP BY relay_url over a timestamp window read score index-only (no table
  -- row fetches), turning multi-second full scans into sub-second lookups.
  CREATE INDEX IF NOT EXISTS idx_score_history_relay_ts_score ON score_history(relay_url, timestamp, score);

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

  CREATE TABLE IF NOT EXISTS network_stats_cache (
    period VARCHAR NOT NULL,
    computed_at BIGINT NOT NULL,
    stats_json VARCHAR NOT NULL,
    PRIMARY KEY (period)
  );
`;

export class DataStore {
  private db: DbAdapter | null = null;
  private sqlite: SQLiteDatabase | null = null;
  private dbPath: string;
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;

  constructor(dbPath: string = './data/trustedrelays.db') {
    this.dbPath = dbPath;
    this.initPromise = this.init();
    // Attach a no-op rejection handler so a failed init never surfaces as an
    // unhandled promise rejection (which can crash the process). The real error
    // is captured in initError and re-thrown from ensureReady().
    this.initPromise.catch(() => { /* handled in ensureReady */ });
  }

  private async init(): Promise<void> {
    try {
      await this.initInner();
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    }
  }

  private async initInner(): Promise<void> {
    const sqlite = new SQLiteDatabase(this.dbPath, { create: true });
    this.sqlite = sqlite;
    // PRAGMAs tuned for a small, memory-constrained host. WAL gives durable
    // crash recovery with good write throughput; NORMAL sync is safe under WAL.
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -16000;
      PRAGMA foreign_keys = ON;
    `);
    // Use incremental auto-vacuum so cleanup can reclaim deleted pages cheaply
    // (PRAGMA incremental_vacuum) instead of a full, event-loop-blocking VACUUM.
    // Changing the mode only takes effect after a VACUUM, so convert once on a
    // database that predates this (auto_vacuum NONE=0 / FULL=1). No-op once
    // already INCREMENTAL (2). The one-time conversion VACUUM can take ~20s on a
    // large legacy DB — a single startup cost.
    const avMode = (sqlite.query('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum;
    sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL');
    if (avMode !== 2) {
      console.log('[db] converting to incremental auto_vacuum (one-time VACUUM)...');
      sqlite.exec('VACUUM');
    }

    this.db = {
      run: async (sql, ...params) => { sqlite.query(sql).run(...(normalizeBindings(params) as any)); },
      all: async (sql, ...params) => sqlite.query(sql).all(...(normalizeBindings(params) as any)),
      exec: async (sql) => { sqlite.exec(sql); },
    };
    // Fresh databases (and the one-time DuckDB→SQLite conversion) carry the
    // final schema; create any missing tables/indexes. The old DuckDB-era data
    // migrations no longer apply — the production data was converted clean.
    await this.db.exec(SCHEMA);

    // Drop single-column nip66 indexes that are now strict prefixes of the
    // composite covering indexes above (redundant; just add write overhead).
    await this.db.exec('DROP INDEX IF EXISTS idx_nip66_relay; DROP INDEX IF EXISTS idx_nip66_monitor;');
  }

  private async ensureReady(): Promise<DbAdapter> {
    // Await initialization on every call. The promise is retained (not nulled)
    // so concurrent and later callers all observe the same settled result;
    // awaiting an already-settled promise is effectively free.
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch (err) {
        // Surface the original initialization failure with its cause.
        throw new Error(`Database initialization failed: ${(err as Error).message}`, { cause: err });
      }
    }
    if (this.initError) {
      throw new Error(`Database initialization failed: ${this.initError.message}`, { cause: this.initError });
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
      reachable: !!row.reachable,
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
      reachable: !!row.reachable,
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
    relayType?: string;
    requirements?: string[];
    topics?: string[];
    acceptedKinds?: number[];
    rejectedKinds?: number[];
  }): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO nip66_metrics
       (event_id, relay_url, monitor_pubkey, timestamp, rtt_open, rtt_read, rtt_write, network, supported_nips, geohash,
        relay_type, requirements, topics, accepted_kinds, rejected_kinds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO UPDATE SET
         relay_url = excluded.relay_url,
         monitor_pubkey = excluded.monitor_pubkey,
         timestamp = excluded.timestamp,
         rtt_open = excluded.rtt_open,
         rtt_read = excluded.rtt_read,
         rtt_write = excluded.rtt_write,
         network = excluded.network,
         supported_nips = excluded.supported_nips,
         geohash = excluded.geohash,
         relay_type = excluded.relay_type,
         requirements = excluded.requirements,
         topics = excluded.topics,
         accepted_kinds = excluded.accepted_kinds,
         rejected_kinds = excluded.rejected_kinds`,
      metric.eventId,
      metric.relayUrl,
      metric.monitorPubkey,
      metric.timestamp,
      metric.rttOpen ?? null,
      metric.rttRead ?? null,
      metric.rttWrite ?? null,
      metric.network ?? null,
      metric.supportedNips ? JSON.stringify(metric.supportedNips) : null,
      metric.geohash ?? null,
      metric.relayType ?? null,
      metric.requirements ? JSON.stringify(metric.requirements) : null,
      metric.topics ? JSON.stringify(metric.topics) : null,
      metric.acceptedKinds ? JSON.stringify(metric.acceptedKinds) : null,
      metric.rejectedKinds ? JSON.stringify(metric.rejectedKinds) : null
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
    relayType?: string;
    requirements?: string[];
    topics?: string[];
    acceptedKinds?: number[];
    rejectedKinds?: number[];
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
      relayType: row.relay_type ?? undefined,
      requirements: safeJsonParse<string[]>(row.requirements),
      topics: safeJsonParse<string[]>(row.topics),
      acceptedKinds: safeJsonParse<number[]>(row.accepted_kinds),
      rejectedKinds: safeJsonParse<number[]>(row.rejected_kinds),
    }));
  }

  /**
   * Get aggregated NIP-66 stats for a relay with percentile-based scoring.
   *
   * Percentile scoring removes geographic bias by ranking each relay relative
   * to other relays from each monitor's perspective, then averaging across monitors.
   * Only monitors tracking ≥20 relays contribute to percentile scores.
   * Excludes data from stale monitors (no activity in 30 days).
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
    const staleThreshold = Math.floor(Date.now() / 1000) - (30 * 86400); // 30 days

    // Basic aggregation for raw metrics (excluding stale monitors)
    const basicRows = await db.all(
      `SELECT
        COUNT(*) as metric_count,
        COUNT(DISTINCT m.monitor_pubkey) as monitor_count,
        AVG(m.rtt_open) as avg_rtt_open,
        AVG(m.rtt_read) as avg_rtt_read,
        AVG(m.rtt_write) as avg_rtt_write,
        MIN(m.timestamp) as first_seen,
        MAX(m.timestamp) as last_seen
      FROM nip66_metrics m
      INNER JOIN trusted_monitors tm ON m.monitor_pubkey = tm.pubkey
      WHERE m.relay_url = ?
        AND m.timestamp >= ?
        AND (tm.last_seen IS NULL OR tm.last_seen >= ?)`,
      relayUrl,
      sinceTimestamp,
      staleThreshold
    );

    const basicRow = (basicRows[0] as any) || {};

    // Percentile calculation using latest metrics only (excluding stale monitors)
    // Uses ROW_NUMBER to get most recent metric per monitor per relay
    const percentileRows = await db.all(
      `WITH active_monitors AS (
        -- Only include monitors that have been active within the stale threshold
        SELECT pubkey FROM trusted_monitors
        WHERE last_seen IS NULL OR last_seen >= ?
      ),
      latest_metrics AS (
        -- Get most recent metric from each active monitor for each relay
        SELECT
          m.monitor_pubkey,
          m.relay_url,
          m.rtt_open,
          m.rtt_read,
          ROW_NUMBER() OVER (
            PARTITION BY m.monitor_pubkey, m.relay_url
            ORDER BY m.timestamp DESC
          ) as rn
        FROM nip66_metrics m
        WHERE m.timestamp >= ?
          AND m.monitor_pubkey IN (SELECT pubkey FROM active_monitors)
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
      percentiles AS (
        -- PERCENT_RANK over each monitor's relays; invert so lower RTT = higher
        -- percentile. Identical formula to getAllNip66Stats so the single-relay
        -- detail view and the bulk list view agree exactly.
        SELECT
          relay_url,
          monitor_pubkey,
          rtt_read,
          (1.0 - PERCENT_RANK() OVER (PARTITION BY monitor_pubkey ORDER BY rtt_open ASC)) * 100 as connect_pct,
          (1.0 - PERCENT_RANK() OVER (PARTITION BY monitor_pubkey ORDER BY rtt_read ASC)) * 100 as read_pct
        FROM latest_only
        WHERE monitor_pubkey IN (SELECT monitor_pubkey FROM qualifying_monitors)
          AND rtt_open IS NOT NULL
      )
      SELECT
        AVG(connect_pct) as connect_percentile,
        AVG(read_pct) as read_percentile,
        -- Use connect-only when read data unavailable, otherwise 30/70 weighted
        AVG(CASE
          WHEN rtt_read IS NULL THEN connect_pct
          ELSE connect_pct * 0.3 + read_pct * 0.7
        END) as latency_score,
        COUNT(*) as qualifying_monitor_count
      FROM percentiles
      WHERE relay_url = ?`,
      staleThreshold,
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
   * Aggregate monitor-observed policy signals (NIP-66 `R`/`k`/`T` tags) for a
   * relay. Takes the latest metric from each active (non-stale) trusted monitor
   * and resolves each requirement by majority vote among the monitors that
   * expressed an opinion. Returns `undefined` for a key when no monitor voted,
   * so callers can distinguish "observed false" from "not observed".
   */
  async getNip66PolicySignals(relayUrl: string, sinceDays: number = 30): Promise<Nip66PolicySignals> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
    const staleThreshold = Math.floor(Date.now() / 1000) - (30 * 86400);

    // Latest metric per active monitor for this relay (same shape as the
    // percentile path in getNip66Stats: active monitors only, newest row per).
    const rows = await db.all(
      `WITH active_monitors AS (
        SELECT pubkey FROM trusted_monitors
        WHERE last_seen IS NULL OR last_seen >= ?
      ),
      latest_metrics AS (
        SELECT
          m.requirements,
          m.relay_type,
          m.rejected_kinds,
          m.topics,
          ROW_NUMBER() OVER (
            PARTITION BY m.monitor_pubkey
            ORDER BY m.timestamp DESC
          ) as rn
        FROM nip66_metrics m
        WHERE m.relay_url = ?
          AND m.timestamp >= ?
          AND m.monitor_pubkey IN (SELECT pubkey FROM active_monitors)
      )
      SELECT requirements, relay_type, rejected_kinds, topics
      FROM latest_metrics
      WHERE rn = 1`,
      staleThreshold,
      relayUrl,
      sinceTimestamp
    );

    return tallyNip66PolicySignals(rows as any[]);
  }

  /**
   * Bulk version of getNip66PolicySignals: aggregates policy signals for ALL
   * relays in a single query (latest metric per monitor per relay, via one
   * window-function pass), then tallies each relay's majority verdict in JS.
   * Lets the batch publisher pre-fetch once instead of querying per relay.
   */
  async getAllNip66PolicySignals(sinceDays: number = 30): Promise<Map<string, Nip66PolicySignals>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);
    const staleThreshold = Math.floor(Date.now() / 1000) - (30 * 86400);

    const rows = await db.all(
      `WITH active_monitors AS (
        SELECT pubkey FROM trusted_monitors
        WHERE last_seen IS NULL OR last_seen >= ?
      ),
      latest AS (
        -- Latest (monitor,relay) timestamps via GROUP BY MAX over the
        -- (monitor_pubkey, relay_url, timestamp) covering index; far cheaper
        -- than a ROW_NUMBER() window scan of the whole table.
        SELECT monitor_pubkey, relay_url, MAX(timestamp) AS ts
        FROM nip66_metrics
        WHERE timestamp >= ?
          AND monitor_pubkey IN (SELECT pubkey FROM active_monitors)
        GROUP BY monitor_pubkey, relay_url
      )
      SELECT m.relay_url, m.requirements, m.relay_type, m.rejected_kinds, m.topics
      FROM nip66_metrics m
      JOIN latest l ON m.monitor_pubkey = l.monitor_pubkey
        AND m.relay_url = l.relay_url AND m.timestamp = l.ts`,
      staleThreshold,
      sinceTimestamp
    );

    // Group the latest-per-monitor rows by relay, then tally each relay once.
    const grouped = new Map<string, Array<{ requirements: unknown; relay_type: unknown; rejected_kinds: unknown; topics: unknown }>>();
    for (const row of rows as any[]) {
      const list = grouped.get(row.relay_url);
      if (list) list.push(row);
      else grouped.set(row.relay_url, [row]);
    }

    const result = new Map<string, Nip66PolicySignals>();
    for (const [url, relayRows] of grouped) {
      result.set(url, tallyNip66PolicySignals(relayRows));
    }
    return result;
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
  async addRequestedRelay(url: string, requestedBy?: string, maxRequested?: number): Promise<void> {
    const db = await this.ensureReady();
    const normalized = normalizeRelayUrl(url);
    const now = Math.floor(Date.now() / 1000);

    // Enforce a cap on the requested-relay list to prevent unbounded growth
    // from anonymous /api/track calls. Re-tracking an existing URL is always
    // allowed (it is an upsert); only genuinely new entries are capped.
    if (maxRequested && maxRequested > 0) {
      const existing = await db.all(`SELECT 1 FROM requested_relays WHERE url = ?`, normalized);
      if (existing.length === 0) {
        const countRow = await db.all(`SELECT COUNT(*) AS n FROM requested_relays`);
        const count = Number(countRow[0]?.n ?? 0);
        if (count >= maxRequested) {
          throw new Error('Requested relay limit reached');
        }
      }
    }

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
    // Upsert: a UPDATE-only statement silently no-ops for monitors that were
    // never explicitly registered (accept-all ingestion mode), which then made
    // getNip66Stats' INNER JOIN on trusted_monitors drop all their metrics.
    await db.run(
      `INSERT INTO trusted_monitors (pubkey, name, added_at, last_seen, event_count)
       VALUES (?, NULL, ?, ?, 1)
       ON CONFLICT (pubkey) DO UPDATE SET
         last_seen = excluded.last_seen,
         event_count = trusted_monitors.event_count + 1`,
      pubkey,
      now,
      now
    );
  }

  /**
   * Batch-apply buffered monitor stats (last_seen / event_count) in one
   * transaction. Used by the ingestor to avoid a per-event write.
   */
  async flushMonitorStats(updates: Map<string, { count: number; lastSeen: number }>): Promise<void> {
    if (updates.size === 0) return;
    const db = await this.ensureReady();
    await db.exec('BEGIN');
    try {
      for (const [pubkey, { count, lastSeen }] of updates) {
        await db.run(
          `INSERT INTO trusted_monitors (pubkey, name, added_at, last_seen, event_count)
           VALUES (?, NULL, ?, ?, ?)
           ON CONFLICT (pubkey) DO UPDATE SET
             last_seen = MAX(trusted_monitors.last_seen, excluded.last_seen),
             event_count = trusted_monitors.event_count + ?`,
          pubkey, lastSeen, lastSeen, count, count
        );
      }
      await db.exec('COMMIT');
    } catch (err) {
      try { await db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }
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
   * Relay mapping goes to operator_mappings, WoT data goes to operators table
   */
  async storeOperatorResolution(resolution: OperatorResolution): Promise<void> {
    const db = await this.ensureReady();

    // Store relay -> operator mapping
    await db.run(
      `INSERT INTO operator_mappings
       (relay_url, operator_pubkey, verification_method, verified_at, confidence, nip11_pubkey, dns_pubkey, wellknown_pubkey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (relay_url) DO UPDATE SET
         operator_pubkey = excluded.operator_pubkey,
         verification_method = excluded.verification_method,
         verified_at = excluded.verified_at,
         confidence = excluded.confidence,
         nip11_pubkey = excluded.nip11_pubkey,
         dns_pubkey = excluded.dns_pubkey,
         wellknown_pubkey = excluded.wellknown_pubkey`,
      resolution.relayUrl,
      resolution.operatorPubkey,
      resolution.verificationMethod,
      resolution.verifiedAt,
      resolution.confidence,
      resolution.nip11Pubkey ?? null,
      resolution.dnsPubkey ?? null,
      resolution.wellknownPubkey ?? null
    );

    // Store WoT data in operators table if present
    if (resolution.operatorPubkey && resolution.trustScore != null) {
      await this.storeOperatorWot(
        resolution.operatorPubkey,
        resolution.trustScore,
        resolution.trustConfidence ?? null,
        resolution.trustProviderCount ?? null
      );
    }
  }

  /**
   * Store or update an operator's WoT score
   */
  async storeOperatorWot(
    pubkey: string,
    wotScore: number,
    wotConfidence: 'low' | 'medium' | 'high' | null,
    wotProviderCount: number | null
  ): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO operators (pubkey, wot_score, wot_confidence, wot_provider_count, wot_updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (pubkey) DO UPDATE SET
         wot_score = excluded.wot_score,
         wot_confidence = excluded.wot_confidence,
         wot_provider_count = excluded.wot_provider_count,
         wot_updated_at = excluded.wot_updated_at`,
      pubkey,
      wotScore,
      wotConfidence,
      wotProviderCount,
      Math.floor(Date.now() / 1000)
    );
  }

  /**
   * Get an operator's WoT score
   */
  async getOperatorWot(pubkey: string): Promise<{
    wotScore: number | null;
    wotConfidence: 'low' | 'medium' | 'high' | null;
    wotProviderCount: number | null;
    wotUpdatedAt: number | null;
  } | null> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `SELECT * FROM operators WHERE pubkey = ?`,
      pubkey
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    return {
      wotScore: row.wot_score != null ? Number(row.wot_score) : null,
      wotConfidence: row.wot_confidence as 'low' | 'medium' | 'high' | null,
      wotProviderCount: row.wot_provider_count != null ? Number(row.wot_provider_count) : null,
      wotUpdatedAt: row.wot_updated_at != null ? Number(row.wot_updated_at) : null,
    };
  }

  /**
   * Get cached operator resolution for a relay
   * Joins with operators table to include WoT data
   */
  async getOperatorResolution(relayUrl: string): Promise<OperatorResolution | null> {
    const db = await this.ensureReady();
    const normalizedUrl = normalizeRelayUrl(relayUrl);
    const rows = await db.all(
      `SELECT m.*, o.wot_score, o.wot_confidence, o.wot_provider_count
       FROM operator_mappings m
       LEFT JOIN operators o ON m.operator_pubkey = o.pubkey
       WHERE m.relay_url = ?`,
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

    // Add WoT fields if present (from joined operators table)
    if (row.wot_score != null) {
      resolution.trustScore = Number(row.wot_score);
      resolution.trustConfidence = row.wot_confidence as 'low' | 'medium' | 'high';
      resolution.trustProviderCount = Number(row.wot_provider_count);
    }

    return resolution;
  }

  /**
   * Get operator pubkeys that need WoT score refresh
   * Returns distinct operator pubkeys where wot_updated_at is null or older than maxAgeDays
   */
  async getOperatorsNeedingWotRefresh(maxAgeDays: number = 1): Promise<string[]> {
    const db = await this.ensureReady();
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);

    // Get distinct operator pubkeys that either:
    // 1. Don't have an entry in operators table
    // 2. Have an entry with wot_updated_at older than cutoff
    const rows = await db.all(
      `SELECT DISTINCT m.operator_pubkey
       FROM operator_mappings m
       LEFT JOIN operators o ON m.operator_pubkey = o.pubkey
       WHERE m.operator_pubkey IS NOT NULL
       AND (o.pubkey IS NULL OR o.wot_updated_at IS NULL OR o.wot_updated_at < ?)`,
      cutoff
    );

    return rows.map((row: any) => row.operator_pubkey);
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
  /**
   * Store a report. Reports are immutable (keyed by event id), so a duplicate
   * is a no-op. Returns true only when a new row was actually inserted, so
   * callers can avoid double-counting on concurrent delivery of the same event.
   */
  async storeReport(report: RelayReport): Promise<boolean> {
    const db = await this.ensureReady();
    const rows = await db.all(
      `INSERT INTO relay_reports
       (event_id, relay_url, reporter_pubkey, report_type, content, timestamp, reporter_trust_weight)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      report.eventId,
      report.relayUrl,
      report.reporterPubkey,
      report.reportType,
      report.content,
      report.timestamp,
      report.reporterTrustWeight ?? null
    );
    return rows.length > 0;
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
   * Bulk: all reports within the window, grouped by relay_url. Avoids an N+1
   * of getReports() per relay in the publish loop.
   */
  async getAllReports(sinceDays: number = 90): Promise<Map<string, RelayReport[]>> {
    const db = await this.ensureReady();
    const sinceTimestamp = Math.floor(Date.now() / 1000) - (sinceDays * 86400);

    const rows = await db.all(
      `SELECT * FROM relay_reports WHERE timestamp >= ? ORDER BY relay_url, timestamp DESC`,
      sinceTimestamp
    );

    const result = new Map<string, RelayReport[]>();
    for (const row of rows as any[]) {
      const report: RelayReport = {
        eventId: row.event_id,
        relayUrl: row.relay_url,
        reporterPubkey: row.reporter_pubkey,
        reportType: row.report_type as ReportType,
        content: row.content ?? '',
        timestamp: Number(row.timestamp),
        reporterTrustWeight: row.reporter_trust_weight ?? undefined,
      };
      const arr = result.get(row.relay_url);
      if (arr) arr.push(report);
      else result.set(row.relay_url, [report]);
    }
    return result;
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
      isHosting: row.is_hosting != null ? !!row.is_hosting : undefined,
      isTor: row.is_tor != null ? !!row.is_tor : undefined,
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
        reachable: !!row.reachable,
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

    // Exclude nip11_json from bulk loading - it's the largest column per row
    // and only needed from the latest probe (use getAllLatestProbes() for that)
    const rows = await db.all(`
      SELECT url, timestamp, reachable, relay_type, access_level, closed_reason,
             connect_time, read_time, write_time, nip11_fetch_time, error
      FROM probes
      WHERE timestamp >= ?
      ORDER BY url, timestamp ASC
    `, sinceTimestamp);

    const result = new Map<string, ProbeResult[]>();
    for (const row of rows as any[]) {
      const probe: ProbeResult = {
        url: row.url,
        timestamp: Number(row.timestamp),
        reachable: !!row.reachable,
        relayType: row.relay_type ?? undefined,
        accessLevel: row.access_level ?? undefined,
        closedReason: row.closed_reason ?? undefined,
        connectTime: row.connect_time ?? undefined,
        readTime: row.read_time ?? undefined,
        writeTime: row.write_time ?? undefined,
        nip11FetchTime: row.nip11_fetch_time ?? undefined,
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
    const staleThreshold = Math.floor(Date.now() / 1000) - (30 * 86400); // 30 days

    // Basic aggregation for raw metrics. Filter to trusted, non-stale monitors
    // so this matches getNip66Stats' single-relay results exactly.
    const basicRows = await db.all(`
      SELECT
        m.relay_url,
        COUNT(*) as metric_count,
        COUNT(DISTINCT m.monitor_pubkey) as monitor_count,
        AVG(m.rtt_open) as avg_rtt_open,
        AVG(m.rtt_read) as avg_rtt_read,
        AVG(m.rtt_write) as avg_rtt_write,
        MIN(m.timestamp) as first_seen,
        MAX(m.timestamp) as last_seen
      FROM nip66_metrics m
      INNER JOIN trusted_monitors tm ON m.monitor_pubkey = tm.pubkey
      WHERE m.timestamp >= ?
        AND (tm.last_seen IS NULL OR tm.last_seen >= ?)
      GROUP BY m.relay_url
    `, sinceTimestamp, staleThreshold);

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

    // Percentile calculation for ALL relays using PERCENT_RANK() window function.
    // This replaces the previous O(N^2) self-join approach with O(N log N) per partition,
    // significantly reducing memory usage during query execution.
    const percentileRows = await db.all(`
      WITH active_monitors AS (
        SELECT pubkey FROM trusted_monitors
        WHERE last_seen IS NULL OR last_seen >= ?
      ),
      latest AS (
        -- Latest (monitor,relay) timestamps via GROUP BY MAX over the covering
        -- (monitor_pubkey, relay_url, timestamp) index — avoids a ROW_NUMBER()
        -- window scan of the whole nip66_metrics table.
        SELECT monitor_pubkey, relay_url, MAX(timestamp) AS ts
        FROM nip66_metrics
        WHERE timestamp >= ?
          AND monitor_pubkey IN (SELECT pubkey FROM active_monitors)
        GROUP BY monitor_pubkey, relay_url
      ),
      latest_only AS (
        SELECT m.monitor_pubkey, m.relay_url, m.rtt_open, m.rtt_read
        FROM nip66_metrics m
        JOIN latest l ON m.monitor_pubkey = l.monitor_pubkey
          AND m.relay_url = l.relay_url AND m.timestamp = l.ts
      ),
      qualifying_monitors AS (
        SELECT monitor_pubkey
        FROM latest_only
        GROUP BY monitor_pubkey
        HAVING COUNT(DISTINCT relay_url) >= 20
      ),
      percentiles AS (
        SELECT
          relay_url,
          monitor_pubkey,
          rtt_read,
          -- PERCENT_RANK gives 0-1 position; invert so lower RTT = higher percentile
          (1.0 - PERCENT_RANK() OVER (PARTITION BY monitor_pubkey ORDER BY rtt_open ASC)) * 100 as connect_pct,
          (1.0 - PERCENT_RANK() OVER (PARTITION BY monitor_pubkey ORDER BY rtt_read ASC)) * 100 as read_pct
        FROM latest_only
        WHERE monitor_pubkey IN (SELECT monitor_pubkey FROM qualifying_monitors)
          AND rtt_open IS NOT NULL
      )
      SELECT
        relay_url,
        AVG(connect_pct) as connect_percentile,
        AVG(read_pct) as read_percentile,
        -- Use connect-only when read data unavailable, otherwise 30/70 weighted
        AVG(CASE
          WHEN rtt_read IS NULL THEN connect_pct
          ELSE connect_pct * 0.3 + read_pct * 0.7
        END) as latency_score,
        COUNT(*) as qualifying_monitor_count
      FROM percentiles
      GROUP BY relay_url
    `, staleThreshold, sinceTimestamp);

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
        isHosting: row.is_hosting != null ? !!row.is_hosting : undefined,
        isTor: row.is_tor != null ? !!row.is_tor : undefined,
        resolvedAt: Number(row.resolved_at),
      });
    }
    return result;
  }

  /**
   * Get ALL operator resolutions in a single query
   * Joins with operators table to include WoT data
   */
  async getAllOperatorResolutions(): Promise<Map<string, OperatorResolution>> {
    const db = await this.ensureReady();
    const rows = await db.all(`
      SELECT m.*, o.wot_score, o.wot_confidence, o.wot_provider_count
      FROM operator_mappings m
      LEFT JOIN operators o ON m.operator_pubkey = o.pubkey
    `);

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

      // Add WoT fields if present (from joined operators table)
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

    // Most recent score snapshot per relay. GROUP BY MAX(timestamp) over the
    // score_history PK (relay_url, timestamp) + join uses the covering index;
    // ~30x cheaper than a ROW_NUMBER() window scan of the whole table.
    const rows = await db.all(`
      SELECT sh.relay_url, sh.score, sh.reliability, sh.quality, sh.accessibility, sh.timestamp
      FROM score_history sh
      JOIN (
        SELECT relay_url, MAX(timestamp) AS ts
        FROM score_history GROUP BY relay_url
      ) m ON sh.relay_url = m.relay_url AND sh.timestamp = m.ts
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
  async cleanupOldData(opts: {
    scoreHistoryDays?: number;
    reportDays?: number;
    probeDays?: number;
    nip66Days?: number;
  } | number = {}): Promise<{
    probes: number;
    nip66Metrics: number;
    reports: number;
    scoreHistory: number;
  }> {
    const db = await this.ensureReady();
    // Back-compat: a bare number means "same window for everything".
    const o = typeof opts === 'number'
      ? { scoreHistoryDays: opts, reportDays: opts, probeDays: opts, nip66Days: opts }
      : opts;
    const scoreHistoryDays = o.scoreHistoryDays ?? 90;
    const reportDays = o.reportDays ?? 90;
    const probeDays = o.probeDays ?? 45;
    const nip66Days = o.nip66Days ?? 45;

    const now = Math.floor(Date.now() / 1000);
    const cut = (days: number) => now - days * 86400;
    const probeCut = cut(probeDays);
    const nip66Cut = cut(nip66Days);
    const reportCut = cut(reportDays);
    const historyCut = cut(scoreHistoryDays);

    // Counts before deletion (for reporting), each with its own window.
    const [probesResult] = await db.all(`SELECT COUNT(*) as count FROM probes WHERE timestamp < ?`, probeCut);
    const [nip66Result] = await db.all(`SELECT COUNT(*) as count FROM nip66_metrics WHERE timestamp < ?`, nip66Cut);
    const [reportsResult] = await db.all(`SELECT COUNT(*) as count FROM relay_reports WHERE timestamp < ?`, reportCut);
    const [historyResult] = await db.all(`SELECT COUNT(*) as count FROM score_history WHERE timestamp < ?`, historyCut);

    // Delete old data per table (parameterized).
    await db.run(`DELETE FROM probes WHERE timestamp < ?`, probeCut);
    await db.run(`DELETE FROM nip66_metrics WHERE timestamp < ?`, nip66Cut);
    await db.run(`DELETE FROM relay_reports WHERE timestamp < ?`, reportCut);
    await db.run(`DELETE FROM score_history WHERE timestamp < ?`, historyCut);

    // Strip nip11_json from probes older than 7 days to reduce DB size.
    // NIP-11 data is only needed from recent probes; older probes only need
    // reachability and timing data for scoring.
    const nip11Cutoff = now - (7 * 86400);
    await db.run(`UPDATE probes SET nip11_json = NULL WHERE timestamp < ? AND nip11_json IS NOT NULL`, nip11Cutoff);

    // Reclaim freed pages incrementally (the DB uses auto_vacuum=INCREMENTAL).
    // This truncates freelist pages back to the OS without the multi-second,
    // event-loop-blocking full-database rebuild a plain VACUUM performs.
    try {
      await db.run('PRAGMA incremental_vacuum');
    } catch (err) {
      console.error('incremental_vacuum failed (non-fatal, will retry next cleanup):', err);
    }

    return {
      probes: Number((probesResult as any)?.count ?? 0),
      nip66Metrics: Number((nip66Result as any)?.count ?? 0),
      reports: Number((reportsResult as any)?.count ?? 0),
      scoreHistory: Number((historyResult as any)?.count ?? 0),
    };
  }

  // ============================================================================
  // ANALYTICS METHODS - Advanced analytics queries using SQL window functions
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

    // Most recent score snapshot per relay via GROUP BY MAX(timestamp) + join
    // (covering-index lookup over the score_history PK; ~30x cheaper than a
    // ROW_NUMBER() window scan of the whole table).
    const rows = await db.all(`
      SELECT sh.relay_url as url, sh.score, sh.reliability, sh.quality, sh.accessibility,
             sh.observations, sh.timestamp as last_updated
      FROM score_history sh
      JOIN (
        SELECT relay_url, MAX(timestamp) AS ts
        FROM score_history GROUP BY relay_url
      ) m ON sh.relay_url = m.relay_url AND sh.timestamp = m.ts
      ORDER BY sh.score DESC NULLS LAST
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
   * Get rolling averages for all relays using SQL aggregates
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

    // SQLite has no STDDEV_SAMP. Compute the sample variance in SQL via the
    // closed form (SUM(x²) − SUM(x)²/n) / (n−1) and take the square root in JS
    // (sqrt() is an optional SQLite math-extension function we don't rely on).
    const rows = await db.all(`
      WITH base AS (
        SELECT
          relay_url,
          score,
          CASE WHEN timestamp >= ? THEN score END AS score7,
          CASE WHEN timestamp >= ? THEN score END AS score30
        FROM score_history
        WHERE score IS NOT NULL AND timestamp >= ?
      )
      SELECT
        relay_url,
        AVG(score7) as rolling_7d,
        AVG(score30) as rolling_30d,
        AVG(score) as rolling_90d,
        CASE WHEN COUNT(score30) > 1
          THEN (SUM(score30 * score30) - SUM(score30) * SUM(score30) / COUNT(score30))
               / (COUNT(score30) - 1)
        END as volatility_var
      FROM base
      GROUP BY relay_url
    `, days7, days30, days90);

    const result = new Map();
    for (const row of rows as any[]) {
      const variance = row.volatility_var;
      result.set(row.relay_url, {
        rolling7d: row.rolling_7d !== null ? Math.round(row.rolling_7d) : null,
        rolling30d: row.rolling_30d !== null ? Math.round(row.rolling_30d) : null,
        rolling90d: row.rolling_90d !== null ? Math.round(row.rolling_90d) : null,
        volatility: variance != null ? Math.round(Math.sqrt(Math.max(0, variance)) * 10) / 10 : null,
      });
    }
    return result;
  }

  /**
   * Get trend analysis data for all relays using SQL
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

    // Single GROUP BY pass over the period computes the per-relay regression
    // sums (closed-form least-squares slope), point count, and the first/last
    // timestamps; the scores AT those timestamps are then fetched with two
    // covering-index (PK) joins. This avoids the previous two ROW_NUMBER window
    // sorts + a second full scan (~7.7s → sub-second with the covering index).
    const rows = await db.all(`
      WITH pts AS (
        SELECT relay_url, timestamp, score, (timestamp - ?) / 86400.0 AS x
        FROM score_history
        WHERE timestamp >= ? AND score IS NOT NULL
      ),
      agg AS (
        SELECT
          relay_url,
          MIN(timestamp) AS first_ts,
          MAX(timestamp) AS last_ts,
          COUNT(*) AS data_points,
          SUM(x) AS sx, SUM(score) AS sy, SUM(x * score) AS sxy, SUM(x * x) AS sxx
        FROM pts
        GROUP BY relay_url
      )
      SELECT
        a.relay_url,
        fs.score AS first_score,
        ls.score AS last_score,
        a.first_ts AS first_timestamp,
        a.last_ts AS last_timestamp,
        a.data_points,
        CASE WHEN a.data_points >= 2
          THEN (a.data_points * a.sxy - a.sx * a.sy)
               / NULLIF(a.data_points * a.sxx - a.sx * a.sx, 0)
        END AS slope
      FROM agg a
      JOIN score_history fs ON fs.relay_url = a.relay_url AND fs.timestamp = a.first_ts
      JOIN score_history ls ON ls.relay_url = a.relay_url AND ls.timestamp = a.last_ts
    `, periodStart, periodStart);

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

  // ============================================================================
  // NETWORK STATS - Aggregate analytics across all relays
  // ============================================================================

  /**
   * Compute comprehensive network statistics using SQL analytical functions.
   * This is computationally expensive - results should be cached.
   */
  async computeNetworkStats(periodDays: number = 7): Promise<NetworkStats> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);
    const periodStart = now - (periodDays * 86400);
    const prevPeriodStart = periodStart - (periodDays * 86400);

    // Fetch the latest score row per relay ONCE (joined with jurisdiction) and
    // derive the summary, percentiles, distribution and geographic breakdown
    // from it in JS. Using GROUP BY MAX(timestamp) over the score_history
    // PRIMARY KEY (relay_url, timestamp) — without a non-indexed WHERE on it —
    // lets SQLite use the covering index, which is ~30x cheaper than a
    // ROW_NUMBER() window scan of the whole table, and collapses four
    // full-table passes into one.
    const latestRows = (await db.all(`
      SELECT sh.relay_url, sh.score, sh.reliability, sh.quality, sh.accessibility,
             j.country_code, j.country_name
      FROM score_history sh
      JOIN (
        SELECT relay_url, MAX(timestamp) AS ts
        FROM score_history GROUP BY relay_url
      ) m ON sh.relay_url = m.relay_url AND sh.timestamp = m.ts
      LEFT JOIN relay_jurisdictions j ON sh.relay_url = j.relay_url
      WHERE sh.score IS NOT NULL
    `)) as any[];

    const num = (v: any) => Number(v ?? 0);
    const totalScored = latestRows.length;
    const avg = (sel: (r: any) => number) =>
      totalScored ? latestRows.reduce((a, r) => a + sel(r), 0) / totalScored : 0;

    // Summary aggregates (AVG/health counts) in JS.
    const summary = {
      total_relays: totalScored,
      avg_score: avg((r) => num(r.score)),
      healthy_count: latestRows.filter((r) => num(r.score) >= 70).length,
      degraded_count: latestRows.filter((r) => num(r.score) >= 50 && num(r.score) < 70).length,
      poor_count: latestRows.filter((r) => num(r.score) < 50).length,
      avg_reliability: avg((r) => num(r.reliability)),
      avg_quality: avg((r) => num(r.quality)),
      avg_accessibility: avg((r) => num(r.accessibility)),
    };

    // Median / quartiles / stddev have no SQLite aggregate — compute in JS.
    const currentScores = latestRows
      .map((r) => Number(r.score))
      .filter((s) => Number.isFinite(s))
      .sort((a, b) => a - b);
    const medianScore = percentileCont(currentScores, 0.5);
    const p25Score = percentileCont(currentScores, 0.25);
    const p75Score = percentileCont(currentScores, 0.75);
    const stddevScore = sampleStddev(currentScores);

    // Distribution histogram in JS.
    const bucketOf = (s: number) =>
      s >= 90 ? '90-100' : s >= 80 ? '80-89' : s >= 70 ? '70-79' : s >= 60 ? '60-69' : s >= 50 ? '50-59' : '<50';
    const distCounts = new Map<string, number>();
    for (const r of latestRows) {
      const b = bucketOf(num(r.score));
      distCounts.set(b, (distCounts.get(b) ?? 0) + 1);
    }
    const distributionRows = ['90-100', '80-89', '70-79', '60-69', '50-59', '<50']
      .filter((b) => distCounts.has(b))
      .map((b) => ({ bucket: b, count: distCounts.get(b)! }));

    // Network trend over time (daily averages). Per-day median is computed in
    // JS (no SQLite percentile aggregate) from the raw daily scores below.
    const trendRows = await db.all(`
      SELECT
        CAST(timestamp / 86400 AS INTEGER) * 86400 as day,
        AVG(score) as avg_score,
        COUNT(DISTINCT relay_url) as relay_count
      FROM score_history
      WHERE timestamp >= ? AND score IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `, periodStart);

    // Collect per-day scores once and compute each day's median in JS.
    const trendScoreRows = await db.all(`
      SELECT CAST(timestamp / 86400 AS INTEGER) * 86400 as day, score
      FROM score_history
      WHERE timestamp >= ? AND score IS NOT NULL
    `, periodStart);
    const scoresByDay = new Map<number, number[]>();
    for (const r of trendScoreRows as any[]) {
      const day = Number(r.day);
      const arr = scoresByDay.get(day);
      if (arr) arr.push(Number(r.score));
      else scoresByDay.set(day, [Number(r.score)]);
    }
    const trendMedianByDay = new Map<number, number | null>();
    for (const [day, scores] of scoresByDay) {
      scores.sort((a, b) => a - b);
      trendMedianByDay.set(day, percentileCont(scores, 0.5));
    }

    // Compare with previous period for "vs last week" stats
    const compareRows = await db.all(`
      WITH current_agg AS (
        SELECT AVG(sh.score) as avg_score, COUNT(*) as cnt,
          SUM(CASE WHEN sh.score >= 70 THEN 1 ELSE 0 END) as healthy
        FROM score_history sh
        JOIN (
          SELECT relay_url, MAX(timestamp) AS ts
          FROM score_history WHERE timestamp >= ? GROUP BY relay_url
        ) m ON sh.relay_url = m.relay_url AND sh.timestamp = m.ts
        WHERE sh.score IS NOT NULL
      ),
      prev_agg AS (
        SELECT AVG(sh.score) as avg_score, COUNT(*) as cnt,
          SUM(CASE WHEN sh.score >= 70 THEN 1 ELSE 0 END) as healthy
        FROM score_history sh
        JOIN (
          SELECT relay_url, MAX(timestamp) AS ts
          FROM score_history WHERE timestamp >= ? AND timestamp < ? GROUP BY relay_url
        ) m ON sh.relay_url = m.relay_url AND sh.timestamp = m.ts
        WHERE sh.score IS NOT NULL
      )
      SELECT
        c.avg_score as current_avg,
        p.avg_score as prev_avg,
        c.cnt as current_count,
        p.cnt as prev_count,
        c.healthy as current_healthy,
        p.healthy as prev_healthy
      FROM current_agg c, prev_agg p
    `, periodStart, prevPeriodStart, periodStart);

    const compare = (compareRows[0] as any) || {};

    // Geographic breakdown, derived in JS from the latest-per-relay set above
    // (jurisdiction was joined into latestRows), keyed by country.
    const geoMap = new Map<string, { country_code: string; country_name: string; scores: number[]; reliabilities: number[] }>();
    for (const r of latestRows) {
      const code = r.country_code ?? 'Unknown';
      const name = r.country_name ?? 'Unknown';
      let g = geoMap.get(code);
      if (!g) { g = { country_code: code, country_name: name, scores: [], reliabilities: [] }; geoMap.set(code, g); }
      g.scores.push(num(r.score));
      g.reliabilities.push(num(r.reliability));
    }
    const geoRows = Array.from(geoMap.values())
      .map((g) => ({
        country_code: g.country_code,
        country_name: g.country_name,
        relay_count: g.scores.length,
        avg_score: g.scores.reduce((a, b) => a + b, 0) / g.scores.length,
        avg_reliability: g.reliabilities.reduce((a, b) => a + b, 0) / g.reliabilities.length,
      }))
      .sort((a, b) => b.relay_count - a.relay_count);

    // Top movers (biggest score changes)
    const moversRows = await db.all(`
      WITH period_scores AS (
        SELECT relay_url, score, timestamp,
          FIRST_VALUE(score) OVER (PARTITION BY relay_url ORDER BY timestamp ASC) as first_score,
          LAST_VALUE(score) OVER (PARTITION BY relay_url ORDER BY timestamp ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as last_score
        FROM score_history
        WHERE timestamp >= ? AND score IS NOT NULL
      ),
      changes AS (
        SELECT DISTINCT relay_url,
          last_score - first_score as change,
          first_score,
          last_score
        FROM period_scores
      )
      SELECT * FROM changes WHERE ABS(change) >= 3 ORDER BY change DESC
    `, periodStart);

    // Churn analysis
    const churnRows = await db.all(`
      WITH latest_probes AS (
        -- Only MIN/MAX(timestamp) per url is needed (churn windows), which the
        -- probes PK (url, timestamp) serves as a covering index. Aggregating
        -- reachable/total here would force a full row read (~10x slower).
        SELECT url, MAX(timestamp) as last_seen,
          MIN(timestamp) as first_seen
        FROM probes
        GROUP BY url
      )
      SELECT
        COUNT(*) FILTER (WHERE first_seen >= ?) as new_relays,
        COUNT(*) FILTER (WHERE last_seen < ? AND last_seen >= ?) as went_offline,
        COUNT(*) FILTER (WHERE last_seen < ?) as zombie_relays
      FROM latest_probes
    `, periodStart, now - 86400, periodStart, now - (30 * 86400));

    const churn = (churnRows[0] as any) || {};

    // Build result
    const totalRelays = Number(summary.total_relays ?? 0);

    return {
      computedAt: now,
      periodDays,
      summary: {
        totalRelays,
        avgScore: Math.round((summary.avg_score ?? 0) * 10) / 10,
        medianScore: Math.round(medianScore ?? 0),
        p25Score: Math.round(p25Score ?? 0),
        p75Score: Math.round(p75Score ?? 0),
        stddev: Math.round((stddevScore ?? 0) * 10) / 10,
        healthyCount: Number(summary.healthy_count ?? 0),
        healthyPercent: totalRelays > 0 ? Math.round((Number(summary.healthy_count ?? 0) / totalRelays) * 100) : 0,
        degradedCount: Number(summary.degraded_count ?? 0),
        poorCount: Number(summary.poor_count ?? 0),
        avgReliability: Math.round(summary.avg_reliability ?? 0),
        avgQuality: Math.round(summary.avg_quality ?? 0),
        avgAccessibility: Math.round(summary.avg_accessibility ?? 0),
      },
      comparison: {
        avgScoreChange: compare.current_avg != null && compare.prev_avg != null
          ? Math.round((Number(compare.current_avg) - Number(compare.prev_avg)) * 10) / 10
          : null,
        relayCountChange: Number(compare.current_count ?? 0) - Number(compare.prev_count ?? 0),
        healthyPercentChange: compare.current_count && compare.prev_count
          ? Math.round((Number(compare.current_healthy) / Number(compare.current_count) - Number(compare.prev_healthy) / Number(compare.prev_count)) * 100)
          : null,
      },
      distribution: distributionRows.map((r: any) => ({
        bucket: r.bucket,
        count: Number(r.count),
        percent: totalRelays > 0 ? Math.round((Number(r.count) / totalRelays) * 100) : 0,
      })),
      trend: trendRows.map((r: any) => ({
        timestamp: Number(r.day),
        avgScore: Math.round((r.avg_score ?? 0) * 10) / 10,
        medianScore: Math.round(trendMedianByDay.get(Number(r.day)) ?? 0),
        relayCount: Number(r.relay_count),
      })),
      geographic: geoRows.map((r: any) => ({
        countryCode: r.country_code,
        countryName: r.country_name,
        relayCount: Number(r.relay_count),
        avgScore: Math.round((r.avg_score ?? 0) * 10) / 10,
        avgReliability: Math.round(r.avg_reliability ?? 0),
      })),
      topMovers: {
        improving: moversRows
          .filter((r: any) => Number(r.change) > 0)
          .slice(0, 10)
          .map((r: any) => ({
            relayUrl: r.relay_url,
            change: Number(r.change),
            fromScore: Number(r.first_score),
            toScore: Number(r.last_score),
          })),
        declining: moversRows
          .filter((r: any) => Number(r.change) < 0)
          .slice(-10)
          .reverse()
          .map((r: any) => ({
            relayUrl: r.relay_url,
            change: Number(r.change),
            fromScore: Number(r.first_score),
            toScore: Number(r.last_score),
          })),
      },
      churn: {
        newRelays: Number(churn.new_relays ?? 0),
        wentOffline: Number(churn.went_offline ?? 0),
        zombieRelays: Number(churn.zombie_relays ?? 0),
      },
    };
  }

  /**
   * Cache network stats for a specific period
   */
  async cacheNetworkStats(period: string, stats: NetworkStats): Promise<void> {
    const db = await this.ensureReady();
    await db.run(
      `INSERT INTO network_stats_cache (period, computed_at, stats_json)
       VALUES (?, ?, ?)
       ON CONFLICT (period) DO UPDATE SET
         computed_at = excluded.computed_at,
         stats_json = excluded.stats_json`,
      period,
      stats.computedAt,
      JSON.stringify(stats)
    );
  }

  /**
   * Get cached network stats for a period
   * Returns null if cache is stale (older than maxAgeSeconds)
   */
  async getCachedNetworkStats(period: string, maxAgeSeconds: number = 3600): Promise<NetworkStats | null> {
    const db = await this.ensureReady();
    const now = Math.floor(Date.now() / 1000);

    const rows = await db.all(
      `SELECT stats_json, computed_at FROM network_stats_cache WHERE period = ?`,
      period
    );

    if (rows.length === 0) return null;

    const row = rows[0] as any;
    const age = now - Number(row.computed_at);

    if (age > maxAgeSeconds) return null;

    try {
      return JSON.parse(row.stats_json) as NetworkStats;
    } catch {
      return null;
    }
  }

  /**
   * Get network stats, using cache if available, otherwise compute fresh
   */
  async getNetworkStats(periodDays: number = 7, maxCacheAgeSeconds: number = 3600): Promise<NetworkStats> {
    const period = `${periodDays}d`;

    // Try cache first
    const cached = await this.getCachedNetworkStats(period, maxCacheAgeSeconds);
    if (cached) return cached;

    // Compute fresh
    const stats = await this.computeNetworkStats(periodDays);

    // Cache for future requests
    await this.cacheNetworkStats(period, stats);

    return stats;
  }

  /**
   * Checkpoint the WAL file to prevent unbounded WAL growth.
   * TRUNCATE pushes committed pages into the main DB and resets the WAL file.
   * Should be called periodically and before shutdown.
   *
   * @param force - retained for API compatibility (TRUNCATE is always used)
   * @returns true if checkpoint succeeded, false otherwise
   */
  async checkpoint(_force: boolean = true): Promise<boolean> {
    const db = await this.ensureReady();
    try {
      await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch (err) {
      console.error('Checkpoint failed:', err);
      return false;
    }
  }

  /**
   * Get the WAL file size in bytes.
   * Returns 0 if WAL file doesn't exist.
   */
  getWalFileSize(): number {
    try {
      const walPath = this.dbPath + '-wal';
      const fs = require('fs');
      const stats = fs.statSync(walPath);
      return stats.size;
    } catch {
      // WAL file doesn't exist or can't be read
      return 0;
    }
  }

  /**
   * Get the WAL file size in megabytes (for logging).
   */
  getWalFileSizeMB(): number {
    return Math.round(this.getWalFileSize() / (1024 * 1024) * 10) / 10;
  }

  /**
   * Get the oldest probe timestamp to determine data availability
   */
  async getOldestProbeTimestamp(): Promise<number | null> {
    const db = await this.ensureReady();
    const rows = await db.all(`SELECT MIN(timestamp) as oldest FROM probes`);
    const oldest = (rows[0] as any)?.oldest;
    return oldest ? Number(oldest) : null;
  }

  async close(): Promise<void> {
    if (this.sqlite) {
      // Checkpoint + truncate the WAL before closing so we don't leave a stale
      // WAL behind for the next open.
      try {
        this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Ignore checkpoint errors during close
      }
      this.sqlite.close();
      this.sqlite = null;
      this.db = null;
    }
  }
}
