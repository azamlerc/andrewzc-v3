import "dotenv/config";
import { MongoClient } from "mongodb";

const list = process.argv[2];
if (!list) {
  console.error("Usage: node get-reference-from-name.js <list>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const col = client.db("andrewzc").collection("entities");

// Fetch all entities on this page that don't already have a reference
const toUpdate = await col.find(
  { list, reference: { $exists: false } },
  { projection: { _id: 1, name: 1 } }
).toArray();

if (toUpdate.length === 0) {
  console.log(`No entities without a reference found in '${list}'.`);
  await client.close();
  process.exit(0);
}

// Extract first word as reference, apply update
const byReference = {};
let updated = 0;

for (const { _id, name } of toUpdate) {
  const spaceIdx = name.indexOf(" ");
  if (spaceIdx === -1) {
    // Entire name is one word — skip, would leave name empty
    byReference["(skipped — single word)"] ??= [];
    byReference["(skipped — single word)"].push(name);
    continue;
  }
  const reference = name.slice(0, spaceIdx);
  const newName = name.slice(spaceIdx + 1);

  await col.updateOne({ _id }, { $set: { reference, name: newName } });

  byReference[reference] ??= [];
  byReference[reference].push(newName);
  updated++;
}

// Print report bucketed by reference value
console.log(`\n=== get-reference-from-name: ${list} ===\n`);
console.log(`Updated ${updated} of ${toUpdate.length} entities.\n`);

for (const [ref, names] of Object.entries(byReference).sort()) {
  console.log(`${ref} (${names.length}):`);
  for (const n of names.sort()) {
    console.log(`  ${n}`);
  }
}

await client.close();
