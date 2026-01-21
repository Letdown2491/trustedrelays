import { mkdirSync, existsSync } from 'fs';
import { probeRelay } from './prober.js';
import { computeCombinedReliabilityScore } from './scorer.js';
import { buildAssertion, assertionToEvent, formatAssertion } from './assertion.js';
import { DataStore } from './database.js';
import { MonitorIngestor, discoverMonitors } from './ingestor.js';
import { resolveOperator } from './operator-resolver.js';
import { ReportIngestor, queryRelayReports } from './report-ingestor.js';
import { computeQualityScore, formatQualityScore } from './quality-scorer.js';
import { computeAccessibilityScore, formatAccessibilityScore } from './accessibility-scorer.js';
import { AssertionPublisher, formatPublishResult, generatePrivateKey } from './assertion-publisher.js';
import { resolveJurisdiction, formatJurisdiction, getCountryFlag } from './jurisdiction.js';
import { queryRelayAppeals, formatAppeal } from './appeal-processor.js';
import { loadConfig, validateConfig, generateSampleConfig } from './config.js';
import { RelayTrustService } from './service.js';
import { startApiServer } from './api.js';
import { normalizePrivateKey, isValidPrivateKey } from './key-utils.js';

const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.nip46.com',
];

const DATA_DIR = './data';
const DB_PATH = `${DATA_DIR}/trustedrelays.db`;

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

