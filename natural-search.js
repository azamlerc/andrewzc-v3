// Natural language search via the andrewzc API.
// Sends the query to POST /search and displays results with tool/args info.
// Usage: node natural-search.js <query> [limit]

const query = process.argv[2];
const limit = parseInt(process.argv[3]) || 10;

if (!query) {
  console.error("Usage: node natural-search.js <query> [limit]");
  process.exit(1);
}

console.log(`\n🔍 Natural language search: "${query}"\n`);

const res  = await fetch("https://api.andrewzc.net/search", {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({ query, limit }),
});

if (!res.ok) {
  console.error(`❌ API error: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.error(text);
  process.exit(1);
}

const data = await res.json();

// Show what the router decided
const tool = Array.isArray(data.tool) ? data.tool.join(" + ") : data.tool;
console.log(`🛠  Tool:  ${tool}`);
console.log(`📦 Args:  ${JSON.stringify(data.args)}`);
console.log();

const results = data.results ?? [];
if (results.length === 0) {
  console.log("No results.");
} else {
  console.log("Rank  Score   Page             Name");
  console.log("─".repeat(70));
  for (const [i, r] of results.entries()) {
    const rank  = String(i + 1).padStart(2);
    const score = r.score != null ? r.score.toFixed(4) : "  —   ";
    const page  = `${r.page?.icon ?? "📋"} ${r.page?.name ?? r.list}`;
    const icons = (r.icons ?? []).join("");
    console.log(`${rank}.   ${score}  ${page.padEnd(16)} ${icons} ${r.name}`);
  }
}

console.log("\n✅ Done!");
