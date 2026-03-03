// Remove wikiSummary, wikiEmbedding, and enrichedAt from entities in a list.
// Usage: node clear-wiki-data.js <list-name> [--junk-only]
//   --junk-only  only clear entries where wikiSummary starts with ".mw-parser-output"

import { processEntities } from "./database.js";

const listName = process.argv[2];
const junkOnly = process.argv.includes("--junk-only");

if (!listName) {
  console.error("Usage: node clear-wiki-data.js <list-name> [--junk-only]");
  process.exit(1);
}

const filter = junkOnly
  ? { list: listName, wikiSummary: { $regex: /^\.mw-parser-output/ } }
  : { list: listName, $or: [{ wikiSummary: { $exists: true } }, { wikiEmbedding: { $exists: true } }, { enrichedAt: { $exists: true } }] };

await processEntities(filter, (entity) => {
  delete entity.wikiSummary;
  delete entity.wikiEmbedding;
  delete entity.enrichedAt;
});

console.log("✅ Done! Wiki data cleared.");
