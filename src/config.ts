import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs';
import { isValidPrivateKey } from './key-utils.js';
import { ALGORITHM_VERSION, ALGORITHM_URL } from './version.js';

/**
 * Service configuration
 */
export interface ServiceConfig {
  // Provider identity
  provider: {
    privateKey?: string;  // Hex private key (can also use NOSTR_PRIVATE_KEY env)
    algorithmVersion: string;
    algorithmUrl: string;
  };

  // Target relays to evaluate
  targets: {
    // Static list of relay URLs to monitor
    relays: string[];
    // Whether to discover relays from NIP-66 monitors
    discoverFromMonitors: boolean;
    // Maximum relays to track (prevents unbounded growth)
    maxRelays: number;
  };

  // Data source configuration
  sources: {
    // Relays to query for NIP-66 and report data
    sourceRelays: string[];
    // Trusted NIP-66 monitor pubkeys (always trusted; auto-discovery adds more,
    // gated by cross-source corroboration + maxMonitors below).
    trustedMonitors: string[];
    // Cap on total auto-trusted monitors (Sybil bound). Default 200.
    maxMonitors?: number;
    // Min distinct source relays that must announce a NOT-yet-trusted monitor
    // before it is auto-trusted (Sybil corroboration). Default 2.
    minMonitorSources?: number;
  };

  // Publishing configuration
  publishing: {
    // Enable/disable publishing (set to false for probe-only mode)
    enabled: boolean;
    // Relays to publish assertions to
    relays: string[];
    // Minimum score change to trigger republish
    materialChangeThreshold: number;
    // Minimum observations before publishing
    minObservations: number;
    // Minimum delay between publishing events (milliseconds)
    // Helps avoid rate limiting on target relays
    minPublishDelayMs: number;
    // Use persistent connection pool (recommended for many relays)
    useConnectionPool: boolean;
  };

  // Probing configuration
  probing?: {
    // Number of relays to probe concurrently (default: 30)
    concurrency: number;
    // A relay with no successful probe in this many days (and >=3 attempts) is
    // demoted from every-cycle probing to a periodic revival check (default: 7).
    demoteAfterDays?: number;
    // How often (hours) demoted relays get a revival probe (default: 24).
    revivalIntervalHours?: number;
  };

  // Timing intervals (in seconds)
  intervals: {
    // How often to run a full cycle (probe → publish)
    cycle: number;
    // How often to ingest NIP-66 metrics
    nip66Ingest: number;
    // How often to ingest reports
    reportIngest: number;
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };

  // Database
  database: {
    path: string;
    // Retention for score_history (and the default for reports). Must be >= the
    // longest analytics window (90d rolling averages), so keep at 90+.
    retentionDays: number;
    // Retention for raw probe rows (reliability scoring only looks back ~30d).
    probeRetentionDays?: number;
    // Retention for nip66_metrics (RTT stats use recent samples).
    nip66RetentionDays?: number;
  };

