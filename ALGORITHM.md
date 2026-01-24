# Scoring Algorithm Specification

**Algorithm Version:** v0.2.0
**Last Updated:** 2026-01-18

This document describes the scoring methodology used to compute relay trust assertions.

## Overview

Relays are evaluated across three primary dimensions:

| Dimension | Overall Weight | Components | Description |
|-----------|---------------|------------|-------------|
| **Reliability** | 40% | 40% uptime + 20% recovery + 20% consistency + 20% latency | Availability, recovery speed, stability, and latency rank |
| **Quality** | 35% | 60% policy + 25% security + 15% operator | Policy documentation, encryption, and operator accountability |
| **Accessibility** | 25% | 40% barriers + 20% limits + 20% jurisdiction + 20% surveillance | Access barriers, limits, internet freedom, and surveillance risk |

Each dimension produces a score from 0-100, where 100 is best. The **overall trust score** is a weighted average of all three dimensions.

## Data Sources

### 1. Direct Probing

The system performs direct WebSocket connections to relays to measure:

- **Connect time**: Time to establish WebSocket connection
- **Read time**: Time to receive response to a REQ query
- **NIP-11 fetch**: HTTP request to relay for metadata

### 2. NIP-66 Monitors

Aggregated metrics from trusted NIP-66 monitors provide:

- `rtt_open`: Round-trip time to connect
- `rtt_read`: Round-trip time for read operations
- `rtt_write`: Round-trip time for write operations

---

## Reliability Score

Measures relay availability and stability. **Reliability is NOT the same as speed.**

A slow but consistently available relay is more reliable than a fast but flaky one.

### Components

| Component | Weight | Description |
|-----------|--------|-------------|
| **Uptime** | 40% | Percentage of probes where relay was reachable |
| **Recovery** | 20% | How quickly relay recovers from outages |
| **Consistency** | 20% | Low variance in response times (stable = high score) |
| **Latency** | 20% | Tiered scoring based on absolute latency (reflects real-world usability) |

### Overall Formula

```
reliability_score = uptime_score * 0.40 + recovery_score * 0.20 + consistency_score * 0.20 + latency_score * 0.20
```

### Uptime Score (40%)

Percentage of probes where the relay was successfully reachable.

```
uptime_score = (reachable_probes / total_probes) * 100
```

| Uptime | Score |
|--------|-------|
| 100% | 100 |
| 95% | 95 |
| 90% | 90 |
| 80% | 80 |
| <50% | <50 |

### Recovery Score (20%)

Measures how quickly the relay recovers from outages. Calculated by analyzing the duration of downtime periods in probe history.

```
For each outage period:
  outage_duration = time_of_recovery - time_of_failure

average_outage_duration = sum(outage_durations) / count(outages)
```

| Avg Outage Duration | Score Range | Rating |
|--------------------|-------------|--------|
| No outages | 100 | Perfect |
| < 10 minutes | 90-100 | Excellent |
| 10-30 minutes | 75-90 | Good |
| 30-120 minutes | 50-75 | Moderate |
| > 120 minutes | 0-50 | Poor |

**Why this matters:** Two relays with 95% uptime can have very different reliability profiles:
- Relay A: One 7-hour outage per week
- Relay B: Several 5-minute blips per week

Relay B is more reliable for users because brief interruptions are less disruptive than extended outages.

### Consistency Score (20%)

Measures how stable the relay's connection times are. Uses **IQR (Interquartile Range)** which is robust to outliers:

```
iqr_ratio = (P75 - P25) / P50
consistency_score = max(0, 100 - (iqr_ratio * 50))
```

Note: Only uses `connectTime` (not `readTime`) because they measure different operations with different baseline latencies.

| IQR Ratio | Meaning | Score |
|-----------|---------|-------|
| 0.0 | Perfect consistency | 100 |
| 0.5 | Moderate spread | 75 |
| 1.0 | High spread | 50 |
| 2.0+ | Unstable | 0 |

**Why IQR instead of CV (coefficient of variation)?**

Network probes often have bimodal distributions with occasional multi-second outliers from TCP retries, rate limiting, or transient network issues. Using CV (stddev/mean), a single 2000ms outlier among 100ms samples would destroy the score. IQR ignores outliers by design since it only considers the middle 50% of measurements.

