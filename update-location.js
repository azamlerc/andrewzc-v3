// Maintenance script for coords and location fields.
// Run with no arguments to execute both passes.
//
// Pass 1 — Normalise DMS coords to decimal:
//   Finds entities whose coords field contains a degree symbol (e.g. "51°30'N, 0°7'W")
//   and rewrites coords as a plain decimal string ("51.5083, -0.1167").
//
// Pass 2 — Backfill GeoJSON location from coords:
//   Finds entities that have a coords field but no location field and sets
//   location to a GeoJSON Point. coords is retained as the human-editable field;
//   location is the tightly-controlled GeoJSON version used for geo queries.

import { processEntities, geoPointFromCoords } from "./database.js";
import { parseCoords, isDmsCoords, formatCoords } from "./utilities.js";

const dryRun = process.argv.includes("--dryrun");

// ---- Pass 1: normalise DMS → decimal ----
console.log("Pass 1: normalising DMS coords to decimal...");

await processEntities(
  { coords: { $regex: "°" } },

  (entity) => {
    const ll = parseCoords(entity.coords);
    if (!ll) {
      console.warn(`  ⚠️  Could not parse coords for ${entity.list}/${entity.key}: "${entity.coords}"`);
      return;
    }
    entity.coords = formatCoords(ll);
  },

  { dryRun }
);

// ---- Pass 2: backfill GeoJSON location from coords ----
console.log("\nPass 2: backfilling location from coords...");

await processEntities(
  { coords: { $exists: true }, location: { $exists: false } },

  (entity) => {
    const point = geoPointFromCoords(entity.coords);
    if (!point) {
      console.warn(`  ⚠️  Could not parse coords for ${entity.list}/${entity.key}: "${entity.coords}"`);
      return;
    }
    entity.location = point;
  },

  { dryRun }
);

console.log("\n✅ Done!");
