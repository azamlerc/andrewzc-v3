// Update props on entities in a list from a JSON file.
// Usage: node update-props.js <list-name> <data-file.json> [--dryrun]
// The JSON file should be an object keyed by entity key, with prop fields as values:
//   { "london": { "opened": 1863, "length": 402 }, ... }

import { readFileSync } from "fs";
import { resolve } from "path";
import { processEntities } from "./database.js";

const [listName, dataFile] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const dryRun = process.argv.includes("--dryrun");

if (!listName || !dataFile) {
  console.error("Usage: node update-props.js <list-name> <data-file.json> [--dryrun]");
  process.exit(1);
}

const data = JSON.parse(readFileSync(resolve(dataFile), "utf8"));
console.log(`Loaded ${Object.keys(data).length} entries from ${dataFile}`);

await processEntities(
  { list: listName, key: { $in: Object.keys(data) } },

  (entity) => {
    if (!entity.props) entity.props = {};
    Object.assign(entity.props, data[entity.key]);
  },

  { dryRun }
);

console.log("✅ Done!");
