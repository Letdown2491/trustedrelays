import { describe, test, expect, afterEach } from 'bun:test';
import { DataStore } from './database.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

// Exercises getNip66PolicySignals: latest-per-active-monitor aggregation with
// majority voting over the NIP-66 R/k/T tags.

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `tr-nip66sig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    rmSync(p, { force: true });
    rmSync(`${p}.wal`, { force: true });
  }
});

const URL = 'wss://relay.example.com';
let seq = 0;

async function seedMetric(
  store: DataStore,
  monitor: string,
  fields: { requirements?: string[]; relayType?: string; rejectedKinds?: number[]; topics?: string[]; timestamp?: number }
) {
  await store.addTrustedMonitor(monitor);
  await store.storeNip66Metric({
    eventId: `${monitor}-${seq++}`.padEnd(64, '0'),
    relayUrl: URL,
    monitorPubkey: monitor,
    timestamp: fields.timestamp ?? Math.floor(Date.now() / 1000),
    requirements: fields.requirements,
    relayType: fields.relayType,
    rejectedKinds: fields.rejectedKinds,
    topics: fields.topics,
  });
}

describe('getNip66PolicySignals', () => {
  test('majority of monitors decides a requirement', async () => {
    const store = new DataStore(tmpDbPath());
    await seedMetric(store, 'm1'.padEnd(64, 'a'), { requirements: ['auth'] });
    await seedMetric(store, 'm2'.padEnd(64, 'b'), { requirements: ['auth'] });
    await seedMetric(store, 'm3'.padEnd(64, 'c'), { requirements: ['!auth'] });

    const signals = await store.getNip66PolicySignals(URL);
    expect(signals.monitorCount).toBe(3);
    expect(signals.authRequired).toBe(true);
    await store.close();
  });

  test('a tie yields no verdict (undefined)', async () => {
    const store = new DataStore(tmpDbPath());
    await seedMetric(store, 'm1'.padEnd(64, 'a'), { requirements: ['payment'] });
    await seedMetric(store, 'm2'.padEnd(64, 'b'), { requirements: ['!payment'] });

    const signals = await store.getNip66PolicySignals(URL);
    expect(signals.paymentRequired).toBeUndefined();
    await store.close();
  });

  test('only the latest metric per monitor counts', async () => {
    const store = new DataStore(tmpDbPath());
    const m = 'm1'.padEnd(64, 'a');
    const now = Math.floor(Date.now() / 1000);
    // Older observation says auth; newer says !auth — newer should win.
    await seedMetric(store, m, { requirements: ['auth'], timestamp: now - 100 });
    await seedMetric(store, m, { requirements: ['!auth'], timestamp: now - 50 });

    const signals = await store.getNip66PolicySignals(URL);
    expect(signals.monitorCount).toBe(1);
    expect(signals.authRequired).toBe(false);
    await store.close();
  });

  test('aggregates relay type and kind restrictions by majority', async () => {
    const store = new DataStore(tmpDbPath());
    await seedMetric(store, 'm1'.padEnd(64, 'a'), { relayType: 'PrivateInbox', rejectedKinds: [4] });
    await seedMetric(store, 'm2'.padEnd(64, 'b'), { relayType: 'PrivateInbox', rejectedKinds: [4] });
    await seedMetric(store, 'm3'.padEnd(64, 'c'), { relayType: 'General', rejectedKinds: [] });

    const signals = await store.getNip66PolicySignals(URL);
    expect(signals.relayType).toBe('PrivateInbox');
    expect(signals.kindRestrictions).toBe(true);
    await store.close();
  });

  test('unions distinct topics across monitors (case-insensitive dedupe)', async () => {
    const store = new DataStore(tmpDbPath());
    await seedMetric(store, 'm1'.padEnd(64, 'a'), { topics: ['nostr', 'dev'] });
    await seedMetric(store, 'm2'.padEnd(64, 'b'), { topics: ['Nostr', 'art'] });

    const signals = await store.getNip66PolicySignals(URL);
    // Deduped case-insensitively (Nostr/nostr collapse to one); first-seen
    // casing is preserved, so compare lowercased to stay order-independent.
    const normalized = (signals.topics ?? []).map((t) => t.toLowerCase()).sort();
    expect(normalized).toEqual(['art', 'dev', 'nostr']);
    await store.close();
  });

  test('bulk getAllNip66PolicySignals groups verdicts per relay', async () => {
    const store = new DataStore(tmpDbPath());
    const urlA = 'wss://a.example.com';
    const urlB = 'wss://b.example.com';
    const m1 = 'm1'.padEnd(64, 'a');
    const m2 = 'm2'.padEnd(64, 'b');
    const now = Math.floor(Date.now() / 1000);
    await store.addTrustedMonitor(m1);
    await store.addTrustedMonitor(m2);
    // Relay A: both monitors observe auth. Relay B: both observe !auth.
    let id = 0;
    for (const [url, req] of [[urlA, 'auth'], [urlB, '!auth']] as const) {
      for (const m of [m1, m2]) {
        await store.storeNip66Metric({
          eventId: `${id++}`.padEnd(64, '0'),
          relayUrl: url,
          monitorPubkey: m,
          timestamp: now,
          requirements: [req],
        });
      }
    }

    const all = await store.getAllNip66PolicySignals();
    expect(all.get(urlA)?.authRequired).toBe(true);
    expect(all.get(urlB)?.authRequired).toBe(false);
    expect(all.get(urlA)?.monitorCount).toBe(2);
    await store.close();
  });
});
