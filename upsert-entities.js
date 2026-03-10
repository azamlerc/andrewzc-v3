// Upsert entities from a CSV or JSON file into the entities collection.
//
// Usage:
//   node upsert-entities.js <file.csv|file.json> [list]
//
// - 'list' can be provided as a CLI argument or as a field in each row/object.
//   The field in the file takes precedence.
// - Key is computed from name/reference/country using the page's tags (same
//   rules as rekey.js). The 'key' field must NOT be in the input file.
// - If the page has the "reference" tag and a row has no reference, it is
//   logged as an error and skipped.
// - If country is provided but icons is not, icons is set to [flagEmoji(country)].
// - If icons is provided but country is not, country is derived from any flag
//   emoji in icons (multiple country flags → array; single → string).
// - CSV type coercion: "true"/"false" → boolean, numeric → number,
//   "null"/empty → null (nulls are stripped and don't overwrite existing fields).
// - Dot-notation CSV headers expand to nested objects:
//     props.bumper  →  { props: { bumper: true } }
// - JSON can also be a key→entity object (legacy andrewzc.net format). Keys are
//   ignored (recomputed); the "--info--" metadata entry is skipped automatically.
// - If the page is tagged "no-coords" or "people", coord fetching and city/reference
//   derivation from location are skipped entirely.
// - For new entities, `been` defaults to false if not explicitly set. Set been=true
//   (or "true"/"1" in CSV) to mark an entity as visited.
// - If `coords` is supplied, it is normalised (DMS, degree symbols, directional
//   suffixes all accepted) and `location` GeoJSON is (re)built from it.

import "dotenv/config";
import { MongoClient } from "mongodb";
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import path from "path";
import {
  computeKey,
  countryCodeToFlagEmoji,
  countryCodesFromIcons,
  findNearestCity,
  parseCoords,
  formatCoords,
} from "./utilities.js";
import { getCoordsFromUrl } from "./wiki.js";

const [,, filePath, listArg] = process.argv;

if (!filePath) {
  console.error("Usage: node upsert-entities.js <file.csv|file.json> [list]");
  process.exit(1);
}

const ext = path.extname(filePath).toLowerCase();
if (![".csv", ".json"].includes(ext)) {
  console.error("File must be .csv or .json");
  process.exit(1);
}

// --- Parse file ---

function coerceValue(v) {
  if (v === "true")  return true;
  if (v === "false") return false;
  if (v === "null" || v === "") return null;
  if (!isNaN(v) && v.trim() !== "") return Number(v);
  return v;
}

function setNested(obj, dotPath, value) {
  const parts = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

let rows;
const raw = readFileSync(filePath, "utf8");

if (ext === ".json") {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    // Legacy key→entity object format (e.g. old andrewzc.net data files).
    // Keys are ignored (recomputed); the "--info--" metadata entry is skipped.
    rows = Object.entries(parsed)
      .filter(([k]) => k !== "--info--")
      .map(([, v]) => v);
  } else {
    rows = [parsed];
  }
} else {
  const csvRows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  rows = csvRows.map(row => {
    const doc = {};
    for (const [header, value] of Object.entries(row)) {
      setNested(doc, header, coerceValue(value));
    }
    return doc;
  });
}

// --- Wikipedia search ---

