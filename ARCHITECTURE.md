# Relay Trust Scoring System Architecture

A system for computing and publishing NIP-XX relay trust assertions (kind 30385), combining direct probing, NIP-66 monitor data, user reports, and operator verification.

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Data Sources                                     │
├─────────────────────┬─────────────────────┬──────────────────────────────────┤
│   NIP-66 Monitors   │   User Reports      │        Direct Probing            │
│   (kind 30166)      │   (kind 1985)       │        (WebSocket + NIP-11)      │
│                     │                     │                                  │
│   - uptime/RTT      │   - spam flags      │   - connectivity test            │
│   - supported NIPs  │   - censorship      │   - latency measurement          │
│   - geolocation     │   - unreliable      │   - NIP-11 metadata              │
│   - requirements    │   - malicious       │   - operator pubkey              │
└─────────┬───────────┴─────────┬───────────┴────────────────┬─────────────────┘
          │                     │                            │
          ▼                     ▼                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Ingestion Layer                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │    ingestor.ts  │  │report-ingestor  │  │       prober.ts             │   │
│  │                 │  │      .ts        │  │                             │   │
│  │ Subscribe to    │  │ Subscribe to    │  │ WebSocket connectivity      │   │
│  │ kind 30166 from │  │ kind 1985 with  │  │ REQ/EOSE timing test        │   │
│  │ trusted monitors│  │ L=relay-report  │  │ NIP-11 HTTPS fetch          │   │
│  └────────┬────────┘  └────────┬────────┘  └─────────────┬───────────────┘   │
│           │                    │                         │                   │
│           └────────────────────┼─────────────────────────┘                   │
│                                ▼                                             │
│                    ┌───────────────────────┐                                 │
│                    │     database.ts       │                                 │
│                    │      (DuckDB)         │                                 │
│                    └───────────┬───────────┘                                 │
└────────────────────────────────┼─────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Computation Layer                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                         Scoring Pipeline                            │     │
│  │                                                                     │     │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────┐  │     │
│  │  │  scorer.ts  │  │  quality-   │  │accessibility│  │ operator- │  │     │
│  │  │             │  │  scorer.ts  │  │  -scorer.ts │  │resolver.ts│  │     │
│  │  │ Reliability │  │   Quality   │  │Accessibility│  │ Operator  │  │     │
│  │  │   (40%)     │  │   (35%)     │  │   (25%)     │  │  Trust    │  │     │
│  │  │             │  │             │  │             │  │           │  │     │
│  │  │ - uptime    │  │ - policy    │  │ - barriers  │  │ - NIP-11  │  │     │
│  │  │ - recovery  │  │ - security  │  │ - limits    │  │ - DNS     │  │     │
│  │  │ - latency   │  │ - operator  │  │ - jurisdict │  │ - WoT     │  │     │
│  │  │ - consistcy │  │             │  │ - surveill  │  │           │  │     │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬─────┘  │     │
│  │         │                │                │               │        │     │
│  │         └────────────────┴────────┬───────┴───────────────┘        │     │
│  │                                   ▼                                │     │
│  │                        ┌───────────────────┐                       │     │
│  │                        │   assertion.ts    │                       │     │
│  │                        │  Build kind 30385 │                       │     │
│  │                        └───────────────────┘                       │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                    Supporting Components                            │     │
│  │                                                                     │     │
│  │  policy-classifier.ts   jurisdiction.ts      wot-client.ts         │     │
│  │  (open/moderated/       (IP geolocation,     (NIP-85 trust         │     │
│  │   curated/specialized)   freedom scores)      assertions)          │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Publishing & API Layer                              │
│                                                                              │
│  ┌─────────────────────────────┐  ┌────────────────────────────────────┐    │
│  │  assertion-publisher.ts     │  │           api.ts                   │    │
│  │                             │  │                                    │    │
│  │  - Sign with provider key   │  │  - REST API endpoints              │    │
│  │  - Publish to relays        │  │  - Web dashboard UI                │    │
│  │  - Material change throttle │  │  - Rate limiting                   │    │
│  │  - Track published events   │  │  - Security headers                │    │
│  └─────────────────────────────┘  └────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
trustedrelays/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── config.ts             # Configuration management
│   ├── types.ts              # TypeScript interfaces
│   ├── database.ts           # DuckDB data store
│   │
│   ├── prober.ts             # Direct relay probing
│   ├── ingestor.ts           # NIP-66 monitor data ingestion
│   ├── report-ingestor.ts    # User report ingestion (kind 1985)
│   │
│   ├── scorer.ts             # Reliability scoring
│   ├── quality-scorer.ts     # Quality scoring
│   ├── accessibility-scorer.ts # Accessibility scoring
│   │
│   ├── operator-resolver.ts  # Operator pubkey resolution
│   ├── policy-classifier.ts  # Relay policy classification
│   ├── jurisdiction.ts       # IP geolocation
│   ├── freedom-scores.ts     # Freedom House index data
│   │
│   ├── wot-client.ts         # NIP-85 WoT integration
│   ├── assertion.ts          # Kind 30385 event builder
│   ├── assertion-publisher.ts # Event signing & publishing
│   │
│   ├── appeal-processor.ts   # Handle relay appeals
│   ├── key-utils.ts          # Nostr key management
│   ├── service.ts            # Daemon orchestration
│   └── api.ts                # HTTP API & dashboard
│
├── data/                     # DuckDB database files
├── mockups/                  # UI design mockups
├── package.json
└── tsconfig.json
```

## Database Schema (DuckDB)

```sql
-- Direct probe results
CREATE TABLE probes (
  url TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  reachable INTEGER NOT NULL,
  connect_time INTEGER,
  read_time INTEGER,
  nip11_json TEXT,
  error TEXT,
  PRIMARY KEY (url, timestamp)
);

