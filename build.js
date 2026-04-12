#!/usr/bin/env node
/**
 * matchpass.club static site generator
 *
 * Reads data/clubs.json and generates:
 *   dist/{slug}/index.html   — one page per club (pre-network or active)
 *   dist/index.html           — directory listing all clubs
 *   dist/.well-known/nostr.json — NIP-05 style mapping for active clubs
 */

const fs = require('fs');
const path = require('path');
const { nip19 } = require('nostr-tools');

const DATA_FILE = path.join(__dirname, 'data', 'clubs.json');
const DIST_DIR = path.join(__dirname, 'dist');
const { version } = require('./package.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateNpub(npub) {
  if (!npub || npub.length < 20) return npub || '';
  return npub.slice(0, 12) + '...' + npub.slice(-8);
}

function npubToHex(npub) {
  if (!npub || !npub.startsWith('npub1')) return null;
  try {
    const { type, data } = nip19.decode(npub);
    if (type !== 'npub') return null;
    return data;
  } catch {
    return null;
  }
}

function roleToKey(role) {
  const map = {
    'Admin': 'admin',
    'Club Admin': 'admin',
    'Safeguarding Officer': 'safeguarding',
    'Steward': 'steward',
  };
  return map[role] || role.split(' ')[0].toLowerCase();
}

// Note: the `index` parameter is only used for unnamed stewards (to produce steward-1, steward-2, etc.)
function officerNip05Key(officer, club, index) {
  const base = roleToKey(officer.role);
  const slug = club.slug.replace(/-/g, '');
  if (base === 'steward' && officer.name) {
    return `${base}-${officer.name.toLowerCase().replace(/\s+/g, '-')}.${slug}`;
  }
  if (base === 'steward') {
    return `${base}-${index + 1}.${slug}`;
  }
  return `${base}.${slug}`;
}

function groupOfficers(officers) {
  const groups = { admin: [], safeguarding: [], steward: [], other: [] };
  for (const o of officers) {
    const key = roleToKey(o.role);
    if (key === 'admin') groups.admin.push(o);
    else if (key === 'safeguarding') groups.safeguarding.push(o);
    else if (key === 'steward') groups.steward.push(o);
    else groups.other.push(o);
  }
  return groups;
}

function renderOfficerCard(officer, club, index) {
  const nip05 = officerNip05Key(officer, club, index) + '@matchpass.club';
  const isPlaceholder = !officer.npub || officer.npub.includes('placeholder');
  const npubHtml = isPlaceholder
    ? '<div class="officer-npub pending">Pending verification</div>'
    : `<div class="officer-npub" title="${escapeHtml(officer.npub)}">${truncateNpub(officer.npub)}</div>`;
  return `
        <div class="officer-card">
          <div class="officer-role">${escapeHtml(officer.role)}</div>
          ${officer.name ? `<div class="officer-name">${escapeHtml(officer.name)}</div>` : ''}
          ${npubHtml}
          <div class="officer-nip05">${escapeHtml(nip05)}</div>
          <div class="officer-verified">${escapeHtml(officer.verifiedBy || '')}</div>
        </div>`;
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

const CSS_VARS = `
:root {
  --bg: #0f172a;
  --bg-card: #1e293b;
  --bg-card-hover: #253349;
  --bg-section: #162032;
  --green: #2d6a4f;
  --green-bright: #059669;
  --green-light: #95d5b2;
  --green-pale: #d8f3dc;
  --green-wash: rgba(5, 150, 105, 0.08);
  --amber: #f59e0b;
  --amber-wash: rgba(245, 158, 11, 0.1);
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --border: #334155;
  --border-light: rgba(148, 163, 184, 0.1);
  --font-heading: Impact, 'Arial Narrow', 'Helvetica Neue', Helvetica, sans-serif;
  --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', Consolas, 'Liberation Mono', monospace;
  --max-width: 720px;
  --radius: 8px;
}
`;

const CSS_BASE = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
a { color: var(--green-light); text-decoration: none; }
a:hover { text-decoration: underline; }
`;

const CSS_HEADER = `
.site-header {
  background: rgba(15, 23, 42, 0.95);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0.75rem 1.5rem;
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.site-logo {
  font-family: var(--font-heading);
  font-size: 1.3rem;
  letter-spacing: 0.04em;
  color: var(--text);
  text-decoration: none;
  text-transform: uppercase;
}
.site-logo span { color: var(--green-bright); }
.site-logo:hover { text-decoration: none; color: var(--green-light); }
.site-nav a {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-left: 1.5rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}
.site-nav a:hover { color: var(--green-light); }
`;

const CSS_FOOTER = `
.site-footer {
  border-top: 1px solid var(--border);
  padding: 2rem 1.5rem;
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-top: 4rem;
}
.site-footer a { color: var(--text-muted); }
`;

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function pageShell(title, bodyContent, { canonical = '', extraHead = '', scripts = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${canonical ? `<link rel="canonical" href="https://matchpass.club/${canonical}">` : ''}
  <meta name="description" content="${escapeHtml(title)} — club profile on the MatchPass football safety network">
  <style>
    ${CSS_VARS}
    ${CSS_BASE}
    ${CSS_HEADER}
    ${CSS_FOOTER}
    ${CSS_PAGE}
  </style>
  ${extraHead}
</head>
<body>
  <header class="site-header">
    <a href="../" class="site-logo">Match<span>Pass</span></a>
    <nav class="site-nav">
      <a href="../">All Clubs</a>
    </nav>
  </header>
  ${bodyContent}
  <footer class="site-footer">
    matchpass.club &mdash; football safety, community owned &mdash; v${version}
  </footer>
  ${scripts}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Club page CSS (shared between pre-network and active)
// ---------------------------------------------------------------------------

const CSS_PAGE = `
.page { max-width: var(--max-width); margin: 0 auto; padding: 2rem 1.5rem; }

/* Club header */
.club-header { text-align: center; padding: 3rem 0 2rem; }
.club-name {
  font-family: var(--font-heading);
  font-size: clamp(2rem, 6vw, 3.2rem);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  line-height: 1.1;
  margin-bottom: 0.5rem;
}
.club-meta {
  font-size: 0.95rem;
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.club-meta .dot { margin: 0 0.4rem; opacity: 0.4; }
.club-league {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 0.2rem 0.7rem;
  border-radius: 3px;
  background: rgba(148, 163, 184, 0.1);
  color: var(--text-muted);
  margin-bottom: 1rem;
}

/* Section blocks */
.section {
  margin: 2rem 0;
  padding: 1.5rem;
  background: var(--bg-card);
  border-radius: var(--radius);
  border: 1px solid var(--border-light);
}
.section-label {
  font-family: var(--font-heading);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--green-bright);
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border-light);
}
.section h3 {
  font-family: var(--font-body);
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.section p, .section li {
  font-size: 0.9rem;
  color: var(--text-muted);
  line-height: 1.7;
}
.section ul {
  list-style: none;
  padding: 0;
}
.section li {
  padding: 0.3rem 0 0.3rem 1.2rem;
  position: relative;
}
.section li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.85rem;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green-bright);
}

