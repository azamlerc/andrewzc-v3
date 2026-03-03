// Regenerate keys for all entities in a list based on the page's tags.
// Usage: node rekey.js <list-name> [--dryrun]

import { queryPages, processEntities } from "./database.js";
import { simplify } from "./utilities.js";

const listName = process.argv[2];
const dryRun = process.argv.includes("--dryrun");

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
console.log(`Tags: ${tags.length ? tags.join(", ") : "none"}`);

const referenceKey   = tags.includes("reference-key");
const referenceFirst = tags.includes("reference-first");
const countryKey     = tags.includes("country-key");

function computeKey({ name, reference, country }) {
  const cc = country ? String(country).toUpperCase() : null;
  if (countryKey && cc && !String(name).includes(",")) return simplify(`${name} ${cc}`);
  if (referenceKey && reference) return simplify(referenceFirst ? `${reference} ${name}` : `${name} ${reference}`);
  return simplify(name);
}

await processEntities(
  { list: listName },

  (entity) => {
    const newKey = computeKey(entity);
    if (entity.key !== newKey) entity.key = newKey;
  },

  { dryRun }
);

console.log("✅ Done! Keys regenerated.");
