import { describe, test, expect, afterEach } from 'bun:test';
import { DataStore } from './database.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

// Guards the bun:sqlite port: SQLite has no native BOOLEAN type (stores 0/1),
// so DataStore must coerce boolean columns back to JS booleans on read.

const tmpFiles: string[] = [];
function tmpDbPath(): string {
  const p = join(tmpdir(), `tr-dbtest-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    rmSync(p, { force: true });
    rmSync(`${p}-wal`, { force: true });
    rmSync(`${p}-shm`, { force: true });
  }
});

describe('boolean round-trip (SQLite stores booleans as 0/1)', () => {
  test('reachable comes back as a JS boolean, preserving value', async () => {
    const store = new DataStore(tmpDbPath());
    const now = Math.floor(Date.now() / 1000);
    const base = {
      url: 'wss://relay.example.com',
      relayType: 'general' as const,
    };
    await store.storeProbe({ ...base, timestamp: now - 100, reachable: true });
    await store.storeProbe({ ...base, timestamp: now, reachable: false });

    const latest = await store.getLatestProbe(base.url);
    expect(latest).not.toBeNull();
    expect(typeof latest!.reachable).toBe('boolean');
    expect(latest!.reachable).toBe(false); // newest by timestamp

    const all = await store.getProbes(base.url);
    const truthy = all.find((p) => p.timestamp === now - 100);
    expect(typeof truthy!.reachable).toBe('boolean');
    expect(truthy!.reachable).toBe(true);

    await store.close();
  });
});