/* Officer cards */
.officer-card {
  background: var(--bg-section);
  border-radius: 6px;
  padding: 1rem 1.2rem;
  margin-bottom: 0.75rem;
  border-left: 3px solid var(--green-bright);
}
.officer-card:last-child { margin-bottom: 0; }
.officer-role {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--green-light);
  margin-bottom: 0.3rem;
}
.officer-name {
  font-size: 0.95rem;
  color: var(--text);
  margin-bottom: 0.3rem;
}
.officer-npub {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-dim);
  word-break: break-all;
  margin-bottom: 0.3rem;
}
.officer-npub.pending {
  font-family: var(--font-body);
  font-style: italic;
  color: var(--amber);
}
.officer-verified {
  font-size: 0.75rem;
  color: var(--text-dim);
  font-style: italic;
}
.officer-nip05 {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--green-bright);
  margin-bottom: 0.3rem;
}
.officer-group-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  margin: 1rem 0 0.5rem;
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--border-light);
}
.officer-group-label:first-child { margin-top: 0; }

/* Nudge box (pre-network) */
.nudge-box {
  background: var(--green-wash);
  border: 1px solid rgba(5, 150, 105, 0.2);
  border-radius: var(--radius);
  padding: 1.5rem;
  text-align: center;
  margin: 2rem 0;
}
.nudge-box h3 {
  font-family: var(--font-body);
  font-size: 1.05rem;
  color: var(--text);
  margin-bottom: 0.5rem;
}
.nudge-box p {
  font-size: 0.9rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}
.nudge-btn {
  display: inline-block;
  background: var(--green);
  color: var(--text);
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0.6rem 1.8rem;
  border-radius: 6px;
  transition: background 0.15s;
}
.nudge-btn:hover {
  background: var(--green-bright);
  text-decoration: none;
}

/* CTA section (active — for other clubs) */
.cta-section {
  background: var(--green-wash);
  border: 1px solid rgba(5, 150, 105, 0.2);
  border-radius: var(--radius);
  padding: 1.5rem;
  margin: 2rem 0;
}
.cta-section h3 {
  font-family: var(--font-body);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.5rem;
}
.cta-section p {
  font-size: 0.9rem;
  color: var(--text-muted);
  line-height: 1.7;
}

/* Verification note */
.verification-note {
  font-size: 0.78rem;
  color: var(--text-dim);
  font-style: italic;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-light);
}

/* Active page specific */
.club-link {
  font-size: 0.85rem;
}

