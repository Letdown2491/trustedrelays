/**
 * Network Statistics Page Template
 * Displays aggregate analytics across all relays
 */

// Cache-busting timestamp - set when server starts
const BUILD_TIME = Date.now();

export const NETWORK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Network Health - Trusted Relays</title>
  <meta name="description" content="Nostr relay network health statistics and trends">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css?v=${BUILD_TIME}">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
  <style>
    /* Network page specific styles */
    .network-content {
      padding: 16px 20px;
    }
    .header-center {
      display: flex;
      align-items: center;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 12px;
    }
    @media (max-width: 900px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 500px) {
      .stats-grid { grid-template-columns: 1fr; }
      .header-center { display: none; }
    }
    .stat-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 16px;
      text-align: center;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.2;
    }
    .stat-label {
      font-size: 11px;
      color: var(--text-primary);
      margin-top: 2px;
    }
    .stat-change {
      font-size: 10px;
      margin-top: 4px;
    }
    .stat-change.positive { color: var(--green); }
    .stat-change.negative { color: var(--red); }
    .stat-change.neutral { color: var(--text-muted); }
    .section {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--text-primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 900px) {
      .two-col { grid-template-columns: 1fr; }
    }
    .map-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 1000px) {
      .map-layout { grid-template-columns: 1fr; }
    }
    .map-sidebar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .map-sidebar .section {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .map-sidebar .section-title {
      flex-shrink: 0;
    }
    .distribution-bars {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      flex: 1;
    }
    .distribution-bar {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .distribution-label {
      width: 50px;
      font-size: 12px;
      color: var(--text-primary);
      text-align: right;
    }
    .distribution-track {
      flex: 1;
      height: 24px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
    }
    .distribution-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.5s ease;
    }
    .distribution-fill.excellent { background: var(--green); }
    .distribution-fill.good { background: #238636; }
    .distribution-fill.fair { background: var(--yellow); }
    .distribution-fill.poor { background: #da3633; }
    .distribution-fill.bad { background: var(--red); }
    .distribution-count {
      width: 80px;
      font-size: 12px;
      color: var(--text-primary);
    }

    /* Leaflet Map Styles */
    #map {
      height: 600px;
      border-radius: 4px;
      background: var(--bg-tertiary);
    }
    .leaflet-container {
      background: var(--bg-tertiary);
      font-family: inherit;
    }
    .leaflet-popup-content-wrapper {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border-radius: 6px;
      border: 1px solid var(--border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .leaflet-popup-content {
      margin: 12px;
    }
    .leaflet-popup-tip {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-top: none;
      border-left: none;
    }
    .leaflet-control-attribution {
      background: rgba(24, 28, 40, 0.8) !important;
      color: var(--text-primary) !important;
      font-size: 10px;
    }
    .leaflet-control-attribution a {
      color: var(--accent) !important;
    }
    .map-popup-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .map-popup-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    .map-popup-row span:last-child {
      color: var(--text-primary);
      font-weight: 500;
      margin-left: 16px;
    }

    /* Donut Charts */
    .donuts-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 600px) {
      .donuts-row { grid-template-columns: 1fr; }
    }
    .donut-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 20px;
    }
    .donut-chart {
      width: 210px;
      height: 210px;
      border-radius: 50%;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .donut-chart::before {
      content: '';
      position: absolute;
      width: 120px;
      height: 120px;
      background: var(--bg-secondary);
      border-radius: 50%;
    }
    .donut-center {
      position: relative;
      z-index: 1;
      text-align: center;
    }
    .donut-center-value {
      font-size: 32px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1;
    }
    .donut-center-label {
      font-size: 12px;
      color: var(--text-primary);
      margin-top: 4px;
    }
    .donut-legend {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
    }
    .donut-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }
    .donut-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .donut-legend-label {
      color: var(--text-primary);
    }
    .donut-legend-value {
      color: var(--text-primary);
      margin-left: auto;
    }

    .loading {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 200px;
      color: var(--text-primary);
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .updated-at {
      font-size: 10px;
      color: var(--text-muted);
      text-align: right;
      margin-top: 8px;
    }
    .period-selector {
      display: flex;
      gap: 2px;
    }
    .period-btn {
      padding: 5px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
      transition: all 0.15s;
    }
    .period-btn:hover { color: var(--text-primary); border-color: var(--text-muted); }
    .period-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Trusted Relays</h1>
    </div>
    <div class="header-center">
      <div class="period-selector" id="period-selector"></div>
    </div>
    <div class="header-right">
      <a href="/ALGORITHM.md" class="btn btn-icon" title="How trust scores are calculated" target="_blank">?</a>
      <a href="/" class="btn btn-icon" title="Relay List">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>
      </a>
      <a href="https://github.com/Letdown2491/trustedrelays" target="_blank" rel="noopener" class="btn btn-icon" title="View on GitHub">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
    </div>
  </div>

  <div class="network-content">
    <div id="content">
      <div class="loading"><div class="spinner"></div></div>
    </div>
    <div class="updated-at" id="updated-at"></div>
  </div>

  <script>
    let currentPeriod = '24h';
    let statsData = null;
    let map = null;
    let markersLayer = null;

    // Available periods and their day requirements
    const PERIODS = [
      { id: '24h', label: '24h', days: 1 },
      { id: '7d', label: '7d', days: 7 },
      { id: '30d', label: '30d', days: 30 },
      { id: '90d', label: '90d', days: 90 },
    ];

    // Render period selector based on available data
    function renderPeriodSelector(dataAgeDays) {
      const container = document.getElementById('period-selector');
      if (!container) return;

      // Always show 24h, then show others if we have enough data
      const available = PERIODS.filter(p => dataAgeDays >= p.days || p.id === '24h');

      container.innerHTML = available.map(p =>
        '<button class="period-btn' + (p.id === currentPeriod ? ' active' : '') + '" data-period="' + p.id + '">' + p.label + '</button>'
      ).join('');

      // Re-attach event handlers
      container.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          container.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentPeriod = btn.dataset.period;
          loadData(currentPeriod);
        });
      });
    }

    // Country centroids for map positioning [lat, lon]
    const COUNTRY_COORDS = {
      'US': [39.8, -98.5], 'CA': [56.1, -106.3], 'MX': [23.6, -102.5],
      'BR': [-14.2, -51.9], 'AR': [-38.4, -63.6], 'CL': [-35.7, -71.5],
      'CO': [4.6, -74.3], 'PE': [-9.2, -75.0], 'VE': [6.4, -66.6],
      'GB': [55.4, -3.4], 'DE': [51.2, 10.5], 'FR': [46.2, 2.2],
      'ES': [40.5, -3.7], 'IT': [41.9, 12.6], 'NL': [52.1, 5.3],
      'BE': [50.5, 4.5], 'CH': [46.8, 8.2], 'AT': [47.5, 14.6],
      'PL': [51.9, 19.1], 'CZ': [49.8, 15.5], 'SE': [60.1, 18.6],
      'NO': [60.5, 8.5], 'FI': [61.9, 25.7], 'DK': [56.3, 9.5],
      'IE': [53.1, -8.2], 'PT': [39.4, -8.2], 'GR': [39.1, 21.8],
      'RU': [61.5, 105.3], 'UA': [48.4, 31.2], 'RO': [45.9, 25.0],
      'HU': [47.2, 19.5], 'BG': [42.7, 25.5], 'SK': [48.7, 19.7],
      'HR': [45.1, 15.2], 'RS': [44.0, 21.0], 'SI': [46.2, 15.0],
      'LT': [55.2, 23.9], 'LV': [56.9, 24.6], 'EE': [58.6, 25.0],
      'BY': [53.7, 27.95], 'MD': [47.4, 28.4],
      'JP': [36.2, 138.3], 'CN': [35.9, 104.2], 'KR': [35.9, 127.8],
      'IN': [20.6, 78.9], 'TH': [15.9, 100.9], 'VN': [14.1, 108.3],
      'SG': [1.4, 103.8], 'MY': [4.2, 101.98], 'ID': [-0.8, 113.9],
      'PH': [12.9, 121.8], 'TW': [23.7, 121.0], 'HK': [22.4, 114.1],
      'AU': [-25.3, 133.8], 'NZ': [-40.9, 174.9],
      'ZA': [-30.6, 22.9], 'EG': [26.8, 30.8], 'NG': [9.1, 8.7],
      'KE': [-0.02, 37.9], 'MA': [31.8, -7.1], 'GH': [7.9, -1.0],
      'TR': [39.0, 35.2], 'IL': [31.0, 34.9], 'AE': [23.4, 53.8],
      'SA': [23.9, 45.1], 'IR': [32.4, 53.7], 'PK': [30.4, 69.3],
      'BD': [23.7, 90.4], 'LK': [7.9, 80.8],
      'IS': [65.0, -19.0], 'LU': [49.8, 6.1], 'MT': [35.9, 14.4],
      'CY': [35.1, 33.4], 'AL': [41.2, 20.2], 'MK': [41.5, 21.7],
      'BA': [43.9, 17.7], 'ME': [42.7, 19.4], 'XK': [42.6, 20.9],
    };

    // Country code to flag emoji
    function countryFlag(code) {
      if (!code || code === 'Unknown') return '\\u{1F310}';
      const codePoints = code.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0));
      return String.fromCodePoint(...codePoints);
    }

    // Format number with commas
    function fmt(n) {
      return n.toLocaleString();
    }

    // Format change with sign
    function fmtChange(n, suffix = '', decimals = 0) {
      if (n === null || n === undefined) return '-';
      const sign = n > 0 ? '+' : '';
      return sign + n.toFixed(decimals) + suffix;
    }

    // Get change class
    function changeClass(n) {
      if (n === null || n === undefined) return 'neutral';
      return n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
    }

    // Get color for score
    function scoreColor(score) {
      if (score >= 80) return '#22c55e';
      if (score >= 70) return '#238636';
      if (score >= 60) return '#eab308';
      return '#ef4444';
    }

    // Get distribution bar class
    function distClass(bucket) {
      if (bucket.startsWith('90')) return 'excellent';
      if (bucket.startsWith('80')) return 'good';
      if (bucket.startsWith('70')) return 'fair';
      if (bucket.startsWith('60') || bucket.startsWith('50')) return 'poor';
      return 'bad';
    }

    // Policy colors and labels
    const TYPE_CONFIG = {
      'open': { color: '#22c55e', label: 'Open' },
      'moderated': { color: '#3b82f6', label: 'Moderated' },
      'curated': { color: '#a855f7', label: 'Curated' },
      'specialized': { color: '#eab308', label: 'Specialized' },
      'unknown': { color: '#666', label: 'Unknown' },
    };

    // Operator trust colors
    const TRUST_CONFIG = {
      'high': { color: '#22c55e', label: 'High' },
      'medium': { color: '#eab308', label: 'Medium' },
      'low': { color: '#ef4444', label: 'Low' },
      'unverified': { color: '#666', label: 'Unverified' },
    };

    // Calculate verified percentage for operator trust
    function calculateVerifiedPercent(operatorTrust) {
      if (!operatorTrust || operatorTrust.length === 0) return 0;
      const verifiedCount = operatorTrust.filter(t => t.type !== 'unverified').reduce((sum, t) => sum + t.count, 0);
      const totalCount = operatorTrust.reduce((sum, t) => sum + t.count, 0);
      return totalCount > 0 ? Math.round((verifiedCount / totalCount) * 100) : 0;
    }

    // Render a donut widget (title + donut + legend)
    function renderDonutWidget(data, colorConfig, title, centerValue, centerLabel) {
      if (!data || data.length === 0) {
        return '<div class="section-title">' + title + '</div><div class="donut-content" style="color:var(--text-primary);">No data</div>';
      }

      const total = data.reduce((sum, d) => sum + d.count, 0);
      if (total === 0) {
        return '<div class="section-title">' + title + '</div><div class="donut-content" style="color:var(--text-primary);">No data</div>';
      }

      // Build conic gradient
      let gradientStops = [];
      let currentAngle = 0;
      for (const d of data) {
        const config = colorConfig[d.type] || { color: '#666' };
        const angle = (d.count / total) * 360;
        gradientStops.push(config.color + ' ' + currentAngle + 'deg ' + (currentAngle + angle) + 'deg');
        currentAngle += angle;
      }
      const gradient = 'conic-gradient(' + gradientStops.join(', ') + ')';

      // Build legend
      let legend = '';
      for (const d of data) {
        const config = colorConfig[d.type] || { color: '#666', label: d.type };
        const label = d.label || config.label || d.type;
        legend += '<div class="donut-legend-item">' +
          '<div class="donut-legend-dot" style="background:' + config.color + '"></div>' +
          '<span class="donut-legend-label">' + label + '</span>' +
          '<span class="donut-legend-value">' + d.percent + '%</span>' +
          '</div>';
      }

      return '<div class="section-title">' + title + '</div>' +
        '<div class="donut-content">' +
        '<div class="donut-chart" style="background:' + gradient + '">' +
        '<div class="donut-center"><div class="donut-center-value">' + centerValue + '</div><div class="donut-center-label">' + centerLabel + '</div></div>' +
        '</div>' +
        '<div class="donut-legend">' + legend + '</div>' +
        '</div>';
    }

    // Initialize Leaflet map
    function initMap() {
      if (map) return;

      const mapEl = document.getElementById('map');
      if (!mapEl) {
        console.error('Map element not found');
        return;
      }

      try {
        // Bounds to prevent horizontal repeat
        const bounds = L.latLngBounds(
          L.latLng(-60, -180),  // Southwest
          L.latLng(85, 180)     // Northeast
        );

        map = L.map('map', {
          center: [25, 15],
          zoom: 2,
          minZoom: 1,
          maxZoom: 6,
          maxBounds: bounds,
          maxBoundsViscosity: 1.0,
          worldCopyJump: false
        });

        // Dark tile layer (CartoDB Dark Matter)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 19,
          noWrap: true
        }).addTo(map);

        markersLayer = L.layerGroup().addTo(map);
        console.log('Map initialized successfully');
      } catch (err) {
        console.error('Map init failed:', err);
      }
    }

    // Render map markers
    function renderMapMarkers(geographic) {
      console.log('renderMapMarkers called, map:', !!map, 'markersLayer:', !!markersLayer, 'geographic:', geographic?.length);
      if (!map || !markersLayer) {
        console.error('Map not ready');
        return;
      }

      markersLayer.clearLayers();

      if (!geographic || geographic.length === 0) {
        console.warn('No geographic data');
        return;
      }

      // Aggregate by country code
      const countryData = new Map();
      for (const g of geographic) {
        const code = g.countryCode || 'Unknown';
        if (code === 'Unknown') continue;
        if (countryData.has(code)) {
          const existing = countryData.get(code);
          existing.relayCount += g.relayCount;
          existing.totalScore += g.avgScore * g.relayCount;
        } else {
          countryData.set(code, {
            countryCode: code,
            countryName: g.countryName || code,
            relayCount: g.relayCount,
            totalScore: g.avgScore * g.relayCount
          });
        }
      }

      // Calculate max for scaling
      const maxCount = Math.max(...Array.from(countryData.values()).map(c => c.relayCount), 1);

      // Add circles for each country
      let addedCount = 0;
      for (const [code, data] of countryData) {
        const coords = COUNTRY_COORDS[code];
        if (!coords) {
          console.log('No coords for:', code);
          continue;
        }

        const avgScore = data.totalScore / data.relayCount;
        const radius = Math.max(8, Math.min(40, 8 + (data.relayCount / maxCount) * 32));
        const color = scoreColor(avgScore);

        const circle = L.circleMarker(coords, {
          radius: radius,
          fillColor: color,
          fillOpacity: 0.7,
          color: color,
          weight: 2,
          opacity: 0.9
        });

        const popupContent = '<div class="map-popup-title">' + countryFlag(code) + ' ' + data.countryName + '</div>' +
          '<div class="map-popup-row"><span>Relays</span><span>' + data.relayCount + '</span></div>' +
          '<div class="map-popup-row"><span>Avg Score</span><span>' + avgScore.toFixed(0) + '</span></div>';

        circle.bindPopup(popupContent);
        circle.on('mouseover', function() { this.openPopup(); });
        circle.on('mouseout', function() { this.closePopup(); });

        markersLayer.addLayer(circle);
        addedCount++;
      }
      console.log('Added', addedCount, 'circles to map');
    }

    // Render page content
    function render(data) {
      const s = data.summary;
      const c = data.comparison;

      let html = '';

      // Stats cards
      html += '<div class="stats-grid">';
      html += '<div class="stat-card"><div class="stat-value">' + fmt(s.totalRelays) + '</div><div class="stat-label">Total Relays</div>' +
              '<div class="stat-change ' + changeClass(c.relayCountChange) + '">' + fmtChange(c.relayCountChange, '', 0) + ' vs last period</div></div>';
      html += '<div class="stat-card"><div class="stat-value">' + s.avgScore.toFixed(2) + '</div><div class="stat-label">Average Score</div>' +
              '<div class="stat-change ' + changeClass(c.avgScoreChange) + '">' + fmtChange(c.avgScoreChange, '', 2) + ' vs last period</div></div>';
      html += '<div class="stat-card"><div class="stat-value">' + s.healthyPercent + '%</div><div class="stat-label">Healthy (\\u226570)</div>' +
              '<div class="stat-change ' + changeClass(c.healthyPercentChange) + '">' + fmtChange(c.healthyPercentChange, '%', 2) + ' vs last period</div></div>';
      html += '<div class="stat-card"><div class="stat-value">' + s.medianScore + '</div><div class="stat-label">Median Score</div>' +
              '<div class="stat-change neutral">P25: ' + s.p25Score + ' / P75: ' + s.p75Score + '</div></div>';
      html += '</div>';

      // Sidebar + Map layout
      html += '<div class="map-layout">';

      // Sidebar with distribution and policies
      html += '<div class="map-sidebar">';

      // Score distribution
      html += '<div class="section">';
      html += '<div class="section-title">Score Distribution</div>';
      html += '<div class="distribution-bars">';
      const maxCount = Math.max(...data.distribution.map(d => d.count));
      for (const d of data.distribution) {
        const pct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
        html += '<div class="distribution-bar">' +
          '<div class="distribution-label">' + d.bucket + '</div>' +
          '<div class="distribution-track"><div class="distribution-fill ' + distClass(d.bucket) + '" style="width:' + pct + '%"></div></div>' +
          '<div class="distribution-count">' + d.count + ' (' + d.percent + '%)</div>' +
          '</div>';
      }
      html += '</div>';
      html += '</div>';

      // Relay Policies and Operator Trust donuts (two separate widgets)
      html += '<div class="donuts-row">';
      html += '<div class="section">';
      html += renderDonutWidget(data.relayTypes || [], TYPE_CONFIG, 'Relay Policies',
        (data.relayTypes?.find(t => t.type === 'open')?.percent || 0) + '%', 'Open');
      html += '</div>';
      html += '<div class="section">';
      html += renderDonutWidget(data.operatorTrust || [], TRUST_CONFIG, 'Operator Trust',
        calculateVerifiedPercent(data.operatorTrust) + '%', 'Verified');
      html += '</div>';
      html += '</div>';

      html += '</div>'; // end sidebar

      // World Map (main content)
      html += '<div class="section">';
      html += '<div class="section-title">Geographic Distribution</div>';
      html += '<div id="map"></div>';
      html += '</div>';

      html += '</div>'; // end map-layout

      document.getElementById('content').innerHTML = html;
      document.getElementById('updated-at').textContent = 'Data computed ' + new Date(data.computedAt * 1000).toLocaleString();

      // Update period selector based on available data
      renderPeriodSelector(data.dataAgeDays || 0);

      // Initialize map after DOM is updated
      setTimeout(() => {
        initMap();
        renderMapMarkers(data.geographic);
      }, 0);
    }

    // Load data
    async function loadData(period) {
      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      map = null; // Reset map reference since DOM will be replaced
      markersLayer = null;
      try {
        const res = await fetch('/api/network/stats?period=' + period);
        if (!res.ok) throw new Error('Failed to load stats');
        const json = await res.json();
        // API returns { success: true, data: {...} }
        statsData = json.data || json;
        render(statsData);
      } catch (err) {
        document.getElementById('content').innerHTML = '<div class="loading">Failed to load network statistics</div>';
        console.error(err);
      }
    }

    // Initial load
    loadData(currentPeriod);
  </script>
</body>
</html>`;
