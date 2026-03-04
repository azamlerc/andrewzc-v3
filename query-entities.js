// Semantic search across all entities using a natural language query string.
// Generates an OpenAI embedding for the query, then runs an Atlas vector search.
// Usage: node query-entities.js <query> [list-filter] [limit]

import OpenAI from "openai";
import { vectorSearch } from "./database.js";

const query      = process.argv[2];
const listFilter = process.argv[3] ?? null;
const limit      = parseInt(process.argv[4]) || 10;

if (!query) {
  console.error("Usage: node query-entities.js <query> [list-filter] [limit]");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY environment variable not set");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log(`\n🔍 Semantic search: "${query}"${listFilter ? ` (filtered to: ${listFilter})` : ""}\n`);

const { data } = await openai.embeddings.create({ model: "text-embedding-3-small", input: query, dimensions: 512 });
const results  = await vectorSearch(data[0].embedding, { listFilter, limit });

console.log("Rank  Score   Page             Name");
console.log("─".repeat(70));
for (const [i, r] of results.entries()) {
  const rank  = String(i + 1).padStart(2);
  const score = r.score.toFixed(4);
  const page  = `${r.pageInfo?.icon ?? "📋"} ${r.pageInfo?.name ?? r.list}`;
  const icons = r.icons?.join("") ?? "";
  console.log(`${rank}.   ${score}  ${page.padEnd(16)} ${icons} ${r.name}`);
}

console.log("\n✅ Done!");
