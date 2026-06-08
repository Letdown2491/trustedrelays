import { describe, test, expect, afterEach } from 'bun:test';
import { Database } from 'duckdb-async';
import { DataStore } from './database.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

// Exercises the repair migration (repairMissingUniqueConstraints) that restores
// PRIMARY KEY / unique indexes on databases created under an older schema where
// `CREATE TABLE IF NOT EXISTS` could not retrofit the declared PK. This is the
// fix that unblocked NIP-66 ingestion and operator-WoT persistence in prod.

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `tr-migtest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    rmSync(p, { force: true });
    rmSync(`${p}.wal`, { force: true });
  }
});

describe('repair migration: missing unique constraints', () => {
  test('dedups a PK-less score_history and adds a unique index', async () => {
    const path = tmpDbPath();

    // Simulate an old DB: score_history WITHOUT its PRIMARY KEY, with a
    // duplicate (relay_url, timestamp) pair. The SCHEMA's CREATE TABLE IF NOT
    // EXISTS will then no-op, leaving it PK-less until the repair runs.
    const seed = await Database.create(path);
    await seed.exec(`CREATE TABLE score_history (
      relay_url VARCHAR NOT NULL, timestamp BIGINT NOT NULL, score INTEGER,
      reliability INTEGER, quality INTEGER, accessibility INTEGER,
      operator_trust INTEGER, confidence VARCHAR, observations INTEGER
    )`);
    await seed.run(`INSERT INTO score_history (relay_url, timestamp, score) VALUES ('wss://a', 100, 50)`);
    await seed.run(`INSERT INTO score_history (relay_url, timestamp, score) VALUES ('wss://a', 100, 60)`); // dup key
    await seed.run(`INSERT INTO score_history (relay_url, timestamp, score) VALUES ('wss://b', 100, 70)`);
    await seed.close();

    // Opening via DataStore runs init -> migrations -> repair.
    const store = new DataStore(path);
    await store.getRelayUrls(); // any awaited call guarantees init completed
    await store.close();

    // Verify against the repaired file.
    const check = await Database.create(path, { access_mode: 'READ_ONLY' });
    const idx = await check.all(
      `SELECT index_name FROM duckdb_indexes() WHERE table_name='score_history' AND is_unique=true`
    );
    expect(idx.length).toBeGreaterThan(0);

    const dupGroups = await check.all(
      `SELECT COUNT(*) n FROM (SELECT 1 FROM score_history GROUP BY relay_url, timestamp HAVING COUNT(*) > 1)`
    );
    expect(Number(dupGroups[0].n)).toBe(0);

    const total = await check.all(`SELECT COUNT(*) n FROM score_history`);
    expect(Number(total[0].n)).toBe(2); // one duplicate removed
    await check.close();
  });

  test('restores ON CONFLICT upserts on a PK-less operators table', async () => {
    const path = tmpDbPath();

    const seed = await Database.create(path);
    await seed.exec(`CREATE TABLE operators (
      pubkey VARCHAR, wot_score INTEGER, wot_confidence VARCHAR,
      wot_provider_count INTEGER, wot_updated_at BIGINT
    )`);
    await seed.run(`INSERT INTO operators (pubkey, wot_score) VALUES ('abc', 10)`);
    await seed.close();

    const store = new DataStore(path);
    await store.getRelayUrls();
    await store.close();

    // After repair, the conflict target exists, so ON CONFLICT must succeed
    // (previously this threw a Binder Error).
    const check = await Database.create(path);
    let threw = false;
    try {
      await check.run(
        `INSERT INTO operators (pubkey, wot_score) VALUES ('abc', 99)
         ON CONFLICT (pubkey) DO UPDATE SET wot_score = excluded.wot_score`
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const row = await check.all(`SELECT wot_score FROM operators WHERE pubkey='abc'`);
    expect(Number(row[0].wot_score)).toBe(99); // upsert updated in place, no duplicate
    await check.close();
  });
});
