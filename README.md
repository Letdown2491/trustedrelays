# Trusted Relays

A tool for computing and publishing trust scores for Nostr relays using Trusted Relay Assertions (kind 30385 events).

## Installation

```bash
bun install
```

## Quick Start

```bash
# Probe a relay and see its scores
bun run src/index.ts probe wss://relay.damus.io

# Start the web dashboard
bun run src/index.ts api --port 3000

# Run as a continuous service (Recommended)
bun run src/index.ts daemon
```

## Commands

```
probe [relay...]          Probe relay(s) and compute scores
watch [--interval N]      Continuous probing
list                      List known relays
stats [relay...]          Show relay statistics

discover                  Find NIP-66 monitors
ingest                    Ingest NIP-66 metrics
reports ingest            Ingest user reports (kind 1985)

publish [--force]         Publish assertions (kind 30385)
keygen                    Generate signing keypair

api [--port N] [--host H] [--trust-proxy]   Start web dashboard & API
daemon [--config path]    Run production service

help                      Show all commands
```

## Configuration

The `daemon` reads a JSON config (see [`config-example.json`](./config-example.json)).
Copy it, set `provider.privateKey`, and run `daemon --config path`. The config
file is written/expected with `0600` permissions since it may hold a private key.

Notable options:

| Key | Default | Description |
|-----|---------|-------------|
| `publishing.enabled` | `false` | Publish kind-30385 assertions |
| `targets.maxRelays` | `500` | Cap on tracked relays (also limits `/api/track`) |
| `api.trustProxy` | `false` | Trust `cf-connecting-ip` / `x-forwarded-for` for the client IP. **Enable only when behind a trusted reverse proxy** (e.g. Cloudflare); otherwise these headers are spoofable and rate limiting can be bypassed. |

For the standalone `api` command, pass `--trust-proxy` to enable the same behavior.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NOSTR_PRIVATE_KEY` | Private key for signing (nsec or hex) |
| `NOSTR_PUBLISH_RELAYS` | Comma-separated publish relays |

## Deployment

**Docker:**
```bash
docker-compose up -d
```

**Systemd:**
```bash
sudo cp trustedrelays.service /etc/systemd/system/
sudo systemctl enable --now trustedrelays
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed deployment instructions.

## Documentation

- [ALGORITHM.md](./ALGORITHM.md) — Scoring methodology
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design and implementation details
- [NIP-XX-TRUSTED-RELAY-ASSERTIONS.md](./NIP-XX-TRUSTED-RELAY-ASSERTIONS.md) — Protocol specification
- [CHANGELOG.md](./CHANGELOG.md) — Release history
