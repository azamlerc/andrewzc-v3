// Regenerate keys for all entities in a list based on the page's tags.
//
// When a rekeyed entity would clash with an existing entity at the new key,
// the two are merged: props are combined, and the duplicate is deleted.
//
// Merge rules for scalar fields (name, link, coords, city, reference, etc.):
//   - Same value on both sides → keep it, no problem.
//   - One side empty/missing, the other non-empty → use the non-empty value.
//   - Both sides non-empty and different → abort this key change, log an error.
//     The entity is left as-is and requires human intervention.
//
// Props are always merged: keys from both sides are combined. If the same prop
// key exists on both sides the merge rules above apply to the value.
//
// Usage: node rekey.js <list-name> [--dryrun]

import "dotenv/config";
import { MongoClient } from "mongodb";
import { queryPages } from "./database.js";
import { computeKey } from "./utilities.js";

const listName = process.argv[2];
const dryRun   = process.argv.includes("--dryrun");

if (!listName) {
  console.error("Usage: node rekey.js <list-name> [--dryrun]");
  process.exit(1);
}

const [page] = await queryPages({ key: listName });
if (!page) {
  console.error(`❌ Page "${listName}" not found`);
  process.exit(1);
}

const tags = page.tags ?? [];
console.log(`Tags: ${tags.length ? tags.join(", ") : "none"}\n`);

// ── DB ────────────────────────────────────────────────────────────────────────

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db  = client.db(process.env.MONGODB_DB || "andrewzc");
const col = db.collection("entities");

const entities = await col.find({ list: listName }).toArray();

// Build a map of current key → entity for conflict detection.
const byKey = new Map(entities.map(e => [e.key, e]));

// ── Merge helpers ─────────────────────────────────────────────────────────────

const SCALAR_FIELDS = ["name", "link", "coords", "city", "reference", "prefix", "wikiSummary"];

// Parse a coords string to { lat, lon } or null.
function parseLatLon(s) {
  if (!s) return null;
  const parts = String(s).split(",").map(p => parseFloat(p.trim()));
  if (parts.length < 2 || parts.some(isNaN)) return null;
  return { lat: parts[0], lon: parts[1] };
}

// Merge two scalar values per the rules above.
// Returns { value, conflict } where conflict is true if human intervention needed.
function mergeScalar(a, b, fieldName, label) {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty)   return { value: a, conflict: false };
  if (aEmpty)             return { value: b, conflict: false };
  if (bEmpty)             return { value: a, conflict: false };
  if (a === b)            return { value: a, conflict: false };

  // wikiSummary: use the longer one.
  if (fieldName === "wikiSummary") {
    return { value: a.length >= b.length ? a : b, conflict: false };
  }

  // coords: treat as matching if lat and lon are both within 0.001°.
  if (fieldName === "coords") {
    const pa = parseLatLon(a), pb = parseLatLon(b);
    if (pa && pb && Math.abs(pa.lat - pb.lat) < 0.001 && Math.abs(pa.lon - pb.lon) < 0.001) {
      return { value: a, conflict: false }; // keep either; prefer existing (a)
    }
  }

  // link: treat as matching if they are equal after URL-decoding; prefer the decoded form.
  if (fieldName === "link") {
    try {
      const da = decodeURIComponent(a), db = decodeURIComponent(b);
      if (da === db) return { value: da, conflict: false };
    } catch (_) {}
  }

  console.error(`  ⚠️  Conflict on field "${fieldName}": "${a}" vs "${b}"`);
  return { value: a, conflict: true };
}

