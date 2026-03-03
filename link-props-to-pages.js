// Inspect props keys on cities and countries entities, find the matching page for each,
// and set propertyOf on that page to indicate it's a sub-list of the parent.
// This is a one-time migration but safe to re-run.

import { fetchEntities, queryPages, updatePage } from "./database.js";

for (const listName of ["cities", "countries"]) {
  console.log(`\n📊 Analyzing props in ${listName}...`);

  const entities = await fetchEntities({
    list:  listName,
    props: { $exists: true, $ne: {} },
  });

  console.log(`  Found ${entities.length} entities with props`);

  const propKeys = new Set(entities.flatMap(e => Object.keys(e.props)));
  console.log(`  Found ${propKeys.size} unique prop keys`);

  const pages = await queryPages({ key: { $in: [...propKeys] } });
  const pageMap = new Map(pages.map(p => [p.key, p]));

  const updated  = [];
  const notFound = [];

  for (const propKey of propKeys) {
    if (pageMap.has(propKey)) {
      await updatePage(propKey, { propertyOf: listName });
      updated.push(propKey);
      console.log(`  ✅ ${propKey} → propertyOf: "${listName}"`);
    } else {
      notFound.push(propKey);
      console.log(`  ⚠️  ${propKey} (no matching page found)`);
    }
  }

  console.log(`\n  Pages updated: ${updated.length}, not found: ${notFound.length}`);
  if (notFound.length) console.log(`  Missing: ${notFound.join(", ")}`);
}

console.log("\n✅ Done!");
