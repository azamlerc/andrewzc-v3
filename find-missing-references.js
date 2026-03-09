import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("andrewzc");

// Get all pages tagged "reference"
const refPages = await db.collection("pages")
  .find({ tags: "reference" }, { projection: { key: 1 } })
  .toArray();

const lists = refPages.map(p => p.key);
console.log(`Checking ${lists.length} pages tagged 'reference'...\n`);

let totalMissing = 0, totalFixed = 0;

for (const list of lists.sort()) {
  const missing = await db.collection("entities").find(
    { list, $or: [{ reference: { $exists: false } }, { reference: "" }] },
    { projection: { key: 1, name: 1, city: 1 } }
  ).toArray();

  if (missing.length === 0) continue;

  const fixable = missing.filter(e => e.city);
  const manual  = missing.filter(e => !e.city);

  // Auto-fix: copy city → reference
  if (fixable.length > 0) {
    for (const e of fixable) {
      await db.collection("entities").updateOne(
        { _id: e._id },
        { $set: { reference: e.city } }
      );
    }
    totalFixed += fixable.length;
  }

  totalMissing += missing.length;

  console.log(`${list} (${missing.length} missing):`);

  if (fixable.length > 0) {
    console.log(`  ✅ Auto-fixed from city (${fixable.length}):`);
    for (const e of fixable) console.log(`    ${e.key} → "${e.city}"`);
  }
  if (manual.length > 0) {
    console.log(`  ⚠️  Needs manual reference (${manual.length}):`);
    for (const e of manual) console.log(`    ${e.key} (name: "${e.name}")`);
  }
}

console.log(`\nDone. ${totalMissing} missing references found across ${lists.length} pages.`);
console.log(`Auto-fixed: ${totalFixed}, needs manual attention: ${totalMissing - totalFixed}.`);

await client.close();
