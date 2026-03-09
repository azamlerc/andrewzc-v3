// Remove a single prop from all entities in a list, and from the page's props schema.
// Usage: node delete-prop.js <list-name> <prop-name>

import { processEntities, queryPages, updatePage } from "./database.js";

const listName = process.argv[2];
const propName = process.argv[3];

if (!listName || !propName) {
  console.error("Usage: node delete-prop.js <list-name> <prop-name>");
  process.exit(1);
}

// Remove from all entities in the list that have this prop
const filter = { list: listName, [`props.${propName}`]: { $exists: true } };

await processEntities(filter, (entity) => {
  const props = { ...entity.props };
  delete props[propName];
  entity.props = props;  // reassign to trigger the proxy's change detection
});

// Remove all matching keys from the page's props schema
// (e.g. "tariffs" removes "tariffs.percent" as well as "tariffs")
const [page] = await queryPages({ key: listName });
if (page?.props) {
  const updated = Object.fromEntries(
    Object.entries(page.props).filter(([k]) => k !== propName && !k.startsWith(`${propName}.`))
  );
  await updatePage(listName, { props: updated });
  console.log(`✅ Removed "${propName}" from pages/${listName}.props`);
} else {
  console.log(`⚠️  No props schema found on page "${listName}"`);
}
