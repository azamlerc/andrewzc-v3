// Copy city field to reference field for entities in a list.
// Usage: node copy-city-to-reference.js <list-name>

import { processEntities } from "./database.js";

const listName = process.argv[2];

if (!listName) {
  console.error("Usage: node copy-city-to-reference.js <list-name>");
  process.exit(1);
}

await processEntities(
  { list: listName, city: { $exists: true } },

  (entity) => {
    entity.reference = entity.city;
  }
);

console.log("✅ Done! city → reference copied.");
