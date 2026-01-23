/**
 * Dashboard HTML template
 * Extracted from api.ts for better code organization
 */

// Cache-busting timestamp - set when server starts
const BUILD_TIME = Date.now();

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Trust scores for Nostr relays. Find reliable, secure, and accessible relays with transparency into how scores are computed.">
  <meta name="keywords" content="nostr, relay, trust, score, decentralized, social, protocol">
  <meta name="author" content="Trusted Relays">
  <meta name="robots" content="index, follow">

  <!-- OpenGraph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="Trusted Relays - Nostr Relay Trust Scores">
  <meta property="og:description" content="Trust scores for Nostr relays. Find reliable, secure, and accessible relays with transparency into how scores are computed.">
  <meta property="og:url" content="https://trustedrelays.xyz">
  <meta property="og:site_name" content="Trusted Relays">
  <meta property="og:image" content="https://trustedrelays.xyz/og-image.svg">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Trusted Relays - Nostr Relay Trust Scores">
  <meta name="twitter:description" content="Trust scores for Nostr relays. Find reliable, secure, and accessible relays.">
  <meta name="twitter:image" content="https://trustedrelays.xyz/og-image.svg">

  <link rel="canonical" href="https://trustedrelays.xyz">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${BUILD_TIME}">
  <title>Trusted Relays - Nostr Relay Trust Scores</title>
  <link rel="stylesheet" href="/styles.css?v=${BUILD_TIME}">
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Trusted Relays</h1>
    </div>
    <div class="header-right">
      <button class="freshness-btn" id="freshness-btn" title="Auto-refresh enabled - click to pause">
        <span class="freshness-dot" id="freshness-dot"></span>
      </button>
      <button class="btn btn-icon" id="algo-link" title="How trust scores are calculated">?</button>
      <a href="https://github.com/Letdown2491/trustedrelays" target="_blank" rel="noopener" class="btn btn-icon" title="View on GitHub">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
    </div>
  </div>

  <div class="toolbar">
    <input type="text" class="search-input" id="search" placeholder="Search relays..." title="Search by relay name or URL">
    <div class="toolbar-right">
      <button class="btn btn-filters" id="btn-filters" title="Open filters">
        <span class="filters-icon">⚙</span>
        <span class="filters-label">Filters</span>
        <span class="filters-count" id="filters-count"></span>
      </button>
      <div class="dropdown" id="export-dropdown">
        <button class="btn btn-export" id="btn-export" title="Export data">
          Export <span class="dropdown-arrow">▼</span>
        </button>
        <div class="dropdown-menu" id="export-menu">
          <button class="dropdown-item" id="btn-export-csv">Download CSV</button>
          <button class="dropdown-item" id="btn-export-json">Download JSON</button>
        </div>
      </div>
    </div>
  </div>

  <div class="active-filters" id="active-filters"></div>

  <!-- Filter Drawer -->
  <div class="filter-drawer-overlay" id="filter-drawer-overlay"></div>
  <div class="filter-drawer" id="filter-drawer">
    <div class="filter-drawer-header">
      <h3>Filters</h3>
      <button class="btn btn-icon filter-drawer-close" id="filter-drawer-close">×</button>
    </div>
    <div class="filter-drawer-content">
      <div class="filter-section">
        <div class="filter-section-title">Access</div>
        <div class="filter-group-drawer">
          <label class="filter-label-drawer">Policy</label>
          <select id="filter-policy">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="moderated">Moderated</option>
            <option value="curated">Curated</option>
            <option value="specialized">Specialized</option>
          </select>
        </div>
        <div class="filter-group-drawer">
          <label class="filter-label-drawer">Security</label>
          <select id="filter-secure">
            <option value="">All</option>
            <option value="secure">Encrypted (wss)</option>
            <option value="insecure">Unencrypted (ws)</option>
          </select>
        </div>
      </div>
      <div class="filter-section">
        <div class="filter-section-title">Location</div>
        <div class="filter-group-drawer">
          <label class="filter-label-drawer">Country</label>
          <select id="filter-country"><option value="">All</option></select>
        </div>
      </div>
      <div class="filter-section">
        <div class="filter-section-title">Technical</div>
        <div class="filter-group-drawer">
          <label class="filter-label-drawer">Supported NIPs</label>
          <div class="nip-filter-container" id="nip-filter-container">
            <button class="btn btn-nip-select" id="btn-nip-select">Select NIPs...</button>
            <div class="nip-dropdown" id="nip-dropdown"></div>
          </div>
        </div>
        <div class="filter-group-drawer">
          <label class="filter-label-drawer">Score</label>
          <select id="filter-score">
            <option value="">All</option>
            <option value="high">70+ Good</option>
            <option value="medium">40-69 Fair</option>
            <option value="low">&lt;40 Poor</option>
          </select>
        </div>
      </div>
    </div>
    <div class="filter-drawer-footer">
      <button class="btn btn-clear" id="btn-clear-filters">Clear all</button>
      <button class="btn btn-primary" id="btn-apply-filters">Show <span id="filter-result-count">0</span> relays</button>
    </div>
  </div>

  <div class="content">
    <table>
      <thead>
        <tr>
          <th data-sort="name" class="col-relay" title="Relay name and URL" id="th-relay">Relay</th>
          <th data-sort="policy" class="col-policy hide-mobile" title="Access policy: Open, Moderated, Curated, or Specialized">Policy</th>
          <th data-sort="countryCode" class="col-loc center hide-mobile" title="Server location (country code)" id="th-location">Location</th>
          <th data-sort="confidence" class="col-conf center hide-tablet" title="Data confidence based on observation count">Confidence</th>
          <th data-sort="reliability" class="col-score center hide-tablet" title="Reliability score: Connection stability and latency">Reliability</th>
          <th data-sort="quality" class="col-score center hide-tablet" title="Quality score: Spam filtering, policy clarity, security">Quality</th>
          <th data-sort="accessibility" class="col-score center hide-tablet" title="Accessibility score: Access barriers, limits, jurisdiction">Accessibility</th>
          <th data-sort="score" class="col-final center sorted" title="Overall trust score (0-100)">Score</th>
          <th data-sort="trendChange" class="col-trend center hide-tablet" title="Score trend over last 7 days">Trend</th>
        </tr>
      </thead>
      <tbody id="relay-tbody">
        <!-- Skeleton rows while loading -->
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
        <tr class="skeleton-row"><td><div class="skeleton-relay"><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-text skeleton-url"></div></div><div class="skeleton skeleton-text skeleton-desc"></div></td><td class="hide-mobile"><div class="skeleton skeleton-text" style="width:55px"></div></td><td class="col-loc hide-mobile"><div class="skeleton skeleton-text" style="width:28px"></div></td><td class="col-conf hide-tablet"><div class="skeleton skeleton-text" style="width:50px"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-score hide-tablet"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-final"><div class="skeleton skeleton-text skeleton-num"></div></td><td class="col-trend hide-tablet"><div class="skeleton skeleton-text" style="width:40px"></div></td></tr>
      </tbody>
    </table>
  </div>

  <div class="toast" id="toast"></div>

  <div class="modal-overlay" id="modal">
    <div class="modal">
      <div class="modal-header">
        <div>
          <h2 id="modal-title">Relay Details</h2>
          <div class="modal-subtitle" id="modal-subtitle"></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-icon btn-favorite" id="modal-favorite" title="Add to favorites">☆</button>
          <button class="btn" id="modal-copy">Copy</button>
          <div class="dropdown">
            <button class="dropdown-btn" id="modal-open-dropdown">Open ▾</button>
            <div class="dropdown-content" id="open-dropdown-content">
              <button class="dropdown-item" id="modal-open-relay">Open relay</button>
              <a class="dropdown-item" id="modal-nostr-watch" href="#" target="_blank" rel="noopener">Open nostr.watch</a>
            </div>
          </div>
          <button class="modal-close" onclick="closeModal()">×</button>
        </div>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <div class="modal-overlay" id="algo-modal">
    <div class="modal" style="max-width: 800px;">
      <div class="modal-header">
        <div>
          <h2>How Trust Scores Work</h2>
          <div class="modal-subtitle">Algorithm v0.1.2 — Trusted Relay Assertions</div>
        </div>
        <button class="modal-close" onclick="closeAlgoModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="algo-section">
          <h3>Overall Score Formula</h3>
          <div class="algo-formula">
            Trust Score = (<span class="weight">40%</span> × <span class="component">Reliability</span>) + (<span class="weight">35%</span> × <span class="component">Quality</span>) + (<span class="weight">25%</span> × <span class="component">Accessibility</span>)
          </div>
        </div>

        <div class="algo-section">
          <h3>Score Components</h3>
          <div class="algo-grid">
            <div class="algo-card reliability">
              <div class="algo-card-header">
                <span class="algo-card-title">Reliability</span>
                <span class="algo-card-weight">40%</span>
              </div>
              <div class="algo-card-desc">Measures operational stability from probe data and NIP-66 monitor metrics.</div>
              <div class="algo-sub-list">
                <div class="algo-sub-item"><span class="algo-sub-name">Uptime</span><span class="algo-sub-weight">40%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Recovery</span><span class="algo-sub-weight">20%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Consistency</span><span class="algo-sub-weight">20%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Latency</span><span class="algo-sub-weight">20%</span></div>
              </div>
            </div>

            <div class="algo-card quality">
              <div class="algo-card-header">
                <span class="algo-card-title">Quality</span>
                <span class="algo-card-weight">35%</span>
              </div>
              <div class="algo-card-desc">Evaluates relay professionalism, documentation, and operator accountability.</div>
              <div class="algo-sub-list">
                <div class="algo-sub-item"><span class="algo-sub-name">Policy docs</span><span class="algo-sub-weight">60%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Security (TLS)</span><span class="algo-sub-weight">25%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Operator trust</span><span class="algo-sub-weight">15%</span></div>
              </div>
            </div>

            <div class="algo-card accessibility">
              <div class="algo-card-header">
                <span class="algo-card-title">Accessibility</span>
                <span class="algo-card-weight">25%</span>
              </div>
              <div class="algo-card-desc">Assesses openness, access barriers, and jurisdiction characteristics.</div>
              <div class="algo-sub-list">
                <div class="algo-sub-item"><span class="algo-sub-name">Access barriers</span><span class="algo-sub-weight">40%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Rate limits</span><span class="algo-sub-weight">20%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Jurisdiction</span><span class="algo-sub-weight">20%</span></div>
                <div class="algo-sub-item"><span class="algo-sub-name">Surveillance</span><span class="algo-sub-weight">20%</span></div>
              </div>
            </div>
          </div>
        </div>

        <div class="algo-section">
          <h3>Confidence Levels</h3>
          <table class="algo-conf-table">
            <tr><th>Level</th><th>Threshold</th><th>Description</th></tr>
            <tr><td><span class="conf-badge conf-high">high</span></td><td>≥500 observations</td><td>Reliable long-term data</td></tr>
            <tr><td><span class="conf-badge conf-medium">medium</span></td><td>100–499 observations</td><td>Sufficient data for scoring</td></tr>
            <tr><td><span class="conf-badge conf-low">low</span></td><td>&lt;100 observations</td><td>Limited data, scores may change</td></tr>
          </table>
        </div>

        <div class="algo-section">
          <h3>Data Sources</h3>
          <div class="algo-note">
            Scores are computed from multiple sources: <strong>Direct probes</strong> (WebSocket connectivity, latency measurement, NIP-11 metadata), <strong>NIP-66 monitors</strong> (uptime, RTT metrics from trusted monitoring services), and <strong>NIP-11 relay info</strong> (limitations, supported NIPs, operator identity). Data is weighted: 30% direct probes + 70% NIP-66 data when both are available.
          </div>
        </div>

        <div class="algo-section">
          <h3>Operator Verification</h3>
          <div class="algo-note">
            Operator identity is verified through multiple methods: <strong>DNS TXT records</strong>, <strong>.well-known/nostr.json</strong>, and <strong>NIP-11 pubkey</strong>. When multiple sources agree on the same pubkey, confidence increases (up to 95% with all three). Operator trust also factors in <strong>Web of Trust</strong> scores via NIP-85 assertions.
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let allRelays = [];
    let sortCol = 'score';
    let sortAsc = false;
    let countries = [];
    let selectedNips = [];
    let lastFetch = 0;
    let refreshInterval = null;
    let autoRefreshEnabled = true;

    // Performance: cache filtered/sorted data
    let cachedFiltered = null;
    let cachedSorted = null;
    let cacheKey = '';

    // Performance: pre-computed stats
    let stats = { high: 0, medium: 0, low: 0, unreachable: 0 };

    // Pagination
    const PAGE_SIZE = 50;
    let currentPage = 1;

    // Favorites
    const FAVORITES_KEY = 'trustedrelays_favorites';
    let favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'));

    function saveFavorites() {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
    }

    function toggleFavorite(url) {
      if (favorites.has(url)) {
        favorites.delete(url);
      } else {
        favorites.add(url);
      }
      saveFavorites();
      invalidateCache();
      renderTable();
      return favorites.has(url);
    }

    function isFavorite(url) {
      return favorites.has(url);
    }

    // Compute aggregate stats for comparative insights
    function computeAggregateStats() {
      const stats = {
        reliability: { values: [], byPolicy: {} },
        quality: { values: [], byPolicy: {} },
        count: allRelays.length
      };

      for (const r of allRelays) {
        if (r.reliability != null) {
          stats.reliability.values.push(r.reliability);
          const p = r.policy || 'open';
          if (!stats.reliability.byPolicy[p]) stats.reliability.byPolicy[p] = [];
          stats.reliability.byPolicy[p].push(r.reliability);
        }
        if (r.quality != null) {
          stats.quality.values.push(r.quality);
          const p = r.policy || 'open';
          if (!stats.quality.byPolicy[p]) stats.quality.byPolicy[p] = [];
          stats.quality.byPolicy[p].push(r.quality);
        }
      }

      // Sort for percentile calculations
      stats.reliability.values.sort((a, b) => a - b);
      stats.quality.values.sort((a, b) => a - b);
      for (const p in stats.reliability.byPolicy) {
        stats.reliability.byPolicy[p].sort((a, b) => a - b);
      }
      for (const p in stats.quality.byPolicy) {
        stats.quality.byPolicy[p].sort((a, b) => a - b);
      }

      return stats;
    }

    // Get percentile rank (0-100) for a value in a sorted array
    function getPercentile(value, sortedArray) {
      if (!sortedArray || sortedArray.length === 0) return 50;
      let count = 0;
      for (const v of sortedArray) {
        if (v < value) count++;
        else break;
      }
      return Math.round((count / sortedArray.length) * 100);
    }

    // URL state management
    function readUrlState() {
      const params = new URLSearchParams(window.location.search);

      if (params.has('q')) document.getElementById('search').value = params.get('q');
      if (params.has('policy')) document.getElementById('filter-policy').value = params.get('policy');
      if (params.has('score')) document.getElementById('filter-score').value = params.get('score');
      if (params.has('country')) document.getElementById('filter-country').value = params.get('country');
      if (params.has('secure')) document.getElementById('filter-secure').value = params.get('secure');
      if (params.has('sort')) sortCol = params.get('sort');
      if (params.has('asc')) sortAsc = params.get('asc') === '1';

      // Update sort header UI
      document.querySelectorAll('th[data-sort]').forEach(th => {
        th.classList.remove('sorted', 'asc');
        if (th.dataset.sort === sortCol) {
          th.classList.add('sorted');
          if (sortAsc) th.classList.add('asc');
        }
      });
    }

    function updateUrlState() {
      const params = new URLSearchParams();

      const search = document.getElementById('search').value;
      const policy = document.getElementById('filter-policy').value;
      const score = document.getElementById('filter-score').value;
      const country = document.getElementById('filter-country').value;
      const secure = document.getElementById('filter-secure').value;

      if (search) params.set('q', search);
      if (policy) params.set('policy', policy);
      if (score) params.set('score', score);
      if (country) params.set('country', country);
      if (secure) params.set('secure', secure);
      if (sortCol !== 'score') params.set('sort', sortCol);
      if (sortAsc) params.set('asc', '1');

      const newUrl = params.toString() ? '?' + params.toString() : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }

    async function init() {
      await fetchData();
      readUrlState();
      renderTable();
      startAutoRefresh();
    }

    async function fetchData() {
      const [relaysRes, countriesRes] = await Promise.all([
        fetch('/api/relays').then(r => r.json()),
        fetch('/api/countries').then(r => r.json())
      ]);

      if (relaysRes.success) {
        allRelays = relaysRes.data;
        lastFetch = Date.now();
        invalidateCache();
        updateStats();
        renderTable();
        updateFreshness();
      }

      if (countriesRes.success && countries.length === 0) {
        countries = countriesRes.data;
        populateCountryFilter();
      }
    }

    function startAutoRefresh() {
      if (refreshInterval) clearInterval(refreshInterval);
      refreshInterval = setInterval(() => {
        if (autoRefreshEnabled) fetchData();
      }, 30000);
      setInterval(updateFreshness, 5000);
    }

    function toggleAutoRefresh() {
      autoRefreshEnabled = !autoRefreshEnabled;
      updateFreshness();
      if (autoRefreshEnabled) {
        fetchData();
        showToast('Auto-refresh enabled');
      } else {
        showToast('Auto-refresh paused');
      }
    }

    function updateFreshness() {
      const age = Math.floor((Date.now() - lastFetch) / 1000);
      const btn = document.getElementById('freshness-btn');
      const dot = document.getElementById('freshness-dot');

      if (!autoRefreshEnabled) {
        dot.className = 'freshness-dot paused';
        btn.title = 'Auto-refresh paused - click to resume';
        return;
      }

      let ageText;
      if (age < 60) {
        dot.className = 'freshness-dot';
        ageText = age + 's ago';
      } else if (age < 300) {
        dot.className = 'freshness-dot stale';
        ageText = Math.floor(age / 60) + 'm ago';
      } else {
        dot.className = 'freshness-dot old';
        ageText = Math.floor(age / 60) + 'm ago';
      }
      btn.title = 'Updated ' + ageText + ' - click to pause';
    }

    function updateStats() {
      // Performance: single-pass stats calculation
      stats = { high: 0, medium: 0, low: 0, unreachable: 0 };
      for (let i = 0; i < allRelays.length; i++) {
        const r = allRelays[i];
        if (r.status === 'unreachable') stats.unreachable++;
        else if (r.score >= 70) stats.high++;
        else if (r.score >= 40) stats.medium++;
        else if (r.score != null) stats.low++;
      }
    }

    function updateColumnHeaders(filteredCount, totalCount, countryCount) {
      const relayHeader = document.getElementById('th-relay');
      const locationHeader = document.getElementById('th-location');

      if (filteredCount === totalCount) {
        relayHeader.innerHTML = 'Relay <span class="count">(' + totalCount + ')</span>';
      } else {
        relayHeader.innerHTML = 'Relay <span class="count">(' + filteredCount + '/' + totalCount + ')</span>';
      }
      locationHeader.innerHTML = 'Location <span class="count">(' + countryCount + ')</span>';
    }

    function populateCountryFilter() {
      const sel = document.getElementById('filter-country');
      countries.sort((a,b) => b.relayCount - a.relayCount).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.countryCode;
        opt.textContent = c.countryCode + ' (' + c.relayCount + ')';
        sel.appendChild(opt);
      });
    }

    function getFilterKey() {
      return [
        document.getElementById('search').value,
        document.getElementById('filter-policy').value,
        document.getElementById('filter-score').value,
        document.getElementById('filter-country').value,
        document.getElementById('filter-secure').value,
        selectedNips.sort().join(','),
        sortCol,
        sortAsc,
        [...favorites].sort().join(',')
      ].join('|');
    }

    function getFiltered() {
      const search = document.getElementById('search').value.toLowerCase();
      const policy = document.getElementById('filter-policy').value;
      const scoreFilter = document.getElementById('filter-score').value;
      const country = document.getElementById('filter-country').value;
      const secure = document.getElementById('filter-secure').value;

      // Performance: use cached result if filters unchanged
      const key = getFilterKey();
      if (cachedFiltered && cacheKey === key) return cachedFiltered;

      cachedFiltered = allRelays.filter(r => {
        if (search && !r.url.toLowerCase().includes(search) && !(r.name && r.name.toLowerCase().includes(search))) return false;
        if (policy && r.policy !== policy) return false;
        if (country && r.countryCode !== country) return false;
        if (secure === 'secure' && !r.isSecure) return false;
        if (secure === 'insecure' && r.isSecure) return false;
        if (scoreFilter === 'high' && (r.score == null || r.score < 70)) return false;
        if (scoreFilter === 'medium' && (r.score == null || r.score < 40 || r.score >= 70)) return false;
        if (scoreFilter === 'low' && (r.score == null || r.score >= 40)) return false;
        if (selectedNips.length > 0) {
          const relayNips = r.supportedNips || [];
          const numericNips = selectedNips.filter(n => n !== 'unknown');
          const wantsUnknown = selectedNips.includes('unknown');
          // Must have all selected numeric NIPs
          if (numericNips.length > 0 && !numericNips.every(n => relayNips.includes(n))) return false;
          // If "unknown" selected, must have at least one unknown NIP
          if (wantsUnknown && !relayNips.some(n => !NIP_LABELS[n])) return false;
        }
        return true;
      });

      // Sort in place for cache
      cachedFiltered.sort((a, b) => {
        // Favorites always bubble to top
        const aFav = isFavorite(a.url);
        const bFav = isFavorite(b.url);
        if (aFav && !bFav) return -1;
        if (!aFav && bFav) return 1;

        // Then sort by selected column
        let av = a[sortCol], bv = b[sortCol];
        if (sortCol === 'name') { av = av || a.url; bv = bv || b.url; }
        if (av == null) av = sortAsc ? Infinity : -Infinity;
        if (bv == null) bv = sortAsc ? Infinity : -Infinity;
        if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortAsc ? av - bv : bv - av;
      });

      cacheKey = key;
      return cachedFiltered;
    }

    function invalidateCache() {
      cachedFiltered = null;
      cacheKey = '';
      currentPage = 1;
    }

    // Convert country code to flag emoji (e.g., 'US' -> 🇺🇸) - hoisted for reuse
    const toFlag = code => code ? String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';

    function renderRow(r) {
      const scoreClass = r.score >= 80 ? 'score-excellent' : r.score >= 60 ? 'score-good' : r.score >= 40 ? 'score-fair' : 'score-poor';
      const confClass = r.confidence === 'high' ? 'conf-high' : r.confidence === 'medium' ? 'conf-medium' : 'conf-low';
      const confTitle = r.confidence === 'high' ? '500+ observations' : r.confidence === 'medium' ? '100-499 observations' : 'Under 100 observations';
      const displayUrl = r.url.replace('wss://', '').replace('ws://', '');
      const insecureIcon = !r.isSecure ? '<span class="insecure-icon" title="Unencrypted connection (ws://) - traffic can be monitored">⚠</span> ' : '';
      const policyTitle = r.policy === 'open' ? 'Accepts most events from anyone' : r.policy === 'moderated' ? 'Open but with content filtering' : r.policy === 'curated' ? 'Restricted access (auth/payment required)' : r.policy === 'specialized' ? 'Purpose-built for specific use case' : '';
      const flag = r.countryCode ? '<span class="flag">' + toFlag(r.countryCode) + '</span>' : '';
      const accessLevelText = r.accessLevel === 'open' ? '' : r.accessLevel === 'auth_required' ? ' (auth required)' : r.accessLevel === 'payment_required' ? ' (payment required)' : r.accessLevel === 'restricted' ? ' (restricted)' : '';
      const statusTitle = r.isOnline ? 'Online' + accessLevelText + ' - Relay is currently reachable' : 'Offline - Relay is currently unreachable';
      const statusDot = '<span class="status-dot ' + (r.isOnline ? 'online' : 'offline') + '" title="' + statusTitle + '"></span>';
      const favoriteStar = isFavorite(r.url) ? '<span class="favorite-star" title="Favorite">★</span>' : '';
      const descLine = r.name ? '<div class="relay-desc">' + escHtml(r.name.length > 40 ? r.name.slice(0,40) + '…' : r.name) + '</div>' : '';

      // Trend display with magnitude and dynamic period
      let trendHtml = '<span class="trend-cell trend-none">-</span>';
      if (r.trend && r.trendChange != null && r.trendPeriod != null) {
        const absChange = Math.abs(Math.round(r.trendChange));
        const periodLabel = r.trendPeriod + ' day' + (r.trendPeriod !== 1 ? 's' : '');
        if (r.trend === 'up') {
          trendHtml = '<span class="trend-cell trend-up" title="Improving: +' + absChange + ' over ' + periodLabel + '">↑ +' + absChange + '</span>';
        } else if (r.trend === 'down') {
          trendHtml = '<span class="trend-cell trend-down" title="Degrading: -' + absChange + ' over ' + periodLabel + '">↓ -' + absChange + '</span>';
        } else {
          trendHtml = '<span class="trend-cell trend-stable" title="Stable: ±' + absChange + ' over ' + periodLabel + '">→ ±' + absChange + '</span>';
        }
      }

      return '<tr class="clickable" data-url="' + escAttr(r.url) + '" title="Click for details">' +
        '<td>' +
          '<div class="relay-url-primary">' + statusDot + insecureIcon + escHtml(displayUrl) + favoriteStar + '</div>' +
          descLine +
        '</td>' +
        '<td class="hide-mobile">' + (r.policy ? '<span class="tag tag-' + r.policy + '" title="' + policyTitle + '">' + r.policy + '</span>' : '<span class="score-val dim">-</span>') + '</td>' +
        '<td class="col-loc hide-mobile"><span class="loc" title="Server location">' + flag + (r.countryCode || '-') + '</span></td>' +
        '<td class="col-conf hide-tablet"><span class="conf-badge ' + confClass + '" title="' + confTitle + '">' + r.confidence + '</span></td>' +
        '<td class="col-score hide-tablet" title="Connection stability and response time"><span class="score-val">' + (r.reliability ?? '-') + '</span></td>' +
        '<td class="col-score hide-tablet" title="Spam filtering, policy clarity, encryption"><span class="score-val">' + (r.quality ?? '-') + '</span></td>' +
        '<td class="col-score hide-tablet" title="Access barriers, limits, jurisdiction"><span class="score-val">' + (r.accessibility ?? '-') + '</span></td>' +
        '<td class="col-final ' + scoreClass + '" title="Overall trust score"><span class="final-num">' + (r.score != null ? r.score : '-') + '</span></td>' +
        '<td class="col-trend hide-tablet">' + trendHtml + '</td>' +
      '</tr>';
    }

    let loadingMore = false;
    let observer = null;

    function renderTable() {
      const data = getFiltered(); // Already sorted via cache
      const filteredCount = data.length;
      const displayCount = currentPage * PAGE_SIZE;
      const displayData = data.slice(0, displayCount);
      const hasMore = displayCount < filteredCount;

      // Update column headers with counts
      updateColumnHeaders(filteredCount, allRelays.length, countries.length);

      const tbody = document.getElementById('relay-tbody');

      if (filteredCount === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty">No relays match filters</td></tr>';
        return;
      }

      // Find where favorites end
      const lastFavIndex = displayData.findIndex((r, i) =>
        isFavorite(r.url) && (i === displayData.length - 1 || !isFavorite(displayData[i + 1].url))
      );
      const hasFavorites = lastFavIndex >= 0 && lastFavIndex < displayData.length - 1;

      // Render rows with separator after favorites
      let html = displayData.map((r, i) => {
        let row = renderRow(r);
        if (hasFavorites && i === lastFavIndex) {
          row += '<tr class="favorites-separator"><td colspan="9"></td></tr>';
        }
        return row;
      }).join('');
      if (hasMore) {
        html += '<tr id="scroll-sentinel"><td colspan="9"></td></tr>';
      }

      tbody.innerHTML = html;
      setupInfiniteScroll();
    }

    function loadMore() {
      if (loadingMore) return;
      const data = getFiltered();
      const currentCount = currentPage * PAGE_SIZE;
      if (currentCount >= data.length) return;

      loadingMore = true;
      currentPage++;
      const newCount = currentPage * PAGE_SIZE;
      const newItems = data.slice(currentCount, newCount);
      const hasMore = newCount < data.length;

      const sentinel = document.getElementById('scroll-sentinel');
      if (sentinel) {
        // Insert new rows before sentinel using insertAdjacentHTML (handles <tr> correctly)
        sentinel.insertAdjacentHTML('beforebegin', newItems.map(renderRow).join(''));
        if (!hasMore) sentinel.remove();
      }

      loadingMore = false;
    }

    function setupInfiniteScroll() {
      if (observer) observer.disconnect();
      const sentinel = document.getElementById('scroll-sentinel');
      if (!sentinel) return;

      observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) loadMore();
      }, { rootMargin: '200px' });
      observer.observe(sentinel);
    }

    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function escAttr(s) { return s.replace(/'/g, "\\\\'").replace(/"/g, '&quot;'); }

    // Generate natural language insights about a relay
    function generateInsights(d, scores, aggregates) {
      const insights = [];
      const nips = d.nip11?.supported_nips || [];
      const lim = d.nip11?.limitation || {};
      const paymentRequired = lim.payment_required;
      const authRequired = lim.auth_required;
      const policy = d.policy?.classification || 'open';
      const retention = d.nip11?.retention;
      const components = scores.components || {};
      const probeCount = d.observations?.probeCount || 0;
      const hasSufficientData = probeCount >= 10;

      // Determine use-case specializations
      const isNip46 = nips.includes(46) || d.relayType === 'nip46';
      const isNip29 = nips.includes(29);
      const isNip90 = nips.includes(90);
      const isNip96 = nips.includes(96);
      const isNip23 = nips.includes(23);

      // Get percentiles for comparative context
      const reliabilityPct = aggregates ? getPercentile(scores.reliability, aggregates.reliability.values) : 50;
      const qualityPct = aggregates ? getPercentile(scores.quality, aggregates.quality.values) : 50;
      const policyRelays = aggregates?.reliability.byPolicy[policy] || [];
      const reliabilityInPolicyPct = getPercentile(scores.reliability, policyRelays);

      // Helper for retention days
      const getRetentionDays = () => {
        if (!retention || retention.length === 0) return null;
        const general = retention.find(r => !r.kinds || r.kinds.length === 0);
        if (general && general.time != null) return Math.round(general.time / 86400);
        return null;
      };
      const retentionDays = getRetentionDays();

      // 1. PRIMARY FRAMING - What is this relay good for?
      if (policy === 'specialized') {
        if (isNip46) {
          insights.push('Designed for remote signing apps like Amber or Signet. Not for general-purpose messaging.');
        } else if (isNip29) {
          insights.push('Built for group chats and communities. Use with clients that support group messaging.');
        } else if (isNip90) {
          insights.push('Handles data vending and AI/compute job requests. Not for typical social posting.');
        } else if (isNip96) {
          insights.push('Designed for media hosting and file uploads.');
        } else {
          insights.push('A specialized relay for specific use cases rather than general messaging.');
        }
      } else if (policy === 'curated') {
        if (paymentRequired) {
          insights.push('A curated relay with paid access, which typically means less spam.');
        } else {
          insights.push('A curated relay with selective membership. May require approval or invitation.');
        }
      } else if (policy === 'moderated') {
        if (authRequired) {
          insights.push('Requires authentication to write. Check with the operator for access.');
        } else {
          insights.push('A moderated relay with content or user policies in place.');
        }
      } else {
        // Open relays
        if (isNip23 && retentionDays && retentionDays >= 90) {
          insights.push('Suitable for long-form articles and blogs. Good retention for archival.');
        } else {
          insights.push('A general-purpose relay for everyday use.');
        }
      }

      // 2. GUIDANCE - How should I use this relay?
      if (policy !== 'specialized') {
        const highReliability = scores.reliability >= 75;
        const trustedOperator = d.operator?.trustScore >= 70;
        const lowReliability = scores.reliability < 50 && hasSufficientData;

        if (highReliability && trustedOperator) {
          insights.push('Good candidate for a primary relay.');
        } else if (highReliability && !trustedOperator) {
          insights.push('Reliable, though the operator is not yet well-established.');
        } else if (lowReliability) {
          insights.push('Better suited as a backup relay.');
        }

        // Retention guidance (only if notably short)
        if (retentionDays && retentionDays < 30 && retentionDays > 0) {
          insights.push('Better for everyday posts than long-term archival.');
        }
      }

      // 3. COMPARATIVE CONTEXT - How does it compare?
      if (hasSufficientData && aggregates && policy !== 'specialized') {
        if (reliabilityPct >= 75) {
          insights.push('More reliable than most relays.');
        } else if (reliabilityPct <= 25) {
          // Covered by guidance above
        } else if (reliabilityInPolicyPct >= 75 && policy !== 'open') {
          insights.push('Above average reliability for ' + policy + ' relays.');
        }

        if (qualityPct >= 75 && policy === 'open') {
          insights.push('Higher quality than most free relays.');
        }
      }

      // 4. SCORE EXPLANATIONS - Why is a score low?
      if (hasSufficientData) {
        // Reliability explanations
        if (scores.reliability < 50) {
          if (components.uptimeScore < 50) {
            insights.push('Reliability affected by connectivity issues.');
          } else if (components.consistencyScore < 40) {
            insights.push('Response times have been inconsistent.');
          }
        }

        // Quality explanations
        if (scores.quality < 50) {
          if (components.policyScore < 40) {
            insights.push('Quality score reflects minimal documentation.');
          } else if (components.securityScore < 50) {
            insights.push('Quality score affected by lack of encryption.');
          }
        }
      }

      // 5. TREND CONTEXT - Is it improving or declining?
      if (d.trend && d.trend.change !== undefined && hasSufficientData) {
        const change = d.trend.change;
        if (change > 5) {
          insights.push('Reliability has been improving recently.');
        } else if (change < -5) {
          insights.push('Reliability has declined recently. May be worth monitoring.');
        } else if (scores.reliability >= 70) {
          insights.push('Consistently reliable.');
        }
      }

      // 6. OPERATOR INSIGHTS - Who runs this relay?
      if (d.operator?.pubkey) {
        const trustScore = d.operator.trustScore;
        const providerCount = d.operator.trustProviderCount || 0;
        const verificationMethod = d.operator.verificationMethod;

        if (trustScore >= 70) {
          if (providerCount >= 3) {
            insights.push('Run by a well-established operator with strong reputation across multiple sources.');
          } else {
            insights.push('Run by a trusted operator.');
          }
        } else if (trustScore >= 50) {
          insights.push('Operator has a reasonable reputation.');
        } else if (trustScore > 0 && trustScore < 50) {
          insights.push('Operator has limited reputation in the network.');
        } else if (trustScore === 0 || trustScore === undefined) {
          if (verificationMethod) {
            insights.push('Operator identity verified but no reputation data available yet.');
          }
        }
      } else {
        // No operator identified
        if (probeCount < 10) {
          insights.push('Limited track record so far. Consider pairing with a more established relay.');
        } else if (scores.reliability < 60) {
          insights.push('Unknown operator and middling reliability. Worth observing before relying on it.');
        } else if (hasSufficientData) {
          insights.push('Operator not identified.');
        }
      }

      // 7. SOFT WARNINGS - What should I be cautious about?
      // Restricted writes on open relay
      if (lim.restricted_writes && policy === 'open') {
        insights.push('May have additional access requirements despite being listed as open.');
      }

      return insights.join(' ');
    }

    function copyUrl(url) {
      navigator.clipboard.writeText(url);
      showToast('Copied: ' + url);
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2000);
    }

    function exportCSV() {
      const data = getFiltered(); // Already sorted via cache
      const headers = ['url','name','score','reliability','quality','accessibility','policy','confidence','country','secure','observations'];
      const rows = data.map(r => [r.url, r.name||'', r.score, r.reliability, r.quality, r.accessibility, r.policy||'', r.confidence, r.countryCode||'', r.isSecure, r.observations]);
      const csv = [headers.join(','), ...rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))].join('\\n');
      downloadFile(csv, 'trustedrelays.csv', 'text/csv');
    }

    function exportJSON() {
      const data = getFiltered(); // Already sorted via cache
      downloadFile(JSON.stringify(data, null, 2), 'trustedrelays.json', 'application/json');
    }

    function downloadFile(content, filename, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }

    let currentRelayUrl = '';
    async function viewRelay(url) {
      currentRelayUrl = url;
      const r = allRelays.find(x => x.url === url);
      const isSecure = url.toLowerCase().startsWith('wss://');
      const displayUrl = url.replace('wss://','').replace('ws://','');
      const insecureIcon = !isSecure ? '<span class="insecure-icon" title="Unencrypted connection (ws://) - traffic can be monitored">⚠</span> ' : '';
      document.getElementById('modal-title').innerHTML = insecureIcon + escHtml(displayUrl);
      document.getElementById('modal-subtitle').textContent = r?.name || '';
      // Update nostr.watch link
      const relayHost = url.replace('wss://', '').replace('ws://', '').split('/')[0];
      const protocol = isSecure ? 'wss' : 'ws';
      document.getElementById('modal-nostr-watch').href = 'https://nostr.watch/relays/' + protocol + '/' + relayHost;
      // Show skeleton loader while fetching
      document.getElementById('modal-body').innerHTML =
        '<div class="detail-grid">' +
          '<div class="skeleton-card-hero">' +
            '<div style="display:flex;align-items:center;gap:16px">' +
              '<div class="skeleton skeleton-score hero"></div>' +
              '<div class="skeleton skeleton-text" style="width:80px"></div>' +
            '</div>' +
            '<div class="skeleton skeleton-text" style="width:60px"></div>' +
          '</div>' +
          '<div class="skeleton-card"><div class="skeleton skeleton-text sm"></div><div class="skeleton skeleton-score"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div></div>' +
          '<div class="skeleton-card"><div class="skeleton skeleton-text sm"></div><div class="skeleton skeleton-score"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div></div>' +
          '<div class="skeleton-card"><div class="skeleton skeleton-text sm"></div><div class="skeleton skeleton-score"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div></div>' +
        '</div>' +
        '<div class="detail-section">' +
          '<div class="skeleton skeleton-text" style="width:60px;margin-bottom:12px"></div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
            '<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div>' +
            '<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div>' +
            '<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div>' +
          '</div>' +
        '</div>';
      document.getElementById('modal').classList.add('open');
      updateFavoriteButton(isFavorite(url));

      try {
        const res = await fetch('/api/relay?url=' + encodeURIComponent(url));
        const json = await res.json();
        if (json.success) renderModal(json.data);
        else document.getElementById('modal-body').innerHTML = '<div class="empty">Error: ' + json.error + '</div>';
      } catch (e) {
        document.getElementById('modal-body').innerHTML = '<div class="empty">Failed to load</div>';
      }
    }

    function renderModal(d) {
      const sc = d.scores;
      const c = sc.components;
      const scoreClass = n => n >= 80 ? 'score-excellent' : n >= 60 ? 'score-good' : n >= 40 ? 'score-fair' : 'score-poor';
      const metricClass = n => n >= 80 ? 'excellent' : n >= 60 ? 'good' : n >= 40 ? 'fair' : 'poor';
      const formatDate = ts => ts ? new Date(ts * 1000).toLocaleDateString() : '-';
      const formatBytes = b => b >= 1048576 ? Math.round(b/1048576) + ' MB' : b >= 1024 ? Math.round(b/1024) + ' KB' : b + ' B';

      // Trend display
      const trendIcon = d.trend?.change > 3 ? '↑' : d.trend?.change < -3 ? '↓' : '↔';
      const trendLabel = d.trend?.change > 3 ? 'Rising' : d.trend?.change < -3 ? 'Falling' : 'Stable';
      const trendClass = d.trend?.change > 3 ? 'up' : d.trend?.change < -3 ? 'down' : 'stable';
      const trendPeriod = d.trend?.periodDays || 7;
      const trendTooltip = d.trend?.change !== undefined
        ? 'Score change over ' + trendPeriod + ' days: ' + (d.trend.change > 0 ? '+' : '') + d.trend.change + ' points'
        : 'Insufficient trend data';

      // Helper to render a sub-metric row with colored dot
      const metricRow = (label, value, tooltip) => {
        const cls = metricClass(value);
        const isProblem = value < 40;
        return '<div class="score-row' + (isProblem ? ' problem' : '') + '" title="' + tooltip + '">' +
          '<span class="metric-label"><span class="metric-dot ' + cls + '"></span>' + label + '</span>' +
          '<span class="metric-value ' + cls + '">' + value + '</span></div>';
      };

      // Score cards with hero Trust Score and detailed breakdowns
      // Build SVG area chart from history data
      const SPARKLINE_DAYS = 30;
      const svgWidth = 200;
      const svgHeight = 32;
      let sparklineHtml = '';

      if (d.history && d.history.length > 0) {
        const points = d.history;
        const emptyDays = SPARKLINE_DAYS - points.length;
        const xStep = svgWidth / (SPARKLINE_DAYS - 1);

        // Build area path (filled region under the line)
        let areaPath = '';
        let linePath = '';

        // Start area at bottom-left of data region
        const startX = emptyDays * xStep;
        areaPath = 'M ' + startX + ' ' + svgHeight;

        // Draw through all points
        points.forEach((h, i) => {
          const score = h.score ?? 50;
          const x = (emptyDays + i) * xStep;
          const y = svgHeight - (score / 100) * svgHeight;
          areaPath += ' L ' + x + ' ' + y;
          linePath += (i === 0 ? 'M ' : ' L ') + x + ' ' + y;
        });

        // Close area path back to bottom
        const endX = (emptyDays + points.length - 1) * xStep;
        areaPath += ' L ' + endX + ' ' + svgHeight + ' Z';

        // Determine color based on current score
        const color = sc.overall >= 70 ? 'var(--green)' : sc.overall >= 40 ? 'var(--yellow)' : 'var(--red)';

        sparklineHtml = '<svg class="hero-sparkline-svg" viewBox="0 0 ' + svgWidth + ' ' + svgHeight + '" preserveAspectRatio="none">' +
          '<defs><linearGradient id="sparkGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
          '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.4"/>' +
          '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.1"/>' +
          '</linearGradient></defs>' +
          '<path d="' + areaPath + '" fill="url(#sparkGrad)"/>' +
          '<path d="' + linePath + '" stroke="' + color + '" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>';
      } else {
        // No history - show flat placeholder line
        const color = sc.overall >= 70 ? 'var(--green)' : sc.overall >= 40 ? 'var(--yellow)' : 'var(--red)';
        sparklineHtml = '<svg class="hero-sparkline-svg" viewBox="0 0 ' + svgWidth + ' ' + svgHeight + '" preserveAspectRatio="none">' +
          '<line x1="0" y1="' + (svgHeight - 2) + '" x2="' + svgWidth + '" y2="' + (svgHeight - 2) + '" stroke="' + color + '" stroke-width="2" stroke-opacity="0.3" stroke-dasharray="4 2"/>' +
          '</svg>';
      }

      let html = '<div class="detail-grid">' +
        // Hero Trust Score card (full width) with inline sparkline
        '<div class="detail-card-hero ' + scoreClass(sc.overall) + '">' +
          '<div class="hero-label">Trust Score</div>' +
          '<div class="hero-row">' +
            '<div class="hero-score">' + sc.overall + '</div>' +
            '<div class="hero-sparkline" title="Score history (30 days)">' + sparklineHtml + '</div>' +
          '</div>' +
        '</div>' +
        // Three component score cards below
        '<div class="detail-card ' + scoreClass(sc.reliability) + '" title="Reliability: Uptime (40%), Recovery (20%), Consistency (20%), Latency (20%)">' +
          '<div class="detail-card-label">Reliability</div>' +
          '<div class="detail-card-value">' + sc.reliability + '</div>' +
          '<div class="detail-card-scores">' +
            metricRow('Uptime', c.uptimeScore, 'Percentage of probes where relay was reachable (40% weight)') +
            metricRow('Recovery', c.recoveryScore, 'How quickly relay recovers from outages (20% weight)') +
            metricRow('Consistency', c.consistencyScore, 'Response time stability - low variance = high score (20% weight)') +
            metricRow('Latency', c.latencyScore, 'Latency rank vs other relays - removes geographic bias (20% weight)') +
          '</div>' +
        '</div>' +
        '<div class="detail-card ' + scoreClass(sc.quality) + '" title="Quality: Policy documentation, security, and operator accountability">' +
          '<div class="detail-card-label">Quality</div>' +
          '<div class="detail-card-value">' + sc.quality + '</div>' +
          '<div class="detail-card-scores">' +
            metricRow('Policy', c.policyScore, 'NIP-11 documentation completeness (60% weight)') +
            metricRow('Security', c.securityScore, 'Connection encryption (wss:// = 100, ws:// = 0) - 25% weight') +
            metricRow('Operator', c.operatorScore, 'Operator verification and WoT trust (15% weight)') +
          '</div>' +
        '</div>' +
        '<div class="detail-card ' + scoreClass(sc.accessibility) + '" title="Accessibility: Access barriers, limits, jurisdiction, and surveillance risk">' +
          '<div class="detail-card-label">Accessibility</div>' +
          '<div class="detail-card-value">' + sc.accessibility + '</div>' +
          '<div class="detail-card-scores">' +
            metricRow('Barriers', c.barrierScore, 'Access barriers (auth, payment, PoW) - 40% weight') +
            metricRow('Limits', c.limitScore, 'How restrictive the relay limits are - 20% weight') +
            metricRow('Jurisdiction', c.jurisdictionScore, 'Internet freedom rating (Freedom House) - 20% weight') +
            metricRow('Surveillance', c.surveillanceScore, 'Intelligence alliance membership (Five/Nine/Fourteen Eyes) - 20% weight') +
          '</div>' +
        '</div>' +
      '</div>';

      // Insights section - natural language summary
      const aggregates = computeAggregateStats();
      const insightText = generateInsights(d, sc, aggregates);
      if (insightText) {
        html += '<div class="insights-section">';
        html += '<div class="detail-group-title">Insights</div>';
        html += '<p class="insights-text">' + escHtml(insightText) + '</p>';
        html += '</div>';
      }

      // Details section - organized into grouped cards
      html += '<div class="detail-groups">';

      // Group 1: Relay Info
      html += '<div class="detail-group">';
      html += '<div class="detail-group-title">Relay Info</div>';
      html += '<div class="detail-group-grid">';
      html += '<div class="detail-row" title="Relay classification: general, nip46 (remote signing), or specialized"><span class="detail-key">Type</span><span class="detail-val">' + (d.relayType || '-') + '</span></div>';
      html += '<div class="detail-row" title="Access policy: open, moderated, curated, or specialized"><span class="detail-key">Policy</span><span class="detail-val">' + (d.policy?.classification || '-') + '</span></div>';
      if (d.nip11?.software) {
        const sw = d.nip11.software.split('/').pop()?.split('#')[0] || d.nip11.software;
        html += '<div class="detail-row" title="Relay software reported via NIP-11"><span class="detail-key">Software</span><span class="detail-val">' + escHtml(sw) + '</span></div>';
      }
      const accessLabel = d.accessLevel === 'open' ? '' : d.accessLevel === 'auth_required' ? ' (auth required)' : d.accessLevel === 'payment_required' ? ' (payment required)' : d.accessLevel === 'restricted' ? ' (restricted)' : '';
      html += '<div class="detail-row" title="Current reachability status from most recent probe"><span class="detail-key">Status</span><span class="detail-val ' + (d.reachable ? 'online' : 'offline') + '">' + (d.reachable ? 'Online' + accessLabel : 'Offline') + '</span></div>';
      html += '</div></div>';

      // Group 2: Operator
      if (d.operator?.pubkey) {
        html += '<div class="detail-group">';
        html += '<div class="detail-group-title">Operator</div>';
        html += '<div class="detail-group-grid">';
        html += '<div class="detail-row" title="Relay operator pubkey (click to copy)"><span class="detail-key">Pubkey</span><span class="detail-val"><span class="operator-pubkey" data-pubkey="' + d.operator.pubkey + '" title="Click to copy">' + d.operator.pubkey.slice(0, 8) + '...' + d.operator.pubkey.slice(-8) + '</span></span></div>';
        const verifyMethod = d.operator.verificationMethod === 'nip11' ? 'NIP-11' : d.operator.verificationMethod === 'dns' ? 'DNS TXT' : d.operator.verificationMethod === 'wellknown' ? '.well-known' : d.operator.verificationMethod || '-';
        html += '<div class="detail-row" title="How the operator pubkey was verified"><span class="detail-key">Verified via</span><span class="detail-val">' + verifyMethod + '</span></div>';
        if (d.operator.trustScore != null) {
          const wotClass = d.operator.trustScore >= 70 ? 'excellent' : d.operator.trustScore >= 50 ? 'good' : d.operator.trustScore >= 30 ? 'fair' : 'poor';
          html += '<div class="detail-row" title="Web of Trust score from NIP-85 assertions"><span class="detail-key">WoT Score</span><span class="detail-val"><span class="wot-score ' + wotClass + '">' + d.operator.trustScore + '</span></span></div>';
          const confidenceLabel = d.operator.trustConfidence || 'unknown';
          const providerCount = d.operator.trustProviderCount || 0;
          const providerText = providerCount > 0 ? ' (' + providerCount + ' provider' + (providerCount !== 1 ? 's' : '') + ')' : '';
          html += '<div class="detail-row" title="Confidence level based on number of assertion providers"><span class="detail-key">WoT Confidence</span><span class="detail-val">' + confidenceLabel + providerText + '</span></div>';
        }
        html += '</div></div>';
      }

      // Group 2: Location & Privacy
      html += '<div class="detail-group">';
      html += '<div class="detail-group-title">Location & Privacy</div>';
      html += '<div class="detail-group-grid">';
      if (d.jurisdiction) {
        const loc = [d.jurisdiction.city, d.jurisdiction.countryCode].filter(Boolean).join(', ');
        html += '<div class="detail-row" title="Server location determined via IP geolocation"><span class="detail-key">Location</span><span class="detail-val">' + escHtml(loc || 'Unknown') + '</span></div>';
        html += '<div class="detail-row" title="Whether the relay is hosted in a datacenter"><span class="detail-key">Hosting</span><span class="detail-val">' + (d.jurisdiction.isHosting ? 'Datacenter' : 'Residential') + '</span></div>';
        if (d.jurisdiction.eyesAlliance) {
          const allianceLabels = { 'five_eyes': 'Five Eyes', 'nine_eyes': 'Nine Eyes', 'fourteen_eyes': 'Fourteen Eyes', 'privacy_friendly': 'Privacy-friendly', 'non_aligned': 'Non-aligned', 'unknown': 'Unknown' };
          const allianceLabel = allianceLabels[d.jurisdiction.eyesAlliance] || d.jurisdiction.eyesAlliance;
          const isEyes = ['five_eyes', 'nine_eyes', 'fourteen_eyes'].includes(d.jurisdiction.eyesAlliance);
          html += '<div class="detail-row" title="Intelligence alliance membership"><span class="detail-key">Surveillance</span><span class="detail-val' + (isEyes ? ' warn' : '') + '">' + allianceLabel + '</span></div>';
        }
        html += '<div class="detail-row" title="Internet freedom rating from Freedom House"><span class="detail-key">Freedom</span><span class="detail-val">' + (c.jurisdictionScore >= 80 ? 'Free' : c.jurisdictionScore >= 50 ? 'Partly Free' : 'Not Free') + '</span></div>';
      } else {
        html += '<div class="detail-row"><span class="detail-key">Location</span><span class="detail-val">Unknown</span></div>';
      }
      html += '</div></div>';

      // Group 3: Limits (from NIP-11)
      const lim = d.nip11?.limitation || {};
      html += '<div class="detail-group">';
      html += '<div class="detail-group-title">Limits</div>';
      html += '<div class="detail-group-grid">';
      html += '<div class="detail-row" title="Maximum size of incoming events"><span class="detail-key">Max message</span><span class="detail-val">' + (lim.max_message_length ? formatBytes(lim.max_message_length) : '-') + '</span></div>';
      html += '<div class="detail-row" title="Maximum concurrent subscriptions per connection"><span class="detail-key">Max subs</span><span class="detail-val">' + (lim.max_subscriptions || '-') + '</span></div>';
      html += '<div class="detail-row" title="Maximum limit value in filters"><span class="detail-key">Max limit</span><span class="detail-val">' + (lim.max_limit || '-') + '</span></div>';
      html += '<div class="detail-row" title="Maximum filters in a subscription"><span class="detail-key">Max filters</span><span class="detail-val">' + (lim.max_filters || '-') + '</span></div>';
      if (lim.auth_required) html += '<div class="detail-row" title="NIP-42 authentication required"><span class="detail-key">Auth</span><span class="detail-val warn">Required</span></div>';
      if (lim.payment_required) html += '<div class="detail-row" title="Payment required to use relay"><span class="detail-key">Payment</span><span class="detail-val warn">Required</span></div>';
      html += '</div></div>';

      // Group 5: Data
      html += '<div class="detail-group">';
      html += '<div class="detail-group-title">Data</div>';
      html += '<div class="detail-group-grid">';
      if (d.observations?.firstSeen) {
        html += '<div class="detail-row" title="First time this relay was observed"><span class="detail-key">First seen</span><span class="detail-val">' + formatDate(d.observations.firstSeen) + '</span></div>';
      }
      if (d.observations?.lastSeen) {
        html += '<div class="detail-row" title="Most recent observation of this relay"><span class="detail-key">Last seen</span><span class="detail-val">' + formatDate(d.observations.lastSeen) + '</span></div>';
      }
      html += '<div class="detail-row" title="Number of data points used for scoring"><span class="detail-key">Observations</span><span class="detail-val">' + (d.observations?.probeCount || 0) + ' probes, ' + (d.observations?.nip66MetricCount || 0) + ' NIP-66</span></div>';
      html += '</div></div>';

      html += '</div>'; // end detail-groups

      document.getElementById('modal-body').innerHTML = html;

      // Add event handlers
      const pubkeyEl = document.querySelector('.operator-pubkey');
      if (pubkeyEl) {
        pubkeyEl.addEventListener('click', function() {
          navigator.clipboard.writeText(this.dataset.pubkey);
          showToast('Copied pubkey');
        });
      }
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      document.getElementById('open-dropdown-content').classList.remove('show');
    }
    function openAlgoModal() {
      document.getElementById('algo-modal').classList.add('open');
    }
    function closeAlgoModal() {
      document.getElementById('algo-modal').classList.remove('open');
    }
    document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
    document.getElementById('algo-modal').addEventListener('click', e => { if (e.target.id === 'algo-modal') closeAlgoModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeAlgoModal(); } });
    document.getElementById('algo-link').addEventListener('click', openAlgoModal);
    document.getElementById('modal-copy').addEventListener('click', () => { copyUrl(currentRelayUrl); });
    document.getElementById('modal-favorite').addEventListener('click', () => {
      const isFav = toggleFavorite(currentRelayUrl);
      updateFavoriteButton(isFav);
      showToast(isFav ? 'Added to favorites' : 'Removed from favorites');
    });

    function updateFavoriteButton(isFav) {
      const btn = document.getElementById('modal-favorite');
      btn.textContent = isFav ? '★' : '☆';
      btn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
      btn.classList.toggle('active', isFav);
    }

    // Dropdown toggle
    document.getElementById('modal-open-dropdown').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('open-dropdown-content').classList.toggle('show');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      document.getElementById('open-dropdown-content').classList.remove('show');
    });

    // Open relay button
    document.getElementById('modal-open-relay').addEventListener('click', () => {
      const httpUrl = currentRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://');
      window.open(httpUrl, '_blank');
      document.getElementById('open-dropdown-content').classList.remove('show');
    });

    // Sorting
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortCol === col) sortAsc = !sortAsc;
        else { sortCol = col; sortAsc = false; }
        document.querySelectorAll('th').forEach(t => t.classList.remove('sorted', 'asc'));
        th.classList.add('sorted');
        if (sortAsc) th.classList.add('asc');
        invalidateCache();
        renderTable();
        updateUrlState();
      });
    });

    // Filter Drawer
    const drawer = document.getElementById('filter-drawer');
    const overlay = document.getElementById('filter-drawer-overlay');
    const btnFilters = document.getElementById('btn-filters');
    const btnClose = document.getElementById('filter-drawer-close');
    const btnApply = document.getElementById('btn-apply-filters');
    const btnClear = document.getElementById('btn-clear-filters');

    function openDrawer() {
      drawer.classList.add('open');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      updateFilterResultCount();
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    btnFilters.addEventListener('click', openDrawer);
    btnClose.addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);
    btnApply.addEventListener('click', () => {
      closeDrawer();
      invalidateCache();
      renderTable();
      updateUrlState();
      updateActiveFilters();
    });
    btnClear.addEventListener('click', () => {
      document.getElementById('filter-policy').value = '';
      document.getElementById('filter-score').value = '';
      document.getElementById('filter-country').value = '';
      document.getElementById('filter-secure').value = '';
      selectedNips = [];
      updateNipButtonText();
      updateFilterResultCount();
    });

    // Live update count as filters change in drawer
    function updateFilterResultCount() {
      const count = getFilteredCount();
      document.getElementById('filter-result-count').textContent = count;
    }

    function getFilteredCount() {
      const search = document.getElementById('search').value.toLowerCase();
      const policy = document.getElementById('filter-policy').value;
      const scoreFilter = document.getElementById('filter-score').value;
      const country = document.getElementById('filter-country').value;
      const secure = document.getElementById('filter-secure').value;

      return allRelays.filter(r => {
        if (search && !r.url.toLowerCase().includes(search) && !(r.name && r.name.toLowerCase().includes(search))) return false;
        if (policy && r.policy !== policy) return false;
        if (country && r.countryCode !== country) return false;
        if (secure === 'secure' && !r.isSecure) return false;
        if (secure === 'insecure' && r.isSecure) return false;
        if (scoreFilter === 'high' && (r.score == null || r.score < 70)) return false;
        if (scoreFilter === 'medium' && (r.score == null || r.score < 40 || r.score >= 70)) return false;
        if (scoreFilter === 'low' && (r.score == null || r.score >= 40)) return false;
        if (selectedNips.length > 0) {
          const relayNips = r.supportedNips || [];
          const numericNips = selectedNips.filter(n => n !== 'unknown');
          const wantsUnknown = selectedNips.includes('unknown');
          if (numericNips.length > 0 && !numericNips.every(n => relayNips.includes(n))) return false;
          if (wantsUnknown && !relayNips.some(n => !NIP_LABELS[n])) return false;
        }
        return true;
      }).length;
    }

    // Active filter chips
    function updateActiveFilters() {
      const container = document.getElementById('active-filters');
      const chips = [];
      let count = 0;

      const policy = document.getElementById('filter-policy').value;
      const score = document.getElementById('filter-score').value;
      const country = document.getElementById('filter-country').value;
      const secure = document.getElementById('filter-secure').value;

      if (policy) {
        chips.push(createChip('Policy', policy, 'filter-policy'));
        count++;
      }
      if (score) {
        const scoreLabels = { high: '70+ Good', medium: '40-69 Fair', low: '<40 Poor' };
        chips.push(createChip('Score', scoreLabels[score] || score, 'filter-score'));
        count++;
      }
      if (country) {
        chips.push(createChip('Country', country, 'filter-country'));
        count++;
      }
      if (secure) {
        chips.push(createChip('Security', secure === 'secure' ? 'Encrypted' : 'Unencrypted', 'filter-secure'));
        count++;
      }
      if (selectedNips.length > 0) {
        const numericNips = selectedNips.filter(n => n !== 'unknown');
        const hasUnknown = selectedNips.includes('unknown');
        let nipText = numericNips.map(n => 'NIP-' + n).join(', ');
        if (hasUnknown) nipText += (nipText ? ', ' : '') + 'Unknown';
        chips.push(createChip('NIPs', nipText, 'nips'));
        count++;
      }

      container.innerHTML = chips.join('');
      const countEl = document.getElementById('filters-count');
      if (count > 0) {
        countEl.textContent = count;
        countEl.classList.add('visible');
      } else {
        countEl.classList.remove('visible');
      }
    }

    function createChip(label, value, filterId) {
      return '<span class="filter-chip">' +
        '<span class="filter-chip-label">' + escHtml(label) + ':</span> ' +
        '<span>' + escHtml(value) + '</span>' +
        '<button class="filter-chip-remove" data-filter="' + filterId + '" title="Remove filter">×</button>' +
      '</span>';
    }

    document.getElementById('active-filters').addEventListener('click', (e) => {
      if (e.target.classList.contains('filter-chip-remove')) {
        const filterId = e.target.dataset.filter;
        if (filterId === 'nips') {
          selectedNips = [];
          updateNipButtonText();
        } else {
          document.getElementById(filterId).value = '';
        }
        invalidateCache();
        renderTable();
        updateUrlState();
        updateActiveFilters();
      }
    });

    // NIP multi-select filter
    const nipDropdown = document.getElementById('nip-dropdown');
    const btnNipSelect = document.getElementById('btn-nip-select');

    // Official NIPs from https://github.com/nostr-protocol/nips
    const NIP_LABELS = {
      1: 'Basic protocol',
      2: 'Follow list',
      3: 'OpenTimestamps',
      4: 'Encrypted DMs (deprecated)',
      5: 'DNS identifiers',
      6: 'Key derivation',
      7: 'Browser extension',
      8: 'Mentions (deprecated)',
      9: 'Event deletion',
      10: 'Text notes',
      11: 'Relay info',
      13: 'Proof of Work',
      14: 'Subject tag',
      15: 'Marketplace',
      17: 'Private DMs',
      18: 'Reposts',
      19: 'bech32 encoding',
      21: 'nostr: URI',
      22: 'Comments',
      23: 'Long-form content',
      24: 'Extra metadata',
      25: 'Reactions',
      26: 'Delegated signing',
      27: 'Text references',
      28: 'Public chat',
      29: 'Groups',
      30: 'Custom emoji',
      31: 'Unknown events',
      32: 'Labeling',
      34: 'Git stuff',
      35: 'Torrents',
      36: 'Sensitive content',
      37: 'Drafts',
      38: 'User statuses',
      39: 'External identities',
      40: 'Expiration',
      42: 'Auth',
      44: 'Encrypted payloads',
      45: 'Counting',
      46: 'Remote signing',
      47: 'Wallet Connect',
      48: 'Proxy tags',
      49: 'Key encryption',
      50: 'Search',
      51: 'Lists',
      52: 'Calendar',
      53: 'Live activities',
      54: 'Wiki',
      55: 'Android signer',
      56: 'Reporting',
      57: 'Zaps',
      58: 'Badges',
      59: 'Gift wrap',
      60: 'Cashu wallet',
      61: 'Nutzaps',
      62: 'Vanish request',
      64: 'Chess',
      65: 'Relay list',
      66: 'Relay monitoring',
      68: 'Picture feeds',
      69: 'P2P orders',
      70: 'Protected events',
      71: 'Video events',
      72: 'Communities',
      73: 'External content IDs',
      75: 'Zap goals',
      77: 'Negentropy sync',
      78: 'App-specific data',
      84: 'Highlights',
      86: 'Relay management',
      87: 'Ecash mint discovery',
      88: 'Polls',
      89: 'App handlers',
      90: 'Data vending',
      92: 'Media attachments',
      94: 'File metadata',
      96: 'File storage',
      98: 'HTTP auth',
      99: 'Classifieds',
      // Hex-based NIPs (reported as decimal)
      125: 'Threads',       // 7D
      160: 'Voice messages', // A0
      164: 'Public messages', // A4
      176: 'Web bookmarks',  // B0
      183: 'Blossom',        // B7
      190: 'BLE comms',      // BE
      192: 'Code snippets',  // C0
      199: 'Chats',          // C7
      238: 'E2EE MLS',       // EE
    };

    function populateNipFilter() {
      // Collect all NIPs from relays and count occurrences
      const nipCounts = {};
      let unknownCount = 0;
      const unknownNipSet = new Set();
      allRelays.forEach(r => {
        (r.supportedNips || []).forEach(n => {
          nipCounts[n] = (nipCounts[n] || 0) + 1;
          if (!NIP_LABELS[n]) {
            unknownNipSet.add(n);
          }
        });
      });

      // Count relays with any unknown NIP
      allRelays.forEach(r => {
        const nips = r.supportedNips || [];
        if (nips.some(n => !NIP_LABELS[n])) unknownCount++;
      });

      // Get official NIPs and sort by NIP number
      const officialNips = Object.keys(nipCounts)
        .map(Number)
        .filter(n => NIP_LABELS[n])
        .sort((a, b) => a - b);

      // Build dropdown HTML - official NIPs sorted by number
      let html = officialNips.map(n => {
        return '<label class="nip-option">' +
          '<input type="checkbox" value="' + n + '"' + (selectedNips.includes(n) ? ' checked' : '') + '>' +
          '<span class="nip-option-label">NIP-' + n + ' (' + NIP_LABELS[n] + ')</span>' +
          '<span class="nip-option-count">' + nipCounts[n] + '</span>' +
        '</label>';
      }).join('');

      // Add single "Unknown" option at the bottom
      if (unknownNipSet.size > 0) {
        const unknownList = Array.from(unknownNipSet).sort((a, b) => a - b).join(', ');
        html += '<div class="nip-separator"></div>';
        html += '<label class="nip-option nip-unknown" title="NIPs: ' + unknownList + '">' +
          '<input type="checkbox" value="unknown"' + (selectedNips.includes('unknown') ? ' checked' : '') + '>' +
          '<span class="nip-option-label">Unknown (' + unknownNipSet.size + ' NIPs)</span>' +
          '<span class="nip-option-count">' + unknownCount + '</span>' +
        '</label>';
      }

      nipDropdown.innerHTML = html;
    }

    btnNipSelect.addEventListener('click', (e) => {
      e.stopPropagation();
      nipDropdown.classList.toggle('open');
      if (nipDropdown.classList.contains('open')) {
        populateNipFilter();
      }
    });

    nipDropdown.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        const val = e.target.value;
        const nip = val === 'unknown' ? 'unknown' : parseInt(val);
        if (e.target.checked) {
          if (!selectedNips.includes(nip)) selectedNips.push(nip);
        } else {
          selectedNips = selectedNips.filter(n => n !== nip);
        }
        updateNipButtonText();
        updateFilterResultCount();
      }
    });

    function updateNipButtonText() {
      if (selectedNips.length === 0) {
        btnNipSelect.innerHTML = 'Select NIPs...';
      } else {
        const hasUnknown = selectedNips.includes('unknown');
        const nipCount = selectedNips.filter(n => n !== 'unknown').length;
        let text = '';
        if (nipCount > 0) text += nipCount + ' NIP' + (nipCount > 1 ? 's' : '');
        if (hasUnknown) text += (text ? ' + ' : '') + 'Unknown';
        btnNipSelect.innerHTML = text + ' selected';
      }
    }

    // Close NIP dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nip-filter-container')) {
        nipDropdown.classList.remove('open');
      }
    });

    // Update filter count when drawer inputs change
    ['filter-policy', 'filter-score', 'filter-country', 'filter-secure'].forEach(id => {
      document.getElementById(id).addEventListener('change', updateFilterResultCount);
    });

    // Filters (main table filtering on search)
    document.getElementById('search').addEventListener('input', () => {
      invalidateCache();
      renderTable();
      updateUrlState();
      updateFilterResultCount();
    });

    // Event delegation for table row clicks
    document.getElementById('relay-tbody').addEventListener('click', (e) => {
      const row = e.target.closest('tr.clickable');
      if (row) viewRelay(row.dataset.url);
    });

    // Freshness button toggles auto-refresh
    document.getElementById('freshness-btn').addEventListener('click', toggleAutoRefresh);

    // Export dropdown
    const exportMenu = document.getElementById('export-menu');
    document.getElementById('btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('open');
    });
    document.getElementById('btn-export-csv').addEventListener('click', () => {
      exportCSV();
      exportMenu.classList.remove('open');
    });
    document.getElementById('btn-export-json').addEventListener('click', () => {
      exportJSON();
      exportMenu.classList.remove('open');
    });
    document.addEventListener('click', () => exportMenu.classList.remove('open'));

    init();
  </script>
</body>
</html>`;