**Example:** A relay with probes of [100, 110, 120, 130, 2500]ms:
- CV approach: mean=592ms, stddev=1018ms, CV=1.72 → **Score: 0** (unfairly penalized)
- IQR approach: P25=105ms, P50=120ms, P75=125ms, IQR ratio=0.17 → **Score: 92** (correctly reflects stable core performance)

### Latency Score (20%)

Uses **percentile-based scoring** from NIP-66 monitor data to remove geographic bias. A well-run relay in Tokyo should score similarly to a well-run relay in Frankfurt, regardless of where monitors are located.

#### The Problem with Raw Latency

If Monitor A (Frankfurt) measures:
- `relay.tokyo.jp` → 250ms
- `relay.frankfurt.de` → 15ms

Using raw latency would unfairly penalize the Tokyo relay, even if it's perfectly well-run. The high latency is due to geography, not relay quality.

#### Percentile-Based Solution

For each NIP-66 monitor:
1. Get the **latest measurement** for each relay (not historical averages)
2. Rank the target relay against all other relays that monitor tracks
3. Calculate percentile: "This relay is faster than X% of relays from this monitor's perspective"

Then average percentiles across all qualifying monitors.

#### Qualifying Monitors

Only monitors tracking **≥20 relays** contribute to percentile scores. This ensures the percentile ranking is meaningful (not just comparing against 2-3 relays).

#### Connect vs Read Weighting

Percentiles are calculated separately for connect time (`rtt_open`) and read time (`rtt_read`), then combined:

```
latency_score = connect_percentile * 0.30 + read_percentile * 0.70
```

**Rationale:** Users connect once but read many times. Read performance matters more for ongoing experience.

**Handling missing read data:** Some relays (e.g., NIP-46 signing relays) don't support standard event reads, so `rtt_read` may be NULL. When read data is unavailable, the score uses connect percentile only:

```
latency_score = connect_percentile  (when rtt_read is NULL)
```

This prevents relays from being unfairly penalized for not having read metrics.

#### Example

| Monitor | Relay A Percentile | Relay B Percentile |
|---------|-------------------|-------------------|
| Frankfurt | 40th (slow from here) | 95th (fast from here) |
| Tokyo | 95th (fast from here) | 40th (slow from here) |
| New York | 60th | 60th |
| **Average** | **65** | **65** |

Both relays score equally despite being in different locations—because both are equally well-run relative to their peers.

#### Fallback: Tiered Scoring

When percentile data is unavailable (no qualifying monitors), falls back to tiered scoring based on absolute latency:

| Latency | Score | Rating |
|---------|-------|--------|
| ≤50ms | 100 | Excellent - imperceptible |
| ≤100ms | 95 | Great - very fast |
| ≤150ms | 90 | Very good |
| ≤200ms | 85 | Good |
| ≤300ms | 75 | Acceptable |
| ≤500ms | 60 | Noticeable delay |
| ≤750ms | 40 | Slow |
| ≤1000ms | 20 | Very slow |
| >1000ms | 0 | Unusable |

This tiered approach (rather than linear) reflects actual user experience—users can't perceive differences under ~100ms.

### Example Calculations

| Relay | Uptime | Recovery | Consistency | Latency | **Reliability** |
|-------|--------|----------|-------------|---------|-----------------|
| A: Fast but flaky | 85% | 60 | 40 | 95 | **73** |
| B: Slow but rock solid | 100% | 100 | 95 | 40 | **87** |
| C: Average, stable | 98% | 90 | 85 | 70 | **88** |
| D: Brief outages | 90% | 95 | 80 | 60 | **83** |

Relay B correctly scores higher than A despite being slower - because it's more *reliable*.
Relay D with brief outages (high recovery) scores better than A despite lower uptime.

---

## Quality Score

Measures policy documentation, connection security, and operator accountability.

### Components

| Component | Weight | Description |
|-----------|--------|-------------|
| Policy Score | 60% | NIP-11 documentation clarity |
| Security Score | 25% | Connection encryption |
| Operator Score | 15% | Operator verification and WoT trust |

### Policy Clarity Scoring