/* Responsive */
@media (max-width: 640px) {
  .page { padding: 1.5rem 1rem; }
  .club-header { padding: 2rem 0 1.5rem; }
  .section { padding: 1.2rem; }
  .site-nav a { margin-left: 1rem; font-size: 0.7rem; }
}
`;

// ---------------------------------------------------------------------------
// Pre-network page template
// ---------------------------------------------------------------------------

function preNetworkPage(club) {
  const leagueDisplay = club.division
    ? `${escapeHtml(club.league)} &mdash; ${escapeHtml(club.division)}`
    : escapeHtml(club.league);

  const body = `
  <div class="page">
    <div class="club-header">
      <h1 class="club-name">${escapeHtml(club.name)}</h1>
      <div class="club-meta">
        ${escapeHtml(club.ground)}<span class="dot">&middot;</span>${escapeHtml(club.address)}
      </div>
      <div class="club-league">${leagueDisplay}</div>
    </div>

    <div class="section">
      <div class="section-label">What MatchPass Would Give ${escapeHtml(club.name)}</div>
      <ul>
        <li>Turnstile identity &mdash; 2-second entry via QR scan, no paper tickets needed</li>
        <li>The card system &mdash; yellow, red, suspension, and banning in language every fan knows</li>
        <li>Cross-club bans &mdash; a ban at one club visible at every club on the network</li>
        <li>Safeguarding tools &mdash; verified parent-child linkage, photo identity, officer attestations</li>
        <li>GDPR template pack &mdash; ready-made policies for fan data, banning records, and safeguarding</li>
        <li>NFC wristbands &mdash; works without a phone, for kids and when batteries die</li>
      </ul>
    </div>

    <div class="nudge-box">
      <h3>Think your club should be on the network?</h3>
      <p>Fans can make this happen. Let ${escapeHtml(club.name)} know there's demand.</p>
      <a href="${escapeHtml(club.contactUrl)}" target="_blank" rel="noopener" class="nudge-btn">
        Contact ${escapeHtml(club.name)} &rarr;
      </a>
    </div>

  </div>`;

  return pageShell(
    `${club.name} — MatchPass`,
    body,
    { canonical: club.slug }
  );
}

// ---------------------------------------------------------------------------
// Active page template
// ---------------------------------------------------------------------------

function activePage(club, leagueMates) {
  const leagueDisplay = club.division
    ? `${escapeHtml(club.league)} &mdash; ${escapeHtml(club.division)}`
    : escapeHtml(club.league);

  // Officers section — grouped by role
  const groups = groupOfficers(club.officers || []);
  const renderGroup = (label, officers) => {
    if (officers.length === 0) return '';
    let stewardIdx = 0;
    const cards = officers.map(o => {
      const card = renderOfficerCard(o, club, stewardIdx);
      if (roleToKey(o.role) === 'steward') stewardIdx++;
      return card;
    }).join('\n');
    return `<div class="officer-group-label">${escapeHtml(label)}</div>\n${cards}`;
  };

  const officerCards = [
    renderGroup('Club Administration', groups.admin),
    renderGroup('Safeguarding', groups.safeguarding),
    renderGroup('Stewards', groups.steward),
    renderGroup('Other Officers', groups.other),
  ].filter(Boolean).join('\n');

  // Safeguarding link
  const safeguardingLink = club.safeguardingUrl
    ? `<li>The safeguarding officer listed on this page is the person who verifies family linkages at this club &mdash; <a href="${escapeHtml(club.safeguardingUrl)}" target="_blank" rel="noopener">view the club's own safeguarding page</a></li>`
    : '<li>The safeguarding officer listed on this page is the person who verifies family linkages at this club</li>';

  const body = `
  <div class="page">
    <div class="club-header">
      <h1 class="club-name">${escapeHtml(club.name)}</h1>
      <div class="club-meta">
        ${escapeHtml(club.ground)}<span class="dot">&middot;</span>${escapeHtml(club.address)}
      </div>
      <div class="club-league">${leagueDisplay}</div>
      <a href="${escapeHtml(club.website)}" target="_blank" rel="noopener" class="club-link">Visit club website &rarr;</a>
    </div>

    <!-- Verified Officers -->
    <div class="section">
      <div class="section-label">Verified Officers</div>
      ${officerCards}
      <p class="verification-note">
        Each officer's identity is cryptographically signed and verifiable across the MatchPass network.
        The public key (npub) listed above can be independently verified by any club on the network.
      </p>
    </div>

    <!-- What This Means for Fans -->
    <div class="section">
      <div class="section-label">What This Means for Fans</div>
      <p>Fans at ${escapeHtml(club.name)} use <a href="https://mysignet.app" target="_blank" rel="noopener">mysignet.app</a> for matchday identity.</p>
      <ul>
        <li>2-second entry at the turnstile &mdash; scan your QR, you're in</li>
        <li>Your reputation is portable &mdash; a clean sheet travels to every club on the network</li>
        <li>No phone? NFC wristbands are available at the club office</li>
        <li>One identity across every club on the MatchPass network</li>
      </ul>
    </div>

    <!-- What This Means for Parents -->
    <div class="section">
      <div class="section-label">What This Means for Parents</div>
      <ul>
        <li>Parent-child linkage requires <strong>in-person verification</strong> by the safeguarding officer listed above &mdash; it cannot be self-certified</li>
        <li>Your child's photo is stored on Blossom (decentralised storage), not on MatchPass servers &mdash; you control it</li>
        ${safeguardingLink}
      </ul>
    </div>

    <!-- Community Impact -->
    <div class="section" style="opacity: 0.5;">
      <div class="section-label">Community Impact</div>
      <p style="font-size: 0.85rem; color: var(--text-dim); font-style: italic;">
        Operational stats will appear here once ${escapeHtml(club.name)} has matchday data &mdash;
        entries processed, safeguarding verifications, clean sheet rate.
        All figures are cryptographically signed, not self-reported.
      </p>
      <p class="verification-note">Powered by <a href="https://due.credit">DueCredit</a> &mdash; credit where it's due</p>
    </div>

    <!-- Community Support -->
    <div class="section" style="opacity: 0.5;">
      <div class="section-label">Community Support</div>
      <p style="font-size: 0.85rem; color: var(--text-dim); font-style: italic;">
        Donation tallies will appear here once ${escapeHtml(club.name)}'s community begins
        contributing to the MatchPass network. Value for value &mdash; give what you can.
      </p>
    </div>

    <!-- League Map -->
    ${(club.lat && club.lng) ? `
    <div class="section">
      <div class="section-label">${escapeHtml(club.league)}${club.division ? ' &mdash; ' + escapeHtml(club.division) : ''}</div>
      <div class="map-legend" style="margin-bottom: 0.75rem;">
        <span class="legend-dot active"></span> Active
        <span class="legend-dot pending"></span> Setting up
        <span class="legend-dot pre-network"></span> Listed
      </div>
      <div id="league-map" style="height: 300px; border-radius: var(--radius); border: 1px solid var(--border-light);"></div>
    </div>` : ''}

    <!-- For Other Clubs -->
    <div class="cta-section">
      <h3>Want to join the network?</h3>
      <p>It takes under an hour. Free to implement. No IT department required.</p>
      <p style="margin-top: 0.75rem;">
        Ask ${escapeHtml(club.name)}'s safety officer how it's working for them.
      </p>
    </div>
  </div>`;

  // League map data — current club + league mates with coordinates
  const mapClubs = [club, ...leagueMates].filter(c => c.lat && c.lng);
  const hasMap = club.lat && club.lng && mapClubs.length > 0;

  const mapHead = hasMap ? `
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    .map-legend { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted); }
    .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.15rem; }
    .legend-dot.active { background: var(--green-bright); }
    .legend-dot.pending { background: var(--amber); }
    .legend-dot.pre-network { background: var(--text-dim); }
    .leaflet-popup-content-wrapper { background: var(--bg-card) !important; color: var(--text) !important; border-radius: var(--radius) !important; border: 1px solid var(--border) !important; }
    .leaflet-popup-tip { background: var(--bg-card) !important; }
    .leaflet-popup-content a { color: var(--green-light) !important; font-weight: 600; }
    .leaflet-popup-content .popup-league { font-size: 0.75rem; color: var(--text-dim); }
  </style>` : '';

  const mapScript = hasMap ? `
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
  (function() {
    var clubs = ${JSON.stringify(mapClubs.map(c => ({
      slug: c.slug, name: c.name, ground: c.ground, status: c.status,
      lat: c.lat, lng: c.lng, isCurrent: c.slug === club.slug
    })))};
    var statusColor = { active: '#059669', pending: '#f59e0b', 'pre-network': '#64748b' };
    var map = L.map('league-map', { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &copy; CARTO', maxZoom: 18
    }).addTo(map);
    var bounds = [];
    clubs.forEach(function(c) {
      var color = statusColor[c.status] || statusColor['pre-network'];
      var radius = c.isCurrent ? 9 : 5;
      var weight = c.isCurrent ? 3 : 1;
      var marker = L.circleMarker([c.lat, c.lng], {
        radius: radius, fillColor: color, color: c.isCurrent ? '#fff' : color,
        weight: weight, opacity: 0.9, fillOpacity: 0.8
      });
      if (!c.isCurrent) {
        marker.bindPopup('<a href="../' + c.slug + '/">' + c.name + '</a><div class="popup-league">' + c.ground + '</div>');
      } else {
        marker.bindPopup('<strong>' + c.name + '</strong><div class="popup-league">You are here</div>');
      }
      marker.addTo(map);
      bounds.push([c.lat, c.lng]);
    });
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30] });
    } else {
      map.setView(bounds[0], 10);
    }
  })();
  </script>` : '';

  return pageShell(
    `${club.name} — MatchPass`,
    body,
    { canonical: club.slug, extraHead: mapHead, scripts: mapScript }
  );
}

