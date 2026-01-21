import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isValidPrivateKey } from './key-utils.js';

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
    // Trusted NIP-66 monitor pubkeys (empty = discover automatically)
    trustedMonitors: string[];
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
    // Log to file (in addition to console)
    file?: string;
  };

  // Database
  database: {
    path: string;
    // Retention period for historical data (days)
    retentionDays: number;
  };

  // API server (optional, runs inside daemon)
  api?: {
    enabled: boolean;
    port: number;
    host: string;
  };
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: ServiceConfig = {
  provider: {
    algorithmVersion: 'v0.1.1',
    algorithmUrl: 'https://github.com/Letdown2491/trustedrelays/blob/main/ALGORITHM.md',
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
    path: './data/trustedrelays.db',
    retentionDays: 90,
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

  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    const fileConfig = JSON.parse(fileContent);
    return mergeConfig(DEFAULT_CONFIG, fileConfig);
  } catch (err) {
    console.error(`Error loading config from ${configPath}:`, err);
    return DEFAULT_CONFIG;
  }
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

  return result;
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ServiceConfig, configPath: string): void {
  const content = JSON.stringify(config, null, 2);
  writeFileSync(configPath, content, 'utf-8');
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