Evaluates how well the relay documents its policies in NIP-11.

```
Base score: 50

Additions:
  +15: Has name AND description
  +8:  Has name OR description (but not both)
  +15: Has contact info
  +5:  Has software/version info
  +10: Has limitation object
  +1:  Each documented limit (max_message_length, max_subscriptions, etc.)
  +5:  Has fees documented (if payment_required)

Deductions:
  -10: payment_required but no fees documented

Caps (applied after additions/deductions):
  - No name AND no description: cap at 50 (no identity)
  - No contact info: cap at 70 (no accountability)
  - No limitation object: cap at 85 (rules not documented)
```

| Relay Documentation | Max Possible Score |
|---------------------|-------------------|
| Nothing | 50 |
| Name only | 58 |
| Name + description | 70 (capped, no contact) |
| Name + desc + contact | 85 (capped, no limits) |
| Full documentation | 100 |

### Connection Security Scoring

Evaluates whether the relay uses TLS encryption.

| Protocol | Security Score | Reason |
|----------|---------------|--------|
| wss:// | 100 | Encrypted, secure |
| ws:// | 0 | Unencrypted, MITM vulnerable |
| unknown | 50 | Unknown protocol |

**Rationale for ws:// penalty:**
- Traffic can be intercepted and modified (MITM attacks)
- ISPs and governments can monitor all communications
- No privacy protection for users
- User credentials and content exposed in transit

### Operator Accountability Scoring

Combines verification confidence and Web of Trust score.

```
If operator_pubkey exists:
  verification_confidence = 0-100 based on verification method
  wot_trust = NIP-85 trust score (0-100) if available

  If both available:
    operator_score = verification_confidence * 0.5 + wot_trust * 0.5
  Else:
    operator_score = verification_confidence
Else:
  operator_score = 50 (neutral - no operator info)
```

| Verification Method | Confidence |
|---------------------|------------|
| nip11_signed | 100 |
| dns | 80 |
| wellknown | 75 |
| nip11 | 70 |
| vouched | 50 |
| claimed | 20 |

### Quality Score Formula

```
quality_score = policy_score * 0.60 + security_score * 0.25 + operator_score * 0.15
```

---

## Accessibility Score

Measures access barriers, limit restrictiveness, internet freedom, and surveillance risk.

### Components

| Component | Weight | Description |
|-----------|--------|-------------|
| Barrier Score | 40% | NIP-11 access barriers (auth, payment, PoW) |
| Limit Score | 20% | How restrictive relay limits are |
| Jurisdiction Score | 20% | Internet freedom in relay's country (Freedom House) |
| Surveillance Score | 20% | Intelligence alliance membership (Five/Nine/Fourteen Eyes) |

