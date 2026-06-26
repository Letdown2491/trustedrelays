import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startApiServer } from './api.js';
import { DataStore } from './database.js';
import type { ProbeResult } from './types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

// Integration tests that exercise the real HTTP handlers (Bun.serve) against a
// seeded DataStore. Covers the endpoints/features wired this session:
// /api/metrics, and topics + policy-discrepancy surfacing on /api/relays and
// /api/relay.

const RELAY = 'wss://relay.test.example';
let store: DataStore;
let server: { stop: () => void; port: number };
let dbPath: string;
let base: string;

beforeAll(async () => {
  dbPath = join(tmpdir(), `tr-apitest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new DataStore(dbPath);

  // Relay self-claims it's open (auth_required: false)...
  const probe: ProbeResult = {
    url: RELAY,
    timestamp: Math.floor(Date.now() / 1000),
    reachable: true,
    relayType: 'general',
    accessLevel: 'open',
    connectTime: 100,
    readTime: 120,
    nip11: { name: 'Test Relay', limitation: { auth_required: false } },
  };
  await store.storeProbe(probe);

  // ...but two monitors observe auth required + topics. Conflict expected.
  const now = Math.floor(Date.now() / 1000);
  for (const m of ['mon1'.padEnd(64, 'a'), 'mon2'.padEnd(64, 'b')]) {
    await store.addTrustedMonitor(m);
    await store.storeNip66Metric({
      eventId: `${m}-1`.padEnd(64, '0'),
      relayUrl: RELAY,
      monitorPubkey: m,
      timestamp: now,
      requirements: ['auth'],
      topics: ['nostr', 'dev'],
    });
  }

  server = startApiServer({
    port: 0,
    host: '127.0.0.1',
    db: store,
    getMetrics: () => ({ running: true, probe: { success: 7 } }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server?.stop();
  await store?.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}.wal`, { force: true });
});

describe('API integration', () => {
  test('GET /api/health returns ok with memory', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('ok');
    expect(typeof body.data.memory.rssMB).toBe('number');
  });

  test('GET /api/metrics returns the service snapshot + memory', async () => {
    const res = await fetch(`${base}/api/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.service).toEqual({ running: true, probe: { success: 7 } });
    expect(typeof body.data.memory.rssMB).toBe('number');
  });

  test('GET /api/relays surfaces topics and the policy discrepancy', async () => {
    const res = await fetch(`${base}/api/relays`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const relay = body.data.find((r: any) => r.url === RELAY);
    expect(relay).toBeDefined();
    expect(relay.topics.map((t: string) => t.toLowerCase()).sort()).toEqual(['dev', 'nostr']);
    expect(relay.policyDiscrepancy).toBe(true);
  });

  test('GET /api/relay returns detail with observedConflict + topics', async () => {
    const res = await fetch(`${base}/api/relay?url=${encodeURIComponent(RELAY)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.policy.observedConflict).toBe(true);
    expect(body.data.topics.map((t: string) => t.toLowerCase()).sort()).toEqual(['dev', 'nostr']);
  });
});