-- NIP-66 monitor metrics
CREATE TABLE nip66_metrics (
  relay_url TEXT NOT NULL,
  monitor_pubkey TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  rtt_open INTEGER,
  rtt_read INTEGER,
  rtt_write INTEGER,
  is_online INTEGER,
  PRIMARY KEY (relay_url, monitor_pubkey, timestamp)
);

-- Trusted NIP-66 monitors
CREATE TABLE trusted_monitors (
  pubkey TEXT PRIMARY KEY,
  name TEXT,
  relay_url TEXT,
  last_seen INTEGER,
  event_count INTEGER DEFAULT 0
);

-- Operator pubkey mappings
CREATE TABLE operator_mappings (
  relay_url TEXT PRIMARY KEY,
  operator_pubkey TEXT,
  verification_method TEXT,
  verified_at INTEGER,
  confidence INTEGER
);

-- User reports (kind 1985)
CREATE TABLE relay_reports (
  event_id TEXT PRIMARY KEY,
  relay_url TEXT NOT NULL,
  reporter_pubkey TEXT NOT NULL,
  report_type TEXT NOT NULL,
  content TEXT,
  timestamp INTEGER NOT NULL,
  reporter_trust_weight REAL
);

-- Published assertions
CREATE TABLE published_assertions (
  relay_url TEXT PRIMARY KEY,
  event_id TEXT,
  event_json TEXT,
  score INTEGER,
  reliability INTEGER,
  quality INTEGER,
  openness INTEGER,
  confidence TEXT,
  published_at INTEGER
);

-- Score history for trends
CREATE TABLE score_history (
  relay_url TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  score INTEGER,
  reliability INTEGER,
  quality INTEGER,
  openness INTEGER,
  operator_trust INTEGER,
  PRIMARY KEY (relay_url, timestamp)
);

-- Relay jurisdictions
CREATE TABLE relay_jurisdictions (
  relay_url TEXT PRIMARY KEY,
  ip_address TEXT,
  country_code TEXT,
  country_name TEXT,
  region TEXT,
  city TEXT,
  isp TEXT,
  asn TEXT,
  is_hosting INTEGER,
  resolved_at INTEGER
);

