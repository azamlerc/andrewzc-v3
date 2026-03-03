// Print Wikipedia summaries for all entities in a list that have one.
// Usage: node print-wiki-summaries.js <list-name>

import { processEntities } from "./database.js";

const listName = process.argv[2];

if (!listName) {
  console.error("Usage: node print-wiki-summaries.js <list-name>");
  process.exit(1);
}

let count = 0;

await processEntities(
  { list: listName, wikiSummary: { $exists: true } },

  (entity) => {
    count++;
    console.log(`\n${count}. ${entity.name}${entity.city ? ` (${entity.city})` : ""}`);
    console.log("-".repeat(80));
    console.log(entity.wikiSummary);
  },

  { dryRun: true, sort: { name: 1 } }
);

console.log(`\n✅ ${count} summaries printed.`);
