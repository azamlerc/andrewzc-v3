// Convert string prop values to numbers for all entities in a list.
// Handles: negative numbers, dollar signs, K suffix (×1000), M suffix (×1000000).
// Updates the page schema replacing "string" with "number" for the prop.
// Usage: node make-prop-numeric.js <list-name> <prop>
// Example: node make-prop-numeric.js countries founded.year
// Example: node make-prop-numeric.js metros metro-prices

import { processEntities, queryPages, updatePage } from "./database.js";

const listName = process.argv[2];
const propPath = process.argv[3];

if (!listName || !propPath) {
  console.error("Usage: node make-prop-numeric.js <list-name> <prop>");
  process.exit(1);
}

// Helper: get a nested value using dot notation
function getNestedValue(obj, path) {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

// Helper: set a nested value using dot notation
function setNestedValue(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// Convert a string value to a number, or return null if not parseable.
function toNumber(val) {
  if (typeof val === "number") return val;
  if (typeof val !== "string") return null;

  let s = val.trim();

  // Strip currency symbols
  s = s.replace(/^\$/, "");

  // Handle K and M suffixes (case-insensitive)
  const multiplier =
    s.endsWith("M") || s.endsWith("m") ? 1_000_000 :
    s.endsWith("K") || s.endsWith("k") ? 1_000 : 1;

  if (multiplier !== 1) s = s.slice(0, -1);

  const n = Number(s);
  if (isNaN(n)) return null;
  return n * multiplier;
}

// Convert prop on all matching entities
const filter = { list: listName, [`props.${propPath}`]: { $exists: true } };

let skippedValues = [];

await processEntities(filter, (entity) => {
  const props = { ...entity.props };
  const raw   = getNestedValue(props, propPath);

  // Handle array values (e.g. metro-widths is an array of objects with a value key)
  if (Array.isArray(raw)) {
    const converted = raw.map(item => {
      if (item && typeof item === "object" && "value" in item) {
        const n = toNumber(item.value);
        if (n === null) { skippedValues.push(`${entity.name}: ${JSON.stringify(item.value)}`); return item; }
        return { ...item, value: n };
      }
      const n = toNumber(item);
      if (n === null) { skippedValues.push(`${entity.name}: ${JSON.stringify(item)}`); return item; }
      return n;
    });
    setNestedValue(props, propPath, converted);
  } else {
    const n = toNumber(raw);
    if (n === null) {
      skippedValues.push(`${entity.name}: ${JSON.stringify(raw)}`);
      return;
    }
    setNestedValue(props, propPath, n);
  }

  entity.props = props;
});

if (skippedValues.length > 0) {
  console.log(`\n⚠️  Could not convert ${skippedValues.length} value(s):`);
  for (const s of skippedValues) console.log(`   ${s}`);
}

// Update the page schema: replace "string" with "number" for this prop
const [page] = await queryPages({ key: listName });
if (page?.props) {
  const updated = { ...page.props };
  for (const key of Object.keys(updated)) {
    if (key === propPath || key.startsWith(`${propPath}.`)) {
      if (updated[key] === "string") updated[key] = "number";
    }
  }
  await updatePage(listName, { props: updated });
  console.log(`✅ Updated schema: "${propPath}" marked as number in pages/${listName}.props`);
} else {
  console.log(`⚠️  No props schema found on page "${listName}"`);
}
