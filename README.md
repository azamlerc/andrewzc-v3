# andrewzc-v3

Scripts for managing the andrewzc.net MongoDB database. All database operations are
centralised in `database.js`; general-purpose functions live in `utilities.js`. Individual
scripts import from these and contain only business logic, keeping them short and focused.

---

## Shared Utilities

### `utilities.js`
General-purpose functions with no database dependency. Currently exports:
- `simplify(s)` — converts a name to a URL-safe key (lowercase, no punctuation, no diacritics)
- `parseCoords(s)` — parses any coords string (decimal or DMS with hemisphere letters) to `{ lat, lon }`
- `isDmsCoords(s)` — returns true if a coords string contains a degree symbol
- `formatCoords({ lat, lon })` — formats a parsed coord back to canonical decimal string `"12.345, 23.456"`

### `database.js`
Database utility. Exports:
- `processEntities(filter, transformFn, options)` — fetches matching entities, runs a transform on each, and bulk-saves changes
- `fetchEntity(list, key)` — fetches a single entity by list and key
- `fetchEntities(filter, options)` — fetches entities without modifying them; for scripts with async transforms that can't use `processEntities`
- `bulkSetFields(updates)` — saves an array of `{ _id, fields }` pairs as `$set` updates; pairs with `fetchEntities` for async workflows
- `queryPages(filter)` — fetches pages matching a filter
- `geoPointFromCoords(coords)` — parses a coords string and returns a GeoJSON Point (coordinates in `[lon, lat]` order as GeoJSON requires)
- `vectorSearch(queryVector, options)` — runs an Atlas vector search against the `wikiEmbedding` index, with page info joined
- `fetchCompletionStats()` — aggregates visited/total counts per list, joined with page name and icon, sorted by % done
- `updatePage(key, fields)` — sets fields on a page document
- `insertEntity(doc)` — inserts a new entity and returns it with `_id`
- `pushToEntityField(_id, field, value, exists)` — appends to an array field, or creates it if it doesn’t exist yet

---

## Keys and Structure

### `rekey.js`
Regenerates `key` values for all entities in a list based on the page's tags
(`reference-key`, `reference-first`, `country-key`). Accepts `--dryrun`.
Usage: `node rekey.js <list-name> [--dryrun]`

### `copy-city-to-reference.js`
Copies the `city` field to `reference` for all entities in a given list.
Usage: `node copy-city-to-reference.js <list-name>`

---

## Properties

### `update-props.js`
Reads a JSON file and writes each entry as `props.*` fields on the matching entity in a
given list. The go-to tool for loading a batch of prop data from a JSON file.
Usage: `node update-props.js <list-name> <data-file.json> [--dryrun]`

### `merge-list-to-props.js`
Takes all entities from a "detail list" (e.g. `metro-prices`) and merges them as a prop
into a "main list" (e.g. `metros`), keyed by entity name. Handles parenthetical sub-names,
badges, strike-through, and array accumulation.
Usage: `node merge-list-to-props.js <main-list> <detail-list> [--dryrun]`

### `update-page-props.js`
Introspects the `props` objects across all entities in a list and writes a schema summary
to the matching page document. For each props key, records the JS type (`"boolean"`,
`"number"`, `"string"`, `"prefix"`). Object sub-keys are documented as `key.subkey`;
`strike` and `icons` are ignored as display-only. Safe to re-run — overwrites on each pass.
Usage: `node update-page-props.js <list-name>`

### `link-props-to-pages.js`
Inspects `props` keys on `cities` and `countries` entities, finds matching pages, and sets
`propertyOf` on those pages. One-time migration but safe to re-run.

### `copy-prefix-to-props.js`
Copies `prefix` → `props.speed` for `high-speed` entities. Good example of the ideal
pattern: ~10 lines, just a `processEntities()` call.

---

## Location

### `update-location.js`
Two-pass maintenance script for coords/location fields. Safe to re-run at any time.
- Pass 1: finds entities with DMS coords (containing `°`) and rewrites them as plain decimal strings.
- Pass 2: finds entities with a `coords` field but no `location` field and sets a GeoJSON Point.

`coords` is the human-editable legacy field; `location` is the tightly-controlled GeoJSON
version used for geo queries.

---

## Wikipedia and Semantic Search

### `load-wiki-summaries.js`
Fetches Wikipedia intro text for entities that have a Wikipedia `link`, generates OpenAI
embeddings, and stores `wikiSummary`, `wikiEmbedding`, and `enrichedAt`. Skips entities
that already have an embedding, so it's safe to run repeatedly and will pick up where it
left off. Exits cleanly if Wikipedia starts rate limiting.
Usage: `node load-wiki-summaries.js [list-name]` — omit list name to enrich everything.

### `clear-wiki-data.js`
Removes `wikiSummary`, `wikiEmbedding`, and `enrichedAt` from entities in a given list.
Accepts `--junk-only` to target only malformed summaries (those starting with `.mw-parser-output`).
Usage: `node clear-wiki-data.js <list-name> [--junk-only]`

### `print-wiki-summaries.js`
Prints all `wikiSummary` values for entities in a given list to stdout.
Usage: `node print-wiki-summaries.js <list-name>`

### `find-similar.js`
Given a list name and entity key, runs a MongoDB Atlas vector search to find semantically
similar entities across all lists.
Usage: `node find-similar.js <list-name> <entity-key> [limit]`

### `query-entities.js`
Semantic search across all entities using a natural language query string, via OpenAI
embeddings and Atlas vector search.
Usage: `node query-entities.js <query> [list-filter] [limit]`

---

## Stats and Reporting

### `completion-stats.js`
Prints a table of completion percentages (visited/total) per page, sorted by % done.
