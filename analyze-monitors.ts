import { DataStore } from './src/database.ts';

async function main() {
  const db = new DataStore('./data/trustedrelays.db');
  await db.init();
  const ddb = (db as any).db;

  // Get individual probe times for damus to see the variance pattern
  const damusProbes = await ddb.all(`
    SELECT 
      timestamp,
      connect_time,
      read_time
    FROM probes
    WHERE url = 'wss://relay.damus.io' AND reachable = true
    ORDER BY timestamp DESC
    LIMIT 20
  `);

  console.log("Recent damus.io probe times:");
  console.log("Timestamp           | Connect | Read");
  console.log("-".repeat(45));
  for (const r of damusProbes as any[]) {
    const dt = new Date(Number(r.timestamp) * 1000).toISOString().slice(0,19);
    console.log(
      dt + " | " +
      String(r.connect_time).padStart(6) + "ms | " +
      String(r.read_time).padStart(5) + "ms"
    );
  }

  // Compare to nos.lol
  const nosProbes = await ddb.all(`
    SELECT 
      timestamp,
      connect_time,
      read_time
    FROM probes
    WHERE url = 'wss://nos.lol' AND reachable = true
    ORDER BY timestamp DESC
    LIMIT 10
  `);

  console.log("\n\nRecent nos.lol probe times:");
  console.log("Timestamp           | Connect | Read");
  console.log("-".repeat(45));
  for (const r of nosProbes as any[]) {
    const dt = new Date(Number(r.timestamp) * 1000).toISOString().slice(0,19);
    console.log(
      dt + " | " +
      String(r.connect_time).padStart(6) + "ms | " +
      String(r.read_time).padStart(5) + "ms"
    );
  }

  await db.close();
}
main();