// ---------------------------------------------------------------------------
// Index / directory page
// ---------------------------------------------------------------------------

const CSS_INDEX = `
/* Hero */
.hero {
  text-align: center;
  padding: 5rem 1.5rem 3rem;
  max-width: 800px;
  margin: 0 auto;
}
.hero h1 {
  font-family: var(--font-heading);
  font-size: clamp(2.5rem, 7vw, 4rem);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  line-height: 1.05;
  margin-bottom: 0.75rem;
}
.hero h1 span { color: var(--green-bright); }
.hero .hook {
  font-size: clamp(1.1rem, 2.5vw, 1.3rem);
  color: var(--green-light);
  font-style: italic;
  margin-bottom: 1rem;
}
.hero .lead {
  font-size: 1rem;
  color: var(--text-muted);
  max-width: 600px;
  margin: 0 auto 2rem;
  line-height: 1.8;
}
.hero-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 2.5rem;
}
.btn {
  display: inline-block;
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0.7rem 2rem;
  border-radius: 6px;
  text-decoration: none;
  transition: background 0.15s, transform 0.15s;
}
.btn:hover { transform: translateY(-1px); text-decoration: none; }
.btn-primary { background: var(--green); color: var(--text); }
.btn-primary:hover { background: var(--green-bright); }
.btn-secondary {
  background: transparent; color: var(--text-muted);
  border: 1px solid var(--border);
}
.btn-secondary:hover { border-color: var(--green-bright); color: var(--green-light); }

.hero-stats {
  display: flex;
  justify-content: center;
  gap: 2.5rem;
}
.hero-stat { text-align: center; }
.hero-stat .num {
  font-family: var(--font-heading);
  font-size: 2rem;
  color: var(--green-bright);
}
.hero-stat .label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}

/* Landing sections */
.landing-section {
  max-width: 900px;
  margin: 0 auto;
  padding: 3rem 1.5rem;
}
.landing-section.has-border {
  border-top: 1px solid var(--border);
}
.section-heading {
  font-family: var(--font-heading);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--green-bright);
  margin-bottom: 1.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border-light);
}
.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}
.feature-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 1.5rem;
  border: 1px solid var(--border-light);
}
.feature-card .icon {
  font-size: 1.5rem;
  margin-bottom: 0.75rem;
}
.feature-card h3 {
  font-family: var(--font-body);
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.4rem;
}
.feature-card p {
  font-size: 0.85rem;
  color: var(--text-muted);
  line-height: 1.7;
}

/* Steps */
.steps-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}
.step {
  text-align: center;
  padding: 1.5rem 1rem;
  background: var(--bg-card);
  border-radius: var(--radius);
  border: 1px solid var(--border-light);
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: var(--green);
  color: var(--text);
  font-family: var(--font-heading);
  font-size: 1rem;
  font-weight: 700;
  border-radius: 50%;
  margin-bottom: 0.75rem;
}
.step h3 {
  font-family: var(--font-body);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.3rem;
}
.step p {
  font-size: 0.78rem;
  color: var(--text-muted);
  line-height: 1.6;
}

/* Cost section */
.cost-box {
  background: var(--green-wash);
  border: 1px solid rgba(5, 150, 105, 0.2);
  border-radius: var(--radius);
  padding: 2rem;
  text-align: center;
}
.cost-box h3 {
  font-family: var(--font-heading);
  font-size: clamp(1.5rem, 4vw, 2rem);
  text-transform: uppercase;
  color: var(--green-light);
  margin-bottom: 0.5rem;
}
.cost-box .subtitle {
  font-size: 1rem;
  color: var(--text-muted);
  margin-bottom: 1.5rem;
}
.cost-points {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: center;
}
.cost-point {
  background: var(--bg-card);
  border-radius: 6px;
  padding: 0.8rem 1.2rem;
  font-size: 0.85rem;
  color: var(--text-muted);
  border: 1px solid var(--border-light);
}
.cost-point strong { color: var(--green-light); }

/* Club CTA */
.club-cta {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 2rem;
  border: 1px solid var(--border-light);
}
.club-cta h3 {
  font-family: var(--font-body);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.75rem;
}
.club-cta p {
  font-size: 0.9rem;
  color: var(--text-muted);
  line-height: 1.7;
  margin-bottom: 0.75rem;
}
.club-cta .checklist {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
}
.club-cta .checklist li {
  font-size: 0.88rem;
  color: var(--text-muted);
  padding: 0.4rem 0 0.4rem 1.5rem;
  position: relative;
}
.club-cta .checklist li::before {
  content: "\\2713";
  position: absolute;
  left: 0;
  color: var(--green-bright);
  font-weight: 700;
}
.club-cta .contact-line {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-light);
  font-size: 0.85rem;
  color: var(--text-dim);
}

/* Fan nudge */
.fan-nudge {
  text-align: center;
  padding: 1.5rem;
  color: var(--text-dim);
  font-size: 0.9rem;
}
.fan-nudge strong { color: var(--text-muted); }

/* Directory divider */
.directory-divider {
  text-align: center;
  padding: 3rem 1.5rem 1rem;
  max-width: 900px;
  margin: 0 auto;
}
.directory-divider h2 {
  font-family: var(--font-heading);
  font-size: clamp(1.3rem, 3vw, 1.8rem);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text);
  margin-bottom: 0.5rem;
}
.directory-divider h2 span { color: var(--green-bright); }
.directory-divider p {
  font-size: 0.9rem;
  color: var(--text-muted);
}

/* Club directory */
.directory {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 1.5rem 3rem;
}
.country-group { margin-bottom: 3rem; }
.country-title {
  font-family: var(--font-heading);
  font-size: 1.1rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text);
  padding-bottom: 0.5rem;
  border-bottom: 2px solid var(--green);
  margin-bottom: 1.5rem;
}
.league-group { margin-bottom: 2.5rem; }
.league-title {
  font-family: var(--font-heading);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--green-bright);
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}
.club-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
}
.club-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg-card);
  border-radius: 6px;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border-light);
  color: var(--text);
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s;
}
.club-card:hover {
  background: var(--bg-card-hover);
  border-color: rgba(5, 150, 105, 0.3);
  text-decoration: none;
}
.club-card .indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.club-card .indicator.active { background: var(--green-bright); }
.club-card .indicator.pending { background: var(--amber); }
.club-card .indicator.pre-network { background: var(--text-dim); }
.club-card .info { min-width: 0; }
.club-card .club-card-name {
  font-size: 0.88rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.club-card .club-card-ground {
  font-size: 0.72rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 640px) {
  .hero-stats { gap: 1rem; }
  .hero-stat .num { font-size: 1.5rem; }
  .feature-grid { grid-template-columns: 1fr; }
  .steps-grid { grid-template-columns: 1fr 1fr; }
  .club-grid { grid-template-columns: 1fr; }
  .cost-points { flex-direction: column; align-items: center; }
}
@media (max-width: 400px) {
  .steps-grid { grid-template-columns: 1fr; }
  .hero-buttons { flex-direction: column; align-items: center; }
}
`;