-- On-demand relay tracking requests
CREATE TABLE requested_relays (
  url TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  requested_by TEXT
);
```

## Scoring Algorithm

### Overall Score Composition

```
Overall Score = (Reliability × 0.40) + (Quality × 0.35) + (Accessibility × 0.25)
```

### Reliability Score (40% weight)

Measures operational stability from probe data and NIP-66 metrics.

```typescript
Reliability = (Uptime × 0.40) + (Recovery × 0.20) + (Consistency × 0.20) + (Latency × 0.20)
```

| Component | Calculation |
|-----------|-------------|
| **Uptime** | % of successful probes over observation period |
| **Recovery** | Inverse of average outage duration (shorter = better) |
| **Consistency** | Inverse of connection time variance (stable = better) |
| **Latency** | Tiered scoring based on absolute latency (≤50ms=100, ≤200ms=85, ≤500ms=60, etc.) |

**Data fusion:** Probe data (30%) + NIP-66 data (70%) when both available.

### Quality Score (35% weight)

Evaluates relay professionalism and operator accountability.

```typescript
Quality = (Policy × 0.60) + (Security × 0.25) + (Operator × 0.15)
```

| Component | Calculation |
|-----------|-------------|
| **Policy** | NIP-11 documentation completeness (name, description, contact, limits, fees) |
| **Security** | TLS encryption: wss:// = 100, ws:// = 0 |
| **Operator** | Verification confidence + WoT trust (50/50 blend) |

**Policy score caps:**
- No operator identity → max 50
- No contact info → max 70
- No limitation docs → max 85

### Accessibility Score (25% weight)

Assesses openness and freedom characteristics.

```typescript
Accessibility = (Barriers × 0.40) + (Limits × 0.20) + (Jurisdiction × 0.20) + (Surveillance × 0.20)
```

| Component | Calculation |
|-----------|-------------|
| **Barriers** | Penalties for auth (-30), payment (-40), restricted writes (-10), PoW (-5 to -15) |
| **Limits** | Penalty for restrictive subscription/content/message limits |
| **Jurisdiction** | Freedom House internet freedom index (0-100) |
| **Surveillance** | Eyes Alliance: Five Eyes (-40), Nine Eyes (-30), Fourteen Eyes (-20), Privacy-friendly (+0) |

### Confidence Levels

Based on weighted observation count:

| Level | Threshold | Description |
|-------|-----------|-------------|
| **high** | ≥500 weighted observations | Reliable long-term data |
| **medium** | ≥100 weighted observations | Sufficient data |
| **low** | <100 weighted observations | Limited data, scores may change |

**Observation weighting:**
```
weighted_obs = metric_count × monitor_diversity_bonus × time_factor

monitor_diversity_bonus = 1 + (unique_monitors / 10)  // range: 1.1-2.8
time_factor = 1 + (min(days, 30) / 30)                // range: 1.0-2.0
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web dashboard with relay table, filters, and details modal |
| `GET /api` | API documentation |
| `GET /api/health` | Health check |
| `GET /api/relays` | List all relays with scores (rate limited: 10/min) |
| `GET /api/relay?url=<url>` | Single relay details |
| `GET /api/score?url=<url>` | Lightweight score only |
| `GET /api/assertion?url=<url>` | Kind 30385 event JSON |
| `GET /api/history?url=<url>&days=N` | Score history and trend |
| `GET /api/countries` | Country distribution stats |
| `GET /api/stats` | Overall statistics |
| `GET /api/track?url=<url>` | Add relay to tracking |
| `GET /api/untrack?url=<url>` | Remove relay from tracking |

**Rate limiting:** 60 requests/minute per IP (10/min for `/api/relays`).

**Security:** All endpoints include CORS headers, CSP, X-Frame-Options, etc.

## CLI Commands

```bash
# Probing
bun run src/index.ts probe [relay...]       # Probe specific relays
bun run src/index.ts watch [--interval N]   # Continuous probing

# Data ingestion
bun run src/index.ts discover               # Find NIP-66 monitors
bun run src/index.ts ingest                 # Ingest NIP-66 data
bun run src/index.ts reports ingest         # Ingest user reports

# Analysis
bun run src/index.ts list                   # List known relays
bun run src/index.ts stats [relay...]       # Show statistics
bun run src/index.ts history [--days N]     # Score trends
bun run src/index.ts jurisdiction           # Geolocate relays

# Publishing
bun run src/index.ts publish [--force]      # Publish assertions
bun run src/index.ts published              # List published

# Service
bun run src/index.ts daemon                 # Run as service
bun run src/index.ts api [--port N]         # Start API server
```

