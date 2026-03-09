// Find entities that have a link to Wikipedia, Booking.com or Airbnb but no
// coords/location, then attempt to fetch coordinates and save them.
//
// Usage:
//   node find-location.js [list]  [--dryrun] [--retry] [--test]
//
// Options:
//   list      Restrict to a single list (optional)
//   --dryrun  Print what would be saved without writing to DB
//   --retry   Also attempt entities previously marked "not-found"
//   --test    Report only: bucket eligible entities by list, sorted by count
//
// Skips:
//   - Entities on pages tagged "no-coords"
//   - Entities that already have coords
//   - Entities previously attempted with no result (coords: "not-found")
//     unless --retry is passed
//
// On failure: sets coords to "not-found" so the entity is skipped on future
// runs. Pass --retry to attempt these again.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { getCoordsFromUrl, resetRateLimit } from "./wiki.js";

const args       = process.argv.slice(2).filter(a => !a.startsWith("--"));
const listArg    = args[0] ?? null;
const dryRun     = process.argv.includes("--dryrun");
const retry      = process.argv.includes("--retry");
const testMode   = process.argv.includes("--test");

// ─── DB ───────────────────────────────────────────────────────────────────────

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db       = client.db(process.env.MONGODB_DB || "andrewzc");
const entities = db.collection("entities");
const pages    = db.collection("pages");

// ─── Build set of no-coords lists ─────────────────────────────────────────────

const noCoordsPages = await pages
  .find({ tags: "no-coords" }, { projection: { key: 1 } })
  .toArray();
const noCoordsLists = new Set(noCoordsPages.map(p => p.key));
console.log(`Pages tagged no-coords: ${noCoordsLists.size}`);

// ─── Find candidates ──────────────────────────────────────────────────────────

const linkPattern = /wikipedia\.org|booking\.com|airbnb\.com/;

const baseFilter = {
  link: { $regex: "wikipedia\\.org|booking\\.com|airbnb\\.com" },
  coords: retry
    ? { $in: [null, undefined, "not-found", { $exists: false }] }
    : { $exists: false },
};

// If coords: "not-found" is stored as a string we need a different query
const filter = retry
  ? { link: { $regex: "wikipedia\\.org|booking\\.com|airbnb\\.com" },
      $or: [{ coords: { $exists: false } }, { coords: "not-found" }] }
  : { link: { $regex: "wikipedia\\.org|booking\\.com|airbnb\\.com" },
      coords: { $exists: false } };

if (listArg) filter.list = listArg;

const candidates = await entities
  .find(filter, { projection: { _id: 1, key: 1, list: 1, name: 1, link: 1 } })
  .toArray();

// Filter out no-coords lists
const eligible = candidates.filter(e => !noCoordsLists.has(e.list));

console.log(`Candidates: ${candidates.length}, eligible (excl. no-coords): ${eligible.length}\n`);

// ─── Test mode: report only ───────────────────────────────────────────────────

if (testMode) {
  const counts = {};
  for (const e of eligible) {
    counts[e.list] = (counts[e.list] ?? 0) + 1;
  }

  // Group keys for small lists
  const keysByList = {};
  for (const e of eligible) {
    if (!keysByList[e.list]) keysByList[e.list] = [];
    keysByList[e.list].push(e.key);
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const maxList  = Math.max(...sorted.map(([l]) => l.length));
  const total    = sorted.reduce((s, [, n]) => s + n, 0);

  console.log("=== find-location --test: entities needing coords ===\n");
  for (const [list, count] of sorted) {
    const suffix = count < 5 ? `  — ${keysByList[list].join(", ")}` : "";
    console.log(`  ${list.padEnd(maxList)}  ${String(count).padStart(4)}${suffix}`);
  }
  console.log(`\n  ${"TOTAL".padEnd(maxList)}  ${String(total).padStart(4)}`);

  await client.close();
  process.exit(0);
}

// ─── Process ──────────────────────────────────────────────────────────────────

let found = 0, notFound = 0, errors = 0;

const DELAY_MS = 500; // polite delay between Wikipedia API requests

for (const entity of eligible) {
  const label = `${entity.list}/${entity.key}`;

  // Confirm the link actually matches (in case regex missed edge cases)
  if (!linkPattern.test(entity.link)) continue;

  process.stdout.write(`${label} — ${entity.link} … `);

  let result = null;
  try {
    result = await getCoordsFromUrl(entity.link, { list: entity.list });
  } catch (err) {
    console.error(`\n  ❌ Error: ${err.message}`);
    errors++;
    continue;
  }

  // Polite delay before next request
  await new Promise(r => setTimeout(r, DELAY_MS));

  if (result) {
    console.log(`✅ ${result.coords}`);
    found++;
    if (!dryRun) {
      await entities.updateOne(
        { _id: entity._id },
        { $set: { coords: result.coords, location: result.location } }
      );
    }
  } else {
    console.log("❌ not found");
    notFound++;
    if (!dryRun) {
      await entities.updateOne(
        { _id: entity._id },
        { $set: { coords: "not-found" } }
      );
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`
=== find-location summary ===
Eligible:   ${eligible.length}
Found:      ${found}
Not found:  ${notFound}  ${notFound > 0 ? '(coords set to "not-found"; use --retry to attempt again)' : ""}
Errors:     ${errors}
${dryRun ? "\n[DRY RUN] No changes written." : ""}`.trim());

await client.close();
