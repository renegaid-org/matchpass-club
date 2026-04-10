#!/usr/bin/env node
/**
 * verify-websites.js — Check club websites for published MatchPass pubkeys
 *
 * Usage: node scripts/verify-websites.js [--json]
 *
 * Checks each active club's website and safeguarding page for npub patterns.
 * Reports: verified (found and matches), not_found, mismatch, error.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'clubs.json');
const NPUB_PATTERN = /npub1[a-z0-9]{58}/g;

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MatchPass-Verifier/1.0' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkWellKnown(website) {
  const url = new URL('/.well-known/nostr.json', website).href;
  const text = await fetchText(url);
  if (!text) return [];
  try {
    const json = JSON.parse(text);
    return Object.values(json.names || {});
  } catch {
    return [];
  }
}

async function checkPageForNpubs(url) {
  if (!url) return [];
  const text = await fetchText(url);
  if (!text) return [];
  const matches = text.match(NPUB_PATTERN) || [];
  return [...new Set(matches)];
}

async function verifyClub(club) {
  const result = {
    slug: club.slug,
    name: club.name,
    officers: [],
  };

  const wellKnownPubkeys = await checkWellKnown(club.website);
  const safeguardingNpubs = await checkPageForNpubs(club.safeguardingUrl);
  const homepageNpubs = await checkPageForNpubs(club.website);
  const allFoundNpubs = [...new Set([...safeguardingNpubs, ...homepageNpubs])];

  for (const officer of club.officers || []) {
    const entry = {
      role: officer.role,
      npub: officer.npub,
      status: 'not_found',
      foundOn: [],
    };

    if (officer.npub.startsWith('npub1placeholder')) {
      entry.status = 'placeholder';
      result.officers.push(entry);
      continue;
    }

    if (allFoundNpubs.includes(officer.npub)) {
      entry.status = 'verified';
      if (safeguardingNpubs.includes(officer.npub)) entry.foundOn.push('safeguarding');
      if (homepageNpubs.includes(officer.npub)) entry.foundOn.push('homepage');
    }

    if (wellKnownPubkeys.length > 0) {
      entry.foundOn.push('.well-known (hex check requires manual comparison)');
    }

    result.officers.push(entry);
  }

  return result;
}

async function main() {
  const jsonOutput = process.argv.includes('--json');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const activeClubs = data.clubs.filter(c => c.status === 'active');

  console.log(`Verifying ${activeClubs.length} active clubs...\n`);

  const results = [];
  for (const club of activeClubs) {
    if (!jsonOutput) process.stdout.write(`  Checking ${club.name}...`);
    const result = await verifyClub(club);
    results.push(result);

    if (!jsonOutput) {
      const statuses = result.officers.map(o => `${o.role}: ${o.status}`).join(', ');
      console.log(` ${statuses}`);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\nDone.');
    const verified = results.flatMap(r => r.officers).filter(o => o.status === 'verified').length;
    const total = results.flatMap(r => r.officers).length;
    const placeholders = results.flatMap(r => r.officers).filter(o => o.status === 'placeholder').length;
    console.log(`${verified}/${total} verified (${placeholders} placeholders)`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