// Deep-merge two props objects. Returns { merged, conflict }.
function mergeProps(a = {}, b = {}, label) {
  const merged = { ...a };
  let conflict = false;
  for (const [k, bVal] of Object.entries(b)) {
    if (!(k in merged)) {
      merged[k] = bVal;
      continue;
    }
    const aVal = merged[k];
    // If both values are objects (e.g. { value, icons }), merge their scalar fields.
    if (aVal && bVal && typeof aVal === "object" && typeof bVal === "object"
        && !Array.isArray(aVal) && !Array.isArray(bVal)) {
      const sub = mergeProps(aVal, bVal, label);
      if (sub.conflict) conflict = true;
      merged[k] = sub.merged;
    } else {
      const r = mergeScalar(aVal, bVal, `props.${k}`, label);
      if (r.conflict) conflict = true;
      merged[k] = r.value;
    }
  }
  return { merged, conflict };
}

// Merge entity `src` into entity `dst`, returning the combined fields to $set
// and whether a conflict was detected.
function mergeEntities(dst, src, label) {
  const $set = {};
  let conflict = false;

  for (const f of SCALAR_FIELDS) {
    const r = mergeScalar(dst[f], src[f], f, label);
    if (r.conflict) conflict = true;
    if (r.value !== dst[f] && r.value != null) $set[f] = r.value;
  }

  // Boolean fields: true wins.
  for (const f of ["been", "strike"]) {
    const merged = !!(dst[f] || src[f]);
    if (merged !== dst[f]) $set[f] = merged;
  }

  // Arrays (icons, countries): use whichever is longer / non-empty.
  for (const f of ["icons", "countries"]) {
    const a = Array.isArray(dst[f]) ? dst[f] : [];
    const b = Array.isArray(src[f]) ? src[f] : [];
    if (a.length === 0 && b.length > 0) $set[f] = b;
  }

  // Props: deep merge.
  const { merged: mergedProps, conflict: propsConflict } = mergeProps(dst.props, src.props, label);
  if (propsConflict) conflict = true;
  if (JSON.stringify(mergedProps) !== JSON.stringify(dst.props ?? {})) {
    $set.props = mergedProps;
  }

  return { $set, conflict };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let rekeyed = 0, merged = 0, skipped = 0, unchanged = 0;

for (const entity of entities) {
  const newKey = computeKey(entity, tags);
  if (entity.key === newKey) { unchanged++; continue; }

  const label = `${entity.key} → ${newKey}`;

  if (!byKey.has(newKey)) {
    // Simple rekey — no conflict.
    console.log(`  🔑 ${label}`);
    if (!dryRun) await col.updateOne({ _id: entity._id }, { $set: { key: newKey } });
    byKey.delete(entity.key);
    byKey.set(newKey, { ...entity, key: newKey });
    rekeyed++;
    continue;
  }

  // Conflict: another entity already has (or will have) this key.
  const existing = byKey.get(newKey);
  const mergeLabel = `${entity.key} ⟶ ${newKey} (merge with existing)`;
  console.log(`  🔀 ${mergeLabel}`);

  const { $set, conflict } = mergeEntities(existing, entity, mergeLabel);

  if (conflict) {
    console.error(`  ❌ Skipping ${label} — conflicting field values require human intervention.\n`);
    skipped++;
    continue;
  }

  // Apply merged fields to the keeper and delete the duplicate.
  if (!dryRun) {
    if (Object.keys($set).length > 0) {
      await col.updateOne({ _id: existing._id }, { $set });
    }
    await col.deleteOne({ _id: entity._id });
  } else {
    if (Object.keys($set).length > 0) {
      console.log(`    would $set: ${JSON.stringify($set)}`);
    }
    console.log(`    would delete duplicate ${entity.key}`);
  }

  // Update the in-memory map so later iterations see the merged state.
  byKey.set(newKey, { ...existing, ...$set });
  byKey.delete(entity.key);
  merged++;
}

await client.close();

console.log(`
✅ Done.
  Unchanged: ${unchanged}
  Rekeyed:   ${rekeyed}
  Merged:    ${merged}
  Skipped:   ${skipped}${dryRun ? "\n  [DRY RUN] No changes written." : ""}`.trim());
