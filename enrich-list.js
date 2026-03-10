// Enrich all entities in a given list that are missing link, coords, city,
// or reference, using the same cascade as upsert-entities.js.
//
// Usage:
//   node enrich-list.js <list>
//
// Steps per entity (each only runs if the data is not already present):
//   1. Wikipedia link   — searched by name
//   2. Coords + location — fetched from Wikipedia/Booking/Airbnb link
//   3. Nearest city     — derived from location via $nearSphere
//   4. Reference        — set from city if page has reference/reference-optional tag
//
// Skipped entirely for pages tagged "no-coords" or "people".

import "dotenv/config";
import { MongoClient } from "mongodb";
import { findNearestCity } from "./utilities.js";
import { getCoordsFromUrl } from "./wiki.js";

const [,, list] = process.argv;
if (!list) {
  console.error("Usage: node enrich-list.js <list>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db  = client.db("andrewzc");
const col = db.collection("entities");

// Load page tags
const page = await db.collection("pages").findOne({ key: list }, { projection: { tags: 1 } });
const tags = page?.tags ?? [];

const skipCoords     = tags.includes("no-coords") || tags.includes("people");
const needsReference = tags.includes("reference") || tags.includes("reference-optional");

// --- Wikipedia search (same as upsert-entities.js) ---
async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { rateLimited: true });
  if (!res.ok) return null;
  const json = await res.json();
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// --- Load only entities missing at least one enrichable field ---
const missingConditions = [
  { link: { $exists: false } },
];
if (!skipCoords) {
  missingConditions.push(
    { coords: { $exists: false } },
    { city:   { $exists: false } },
  );
}
if (needsReference) {
  missingConditions.push({ reference: { $exists: false } });
}
const filter = { list, $or: missingConditions };
const entities = await col.find(filter, {
  projection: { key: 1, name: 1, link: 1, coords: 1, location: 1, city: 1, reference: 1 }
}).toArray();

console.log(`Enriching ${entities.length} entities in "${list}"...\n`);

let enriched = 0;
let wikiBlocked = false; // set true on rate limit; skips further Wikipedia requests

for (const entity of entities) {
  const update = {};

  // 1. Wikipedia link
  if (!wikiBlocked && !entity.link) {
    try {
      const found = await searchWikipediaLink(entity.name);
      if (found) {
        update.link = found;
        console.log(`  🔍 ${entity.name}: found ${found}`);
      }
    } catch (err) {
      if (err.rateLimited) {
        console.warn(`  🚫 Rate limited — skipping remaining Wikipedia requests for this run.`);
        wikiBlocked = true;
      } else {
        throw err;
      }
    }
  }

  const link = update.link ?? entity.link;

  // 2. Coords + location
  if (!wikiBlocked && !skipCoords && !entity.coords && link && /wikipedia\.org|booking\.com|airbnb\.com/.test(link)) {
    try {
      const result = await getCoordsFromUrl(link, { list });
      if (result) {
        update.coords   = result.coords;
        update.location = result.location;
        console.log(`  📍 ${entity.name}: ${result.coords}`);
      } else {
        console.log(`  ⚠️  ${entity.name}: coords not found`);
      }
    } catch (err) {
      if (err.rateLimited) {
        console.warn(`  🚫 Rate limited — skipping remaining Wikipedia requests for this run.`);
        wikiBlocked = true;
      } else {
        throw err;
      }
    }
  }

  // 3. Nearest city
  const location = update.location ?? entity.location;
  if (!skipCoords && location && !entity.city) {
    const city = await findNearestCity(location, col);
    if (city) {
      update.city = city;
      console.log(`  🏙️  ${entity.name}: city = ${city}`);
    }
  }

  // 4. Reference from city
  const city = update.city ?? entity.city;
  if (needsReference && !entity.reference && city) {
    update.reference = city;
    console.log(`  📎 ${entity.name}: reference = ${city} (from city)`);
  }

  if (Object.keys(update).length > 0) {
    await col.updateOne({ _id: entity._id }, { $set: update });
    enriched++;
  }
}

console.log(`\nDone. Enriched ${enriched}/${entities.length} entities.`);
await client.close();