## Operator Verification

Multi-method verification with confidence scores. When multiple independent sources agree on the same pubkey, confidence is increased through corroboration:

### Single Source Confidence

| Method | Confidence | Description |
|--------|------------|-------------|
| `dns` | 80% | TXT record at `_nostr.<domain>` |
| `wellknown` | 75% | `/.well-known/nostr.json` on relay domain |
| `nip11` | 70% | Pubkey in NIP-11 (self-attested) |
| `claimed` | 20% | Found but unverified |

### Corroborated Confidence (Multiple Sources Agree)

| Sources Agreeing | Confidence | Description |
|------------------|------------|-------------|
| NIP-11 + well-known | 85% | Two independent sources confirm |
| NIP-11 + DNS | 90% | Strong corroboration |
| DNS + well-known | 90% | Strong corroboration |
| All three | 95% | Maximum confidence without cryptographic proof |

When sources disagree (different pubkeys found), the system uses the highest-confidence source but flags the disagreement for review.

## Report Processing

User reports (kind 1985) are weighted by reporter trust:

```typescript
effective_weight = (reporter_trust / 100) ^ 2  // quadratic weighting
```

| Reporter Trust | Effective Weight |
|----------------|------------------|
| 100 | 1.00 |
| 50 | 0.25 |
| 20 | 0.04 |

**Spam prevention:**
- Minimum reporter trust: 20
- Rate limit: 10 reports/pubkey/day
- Time decay: 30-day half-life
- Minimum 3.0 weighted sum to affect score

## Policy Classification

Relays are classified based on NIP-11 limitations:

| Policy | Criteria |
|--------|----------|
| **open** | No auth, no payment, accepts most content |
| **moderated** | Open but with content filtering |
| **curated** | Auth or payment required |
| **specialized** | Purpose-built (e.g., NIP-46 only) |

## Material Change Publishing

Assertions are republished when:
- Score changes by ≥5 points
- Confidence level changes
- First assertion for a relay

Can be overridden with `--force` flag.


## Configuration

Generate a config file with `bun run src/index.ts config init`. Key options:

```json
{
  "provider": {
    "privateKey": "<hex_or_nsec>",
    "algorithmVersion": "v0.1.1"
  },
  "targets": {
    "relays": ["wss://relay.damus.io"],
    "discoverFromMonitors": true,
    "maxRelays": 500
  },
  "probing": {
    "concurrency": 30
  },
  "intervals": {
    "cycle": 3600
  },
  "api": {
    "enabled": true,
    "port": 3000
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `probing.concurrency` | 30 | Relays to probe in parallel |
| `intervals.cycle` | 3600 | Seconds between probe→publish cycles |
| `targets.discoverFromMonitors` | true | Auto-discover relays from NIP-66 |
| `publishing.materialChangeThreshold` | 5 | Min score change to republish |
| `database.retentionDays` | 90 | Days to retain historical data |

## Deployment

### Docker

```bash
# Create config file
bun run src/index.ts config init

# Set environment variables
export NOSTR_PRIVATE_KEY=<your_hex_or_nsec_key>

# Start container
docker-compose up -d

# View logs
docker-compose logs -f
```

The `docker-compose.yaml` mounts:
- `./data` — Database persistence
- `./config.json` — Configuration (read-only)

### Systemd

```bash
# Create system user
sudo useradd -r -s /bin/false trustedrelays

# Install application
sudo mkdir -p /opt/trustedrelays
sudo cp -r src public package.json bun.lock /opt/trustedrelays/
cd /opt/trustedrelays && sudo bun install --production
sudo chown -R trustedrelays:trustedrelays /opt/trustedrelays

# Configure
sudo -u trustedrelays bun run src/index.ts config init
echo "NOSTR_PRIVATE_KEY=<your_key>" | sudo tee /opt/trustedrelays/.env
sudo chmod 600 /opt/trustedrelays/.env

# Install and start service
sudo cp trustedrelays.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trustedrelays

# View logs
sudo journalctl -u trustedrelays -f
```

### Reverse Proxy (nginx)

For production, run the API behind nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name trustedrelays.example.com;

    ssl_certificate /etc/letsencrypt/live/trustedrelays.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/trustedrelays.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
