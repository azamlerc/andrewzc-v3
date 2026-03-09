import "dotenv/config";
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("andrewzc");
const entities = db.collection("entities");
const pages = db.collection("pages");

// Step 1: Aggregate reference stats per list across all entities
const stats = await entities.aggregate([
  {
    $group: {
      _id: "$list",
      total: { $sum: 1 },
      withRef: {
        $sum: {
          $cond: [
            { $and: [
              { $ifNull: ["$reference", false] },
              { $ne: ["$reference", ""] }
            ]},
            1, 0
          ]
        }
      }
    }
  },
  { $match: { withRef: { $gt: 0 } } },
  { $sort: { _id: 1 } }
]).toArray();

// Step 2: For each list with references, decide on tag
const results = { reference: [], referenceOptional: [], skipped: [] };
let updatedRef = 0, updatedOptional = 0, alreadyTagged = 0, noPage = 0;

// Print distribution header
console.log("\n=== Reference Coverage Distribution ===\n");
console.log("List                           | withRef / total |  %   | Decision");
console.log("-------------------------------|-----------------|------|----------");

for (const { _id: list, total, withRef } of stats) {
  const pct = withRef / total;
  const pctStr = (pct * 100).toFixed(1).padStart(4);

  // Determine intended tag
  let decision;
  if (pct < 0.90) {
    decision = "reference-optional";
  } else {
    decision = "reference";
  }

  const integrityNote = (decision === "reference" && pct < 1.0)
    ? " ⚠️  integrity issue"
    : "";

  console.log(
    `${list.padEnd(30)} | ${String(withRef).padStart(7)} / ${String(total).padEnd(5)} | ${pctStr}% | ${decision}${integrityNote}`
  );

  // Check if page exists and doesn't already have a reference tag
  const page = await pages.findOne(
    { key: list },
    { projection: { key: 1, tags: 1 } }
  );

  if (!page) {
    noPage++;
    results.skipped.push({ list, reason: "no page record", withRef, total, pct });
    continue;
  }

  const existingTags = page.tags || [];
  if (existingTags.includes("reference") || existingTags.includes("reference-optional")) {
    alreadyTagged++;
    results.skipped.push({ list, reason: "already tagged", tag: existingTags.find(t => t.startsWith("reference")), withRef, total, pct });
    continue;
  }

  // Apply tag
  await pages.updateOne(
    { key: list },
    { $addToSet: { tags: decision } }
  );

  if (decision === "reference") {
    updatedRef++;
    results.reference.push({ list, withRef, total, pct, integrity: pct < 1.0 });
  } else {
    updatedOptional++;
    results.referenceOptional.push({ list, withRef, total, pct });
  }
}

// Step 3: Print summary report
console.log("\n=== Update Report ===\n");

console.log(`Tagged as 'reference' (${updatedRef}):`);
for (const { list, withRef, total, pct, integrity } of results.reference) {
  const flag = integrity ? " ⚠️  (integrity issue: not all entities have reference)" : " ✅";
  console.log(`  ${list}: ${withRef}/${total} (${(pct*100).toFixed(1)}%)${flag}`);
}

console.log(`\nTagged as 'reference-optional' (${updatedOptional}):`);
for (const { list, withRef, total, pct } of results.referenceOptional) {
  console.log(`  ${list}: ${withRef}/${total} (${(pct*100).toFixed(1)}%)`);
}

console.log(`\nSkipped — already tagged (${alreadyTagged}):`);
for (const { list, tag } of results.skipped.filter(s => s.reason === "already tagged")) {
  console.log(`  ${list}: already has '${tag}'`);
}

console.log(`\nSkipped — no page record (${noPage}):`);
for (const { list, withRef, total } of results.skipped.filter(s => s.reason === "no page record")) {
  console.log(`  ${list}: ${withRef}/${total} entities have reference but no page document`);
}

console.log(`\nDone. Tagged ${updatedRef} as 'reference', ${updatedOptional} as 'reference-optional'.`);

await client.close();