// Country and pyramid ordering — grassroots first
const COUNTRY_ORDER = ['England', 'Scotland', 'Wales', 'Northern Ireland', 'Republic of Ireland'];

const LEAGUE_COUNTRY = {
  'Northern Premier League': 'England',
  'Southern League': 'England',
  'Isthmian League': 'England',
  'National League North': 'England',
  'National League South': 'England',
  'National League': 'England',
  'League Two': 'England',
  'League One': 'England',
  'Championship': 'England',
  'Premier League': 'England',
  'Scottish League Two': 'Scotland',
  'Scottish League One': 'Scotland',
  'Scottish Championship': 'Scotland',
  'Scottish Premiership': 'Scotland',
  'Cymru South': 'Wales',
  'Cymru North': 'Wales',
  'Cymru Premier': 'Wales',
  'NIFL Championship': 'Northern Ireland',
  'NIFL Premiership': 'Northern Ireland',
  'League of Ireland First Division': 'Republic of Ireland',
  'League of Ireland Premier Division': 'Republic of Ireland',
};

// Lower number = shown first (grassroots at the top)
const LEAGUE_TIER = {
  'Northern Premier League': 1,
  'Southern League': 1,
  'Isthmian League': 1,
  'National League North': 2,
  'National League South': 2,
  'National League': 3,
  'League Two': 4,
  'League One': 5,
  'Championship': 6,
  'Premier League': 7,
  'Scottish League Two': 1,
  'Scottish League One': 2,
  'Scottish Championship': 3,
  'Scottish Premiership': 4,
  'Cymru South': 1,
  'Cymru North': 1,
  'Cymru Premier': 2,
  'NIFL Championship': 1,
  'NIFL Premiership': 2,
  'League of Ireland First Division': 1,
  'League of Ireland Premier Division': 2,
};