async function probeCommand(relayUrls: string[], options: { store?: boolean } = {}) {
  const urls = relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
  const store = options.store ?? true;

  const db = store ? new DataStore(DB_PATH) : null;

  for (const url of urls) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Probing: ${url}`);
    console.log('='.repeat(60));

    try {
      // Probe the relay
      const probe = await probeRelay(url);

      // Store probe result
      if (db) {
        await db.storeProbe(probe);
        console.log('(stored to database)');
      }

      // Display probe results
      console.log('\n--- Probe Results ---');
      console.log(`Relay type: ${probe.relayType}`);
      console.log(`Reachable: ${probe.reachable}`);
      if (probe.connectTime !== undefined) {
        console.log(`Connect time: ${probe.connectTime.toFixed(1)}ms`);
      }
      if (probe.readTime !== undefined) {
        console.log(`Read time: ${probe.readTime.toFixed(1)}ms`);
      } else if (probe.reachable && (probe.relayType === 'nip46' || probe.relayType === 'specialized')) {
        console.log(`Read time: N/A (specialized relay)`);
      }
      if (probe.nip11FetchTime !== undefined) {
        console.log(`NIP-11 fetch: ${probe.nip11FetchTime.toFixed(1)}ms`);
      }
      if (probe.error) {
        console.log(`Error: ${probe.error}`);
      }

      // Display NIP-11 info
      if (probe.nip11) {
        console.log('\n--- NIP-11 Info ---');
        console.log(`Name: ${probe.nip11.name || 'N/A'}`);
        console.log(`Software: ${probe.nip11.software || 'N/A'} ${probe.nip11.version || ''}`);
        console.log(`Contact: ${probe.nip11.contact || 'N/A'}`);
        console.log(`Supported NIPs: ${probe.nip11.supported_nips?.join(', ') || 'N/A'}`);
      }

      // Resolve operator with verification and WoT trust score
      console.log('\n--- Operator Verification ---');
      const operatorResolution = await resolveOperator(url, probe.nip11, {
        fetchTrustScore: true,
        nip85Timeout: 15000,
      });
      if (operatorResolution.operatorPubkey) {
        console.log(`Operator: ${operatorResolution.operatorPubkey}`);
        console.log(`Verified via: ${operatorResolution.verificationMethod} (${operatorResolution.confidence}% confidence)`);
        if (operatorResolution.trustScore !== undefined) {
          console.log(`WoT Trust: ${operatorResolution.trustScore}/100 (${operatorResolution.trustConfidence}, ${operatorResolution.trustProviderCount} provider(s))`);
        }
      } else {
        console.log('Operator: Not found');
      }

      // Cache operator resolution
      if (db && operatorResolution.operatorPubkey) {
        await db.storeOperatorResolution(operatorResolution);
      }

      // Get historical probes if available
      let probes = [probe];
      if (db) {
        const historicalProbes = await db.getProbes(url, 30);
        if (historicalProbes.length > 1) {
          probes = historicalProbes;
          console.log(`\n--- Historical Data ---`);
          console.log(`Probes in last 30 days: ${probes.length}`);
        }
      }

      // Get NIP-66 stats if available
      let nip66Stats = null;
      if (db) {
        nip66Stats = await db.getNip66Stats(url, 365);
        if (nip66Stats.metricCount > 0) {
          console.log(`\n--- NIP-66 Monitor Data ---`);
          console.log(`Metrics: ${nip66Stats.metricCount} from ${nip66Stats.monitorCount} monitor(s)`);
          console.log(`Avg RTT - open: ${nip66Stats.avgRttOpen?.toFixed(0) ?? 'N/A'}ms, read: ${nip66Stats.avgRttRead?.toFixed(0) ?? 'N/A'}ms`);
        }
      }

      // Compute combined score (probes + NIP-66)
      const score = computeCombinedReliabilityScore(probes, nip66Stats);

      console.log('\n--- Reliability Score ---');
      console.log(`Overall: ${score.overall}/100`);
      console.log(`Connect score: ${score.connectScore}/100`);
      console.log(`Read score: ${score.readScore}/100`);
      if (score.observations) {
        console.log(`Observations: ${score.observations} (${score.monitorCount ?? 0} monitors)`);
      }

      // Get relay reports from database or query network
      let reports = db ? await db.getReports(url, 90) : [];
      if (reports.length === 0) {
        console.log('\n--- Community Reports ---');
        console.log('Querying network for reports...');
        reports = await queryRelayReports(url, { timeout: 10000 });
        console.log(`Found ${reports.length} report(s)`);

        // Store reports if we have a database
        if (db && reports.length > 0) {
          for (const report of reports) {
            await db.storeReport(report);
          }
        }
      } else {
        console.log('\n--- Community Reports ---');
        console.log(`Reports in database: ${reports.length}`);
      }

      // Show report breakdown if any
      if (reports.length > 0) {
        const byType = {
          spam: reports.filter(r => r.reportType === 'spam').length,
          censorship: reports.filter(r => r.reportType === 'censorship').length,
          unreliable: reports.filter(r => r.reportType === 'unreliable').length,
          malicious: reports.filter(r => r.reportType === 'malicious').length,
        };
        console.log(`  Spam: ${byType.spam}, Censorship: ${byType.censorship}, Unreliable: ${byType.unreliable}, Malicious: ${byType.malicious}`);
      }

      // Resolve jurisdiction
      console.log('\n--- Jurisdiction ---');
      const jurisdiction = await resolveJurisdiction(url);
      if (db) {
        await db.storeJurisdiction(jurisdiction);
      }
      if (jurisdiction.countryCode) {
        const flag = getCountryFlag(jurisdiction.countryCode);
        console.log(`${flag} ${formatJurisdiction(jurisdiction)}`);
      } else {
        console.log(formatJurisdiction(jurisdiction));
      }

      // Compute quality and accessibility scores
      const qualityScore = computeQualityScore(probe.nip11, url, operatorResolution);
      const accessibilityScore = computeAccessibilityScore(probe.nip11, jurisdiction.countryCode);

      console.log('\n--- Quality Score ---');
      console.log(formatQualityScore(qualityScore));

      console.log('\n--- Accessibility Score ---');
      console.log(formatAccessibilityScore(accessibilityScore));

      // Build assertion with all Phase 4 data
      const assertion = buildAssertion(url, probes, score, operatorResolution, qualityScore, accessibilityScore, {
        reports,
        jurisdiction,
      });

      // Store score snapshot for history
      if (db) {
        await db.storeScoreSnapshot(assertion);
      }

      console.log('\n--- Assertion ---');
      console.log(formatAssertion(assertion));

      // Generate unsigned event
      const event = assertionToEvent(assertion);

      console.log('\n--- Unsigned Kind 30385 Event ---');
      console.log(JSON.stringify(event, null, 2));

    } catch (err) {
      console.error(`Failed to probe ${url}:`, err);
    }
  }

  db?.close();
}

async function statsCommand(relayUrls: string[]) {
  const db = new DataStore(DB_PATH);
  const urls = relayUrls.length > 0 ? relayUrls : await db.getRelayUrls();

  if (urls.length === 0) {
    console.log('No relays in database. Run `probe` first.');
    db.close();
    return;
  }

  for (const url of urls) {
    const stats = await db.getRelayStats(url, 30);

    console.log(`\n${url}`);
    console.log(`  Probes: ${stats.probeCount}`);
    console.log(`  Success rate: ${stats.probeCount > 0 ? ((stats.successCount / stats.probeCount) * 100).toFixed(1) : 0}%`);
    if (stats.avgConnectTime !== null) {
      console.log(`  Avg connect: ${stats.avgConnectTime.toFixed(1)}ms`);
    }
    if (stats.avgReadTime !== null) {
      console.log(`  Avg read: ${stats.avgReadTime.toFixed(1)}ms`);
    }
    if (stats.firstSeen) {
      const firstDate = new Date(stats.firstSeen * 1000).toISOString();
      const lastDate = new Date(stats.lastSeen! * 1000).toISOString();
      console.log(`  First seen: ${firstDate}`);
      console.log(`  Last seen: ${lastDate}`);
    }
  }

  db.close();
}

async function listCommand() {
  const db = new DataStore(DB_PATH);
  const urls = await db.getRelayUrls();

  if (urls.length === 0) {
    console.log('No relays in database. Run `probe` first.');
  } else {
    console.log(`Known relays (${urls.length}):\n`);
    for (const url of urls) {
      const count = await db.getProbeCount(url, 30);
      console.log(`  ${url} (${count} probes)`);
    }
  }

  db.close();
}

async function watchCommand(relayUrls: string[], intervalSecs: number = 300) {
  const urls = relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;

  console.log(`Starting continuous probing every ${intervalSecs}s`);
  console.log(`Relays: ${urls.join(', ')}`);
  console.log('Press Ctrl+C to stop\n');

  const probe = async () => {
    const timestamp = new Date().toISOString();
    console.log(`\n[${timestamp}] Probing ${urls.length} relay(s)...`);
    await probeCommand(urls, { store: true });
  };

  // Initial probe
  await probe();

  // Set up interval
  setInterval(probe, intervalSecs * 1000);
}

async function discoverCommand(sourceRelays: string[]) {
  const relays = sourceRelays.length > 0 ? sourceRelays : [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];

  console.log('Discovering NIP-66 monitors...\n');

  const allMonitors: Map<string, { pubkey: string; frequency?: number; sources: string[] }> = new Map();

  for (const relay of relays) {
    console.log(`Querying ${relay}...`);
    try {
      const monitors = await discoverMonitors(relay, 10000);
      console.log(`  Found ${monitors.length} monitor(s)`);

      for (const m of monitors) {
        const existing = allMonitors.get(m.pubkey);
        if (existing) {
          existing.sources.push(relay);
        } else {
          allMonitors.set(m.pubkey, { ...m, sources: [relay] });
        }
      }
    } catch (err) {
      console.log(`  Error: ${err}`);
    }
  }

  console.log(`\nDiscovered ${allMonitors.size} unique monitor(s):\n`);

  for (const [pubkey, info] of allMonitors) {
    console.log(`  ${pubkey.substring(0, 16)}...`);
    if (info.frequency) {
      console.log(`    Frequency: every ${info.frequency}s`);
    }
    console.log(`    Found on: ${info.sources.length} relay(s)`);
  }

  // Offer to add to trusted monitors
  const db = new DataStore(DB_PATH);
  for (const [pubkey] of allMonitors) {
    await db.addTrustedMonitor(pubkey);
  }
  console.log(`\nAdded ${allMonitors.size} monitor(s) to trusted list.`);
  db.close();
}

async function ingestCommand(sourceRelays: string[]) {
  const db = new DataStore(DB_PATH);

  // Get trusted monitors
  const trustedMonitors = await db.getTrustedMonitors();

  if (trustedMonitors.length === 0) {
    console.log('No trusted monitors configured.');
    console.log('Run `discover` first to find and add monitors.\n');
    db.close();
    return;
  }

  console.log(`Trusted monitors: ${trustedMonitors.length}`);
  for (const m of trustedMonitors) {
    console.log(`  ${m.pubkey.substring(0, 16)}... (${m.eventCount} events)`);
  }

  const relays = sourceRelays.length > 0 ? sourceRelays : [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];

  console.log(`\nSource relays: ${relays.join(', ')}`);
  console.log('Press Ctrl+C to stop\n');

  const ingestor = new MonitorIngestor({
    sourceRelays: relays,
    trustedMonitors: trustedMonitors.map((m) => m.pubkey),
    db,
    onMetric: (relayUrl, metric) => {
      // Log first few events
      if (ingestor.getEventCount() <= 10) {
        console.log(`[${new Date().toISOString()}] ${relayUrl} - RTT open: ${metric.rttOpen ?? 'N/A'}ms`);
      }
    },
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    ingestor.stop();
    db.close();
    process.exit(0);
  });

  await ingestor.start();
}

async function monitorsCommand() {
  const db = new DataStore(DB_PATH);
  const monitors = await db.getTrustedMonitors();

  if (monitors.length === 0) {
    console.log('No trusted monitors configured.');
    console.log('Run `discover` to find monitors.');
  } else {
    console.log(`Trusted monitors (${monitors.length}):\n`);
    for (const m of monitors) {
      console.log(`  ${m.pubkey}`);
      if (m.name) console.log(`    Name: ${m.name}`);
      console.log(`    Events: ${m.eventCount}`);
      if (m.lastSeen) {
        console.log(`    Last seen: ${new Date(m.lastSeen * 1000).toISOString()}`);
      }
    }
  }

  db.close();
}

async function reportsIngestCommand(sourceRelays: string[]) {
  const db = new DataStore(DB_PATH);

  const relays = sourceRelays.length > 0 ? sourceRelays : [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ];

  console.log('Starting relay report ingestion...');
  console.log(`Source relays: ${relays.join(', ')}`);
  console.log('Press Ctrl+C to stop\n');

  const ingestor = new ReportIngestor({
    sourceRelays: relays,
    db,
    fetchTrustScores: true,
    nip85Timeout: 15000,
    onReport: (report) => {
      if (ingestor.getReportCount() <= 20) {
        console.log(`[${new Date().toISOString()}] ${report.relayUrl}`);
        console.log(`  Type: ${report.reportType}, Reporter: ${report.reporterPubkey.slice(0, 8)}...`);
      }
    },
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    console.log(`Total reports ingested: ${ingestor.getReportCount()}`);
    ingestor.stop();
    db.close();
    process.exit(0);
  });

  await ingestor.start();
}

async function reportsStatsCommand(relayUrls: string[]) {
  const db = new DataStore(DB_PATH);

  try {
    const urls = relayUrls.length > 0 ? relayUrls : await db.getReportedRelayUrls();

    if (urls.length === 0) {
      console.log('No reports in database. Run `reports ingest` first.');
      return;
    }

    console.log(`Report stats for ${urls.length} relay(s):\n`);

    for (const url of urls) {
      const stats = await db.getReportStats(url, 90);

      if (stats.reportCount === 0) continue;

      console.log(`${url}`);
      console.log(`  Total reports: ${stats.reportCount} from ${stats.reporterCount} reporter(s)`);
      console.log(`  Weighted total: ${stats.weightedReportCount.toFixed(2)}`);
      console.log(`  By type:`);
      console.log(`    Spam: ${stats.byType.spam.count} (weighted: ${stats.byType.spam.weightedCount.toFixed(2)})`);
      console.log(`    Censorship: ${stats.byType.censorship.count} (weighted: ${stats.byType.censorship.weightedCount.toFixed(2)})`);
      console.log(`    Unreliable: ${stats.byType.unreliable.count} (weighted: ${stats.byType.unreliable.weightedCount.toFixed(2)})`);
      console.log(`    Malicious: ${stats.byType.malicious.count} (weighted: ${stats.byType.malicious.weightedCount.toFixed(2)})`);
      if (stats.firstReport && stats.lastReport) {
        console.log(`  Period: ${new Date(stats.firstReport * 1000).toISOString().split('T')[0]} to ${new Date(stats.lastReport * 1000).toISOString().split('T')[0]}`);
      }
      console.log();
    }
  } finally {
    await db.close();
  }
}

async function nip66StatsCommand(relayUrls: string[]) {
  const db = new DataStore(DB_PATH);

  try {
    // Limit to 20 relays to avoid DuckDB/Bun NAPI crashes with large result sets
    const urls = relayUrls.length > 0 ? relayUrls : await db.getNip66RelayUrls(20);

    if (urls.length === 0) {
      console.log('No NIP-66 data in database. Run `ingest` first.');
      return;
    }

    console.log(`NIP-66 metrics for ${urls.length} relay(s):\n`);

    for (const url of urls) {
      const stats = await db.getNip66Stats(url, 30);

      if (stats.metricCount === 0) continue;

      console.log(`${url}`);
      console.log(`  Metrics: ${stats.metricCount} from ${stats.monitorCount} monitor(s)`);
      if (stats.avgRttOpen !== null) {
        console.log(`  Avg RTT open: ${stats.avgRttOpen.toFixed(1)}ms`);
      }
      if (stats.avgRttRead !== null) {
        console.log(`  Avg RTT read: ${stats.avgRttRead.toFixed(1)}ms`);
      }
      if (stats.firstSeen && stats.lastSeen) {
        console.log(`  Period: ${new Date(stats.firstSeen * 1000).toISOString().split('T')[0]} to ${new Date(stats.lastSeen * 1000).toISOString().split('T')[0]}`);
      }
      console.log();
    }
  } finally {
    await db.close();
  }
}

// Default publish relays
const DEFAULT_PUBLISH_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://ditto.pub/relay',
];

async function publishCommand(relayUrls: string[], options: { force?: boolean } = {}) {
  // Get private key from environment
  const rawKey = process.env.NOSTR_PRIVATE_KEY;
  if (!rawKey) {
    console.error('Error: NOSTR_PRIVATE_KEY environment variable not set.');
    console.error('Set it with: export NOSTR_PRIVATE_KEY=<your_nsec_or_hex_key>');
    console.error('Or generate a new one with: bun run src/index.ts keygen');
    process.exit(1);
  }

  // Validate and normalize private key (accepts nsec or hex)
  if (!isValidPrivateKey(rawKey)) {
    console.error('Error: NOSTR_PRIVATE_KEY must be nsec or 64-char hex format.');
    process.exit(1);
  }
  const privateKey = normalizePrivateKey(rawKey);

  const db = new DataStore(DB_PATH);
  const urls = relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;

  // Get publish relays from environment or use defaults
  const publishRelays = process.env.NOSTR_PUBLISH_RELAYS
    ? process.env.NOSTR_PUBLISH_RELAYS.split(',').map(r => r.trim())
    : DEFAULT_PUBLISH_RELAYS;

  const publisher = new AssertionPublisher({
    privateKey,
    publishRelays,
    materialChangeThreshold: 3,
    db,
  });

  console.log(`Publisher pubkey: ${publisher.getPublicKey()}`);
  console.log(`Publishing to: ${publishRelays.join(', ')}`);
  if (options.force) {
    console.log('Mode: FORCE (bypassing material change check)');
  }
  console.log();

  for (const url of urls) {
    console.log(`${'='.repeat(60)}`);
    console.log(`Processing: ${url}`);
    console.log('='.repeat(60));

    try {
      // Probe the relay
      const probe = await probeRelay(url);
      await db.storeProbe(probe);

      if (!probe.reachable) {
        console.log(`Relay unreachable: ${probe.error}`);
        continue;
      }

      // Resolve operator
      const operatorResolution = await resolveOperator(url, probe.nip11, {
        fetchTrustScore: true,
        nip85Timeout: 15000,
      });

      // Get historical data
      const probes = await db.getProbes(url, 30);
      const nip66Stats = await db.getNip66Stats(url, 365);
      const reports = await db.getReports(url, 90);

      // Get jurisdiction
      let jurisdiction = await db.getJurisdiction(url);
      if (!jurisdiction) {
        jurisdiction = await resolveJurisdiction(url);
        await db.storeJurisdiction(jurisdiction);
      }

      // Compute scores
      const score = computeCombinedReliabilityScore(probes.length > 0 ? probes : [probe], nip66Stats);
      const qualityScore = computeQualityScore(probe.nip11, url, operatorResolution);
      const accessibilityScore = computeAccessibilityScore(probe.nip11, jurisdiction?.countryCode);

      // Build assertion
      const assertion = buildAssertion(url, probes.length > 0 ? probes : [probe], score, operatorResolution, qualityScore, accessibilityScore, { reports, jurisdiction });

      console.log('\n--- Assertion ---');
      console.log(formatAssertion(assertion));

      // Publish
      console.log('\n--- Publishing ---');
      const result = options.force
        ? await publisher.forcePublish(assertion)
        : await publisher.publish(assertion);

      console.log(formatPublishResult(result));
      console.log();

    } catch (err) {
      console.error(`Failed to process ${url}:`, err);
    }
  }

  await db.close();
}

async function publishedCommand() {
  const db = new DataStore(DB_PATH);

  try {
    const assertions = await db.getAllPublishedAssertions();

    if (assertions.length === 0) {
      console.log('No published assertions. Run `publish` first.');
      return;
    }

    console.log(`Published assertions (${assertions.length}):\n`);

    for (const a of assertions) {
      const date = new Date(a.publishedAt * 1000).toISOString();
      console.log(`  ${a.relayUrl}`);
      console.log(`    Event: ${a.eventId.slice(0, 16)}...`);
      console.log(`    Score: ${a.score ?? 'N/A'}, Confidence: ${a.confidence}`);
      console.log(`    Published: ${date}`);
      console.log();
    }
  } finally {
    await db.close();
  }
}

function keygenCommand() {
  const privateKey = generatePrivateKey();
  const privKeyBytes = new Uint8Array(privateKey.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));

  // Use nostr-tools to get pubkey and encode keys
  const { getPublicKey, nip19 } = require('nostr-tools');
  const publicKey = getPublicKey(privKeyBytes);
  const nsec = nip19.nsecEncode(privKeyBytes);
  const npub = nip19.npubEncode(publicKey);

  console.log('Generated new Nostr keypair:\n');
  console.log(`Private key (keep secret!):`);
  console.log(`  nsec: ${nsec}`);
  console.log(`  hex:  ${privateKey}`);
  console.log();
  console.log(`Public key (share this):`);
  console.log(`  npub: ${npub}`);
  console.log(`  hex:  ${publicKey}`);
  console.log();
  console.log('To use this key for publishing:');
  console.log(`  export NOSTR_PRIVATE_KEY=${nsec}`);
}

async function historyCommand(relayUrls: string[], options: { days?: number } = {}) {
  const db = new DataStore(DB_PATH);
  const days = options.days ?? 30;

  try {
    const urls = relayUrls.length > 0 ? relayUrls : await db.getRelayUrls();

    if (urls.length === 0) {
      console.log('No relays in database. Run `probe` first.');
      return;
    }

    console.log(`Score history (last ${days} days):\n`);

    for (const url of urls) {
      const history = await db.getScoreHistory(url, days);

      if (history.length === 0) {
        console.log(`${url}`);
        console.log('  No score history available\n');
        continue;
      }

      const trend = await db.getScoreTrend(url, days);

      console.log(`${url}`);
      console.log(`  Snapshots: ${history.length}`);

      // Show trend info
      if (trend && trend.currentScore !== undefined) {
        const changeStr = trend.change !== undefined
          ? (trend.change > 0 ? `+${trend.change}` : trend.change.toString())
          : 'N/A';
        console.log(`  Current score: ${trend.currentScore}, Previous: ${trend.previousScore ?? 'N/A'}`);
        console.log(`  Change: ${changeStr}, Trend: ${trend.trend}`);
      }

      // Get current scores from most recent history entry
      const latest = history[history.length - 1];
      if (latest) {
        console.log(`  Latest: reliability=${latest.reliability ?? 'N/A'}, quality=${latest.quality ?? 'N/A'}, accessibility=${latest.accessibility ?? 'N/A'}`);
      }

      // Show recent history (most recent first)
      console.log('  Recent snapshots:');
      const recent = history.slice(-5).reverse();
      for (const h of recent) {
        const date = new Date(h.timestamp * 1000).toISOString().split('T')[0];
        console.log(`    ${date}: score=${h.score ?? 'N/A'}, reliability=${h.reliability ?? 'N/A'}, quality=${h.quality ?? 'N/A'}, accessibility=${h.accessibility ?? 'N/A'}`);
      }
      console.log();
    }
  } finally {
    await db.close();
  }
}

async function jurisdictionCommand(relayUrls: string[], options: { refresh?: boolean } = {}) {
  const db = new DataStore(DB_PATH);

  try {
    const urls = relayUrls.length > 0 ? relayUrls : await db.getRelayUrls();

    if (urls.length === 0) {
      console.log('No relays specified. Run `probe` first or provide relay URLs.');
      return;
    }

    console.log(`Jurisdiction info for ${urls.length} relay(s):\n`);

    for (const url of urls) {
      let jurisdiction = options.refresh ? null : await db.getJurisdiction(url);

      if (!jurisdiction) {
        console.log(`Resolving ${url}...`);
        jurisdiction = await resolveJurisdiction(url);
        await db.storeJurisdiction(jurisdiction);
      }

      if (jurisdiction.countryCode) {
        const flag = getCountryFlag(jurisdiction.countryCode);
        console.log(`${flag} ${url}`);
        console.log(`  Country: ${jurisdiction.countryName} (${jurisdiction.countryCode})`);
        if (jurisdiction.region) {
          console.log(`  Region: ${jurisdiction.region}`);
        }
        if (jurisdiction.city) {
          console.log(`  City: ${jurisdiction.city}`);
        }
        if (jurisdiction.ip) {
          console.log(`  IP: ${jurisdiction.ip}`);
        }
        if (jurisdiction.isp) {
          console.log(`  ISP: ${jurisdiction.isp}`);
        }
        if (jurisdiction.asOrg) {
          console.log(`  AS: ${jurisdiction.asn} - ${jurisdiction.asOrg}`);
        }
        if (jurisdiction.isHosting) {
          console.log(`  Type: Datacenter/Hosting`);
        }
        if (jurisdiction.isTor) {
          console.log(`  Type: Tor exit node`);
        }
      } else if (jurisdiction.error) {
        console.log(`${url}`);
        console.log(`  Error: ${jurisdiction.error}`);
      } else {
        console.log(`${url}`);
        console.log(`  Location: Unknown`);
      }
      console.log();
    }

    // Show summary stats
    const stats = await db.getJurisdictionStats();
    if (stats.length > 0) {
      console.log('--- Jurisdiction Summary ---');
      for (const stat of stats.slice(0, 10)) {
        const flag = getCountryFlag(stat.countryCode);
        console.log(`  ${flag} ${stat.countryCode}: ${stat.relayCount} relay(s)`);
      }
    }
  } finally {
    await db.close();
  }
}

async function appealsCommand(relayUrls: string[]) {
  const db = new DataStore(DB_PATH);

  try {
    const urls = relayUrls.length > 0 ? relayUrls : await db.getRelayUrls();

    if (urls.length === 0) {
      console.log('No relays specified. Run `probe` first or provide relay URLs.');
      return;
    }

    console.log(`Querying appeals for ${urls.length} relay(s)...\n`);

    let totalAppeals = 0;

    for (const url of urls) {
      const appeals = await queryRelayAppeals(url, { timeout: 10000 });

      if (appeals.length === 0) {
        continue;
      }

      totalAppeals += appeals.length;

      console.log(`${url}`);
      console.log(`  Appeals: ${appeals.length}`);

      for (const appeal of appeals) {
        // Verify if appealer is operator
        const { isOperator, confidence } = await (async () => {
          const opRes = await db.getOperatorResolution(url);
          if (opRes && opRes.operatorPubkey) {
            const isOp = opRes.operatorPubkey.toLowerCase() === appeal.appealerPubkey.toLowerCase();
            return { isOperator: isOp, confidence: isOp ? opRes.confidence : undefined };
          }
          return { isOperator: false, confidence: undefined };
        })();

        appeal.isOperator = isOperator;
        appeal.operatorConfidence = confidence;

        console.log();
        console.log(formatAppeal(appeal));
      }
      console.log();
    }

    if (totalAppeals === 0) {
      console.log('No appeals found for the specified relays.');
    } else {
      console.log(`Total appeals found: ${totalAppeals}`);
    }
  } finally {
    await db.close();
  }
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'probe':
    probeCommand(args.slice(1));
    break;

  case 'stats':
    statsCommand(args.slice(1));
    break;

  case 'list':
    listCommand();
    break;

  case 'watch': {
    // Parse --interval flag
    const intervalIdx = args.indexOf('--interval');
    let interval = 300;
    let relayArgs = args.slice(1);

    if (intervalIdx !== -1) {
      interval = parseInt(args[intervalIdx + 1], 10) || 300;
      relayArgs = [...args.slice(1, intervalIdx), ...args.slice(intervalIdx + 2)];
    }

    watchCommand(relayArgs, interval);
    break;
  }

  case 'discover':
    discoverCommand(args.slice(1));
    break;

  case 'ingest':
    ingestCommand(args.slice(1));
    break;

  case 'monitors':
    monitorsCommand();
    break;

  case 'nip66':
    nip66StatsCommand(args.slice(1));
    break;

  case 'reports': {
    const subcommand = args[1];
    if (subcommand === 'ingest') {
      reportsIngestCommand(args.slice(2));
    } else if (subcommand === 'stats') {
      reportsStatsCommand(args.slice(2));
    } else {
      console.log('Usage: reports <ingest|stats> [relay_url...]');
    }
    break;
  }

  case 'publish': {
    const forceIdx = args.indexOf('--force');
    const force = forceIdx !== -1;
    const relayArgs = force
      ? [...args.slice(1, forceIdx), ...args.slice(forceIdx + 1)]
      : args.slice(1);
    publishCommand(relayArgs, { force });
    break;
  }

  case 'published':
    publishedCommand();
    break;

  case 'keygen':
    keygenCommand();
    break;

  case 'history': {
    const daysIdx = args.indexOf('--days');
    let days = 30;
    let relayArgs = args.slice(1);

    if (daysIdx !== -1) {
      days = parseInt(args[daysIdx + 1], 10) || 30;
      relayArgs = [...args.slice(1, daysIdx), ...args.slice(daysIdx + 2)];
    }

    historyCommand(relayArgs, { days });
    break;
  }

  case 'jurisdiction': {
    const refreshIdx = args.indexOf('--refresh');
    const refresh = refreshIdx !== -1;
    const relayArgs = refresh
      ? [...args.slice(1, refreshIdx), ...args.slice(refreshIdx + 1)]
      : args.slice(1);
    jurisdictionCommand(relayArgs, { refresh });
    break;
  }

  case 'appeals':
    appealsCommand(args.slice(1));
    break;

  case 'daemon': {
    const configIdx = args.indexOf('--config');
    const configPath = configIdx !== -1 ? args[configIdx + 1] : './config.json';

    // Load and validate config
    const config = loadConfig(configPath);
    const validation = validateConfig(config);

    if (!validation.valid) {
      console.error('Configuration errors:');
      for (const error of validation.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }

    // Create and start service
    const service = new RelayTrustService(config);

    // Handle shutdown with timeout
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        console.log('Force exit...');
        process.exit(1);
      }
      shuttingDown = true;
      console.log('\nReceived shutdown signal...');

      // Force exit after 30 seconds if graceful shutdown hangs
      const forceExitTimer = setTimeout(() => {
        console.error('Shutdown timeout - forcing exit');
        process.exit(1);
      }, 30000);

      try {
        await service.stop();
        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        clearTimeout(forceExitTimer);
        process.exit(1);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Start service
    service.start().catch((err) => {
      console.error('Service failed to start:', err);
      process.exit(1);
    });
    break;
  }

  case 'api': {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 3000;
    const hostIdx = args.indexOf('--host');
    const host = hostIdx !== -1 ? args[hostIdx + 1] : 'localhost';

    const db = new DataStore(DB_PATH);

    const api = startApiServer({ port, host, db });

    // Handle shutdown
    const shutdown = () => {
      console.log('\nShutting down API server...');
      api.stop();
      db.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    break;
  }

  case 'config': {
    const subcommand = args[1];
    const configPath = args[2] || './config.json';

    if (subcommand === 'init') {
      if (existsSync(configPath)) {
        console.error(`Config file already exists: ${configPath}`);
        console.error('Use a different path or delete the existing file.');
        process.exit(1);
      }
      generateSampleConfig(configPath);
      console.log(`Sample configuration written to ${configPath}`);
      console.log('Edit the file to set your private key and customize settings.');
    } else if (subcommand === 'show') {
      const config = loadConfig(configPath);
      console.log(JSON.stringify(config, null, 2));
    } else if (subcommand === 'validate') {
      const config = loadConfig(configPath);
      const validation = validateConfig(config);
      if (validation.valid) {
        console.log('Configuration is valid.');
      } else {
        console.error('Configuration errors:');
        for (const error of validation.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }
    } else {
      console.log('Usage: config <init|show|validate> [config_path]');
      console.log('  init      Generate a sample configuration file');
      console.log('  show      Display current configuration');
      console.log('  validate  Validate configuration file');
    }
    break;
  }

  case undefined:
  case 'help':
    console.log(`
trustedrelays - Nostr Trusted Relay Assertion Provider

Usage:
  bun run src/index.ts probe [relay_url...]              Probe relay(s) and store results
  bun run src/index.ts stats [relay_url...]              Show stats for relay(s)
  bun run src/index.ts list                              List all known relays
  bun run src/index.ts watch [--interval N] [relay...]   Continuous probing every N seconds

  bun run src/index.ts discover [source_relay...]        Discover NIP-66 monitors
  bun run src/index.ts monitors                          List trusted monitors
  bun run src/index.ts ingest [source_relay...]          Ingest NIP-66 data from monitors
  bun run src/index.ts nip66 [relay_url...]              Show NIP-66 stats for relays

  bun run src/index.ts reports ingest [source_relay...]  Ingest user reports (kind 1985)
  bun run src/index.ts reports stats [relay_url...]      Show report stats for relays

  bun run src/index.ts publish [--force] [relay_url...]  Publish assertions (kind 30385)
  bun run src/index.ts published                         List published assertions
  bun run src/index.ts keygen                            Generate a new Nostr keypair

  bun run src/index.ts history [--days N] [relay_url...] Show score history and trends
  bun run src/index.ts jurisdiction [--refresh] [relay...] Show relay locations/jurisdiction
  bun run src/index.ts appeals [relay_url...]            Query relay appeals (kind 1985)

  bun run src/index.ts daemon [--config path]            Run as production service
  bun run src/index.ts api [--port N] [--host H]         Start API server with dashboard
  bun run src/index.ts config init [path]                Generate sample config file
  bun run src/index.ts config show [path]                Show current configuration
  bun run src/index.ts config validate [path]            Validate configuration

  bun run src/index.ts help                              Show this help

Environment variables:
  NOSTR_PRIVATE_KEY      Private key for signing assertions (nsec or hex format)
  NOSTR_PUBLISH_RELAYS   Comma-separated list of relays to publish to

Examples:
  bun run src/index.ts probe                             Probe default test relays
  bun run src/index.ts discover                          Find NIP-66 monitors
  bun run src/index.ts ingest                            Start ingesting NIP-66 data
  bun run src/index.ts nip66 wss://relay.damus.io        Show NIP-66 data for relay
  bun run src/index.ts reports ingest                    Start ingesting user reports
  bun run src/index.ts keygen                            Generate keypair for publishing
  bun run src/index.ts publish wss://relay.damus.io      Publish assertion for relay
  bun run src/index.ts publish --force                   Force republish all assertions
  bun run src/index.ts history --days 7                  Show score history for last 7 days
  bun run src/index.ts jurisdiction wss://relay.damus.io Get relay location info
  bun run src/index.ts appeals wss://relay.damus.io      Query appeals for a relay
  bun run src/index.ts config init                       Generate sample config file
  bun run src/index.ts daemon                            Run production service
  bun run src/index.ts api --port 3000                   Start API server on port 3000
`);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
