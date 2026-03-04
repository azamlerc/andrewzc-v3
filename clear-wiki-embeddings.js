// Remove wikiEmbedding from entities in a list, leaving wikiSummary and enrichedAt intact.
// Use this before re-generating embeddings at a different dimension size.
//
// Usage: node clear-wiki-embeddings.js <list-name>
//        node clear-wiki-embeddings.js --all

import { processEntities, queryPages } from "./database.js";

const arg     = process.argv[2];
const allMode = arg === "--all";

if (!arg) {
  console.error("Usage: node clear-wiki-embeddings.js <list-name>");
  console.error("       node clear-wiki-embeddings.js --all");
  process.exit(1);
}

let filter;

if (allMode) {
  const deprecatedPages = await queryPages({ propertyOf: { $exists: true } });
  const deprecatedLists = deprecatedPages.map(p => p.key);
  filter = {
    list:          { $nin: deprecatedLists },
    wikiEmbedding: { $exists: true },
  };
  console.log("Clearing wikiEmbedding from all non-deprecated lists...");
} else {
  filter = {
    list:          arg,
    wikiEmbedding: { $exists: true },
  };
  console.log(`Clearing wikiEmbedding from "${arg}"...`);
}

await processEntities(filter, (entity) => {
  delete entity.wikiEmbedding;
});

console.log("✅ Done. Summaries and enrichedAt preserved.");
