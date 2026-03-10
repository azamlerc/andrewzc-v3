// Set the city field from coords for entities in a list that have a location
// but no city.
//
// Usage:
//   node set-city-from-coords.js <list>

import "dotenv/config";
import { MongoClient } from "mongodb";
import { findNearestCity } from "./utilities.js";

const [,, list] = process.argv;
if (!list) {
  console.error("Usage: node set-city-from-coords.js <list>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db  = client.db("andrewzc");
const col = db.collection("entities");

const entities = await col.find(
  { list, location: { $exists: true }, city: { $exists: false } },
  { projection: { _id: 1, name: 1, location: 1 } }
).toArray();

console.log(`Found ${entities.length} entities in "${list}" with location but no city.\n`);

let updated = 0;

for (const entity of entities) {
  const city = await findNearestCity(entity.location, col);
  if (city) {
    await col.updateOne({ _id: entity._id }, { $set: { city } });
    console.log(`  🏙️  ${entity.name}: city = ${city}`);
    updated++;
  } else {
    console.log(`  ⚠️  ${entity.name}: no city found within radius`);
  }
}

console.log(`\nDone. Updated ${updated}/${entities.length} entities.`);
await client.close();
