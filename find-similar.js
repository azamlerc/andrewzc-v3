// Find entities semantically similar to a given entity, using its stored wikiEmbedding.
// Usage: node find-similar.js <list-name> <entity-key> [limit]

import { fetchEntity, queryPages, vectorSearch } from "./database.js";

const listName  = process.argv[2];
const entityKey = process.argv[3];
const limit     = parseInt(process.argv[4]) || 10;

if (!listName || !entityKey) {
  console.error("Usage: node find-similar.js <list-name> <entity-key> [limit]");
  process.exit(1);
}

const source = await fetchEntity(listName, entityKey);

if (!source) {
  console.error(`❌ Entity "${entityKey}" not found in "${listName}"`);
  process.exit(1);
}
if (!source.wikiEmbedding) {
  console.error(`❌ Entity "${entityKey}" has no embedding`);
  process.exit(1);
}

const [sourcePage] = await queryPages({ key: listName });
const sourceLabel  = `${sourcePage?.icon ?? "📋"} ${sourcePage?.name ?? listName} / ${source.icons?.join("") ?? ""} ${source.name}`;
console.log(`\n🔍 Finding entities similar to: ${sourceLabel}\n`);

// Request one extra so we can filter out the source entity itself
const results = await vectorSearch(source.wikiEmbedding, { limit: limit + 1 });
const filtered = results.filter(r => r.score < 0.9999).slice(0, limit);

console.log("Rank  Score   Page             Name");
console.log("─".repeat(70));
for (const [i, r] of filtered.entries()) {
  const rank      = String(i + 1).padStart(2);
  const score     = r.score.toFixed(4);
  const page      = `${r.pageInfo?.icon ?? "📋"} ${r.pageInfo?.name ?? r.list}`;
  const icons     = r.icons?.join("") ?? "";
  console.log(`${rank}.   ${score}  ${page.padEnd(16)} ${icons} ${r.name}`);
}

console.log("\n✅ Done!");
