#!/usr/bin/env node
/**
 * Snap club coordinates to their actual football ground using OpenStreetMap.
 *
 * Two-phase approach:
 * 1. Match clubs against a pre-fetched cache of UK/IE stadiums and sports centres
 *    (data/.grounds-cache.json — fetched via Overpass bulk query).
 * 2. For clubs not matched in phase 1, query Overpass individually for nearby
 *    pitches (which are too numerous to bulk-fetch).
 *
 * Phase 2 respects Overpass rate limits with delays and retries.
 */

const fs = require('fs');
const path = require('path');

const CLUBS_PATH = path.join(__dirname, 'data', 'clubs.json');
const GROUNDS_CACHE = path.join(__dirname, 'data', '.grounds-cache.json');
const STATE_PATH = path.join(__dirname, 'data', '.snap-state.json');
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function distMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreElement(el, lat, lng, groundName) {
  const c = el.center || { lat: el.lat, lon: el.lon };
  if (!c || c.lat == null) return null;
  const elLat = c.lat;
  const elLng = c.lon != null ? c.lon : c.lng;
  if (elLat == null || elLng == null) return null;

  const dist = distMetres(lat, lng, elLat, elLng);
  if (dist > 1500) return null;

  const groundLower = (groundName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = ((el.tags && el.tags.name) || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  let nameScore = 0;
  if (name && groundLower) {
    if (name === groundLower) nameScore = 100;
    else if (name.includes(groundLower) || groundLower.includes(name)) nameScore = 50;
    else {
      const groundWords = groundLower.match(/[a-z]{3,}/g) || [];
      const nameWords = name.match(/[a-z]{3,}/g) || [];
      const overlap = groundWords.filter(w => nameWords.some(nw => nw.includes(w) || w.includes(nw)));
      if (overlap.length > 0) nameScore = 25;
    }
  }

  const typeScore = el.tags && el.tags.leisure === 'stadium' ? 20 : 0;

  return {
    elLat, elLng, dist, nameScore, typeScore,
    name: (el.tags && el.tags.name) || '(unnamed)',
    totalScore: nameScore + typeScore - dist / 100,
  };
}

async function queryOverpass(query, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const url = OVERPASS_URLS[attempt % OVERPASS_URLS.length];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < maxRetries) { await sleep(3000 + attempt * 2000); continue; }
        return null;
      }
      if (!resp.ok) return null;
      const text = await resp.text();
      if (text.startsWith('<') || text.startsWith('<!')) {
        if (attempt < maxRetries) { await sleep(3000 + attempt * 2000); continue; }
        return null;
      }
      return JSON.parse(text);
    } catch {
      clearTimeout(timeout);
      if (attempt < maxRetries) { await sleep(2000 + attempt * 1000); continue; }
      return null;
    }
  }
  return null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(CLUBS_PATH, 'utf8'));
  const clubs = data.clubs;

  // Load grounds cache
  let groundElements = [];
  try {
    const cache = JSON.parse(fs.readFileSync(GROUNDS_CACHE, 'utf8'));
    groundElements = cache.elements || [];
    console.log(`Loaded ${groundElements.length} ground features from cache.`);
  } catch (err) {
    console.log(`Warning: no grounds cache found (${err.message}). All lookups will use Overpass API.`);
  }

  let snapped = 0;
  let kept = 0;
  let skipped = 0;
  const examples = [];
  const needsPitchLookup = [];

  // Phase 1: Match against cached stadiums/sports centres
  console.log(`\n=== Phase 1: Matching ${clubs.length} clubs against ${groundElements.length} cached grounds ===`);

  for (let i = 0; i < clubs.length; i++) {
    const club = clubs[i];
    if (!club.lat || !club.lng) {
      skipped++;
      console.log(`[${i + 1}/${clubs.length}] ${club.name} -> skipped (no coords)`);
      continue;
    }

    const origLat = club.lat;
    const origLng = club.lng;

    // Score all cached grounds against this club
    const scored = groundElements
      .map(el => scoreElement(el, origLat, origLng, club.ground))
      .filter(Boolean)
      .sort((a, b) => b.totalScore - a.totalScore);

    if (scored.length > 0 && scored[0].totalScore > -5) {
      const best = scored[0];
      club.lat = Math.round(best.elLat * 100000) / 100000;
      club.lng = Math.round(best.elLng * 100000) / 100000;
      const dist = best.dist;
      const moved = dist > 10 ? `moved ${Math.round(dist)}m` : 'already close';
      console.log(`[${i + 1}/${clubs.length}] ${club.name} -> ${best.name} (${moved})`);
      snapped++;
      if (dist > 50 && examples.length < 30) {
        examples.push({ name: club.name, ground: best.name, dist: Math.round(dist) });
      }
    } else {
      needsPitchLookup.push({ index: i, club });
    }
  }

  console.log(`\nPhase 1 complete: ${snapped} matched, ${needsPitchLookup.length} need pitch lookup, ${skipped} skipped.`);

  // Load resume state for phase 2
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  const processed = state.processed || {};

  // Phase 2: Query Overpass for remaining clubs (pitches)
  if (needsPitchLookup.length > 0) {
    console.log(`\n=== Phase 2: Querying Overpass for ${needsPitchLookup.length} unmatched clubs ===`);

    for (let j = 0; j < needsPitchLookup.length; j++) {
      const { index: i, club } = needsPitchLookup[j];

      if (processed[club.slug]) {
        if (processed[club.slug] === 'kept') kept++;
        continue;
      }

      const origLat = club.lat;
      const origLng = club.lng;
      const radius = 1500;

      const query = `[out:json][timeout:10];(way["leisure"="stadium"](around:${radius},${origLat},${origLng});relation["leisure"="stadium"](around:${radius},${origLat},${origLng});way["leisure"="sports_centre"](around:${radius},${origLat},${origLng});way["leisure"="pitch"]["sport"="soccer"](around:${radius},${origLat},${origLng});way["leisure"="pitch"]["sport"="football"](around:${radius},${origLat},${origLng}););out center;`;

      const result = await queryOverpass(query);
      if (result && result.elements && result.elements.length > 0) {
        const scored = result.elements
          .map(el => scoreElement(el, origLat, origLng, club.ground))
          .filter(Boolean)
          .sort((a, b) => b.totalScore - a.totalScore);

        if (scored.length > 0) {
          const best = scored[0];
          club.lat = Math.round(best.elLat * 100000) / 100000;
          club.lng = Math.round(best.elLng * 100000) / 100000;
          const dist = best.dist;
          const moved = dist > 10 ? `moved ${Math.round(dist)}m` : 'already close';
          console.log(`  [${j + 1}/${needsPitchLookup.length}] ${club.name} -> ${best.name} (${moved})`);
          snapped++;
          processed[club.slug] = 'snapped';
          if (dist > 50 && examples.length < 30) {
            examples.push({ name: club.name, ground: best.name, dist: Math.round(dist) });
          }
        } else {
          console.log(`  [${j + 1}/${needsPitchLookup.length}] ${club.name} -> no suitable match`);
          kept++;
          processed[club.slug] = 'kept';
        }
      } else {
        console.log(`  [${j + 1}/${needsPitchLookup.length}] ${club.name} -> no ground found`);
        kept++;
        processed[club.slug] = 'kept';
      }

      // Save progress every 20 phase-2 clubs
      if ((j + 1) % 20 === 0) {
        fs.writeFileSync(CLUBS_PATH, JSON.stringify(data, null, 2));
        fs.writeFileSync(STATE_PATH, JSON.stringify({ processed }));
        console.log(`  [saved phase 2 progress: ${j + 1}/${needsPitchLookup.length}]`);
      }

      await sleep(DELAY_MS);
    }
  }

  // Final save
  fs.writeFileSync(CLUBS_PATH, JSON.stringify(data, null, 2));
  try { fs.unlinkSync(STATE_PATH); } catch {}

  console.log(`\n=== Summary ===`);
  console.log(`Total clubs: ${clubs.length}`);
  console.log(`Snapped to ground: ${snapped}`);
  console.log(`Kept original coords: ${kept}`);
  console.log(`Skipped (no coords): ${skipped}`);

  if (examples.length > 0) {
    console.log(`\nExample distance corrections:`);
    for (const ex of examples) {
      console.log(`  ${ex.name} moved ${ex.dist}m to ${ex.ground}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
