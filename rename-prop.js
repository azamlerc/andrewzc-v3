// Rename a prop (or nested prop) on all entities in a list, and update the page schema.
// Supports dot notation for nested props.
// Usage: node rename-prop.js <list-name> <old-prop> <new-prop>
// Example: node rename-prop.js countries left-to-right.prefix left-to-right.year

import { processEntities, queryPages, updatePage } from "./database.js";

const listName = process.argv[2];
const oldProp  = process.argv[3];
const newProp  = process.argv[4];

if (!listName || !oldProp || !newProp) {
  console.error("Usage: node rename-prop.js <list-name> <old-prop> <new-prop>");
  process.exit(1);
}

// Helper: get a nested value using dot notation
function getNestedValue(obj, path) {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

// Helper: set a nested value using dot notation, creating intermediate objects as needed
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

// Helper: delete a nested value using dot notation
function deleteNestedValue(obj, path) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) return;
    cur = cur[keys[i]];
  }
  delete cur[keys[keys.length - 1]];
}

// Rename prop on all matching entities
const filter = { list: listName, [`props.${oldProp}`]: { $exists: true } };

await processEntities(filter, (entity) => {
  const props = { ...entity.props };
  const value = getNestedValue(props, oldProp);
  deleteNestedValue(props, oldProp);
  setNestedValue(props, newProp, value);
  entity.props = props;  // reassign to trigger the proxy's change detection
});

// Update the page schema
const [page] = await queryPages({ key: listName });
if (page?.props) {
  const entries = Object.entries(page.props);
  const updated = Object.fromEntries(
    entries.map(([k, v]) => [k === oldProp ? newProp : k, v])
  );
  await updatePage(listName, { props: updated });
  console.log(`✅ Renamed "${oldProp}" → "${newProp}" in pages/${listName}.props`);
} else {
  console.log(`⚠️  No props schema found on page "${listName}"`);
}