function indexPage(clubs) {
  const activeClubs = clubs.filter(c => c.status === 'active');
  const pendingClubs = clubs.filter(c => c.status === 'pending');
  const otherClubs = clubs.filter(c => c.status !== 'active' && c.status !== 'pending');

  // Group all non-active clubs by country then league
  const allDirectoryClubs = [...pendingClubs, ...otherClubs];
  const countryGroups = {};
  for (const c of allDirectoryClubs) {
    const country = LEAGUE_COUNTRY[c.league] || 'England';
    if (!countryGroups[country]) countryGroups[country] = {};
    if (!countryGroups[country][c.league]) countryGroups[country][c.league] = [];
    countryGroups[country][c.league].push(c);
  }

  // Sort clubs alphabetically within each league
  for (const country of Object.values(countryGroups)) {
    for (const list of Object.values(country)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // Render club card
  const clubCard = (c) => `
        <a href="${c.slug}/" class="club-card">
          <div class="indicator ${c.status === 'active' ? 'active' : c.status === 'pending' ? 'pending' : 'pre-network'}"></div>
          <div class="info">
            <div class="club-card-name">${escapeHtml(c.name)}</div>
            <div class="club-card-ground">${escapeHtml(c.ground)}</div>
          </div>
        </a>`;

  // Active clubs section
  const activeHtml = activeClubs.length > 0 ? `
    <div class="league-group">
      <div class="league-title">On the Network</div>
      <div class="club-grid">
        ${activeClubs.map(clubCard).join('')}
      </div>
    </div>` : '';

  // Pending clubs section
  const pendingHtml = pendingClubs.length > 0 ? `
    <div class="league-group">
      <div class="league-title">Setting Up</div>
      <div class="club-grid">
        ${pendingClubs.map(clubCard).join('')}
      </div>
    </div>` : '';

  // Directory by country and league (grassroots first)
  const directoryHtml = COUNTRY_ORDER.map(country => {
    const leagues = countryGroups[country];
    if (!leagues) return '';
    const sortedLeagues = Object.entries(leagues)
      .sort((a, b) => (LEAGUE_TIER[a[0]] || 99) - (LEAGUE_TIER[b[0]] || 99));
    return `
    <div class="country-group">
      <div class="country-title">${escapeHtml(country)}</div>
      ${sortedLeagues.map(([league, list]) => `
      <div class="league-group">
        <div class="league-title">${escapeHtml(league)}</div>
        <div class="club-grid">
          ${list.map(clubCard).join('')}
        </div>
      </div>`).join('\n')}
    </div>`;
  }).filter(Boolean).join('\n');

  const leagueCount = new Set(clubs.map(c => c.league)).size;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MatchPass &mdash; Football Safety, Community Owned</title>
  <link rel="canonical" href="https://matchpass.club/">
  <meta name="description" content="Digital matchday identity for football clubs. QR scan at the turnstile, 2-second entry, cross-club banning, the card system. Free to clubs. Community owned.">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
  <style>
    ${CSS_VARS}
    ${CSS_BASE}
    ${CSS_HEADER}
    ${CSS_FOOTER}
    ${CSS_INDEX}

    /* Map */
    .map-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .map-legend {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .legend-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 0.15rem;
    }
    .legend-dot.active { background: var(--green-bright); }
    .legend-dot.pending { background: var(--amber); }
    .legend-dot.pre-network { background: var(--text-dim); }
    .league-filter {
      background: var(--bg-card);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.4rem 0.8rem;
      font-size: 0.8rem;
      font-family: var(--font-body);
    }
    .league-filter:focus { outline: 1px solid var(--green-bright); }
    /* Override Leaflet cluster styles for dark theme */
    .marker-cluster {
      background: rgba(15, 23, 42, 0.7) !important;
      border: 2px solid var(--green-bright) !important;
    }
    .marker-cluster div {
      background: var(--bg-card) !important;
      color: var(--text) !important;
      font-family: var(--font-body) !important;
      font-weight: 600;
    }
    .marker-cluster-small { border-color: var(--text-dim) !important; }
    .marker-cluster-medium { border-color: var(--amber) !important; }
    .marker-cluster-large { border-color: var(--green-bright) !important; }
    .leaflet-popup-content-wrapper {
      background: var(--bg-card) !important;
      color: var(--text) !important;
      border-radius: var(--radius) !important;
      border: 1px solid var(--border) !important;
    }
    .leaflet-popup-tip { background: var(--bg-card) !important; }
    .leaflet-popup-content a {
      color: var(--green-light) !important;
      font-weight: 600;
    }
    .leaflet-popup-content .popup-league {
      font-size: 0.75rem;
      color: var(--text-dim);
    }
  </style>
</head>
<body>
  <header class="site-header">
    <a href="./" class="site-logo">Match<span>Pass</span></a>
    <nav class="site-nav">
      <a href="#for-clubs">For Clubs</a>
      <a href="#directory">All Clubs</a>
    </nav>
  </header>

  <!-- HERO -->
  <div class="hero">
    <h1>Match<span>Pass</span></h1>
    <p class="hook">Your reputation travels with you.</p>
    <p class="lead">
      Digital matchday identity for football clubs. QR scan at the turnstile,
      2-second entry, cross-club banning, and a card system every fan already
      understands. Free to clubs. Community owned.
    </p>
    <div class="hero-buttons">
      <a href="#for-clubs" class="btn btn-primary">I'm a club</a>
      <a href="#directory" class="btn btn-secondary">Find your club</a>
    </div>
    <div class="hero-stats">
      <div class="hero-stat">
        <div class="num">${activeClubs.length}</div>
        <div class="label">On the network</div>
      </div>
      <div class="hero-stat">
        <div class="num">${pendingClubs.length}</div>
        <div class="label">Setting up</div>
      </div>
      <div class="hero-stat">
        <div class="num">${clubs.length}</div>
        <div class="label">Clubs listed</div>
      </div>
      <div class="hero-stat">
        <div class="num">${leagueCount}</div>
        <div class="label">Leagues</div>
      </div>
    </div>
  </div>

  <!-- WHAT IT DOES -->
  <div class="landing-section has-border">
    <div class="section-heading">What It Does</div>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="icon">&#x1F3AB;</div>
        <h3>QR Scan at the Turnstile</h3>
        <p>Fan opens the app, QR on screen, steward scans it. Photo flashes for a visual match. Green light &mdash; through in 2 seconds. The QR refreshes every 30 seconds. A screenshot dies before your mate can use it.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#x1F7E8;</div>
        <h3>The Card System</h3>
        <p>Yellow card, red card, suspension, ban &mdash; language every fan knows. Stewards issue cards through the app. Fans get instant notification with the reason and a right to challenge. Good behaviour clears the slate.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#x1F6AB;</div>
        <h3>Cross-Club Banning</h3>
        <p>A ban at one club is visible at every club on the network. No spreadsheets, no phone calls, no gaps. A clean record travels too &mdash; good fans are recognised everywhere.</p>
      </div>
      <div class="feature-card">
        <div class="icon">&#x1F4F3;</div>
        <h3>NFC Wristbands <span style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--amber);margin-left:0.4rem;">Coming Soon</span></h3>
        <p>Works without a phone. For kids, for when batteries die, for fans who prefer it. Tap at the turnstile, same result. Anti-clone hardware &mdash; can't be copied. Currently in testing.</p>
      </div>
    </div>
  </div>

  <!-- HOW IT WORKS -->
  <div class="landing-section has-border">
    <div class="section-heading">How It Works</div>
    <div class="steps-grid">
      <div class="step">
        <div class="step-num">1</div>
        <h3>Scan In</h3>
        <p>Fan shows QR. Steward scans. Photo match, status check, ban check &mdash; one hit. Green light, through in 2 seconds.</p>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <h3>Card It</h3>
        <p>Steward sees an issue, opens the app, issues a yellow or red. Fan gets an instant notification with the reason and a right to challenge.</p>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <h3>It Travels</h3>
        <p>Cards and bans propagate to every club on the network within seconds. A clean record travels too. Reputation is portable.</p>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <h3>Fair Process</h3>
        <p>Every card is challengeable. Independent panel for suspensions and bans &mdash; not the issuing steward. Fan sees progress toward a clean sheet.</p>
      </div>
    </div>
  </div>

  <!-- WHAT IT COSTS -->
  <div class="landing-section has-border">
    <div class="section-heading">What It Costs</div>
    <div class="cost-box">
      <h3>Free</h3>
      <p class="subtitle">Community owned. Value for value.</p>
      <div class="cost-points">
        <div class="cost-point"><strong>Clubs</strong> pay nothing</div>
        <div class="cost-point"><strong>Fans</strong> pay nothing for core features</div>
        <div class="cost-point"><strong>NFC wristbands</strong> available &mdash; funded by fan contributions</div>
        <div class="cost-point"><strong>No SaaS fees.</strong> No transaction fees. No vendor lock-in.</div>
        <div class="cost-point"><strong>Open source.</strong> Self-hostable. One Docker command.</div>
      </div>
    </div>
  </div>

  <!-- FOR CLUBS -->
  <div id="for-clubs" class="landing-section has-border">
    <div class="section-heading">For Clubs</div>
    <div class="club-cta">
      <h3>Under an hour to set up. No IT department required.</h3>
      <p>MatchPass gives your club a gate scanner, the card system, cross-club banning, safeguarding tools, and a GDPR template pack. Built and security-audited &mdash; 75 tests, 3 clean security audits.</p>
      <ul class="checklist">
        <li>Gate scanner &mdash; QR and NFC entry with photo verification</li>
        <li>Card system &mdash; yellow, red, suspension, ban with challenge process</li>
        <li>Cross-club network &mdash; bans and reputation travel between clubs</li>
        <li>Safeguarding &mdash; verified parent-child linkage, officer attestations</li>
        <li>GDPR template pack &mdash; ready-made policies for fan data and banning records</li>
        <li>Offline support &mdash; works when the Wi-Fi doesn't</li>
      </ul>
      <p>All you need is a phone and a safety officer willing to try it.</p>
      <div class="contact-line">
        Interested? Get in touch &mdash; we're onboarding pilot clubs in the East Midlands now.
      </div>
    </div>
  </div>

  <!-- FOR FANS -->
  <div class="landing-section has-border">
    <div class="section-heading">For Fans</div>
    <div class="fan-nudge">
      <strong>Think your club should be on the network?</strong>
      <br>Find your club below and let them know there's demand.
      Every club that joins makes every other club safer.
    </div>
  </div>

  <!-- MAP -->
  <div id="map-section" class="landing-section">
    <div class="section-heading">The Network</div>
    <div class="map-controls">
      <div class="map-legend">
        <span class="legend-dot active"></span> Active
        <span class="legend-dot pending"></span> Setting up
        <span class="legend-dot pre-network"></span> Listed
      </div>
      <select id="league-filter" class="league-filter">
        <option value="">All leagues</option>
        ${[...new Set(clubs.map(c => c.league))].sort().map(l =>
          `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`
        ).join('\n        ')}
      </select>
    </div>
    <div id="club-map" style="height: 500px; border-radius: var(--radius); border: 1px solid var(--border);"></div>
  </div>

  <!-- DIRECTORY -->
  <div id="directory" class="directory-divider">
    <h2>Find Your <span>Club</span></h2>
    <p>${clubs.length} clubs across ${leagueCount} leagues. Find yours.</p>
  </div>

  <div class="directory">
    ${activeHtml}
    ${pendingHtml}
    ${directoryHtml}
  </div>

  <footer class="site-footer">
    matchpass.club &mdash; football safety, community owned &mdash; v${version}
  </footer>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
  <script>
  (function() {
    var clubs = ${JSON.stringify(clubs.filter(c => c.lat && c.lng).map(c => ({
      slug: c.slug,
      name: c.name,
      ground: c.ground,
      league: c.league,
      status: c.status,
      lat: c.lat,
      lng: c.lng
    })))};

    var statusColor = { active: '#059669', pending: '#f59e0b', 'pre-network': '#64748b' };
    var map = L.map('club-map', {
      center: [54.5, -3],
      zoom: 6,
      scrollWheelZoom: true,
      zoomControl: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 18
    }).addTo(map);

    var markers = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: function(cluster) {
        var count = cluster.getChildCount();
        var size = count < 10 ? 'small' : count < 50 ? 'medium' : 'large';
        return L.divIcon({
          html: '<div>' + count + '</div>',
          className: 'marker-cluster marker-cluster-' + size,
          iconSize: L.point(36, 36)
        });
      }
    });

    var allMarkers = [];

    clubs.forEach(function(c) {
      var color = statusColor[c.status] || statusColor['pre-network'];
      var marker = L.circleMarker([c.lat, c.lng], {
        radius: 6,
        fillColor: color,
        color: color,
        weight: 1,
        opacity: 0.9,
        fillOpacity: 0.8
      });
      marker.bindPopup(
        '<a href="' + c.slug + '/">' + c.name + '</a>' +
        '<div class="popup-league">' + c.league + '</div>' +
        '<div class="popup-league">' + c.ground + '</div>'
      );
      marker._clubData = c;
      allMarkers.push(marker);
      markers.addLayer(marker);
    });

    map.addLayer(markers);

    // League filter
    var filter = document.getElementById('league-filter');
    filter.addEventListener('change', function() {
      var val = this.value;
      markers.clearLayers();
      allMarkers.forEach(function(m) {
        if (!val || m._clubData.league === val) {
          markers.addLayer(m);
        }
      });
    });
  })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// .well-known/nostr.json
