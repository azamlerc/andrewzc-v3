// Fix the copies list:
// 1. Fix eiffel-tower-tianducheng — wrong coords (Paris) and wrong city (Las Vegas). Not visited.
// 2. Fix statue-of-liberty-paris — wrong coords (Las Vegas), wrong country (US). Visited.
// 3. Insert missing: eiffel-tower-las-vegas (visited), eiffel-tower-tokyo (visited), statue-of-liberty-las-vegas (visited)

import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const col = client.db("andrewzc").collection("entities");

// Fix eiffel-tower-tianducheng: coords were Paris, city was Las Vegas. Not visited.
await col.updateOne(
  { _id: new ObjectId("69850dab960b6c1660aa4ccd") },
  { $set: { coords: "30.29750000, 119.99722222", city: "Tianducheng", been: false } }
);
console.log("✅ Fixed eiffel-tower-tianducheng");

// Fix statue-of-liberty-paris: coords were Las Vegas, country was US. Visited.
await col.updateOne(
  { _id: new ObjectId("69850dab960b6c1660aa4cd1") },
  { $set: { coords: "48.85138889, 2.27916667", city: "Paris", country: "FR", been: true } }
);
console.log("✅ Fixed statue-of-liberty-paris");

// Insert three missing entities
const result = await col.insertMany([
  {
    key:       "eiffel-tower-las-vegas",
    name:      "Eiffel Tower",
    list:      "copies",
    reference: "Las Vegas",
    city:      "Las Vegas",
    country:   "US",
    icons:     ["🇺🇸", "🇫🇷", "🗼"],
    link:      "https://en.wikipedia.org/wiki/Eiffel_Tower_(Las_Vegas)",
    coords:    "36.11250000, -115.17194444",
    been:      true,
    dateAdded: "2026-03-07",
  },
  {
    key:       "eiffel-tower-tokyo",
    name:      "Eiffel Tower",
    list:      "copies",
    reference: "Tokyo",
    city:      "Tokyo",
    country:   "JP",
    icons:     ["🇯🇵", "🇫🇷", "🗼"],
    link:      "https://en.wikipedia.org/wiki/Tokyo_Tower",
    coords:    "35.65858333, 139.74541667",
    been:      true,
    dateAdded: "2026-03-07",
  },
  {
    key:       "statue-of-liberty-las-vegas",
    name:      "Statue of Liberty",
    list:      "copies",
    reference: "Las Vegas",
    city:      "Las Vegas",
    country:   "US",
    icons:     ["🇺🇸", "🇺🇸", "🗽"],
    link:      "https://en.wikipedia.org/wiki/New_York-New_York_Hotel_and_Casino",
    coords:    "36.10200000, -115.17460000",
    been:      true,
    dateAdded: "2026-03-07",
  },
]);
console.log(`✅ Inserted ${result.insertedCount} missing entities`);

await client.close();
console.log("\nDone. copies list should now have 19 entries.");