Note: Connection encryption (ws:// vs wss://) is scored under Quality's Security Score.

Note: Kind restrictions were removed as a scoring factor - NIP count is a weak proxy for actual kind acceptance and cannot be measured reliably. Supported NIPs are still displayed in relay details for informational purposes.

Note: Censorship scoring was removed - no standardized relay reporting mechanism exists in the Nostr ecosystem. Relays themselves don't create content that can be reported; users do. Any future censorship scoring would require a dedicated reporting system to be developed.

### Barrier Scoring

Evaluates access barriers from NIP-11:

```
Base score: 100

Deductions:
  -40: payment_required
  -30: auth_required
  -5 to -15: min_pow_difficulty (penalty equals difficulty level, max 15)
```

Note: `restricted_writes` is NOT penalized. It indicates relay specialization (e.g., NIP-46 signing relays only accepting kinds 24133/24135), not access restriction. The real barriers to user access are auth and payment requirements.

If NIP-11 unavailable: default score is 70 (assume somewhat open).

### Limit Restrictiveness Scoring

Evaluates how restrictive the relay's limits are. Only very restrictive limits are penalized.

```
Base score: 100

Deductions:
  -15: max_subscriptions < 5 (or -5 if < 10)
  -15: max_content_length < 1000 (or -5 if < 5000)
  -10: max_message_length < 10000 (or -3 if < 32000)
  -10: max_filters < 5 (or -3 if < 10)
  -5: max_event_tags < 50
```

If NIP-11 unavailable: default score is 80 (assume reasonable limits).

### Jurisdiction Scoring

Evaluates internet freedom in the relay's country based on Freedom House "Freedom on the Net" data.

| Category | Freedom Score | Jurisdiction Score | Penalty |
|----------|--------------|-------------------|---------|
| Free | 70-100 | 100 | 0 |
| Partly Free | 40-69 | 90-100 | 0-10 |
| Not Free | 0-39 | 80-90 | 10-20 |

Rationale for penalties:
- **Government surveillance**: Relays in "Not Free" countries may be subject to logging requirements
- **Censorship risk**: Operators may face legal pressure to restrict content
- **Data security**: User data may be accessible to authoritarian governments

If country unknown: default score is 75 (assume moderately free).

Example country scores:
- Iceland (94), Finland (88), Estonia (93) → Free → Score 100
- Brazil (54), India (50), Turkey (42) → Partly Free → Score ~90-100
- China (9), Russia (21), Iran (11) → Not Free → Score 80-90

### Surveillance Scoring

Evaluates surveillance risk based on intelligence alliance membership (Five Eyes, Nine Eyes, Fourteen Eyes).

| Alliance | Member Countries | Score | Risk Level |
|----------|-----------------|-------|------------|
| **Privacy-friendly** | Iceland, Switzerland, Romania, Panama, Moldova | 100 | Lowest |
| **Non-aligned** | Most countries not in Eyes alliances | 90 | Low |
| **Fourteen Eyes** | Germany, Belgium, Italy, Sweden, Spain | 80 | Medium |
| **Nine Eyes** | Denmark, France, Netherlands, Norway | 75 | Medium-high |
| **Five Eyes** | USA, UK, Canada, Australia, New Zealand | 70 | Highest |
| **Unknown** | Country not determined | 85 | Neutral |

Rationale:
- **Five Eyes**: Most extensive intelligence sharing agreement - data can be legally compelled and shared across 5 nations
- **Nine/Fourteen Eyes**: Extended intelligence sharing with varying levels of cooperation
- **Privacy-friendly**: Countries with strong privacy laws and no membership in surveillance alliances

Note: This scoring is distinct from Freedom House jurisdiction scoring. A country can be "Free" by Freedom House standards but still have high surveillance risk (e.g., USA, UK), or be "Not Free" but not part of Eyes alliances.

### Accessibility Score Formula

```
accessibility_score = barrier_score * 0.40 + limit_score * 0.20 + jurisdiction_score * 0.20 + surveillance_score * 0.20
```

---

## Overall Trust Score

The final trust score combines all three dimensions, with reliability as the foundation, quality (including operator accountability) as a key differentiator, and accessibility as an important but smaller factor.

### Formula

```
overall_score = reliability_score * 0.40 + quality_score * 0.35 + accessibility_score * 0.25
```

### Rationale

- **Reliability (40%)**: A relay must be reachable and responsive to be useful. This is the foundation.
- **Quality (35%)**: Policy documentation, security, and operator accountability matter for trust.
- **Accessibility (25%)**: Access barriers, limits, and jurisdiction affect usability but are less critical than reliability and quality.

### Example Calculations

| Relay | Reliability | Quality | Accessibility | Overall |
|-------|-------------|---------|---------------|---------|
| High-trust relay | 95 | 90 | 85 | 90 |
| Unreliable but open | 40 | 70 | 95 | 64 |
| Reliable but restrictive | 90 | 80 | 30 | 72 |
| New relay (no data) | 50 | 100 | 85 | 76 |

---

## Policy Classification

Relays are classified into four policy types:

| Policy | Description |
|--------|-------------|
| **open** | Accepts most events from anyone |
| **moderated** | Open but with content filtering |
| **curated** | Restricted access (auth, payment) |
| **specialized** | Purpose-built for specific use case |

### Classification Logic

```
1. If relay_type is 'nip46' or 'specialized':
   → specialized (95% confidence)

2. If auth_required OR payment_required:
   → curated (85-95% confidence)

3. If restricted_writes OR has_moderation_indicators OR pow_required:
   → moderated (70-85% confidence)

4. Otherwise:
   → open (50-75% confidence)
```

Moderation indicators are detected by searching the NIP-11 description for keywords: "moderat", "rules", "policy", "terms".

---

## Operator Trust

Operator trust is determined through verification and Web of Trust integration.

### Verification Methods

The system checks multiple independent sources for operator pubkey and uses **corroborated evidence** for higher confidence when sources agree.

#### Single Source Confidence

| Method | Confidence | Description |
|--------|------------|-------------|
| `dns` | 80% | TXT record at `_nostr.<domain>` |
| `wellknown` | 75% | `/.well-known/nostr.json` on relay domain |
| `nip11` | 70% | NIP-11 pubkey field present (self-attested) |
| `claimed` | 20% | Found but unverified |

#### Corroborated Confidence (Multiple Sources Agree)

When multiple independent sources confirm the same pubkey, confidence increases:

| Sources Agreeing | Confidence | Description |
|------------------|------------|-------------|
| NIP-11 + well-known | 85% | Two independent sources confirm |
| NIP-11 + DNS | 90% | Strong corroboration |
| DNS + well-known | 90% | Strong corroboration |
| All three | 95% | Maximum confidence without cryptographic proof |

#### Source Disagreement

When sources provide different pubkeys, the system:
1. Uses the pubkey with the highest corroboration score
2. Flags the disagreement for potential investigation
3. Logs a warning about conflicting operator claims

This can indicate:
- Relay ownership transfer in progress
- Misconfiguration
- Potential impersonation attempt

### WoT Integration

Operator pubkeys are looked up via NIP-85 trust assertions to get a Web of Trust score (0-100).

Default trust providers:
- `npub1r8lsyu5mqk8rjdax6pzw3xyhvcgtfjrq5s0l40a8x43mxnmpvazs5qqvc5` (relatr)

---

## Confidence Levels

The confidence level indicates data quality based on **weighted observations**.

### Weighted Observation Calculation

NIP-66 metrics are weighted higher than raw probe counts because they represent:
- Dedicated monitoring infrastructure running 24/7
- Geographic diversity from multiple monitors
- Sustained observation over time

```
monitorBonus = 1 + (monitorCount / 10)      // 1.1 to 2.8 for 1-18 monitors
timeFactor = 1 + (min(periodDays, 30) / 30) // 1.0 to 2.0 for 0-30 days

nip66Contribution = nip66Metrics * monitorBonus * timeFactor
weightedObservations = probes + nip66Contribution
```

### Confidence Thresholds

| Level | Weighted Observations |
|-------|----------------------|
| **low** | < 100 |
| **medium** | 100-499 |
| **high** | 500+ |

### Example Calculations

| Scenario | Probes | NIP-66 | Monitors | Days | Weighted | Confidence |
|----------|--------|--------|----------|------|----------|------------|
| Just started | 7 | 2 | 2 | 1 | 9 | low |
| After 1 day | 288 | 50 | 5 | 1 | 365 | medium |
| After 1 week | 500 | 200 | 10 | 7 | 992 | high |

### Status Values

| Status | Meaning |
|--------|---------|
| `evaluated` | Sufficient data for full evaluation |
| `insufficient_data` | < 10 observations |
| `unreachable` | Relay not reachable during probing |
| `blocked` | Relay blocked by provider policy |

---

## Material Change Detection

Assertions are only republished when scores change materially:

```
threshold = 3 points (default)

republish if:
  - First assertion for this relay
  - |current_score - previous_score| >= threshold
  - |component_score - previous_component| >= threshold (reliability, quality, accessibility)
  - confidence level changed
  - status changed
```

The threshold of 3 balances responsiveness (catching degradation within ~2 hours) against filtering measurement noise.

---

## Jurisdiction Detection

Relay locations are determined via IP geolocation:

1. Resolve relay hostname to IP address
2. Query geolocation API (ip-api.com)
3. Extract: country code, region, city, ISP, ASN
4. Detect datacenter/hosting via ASN patterns

---

## Appeal Processing

Relay operators can dispute scores by publishing kind 1985 events with `L=relay-appeal`.

Appeals from verified operators (confidence >= 70%) are auto-accepted.

Appeals with evidence (linked events) are prioritized for review.

Appeals expire after 90 days.