// ---------------------------------------------------------------------------

function nostrJson(clubs) {
  const names = {};
  for (const club of clubs) {
    if (club.status !== 'active' || !club.officers) continue;
    let stewardIndex = 0;
    for (const officer of club.officers) {
      const hex = npubToHex(officer.npub);
      if (!hex) continue;
      const key = officerNip05Key(officer, club, stewardIndex);
      if (names[key]) {
        console.warn(`  NIP-05 key collision: "${key}" — skipping duplicate for ${club.slug}`);
        continue;
      }
      names[key] = hex;
      if (roleToKey(officer.role) === 'steward') stewardIndex++;
    }
  }
  return JSON.stringify({ names }, null, 2);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build() {
  console.log('Reading club data...');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const clubs = data.clubs;

  const active = clubs.filter(c => c.status === 'active').length;
  const pending = clubs.filter(c => c.status === 'pending').length;
  console.log(`Found ${clubs.length} clubs (${active} active, ${pending} pending)`);

  // Clean dist
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  ensureDir(DIST_DIR);

  // Generate club pages
  for (const club of clubs) {
    const dir = path.join(DIST_DIR, club.slug);
    ensureDir(dir);

    let html;
    if (club.status === 'active' || club.status === 'pending') {
      const leagueMates = clubs.filter(c => c.league === club.league && c.slug !== club.slug);
      html = activePage(club, leagueMates);
    } else {
      html = preNetworkPage(club);
    }

    fs.writeFileSync(path.join(dir, 'index.html'), html);
    const icon = club.status === 'active' ? '\x1b[32m●\x1b[0m'
      : club.status === 'pending' ? '\x1b[33m◐\x1b[0m'
      : '\x1b[90m○\x1b[0m';
    console.log(`  ${icon} ${club.slug}/`);
  }

  // Generate index page
  fs.writeFileSync(path.join(DIST_DIR, 'index.html'), indexPage(clubs));
  console.log('  index.html');

  // Generate .well-known/nostr.json
  const wellKnownDir = path.join(DIST_DIR, '.well-known');
  ensureDir(wellKnownDir);
  fs.writeFileSync(path.join(wellKnownDir, 'nostr.json'), nostrJson(clubs));
  console.log('  .well-known/nostr.json');

  console.log(`\nDone. ${clubs.length} pages generated in dist/`);
}

build();
