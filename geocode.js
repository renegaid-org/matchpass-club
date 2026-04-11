const fs = require('fs');
const path = require('path');

const CLUBS_PATH = path.join(__dirname, 'data', 'clubs.json');
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'MatchPass-Geocoder/1.0';
const DELAY_MS = 1100; // slightly over 1s to respect Nominatim policy

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocode(query) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '1',
    countrycodes: 'gb,ie',
  });
  const url = `${NOMINATIM_URL}?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for query: ${query}`);
  }
  const data = await res.json();
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

function extractPostcode(address) {
  // UK postcodes: e.g. DE56 1BA, BT12 5GS, EH1 1RF
  // Irish Eircode: e.g. D01 F5P2
  const match = address.match(/([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})$/i);
  if (match) return match[1].trim();
  // Try Eircode
  const eir = address.match(/([A-Z]\d{2}\s*[A-Z0-9]{4})$/i);
  if (eir) return eir[1].trim();
  return null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(CLUBS_PATH, 'utf8'));
  const clubs = data.clubs;

  let geocoded = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`Processing ${clubs.length} clubs...\n`);

  for (let i = 0; i < clubs.length; i++) {
    const club = clubs[i];

    if (club.lat && club.lng) {
      skipped++;
      console.log(`[${i + 1}/${clubs.length}] SKIP ${club.name} (already geocoded)`);
      continue;
    }

    // Try full address first
    let result = await geocode(club.address);
    await sleep(DELAY_MS);

    // Fallback: postcode only
    if (!result) {
      const postcode = extractPostcode(club.address);
      if (postcode) {
        console.log(`[${i + 1}/${clubs.length}] Retrying ${club.name} with postcode: ${postcode}`);
        result = await geocode(postcode);
        await sleep(DELAY_MS);
      }
    }

    if (result) {
      club.lat = result.lat;
      club.lng = result.lng;
      geocoded++;
      console.log(`[${i + 1}/${clubs.length}] OK ${club.name} → ${result.lat}, ${result.lng}`);
    } else {
      failed++;
      console.log(`[${i + 1}/${clubs.length}] FAIL ${club.name} — ${club.address}`);
    }

    // Save progress every 50 clubs
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(CLUBS_PATH, JSON.stringify(data, null, 2) + '\n');
      console.log(`\n--- Saved progress at ${i + 1}/${clubs.length} ---\n`);
    }
  }

  // Final save
  fs.writeFileSync(CLUBS_PATH, JSON.stringify(data, null, 2) + '\n');

  console.log(`\n=== COMPLETE ===`);
  console.log(`Geocoded: ${geocoded}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Skipped:  ${skipped}`);
  console.log(`Total:    ${clubs.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