  // API server (optional, runs inside daemon)
  api?: {
    enabled: boolean;
    port: number;
    host: string;
    // Trust the cf-connecting-ip / x-forwarded-for header for client IP.
    // Only enable when a trusted reverse proxy (e.g. Cloudflare) is the real
    // ingress; otherwise clients can spoof these headers to bypass rate limits.
    trustProxy?: boolean;
  };
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: ServiceConfig = {
  provider: {
    algorithmVersion: ALGORITHM_VERSION,
    algorithmUrl: ALGORITHM_URL,
  },

  targets: {
    relays: [
      'wss://relay.damus.io',
      'wss://relay.primal.net',
      'wss://nos.lol',
      'wss://relay.nostr.band',
      'wss://relay.snort.social',
      'wss://nostr.wine',
      'wss://relay.current.fyi',
      'wss://nostr-pub.wellorder.net',
    ],
    discoverFromMonitors: true,
    maxRelays: 500,
  },

  sources: {
    // Relays to query for NIP-66 monitor data and user reports
    sourceRelays: [
      'wss://relay.nostr.watch',  // Primary source for NIP-66 monitor data
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ],
    // Known NIP-66 monitors (additional monitors discovered automatically)
    trustedMonitors: [
      '9bbbb845e5b6c831c29789900769843ab43bb5047abe697870cb50b6fc9bf923',  // nostr.watch Amsterdam
    ],
    // Auto-discovery Sybil controls: a new monitor must be announced by this
    // many distinct source relays before it's trusted, capped at maxMonitors.
    minMonitorSources: 2,
    maxMonitors: 200,
  },

  publishing: {
    enabled: true,            // Set to false for probe-only mode
    relays: [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
      'wss://ditto.pub/relay',
    ],
    materialChangeThreshold: 3,
    minObservations: 10,
    minPublishDelayMs: 2000,  // 2 seconds between events
    useConnectionPool: true,  // Use persistent connections
  },

  probing: {
    concurrency: 30,          // Probe 30 relays concurrently
    demoteAfterDays: 7,       // Demote relays dead >7d to periodic revival probing
    revivalIntervalHours: 24, // Re-probe demoted relays once a day
  },

  intervals: {
    cycle: 3600,          // 1 hour (probe → publish)
    nip66Ingest: 600,     // 10 minutes
    reportIngest: 900,    // 15 minutes
  },

  logging: {
    level: 'info',
  },

  database: {
    path: './data/trustedrelays.sqlite',
    retentionDays: 90,
    probeRetentionDays: 45,
    nip66RetentionDays: 45,
  },

  api: {
    enabled: true,
    port: 3000,
    host: '0.0.0.0',
  },
};

/**
 * Load configuration from file, merging with defaults
 */
export function loadConfig(configPath: string): ServiceConfig {
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  // Warn if the config (which may contain provider.privateKey) is group/world
  // readable. Prefer chmod 600, or supply the key via NOSTR_PRIVATE_KEY.
  try {
    const mode = statSync(configPath).mode;
    if (mode & 0o077) {
      console.warn(`[config] WARNING: ${configPath} is group/world-accessible (mode ${(mode & 0o777).toString(8)}). It may contain your private key — run: chmod 600 ${configPath}`);
    }
  } catch { /* stat failure is non-fatal */ }

  let fileContent: string;
  let fileConfig: unknown;
  try {
    fileContent = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config from ${configPath}: ${(err as Error).message}`);
  }
  try {
    fileConfig = JSON.parse(fileContent);
  } catch (err) {
    // Fail fast: silently falling back to defaults could run with unintended
    // targets/relays and publishing.enabled=true.
    throw new Error(`Invalid JSON in config ${configPath}: ${(err as Error).message}`);
  }
  return mergeConfig(DEFAULT_CONFIG, fileConfig as Partial<ServiceConfig>);
}

/**
 * Deep merge configuration objects
 */
function mergeConfig(base: ServiceConfig, override: Partial<ServiceConfig>): ServiceConfig {
  const result = { ...base };

  if (override.provider) {
    result.provider = { ...base.provider, ...override.provider };
  }
  if (override.targets) {
    result.targets = { ...base.targets, ...override.targets };
  }
  if (override.sources) {
    result.sources = { ...base.sources, ...override.sources };
  }
  if (override.publishing) {
    result.publishing = { ...base.publishing, ...override.publishing };
  }
  if (override.intervals) {
    result.intervals = { ...base.intervals, ...override.intervals };
  }
  if (override.logging) {
    result.logging = { ...base.logging, ...override.logging };
  }
  if (override.database) {
    result.database = { ...base.database, ...override.database };
  }
  if (override.api) {
    result.api = { ...base.api, ...override.api };
  }
  if (override.probing) {
    result.probing = { ...base.probing, ...override.probing };
  }

  return result;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ServiceConfig, configPath: string): void {
  const content = JSON.stringify(config, null, 2);
  writeFileSync(configPath, content, 'utf-8');
  // Config may contain a private key; restrict to owner read/write only.
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // chmod is best-effort (e.g. unsupported FS); ignore failures.
  }
}

/**
 * Generate a sample configuration file
 */
export function generateSampleConfig(configPath: string): void {
  const sampleConfig: ServiceConfig = {
    ...DEFAULT_CONFIG,
    provider: {
      ...DEFAULT_CONFIG.provider,
      privateKey: '<your_hex_private_key_here>',
    },
  };
  saveConfig(sampleConfig, configPath);
}

/**
 * Validate configuration
 */
export function validateConfig(config: ServiceConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for private key only if publishing is enabled
  if (config.publishing.enabled) {
    const privateKey = config.provider.privateKey || process.env.NOSTR_PRIVATE_KEY;
    if (!privateKey) {
      errors.push('No private key configured (set provider.privateKey or NOSTR_PRIVATE_KEY env)');
    } else if (!isValidPrivateKey(privateKey)) {
      errors.push('Private key must be 64-char hex or nsec format');
    }
  }

  // Check targets
  if (config.targets.relays.length === 0 && !config.targets.discoverFromMonitors) {
    errors.push('No target relays configured and discovery is disabled');
  }

  // Check intervals are reasonable
  if (config.intervals.cycle < 300) {
    errors.push('Cycle interval too short (minimum 300 seconds)');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
