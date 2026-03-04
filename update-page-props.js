// Introspect the props objects across all entities in a list and write a schema
// summary to the matching page document in the pages collection.
//
// For each props key, records the JS type of the value:
//   - Plain values: "boolean", "number", "string"
//   - Objects with a `value` key: type of that value (true → "boolean")
//   - Objects with a `prefix` key but no `value`: "prefix"
//   - Objects with other sub-keys: documented as "key.subkey" with the sub-key's type
//   - `strike` and `icons` sub-keys are ignored (display-only)
//
// Usage: node update-page-props.js <list-name>

import { fetchEntities, updatePage } from "./database.js";

const IGNORED_SUBKEYS = new Set(["strike", "icons", "badges"]);

const listName = process.argv[2];
if (!listName) {
  console.error("Usage: node update-page-props.js <list-name>");
  process.exit(1);
}

const entities = await fetchEntities({
  list:  listName,
  props: { $exists: true },
});

console.log(`Found ${entities.length} entities with props in "${listName}"`);
if (entities.length === 0) process.exit(0);

// ---- type introspection ----

function jsType(value) {
  if (value === null || value === undefined) return null;
  return typeof value;
}

// Given a prop key and its value (across all entities), return a map of
// dotted-path → type entries to merge into the schema.
function introspectProp(key, values) {
  const schema = {};

  for (let value of values) {
    if (value === null || value === undefined) continue;

    // Arrays are rare (e.g. multiple train widths) — just inspect the first item.
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      value = value[0];
    }

    const t = typeof value;

    if (t !== "object") {
      // Plain value — use its type
      schema[key] = t;
      continue;
    }

    // It's an object — inspect its keys
    const subKeys = Object.keys(value).filter(k => !IGNORED_SUBKEYS.has(k));

    if (subKeys.includes("value")) {
      const v = value["value"];
      // value: true means it's a boolean flag
      schema[key] = v === true ? "boolean" : jsType(v);

    } else {
      // Document each meaningful sub-key as dotted path
      for (const sub of subKeys) {
        if (sub === "value") continue;
        const subVal = value[sub];
        if (subVal !== null && subVal !== undefined) {
          schema[`${key}.${sub}`] = jsType(subVal);
        }
      }
    }
  }

  return schema;
}

// ---- collect all values per prop key ----

const propValues = new Map(); // key → array of values seen

for (const entity of entities) {
  for (const [key, value] of Object.entries(entity.props || {})) {
    if (!propValues.has(key)) propValues.set(key, []);
    propValues.get(key).push(value);
  }
}

// ---- build schema ----

const schema = {};

for (const [key, values] of propValues.entries()) {
  const entries = introspectProp(key, values);
  Object.assign(schema, entries);
}

// ---- report ----

console.log("\nDerived props schema:");
for (const [k, v] of Object.entries(schema).sort()) {
  console.log(`  ${k}: "${v}"`);
}

// ---- write to page document ----

await updatePage(listName, { props: schema });
console.log(`\n✅ Written to pages/${listName}.props`);