async function searchWikipediaLink(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const title = json?.query?.search?.[0]?.title;
  if (!title) return null;
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// --- Connect and load page metadata ---

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db  = client.db("andrewzc");
const col = db.collection("entities");

// Cache page tags keyed by list name
const pageCache = {};
async function getPageTags(list) {
  if (pageCache[list] !== undefined) return pageCache[list];
  const page = await db.collection("pages").findOne({ key: list }, { projection: { tags: 1 } });
  pageCache[list] = page?.tags ?? [];
  return pageCache[list];
}

// --- Process rows ---

let inserted = 0, updated = 0, skipped = 0;
const errors = [], warnings = [];

for (const row of rows) {
  // Strip nulls — don't overwrite existing fields with null
  const doc = Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== null && v !== undefined)
  );

  const list = doc.list ?? listArg;
  if (!list) {
    skipped++;
    errors.push(`Row missing list: ${JSON.stringify(doc)}`);
    continue;
  }
  doc.list = list;

  if (!doc.name) {
    skipped++;
    errors.push(`[${list}] Row missing name: ${JSON.stringify(doc)}`);
    continue;
  }

  if (doc.key) {
    skipped++;
    errors.push(`[${list}] "${doc.name}" — 'key' should not be in input file; it will be computed`);
    continue;
  }

  // Load page tags
  const tags = await getPageTags(list);
  const requiresReference = tags.includes("reference") && !tags.includes("reference-optional");

  // Validate reference
  if (requiresReference && !doc.reference) {
    skipped++;
    errors.push(`[${list}] "${doc.name}" — page requires reference but none provided`);
    continue;
  }

  // Derive icons from country, or country from icons
  if (doc.country && !doc.icons) {
    const flag = countryCodeToFlagEmoji(doc.country);
    if (flag) doc.icons = [flag];
    else warnings.push(`[${list}] "${doc.name}" — could not convert country "${doc.country}" to flag emoji`);
  } else if (doc.icons && !doc.country) {
    const codes = countryCodesFromIcons(doc.icons);
    if (codes.length === 1)      doc.country = codes[0];
    else if (codes.length > 1)   doc.country = codes;
    // if 0 country flags in icons, leave country unset
  }

  // Compute key
  const key = computeKey(doc, tags);
  if (!key) {
    skipped++;
    errors.push(`[${list}] "${doc.name}" — could not compute key`);
    continue;
  }
  doc.key = key;

  // Check existing entity for link/coords/city we shouldn't overwrite
  const existing = await col.findOne({ key, list }, { projection: { link: 1, coords: 1, location: 1, city: 1, reference: 1 } });

  // Enrich: find Wikipedia link if not supplied and not already in DB
  if (!doc.link && !existing?.link) {
    const searchName = doc.name;
    const found = await searchWikipediaLink(searchName);
    if (found) {
      doc.link = found;
      console.log(`  🔍 ${doc.name}: found ${found}`);
    }
  }

  // Normalise any coords supplied in the input: parse (handles DMS, degree symbols,
  // directional suffixes) and reformat as canonical decimal string; rebuild GeoJSON.
  const skipCoords = tags.includes("no-coords") || tags.includes("people");
  if (!skipCoords && doc.coords) {
    const parsed = parseCoords(doc.coords);
    if (parsed) {
      doc.coords   = formatCoords(parsed);
      doc.location = { type: "Point", coordinates: [parsed.lon, parsed.lat] };
    } else {
      warnings.push(`[${list}] "${doc.name}" — could not parse coords: "${doc.coords}"`);
      delete doc.coords;
    }
  }

  // Enrich: fetch coords if not supplied and not already in DB
  const hasCoords = doc.coords || (existing?.coords && existing.coords !== "not-found");
  const linkToFetch = doc.link ?? existing?.link;
  if (!skipCoords && !hasCoords && linkToFetch && /wikipedia\.org|booking\.com|airbnb\.com/.test(linkToFetch)) {
    const result = await getCoordsFromUrl(linkToFetch, { list });
    if (result) {
      doc.coords   = result.coords;
      doc.location = result.location;
      console.log(`  📍 ${doc.name}: ${result.coords}`);
    } else {
      console.log(`  ⚠️  ${doc.name}: coords not found`);
    }
  }

  // Enrich: find nearest city from location (if we now have one)
  const locationForCity = doc.location ?? existing?.location;
  if (!skipCoords && locationForCity && !doc.city && !existing?.city) {
    const city = await findNearestCity(locationForCity, col);
    if (city) {
      doc.city = city;
      console.log(`  🏙️  ${doc.name}: city = ${city}`);
    }
  }

  // Enrich: derive reference from city if the page uses references and none is set
  const needsReference = tags.includes("reference") || tags.includes("reference-optional");
  const hasReference   = doc.reference || existing?.reference;
  if (needsReference && !hasReference && doc.city) {
    doc.reference = doc.city;
    console.log(`  📎 ${doc.name}: reference = ${doc.reference} (from city)`);
  }

  // Now that reference may have been derived, re-validate and re-compute key
  if (requiresReference && !doc.reference && !existing?.reference) {
    skipped++;
    errors.push(`[${list}] "${doc.name}" — page requires reference and could not be derived`);
    continue;
  }
  if (!doc.key || (doc.reference && !existing?.reference)) {
    // Recompute key now that reference is known
    doc.key = computeKey(doc, tags);
  }

  // Default been to false for new entities if not explicitly set
  if (doc.been == null && !existing) {
    doc.been = false;
  }

  // Upsert
  const result = await col.updateOne(
    { key, list },
    { $set: doc },
    { upsert: true }
  );

  const icons = Array.isArray(doc.icons) ? doc.icons.join(" ") : (doc.icons ?? "");
  const label = [icons, doc.name].filter(Boolean).join(" ");

  if (result.upsertedCount) {
    inserted++;
    console.log(`added   ${label}`);
  } else if (result.modifiedCount) {
    updated++;
    console.log(`updated ${label}`);
  }
  // matchedCount but modifiedCount=0 means doc was identical, still counts as ok
}

// --- Report ---

console.log(`\n=== upsert-entities: ${path.basename(filePath)} ===\n`);
console.log(`Inserted: ${inserted}`);
console.log(`Updated:  ${updated}`);
console.log(`Skipped:  ${skipped}`);

if (warnings.length) {
  console.log(`\n⚠️  Warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`  ${w}`);
}

if (errors.length) {
  console.log(`\n❌ Errors (${errors.length}):`);
  for (const e of errors) console.log(`  ${e}`);
}

console.log(`\nTotal rows: ${rows.length}`);

await client.close();
