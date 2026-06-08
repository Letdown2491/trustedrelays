# Changelog

## [0.2.0] - 2026-06-07

First versioned release. Includes a full security/correctness/performance audit,
a critical production database repair, and the introduction of changelog +
single-source versioning.

> ⚠️ **Published scores change in this release.** The scoring adjustments below
> shift the values in published kind-30385 assertions, so the **algorithm
> version is bumped to `v0.3.0`** (previously advertised inconsistently as
> `v0.1.1` / `v0.1.2` / `v0.2.0`). Consumers should expect score movement for
> some relays.

### Security

- **Fixed stored XSS across the dashboard and network pages.** `escHtml` now
  escapes quotes (making it attribute-safe), the broken `escAttr` was replaced
  with a correct encoder, and all relay-controlled fields (name, software,
  operator pubkey, policy, country names, etc.) are now escaped at every
  interpolation point, including Leaflet map popups.
- **Fixed rate-limiter bypass / shared bucket.** Client IP is now taken from the
  trusted socket address (`server.requestIP`); proxy headers
  (`cf-connecting-ip` / `x-forwarded-for`) are only honored when the new
  `api.trustProxy` setting (or `--trust-proxy` flag) is enabled. Previously all
  non-Cloudflare clients shared one `'unknown'` bucket and the header was
  spoofable.
- **Blocked SSRF via user-submitted relay URLs.** `/api/track` and the prober
  now reject loopback / private / link-local / cloud-metadata hosts, and the
  NIP-11 fetch no longer follows redirects, caps the body at 256 KB, and
  requires a JSON content type.
- **Capped abuse of write/compute endpoints.** `/api/track` now enforces
  `targets.maxRelays`; `/api/network/stats` clamps the `period` parameter to an
  allow-list to prevent cache-busting amplification.
- **Bounded untrusted relay input.** The WoT client now sets a query `limit` and
  hard-caps buffered assertions to prevent memory/CPU exhaustion from a hostile
  relay.
- **Hardened secret handling.** `config show` redacts the private key, written
  config files are `chmod 600`, and `loadConfig` fails fast on malformed config
  instead of silently falling back to defaults (which had publishing enabled).
- **Other hardening.** Added Subresource Integrity to the Leaflet CDN tags,
  `X-Content-Type-Options: nosniff` / `Referrer-Policy` to API JSON responses,
  and secp256k1 scalar-range validation for private keys.

### Fixed

- **Critical: repaired missing database primary keys.** On databases created
  under an older schema, `probes`, `nip66_metrics`, `operators`,
  `relay_reports`, and `score_history` were missing their declared PRIMARY KEY
  (which `CREATE TABLE IF NOT EXISTS` cannot retrofit). This silently broke every
  `ON CONFLICT` upsert on those tables. A new repair migration deduplicates and
  adds the missing unique indexes. **This restored NIP-66 metric ingestion and
  operator-trust persistence, which had been silently failing** (on the
  production instance, for ~88 days).
- **Fixed silent failure of schema migrations.** Migrations that recreate tables
  now run inside transactions (atomic) and no longer swallow real errors, and
  they preserve primary keys.
- Fixed a `readScore` computation bug (mismatched sample filters plus an
  operator-precedence issue that dropped legitimate zero averages).
- Fixed an unhandled promise rejection on database initialization that could
  crash startup; the original error is now surfaced.
- Fixed `updateMonitorStats` to upsert, so monitors are actually recorded;
  unified the single-relay and bulk NIP-66 stat queries so the detail and list
  views no longer disagree.
- Fixed a time-of-check/time-of-use double-count in report ingestion.
- Fixed WebSocket/socket and listener leaks in the prober (added a close handler
  and unified teardown), a relay-pool reconnect storm (backoff no longer resets
  on every brief reconnect), and added a proactive per-minute publish rate cap.
- Fixed overlapping daemon cycles: the probe/publish and checkpoint loops are now
  self-rescheduling with re-entrancy guards and per-iteration error handling, so
  a slow or failing run can't stack or kill the loop.
- Fixed `mergeConfig` silently dropping the `probing` config block.
- Fixed Tor/I2P network misclassification (previously overloaded country code
  `XX`); network type is now derived from the relay URL.
- Replaced a non-standard `INSERT OR REPLACE` with `ON CONFLICT` for the network
  stats cache.
- Added global `unhandledRejection` / `uncaughtException` handlers to the daemon
  for graceful shutdown instead of silent death.

### Changed

- **Scoring (affects published values — see algorithm `v0.3.0`):**
  - Unlisted countries are now treated as "unknown" (jurisdiction score 75)
    instead of an invented default of 65, so an unlisted country is no longer
    scored more leniently than a truly-unknown one.
  - The monitor-diversity bonus is now capped at 2.8 (diminishing returns).
  - The single-relay and bulk NIP-66 latency-percentile formulas were unified so
    the detail and list views report identical scores.
- Static files are cached in memory; API JSON responses are no longer
  pretty-printed (smaller payloads on hot paths).
- The cleanup pass now runs `VACUUM` to reclaim disk space.
- Consolidated the algorithm version into a single source (`src/version.ts`);
  the dashboard, config defaults, assertions, and `ALGORITHM.md` now all agree.

### Added

- `CHANGELOG.md` (this file) and `src/version.ts` as the single source of truth
  for versions.
- `api.trustProxy` config option and `--trust-proxy` CLI flag.

### Documented

- `ALGORITHM.md` now describes the displayed-`avgLatencyMs` source blend (probe
  vs. monitor, distinct from the connect/read percentile weighting), corrects
  the proof-of-work penalty range, notes the `monitorBonus` cap, and flags a
  known limitation: NIP-66-only relays default to 95 uptime (possible
  survivorship bias), left unchanged pending confirmation that monitors emit
  downtime events.

## [0.1.0]

- Initial implementation: NIP-XX relay trust assertions (kind 30385) combining
  direct probing, NIP-66 monitor data, user reports, and operator verification;
  reliability/quality/accessibility scoring; REST API and web dashboard;
  network monitoring page.

[Unreleased]: https://github.com/Letdown2491/trustedrelays/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Letdown2491/trustedrelays/releases/tag/v0.2.0
[0.1.0]: https://github.com/Letdown2491/trustedrelays/releases/tag/v0.1.0
