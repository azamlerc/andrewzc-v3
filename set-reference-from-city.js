// Set reference field from city field for entities in a list.
// Usage: node set-reference-from-city.js <list-name>

import { processEntities } from "./database.js";

const listName = process.argv[2];

if (!listName) {
  console.error("Usage: node set-reference-from-city.js <list-name>");
  process.exit(1);
}

await processEntities(
  { list: listName, city: { $exists: true } },

  (entity) => {
    entity.reference = entity.city;
  }
);

console.log("✅ Done! city → reference copied.");
