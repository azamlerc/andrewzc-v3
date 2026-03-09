# andrewzc-v3

Scripts for managing the andrewzc.net MongoDB database. All database operations are
centralised in `database.js`; general-purpose functions live in `utilities.js`. Individual
scripts import from these and contain only business logic, keeping them short and focused.

---

## Shared Utilities

### `utilities.js`
General-purpose functions with no database dependency. Currently exports:
- `simplify(s)` — converts a name to a URL-safe key (lowercase, no punctuation, no diacritics)
- `parseCoords(s)` — parses any coords string (decimal or DMS with hemisphere letters, including Spanish `O` for West) to `{ lat, lon }`
- `isDmsCoords(s)` — returns true if a coords string contains a degree symbol
- `formatCoords({ lat, lon })` — formats a parsed coord back to canonical decimal string `"12.345, 23.456"`
- `computeKey({ name, reference, country }, pageTags)` — derives the entity key respecting `reference-key`, `reference-first`, and `country-key` page tags
- `countryCodeToFlagEmoji(code)` — converts a two-letter country code to a flag emoji (`"GB"` → `🇬🇧`)
- `flagEmojiToCountryCode(emoji)` — reverses a flag emoji to a country code (`🇬🇧` → `"GB"`)
- `countryCodesFromIcons(icons)` — extracts all country codes from an entity's `icons` array
- `findNearestCity(location, entitiesCollection, radiusKm=20)` — `$nearSphere` query against the `cities` list; accepts a GeoJSON Point or `{ lat, lon }`; returns the city name string or `null`

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
- `pushToEntityField(_id, field, value, exists)` — appends to an array field, or creates it if it doesn't exist yet

---

## Entity Upsert Pipeline

This is the main workflow for adding or modifying entities. The full pipeline is:

1. Provide entity data to Claude in any format (notes, table, prose)
2. Claude parses it and produces a downloadable JSON file
3. Run `upsert-entities.js` to enrich and insert

### `upsert-entities.js`
Reads a JSON or CSV file and upserts each entity into the database with full enrichment:
1. Loads page tags to determine key style and reference requirements
2. Derives `country` from `icons` (or vice versa) if one side is missing
3. Computes `key` using `computeKey()`
4. Loads any existing DB record to avoid overwriting coords, link, city, reference
5. Searches Wikipedia for a `link` if none exists (uses `name + reference` for disambiguation)
6. Fetches `coords` and `location` from the link via `wiki.js` if missing
7. Derives `city` via `findNearestCity()` (20 km radius) if missing
8. Derives `reference` from `city` if the page is tagged `reference` or `reference-optional`
9. Recomputes `key` if reference was just derived
10. Validates reference; skips with error if still unresolvable
11. Upserts the enriched document

Usage: `node upsert-entities.js <file.json|file.csv> [--dryrun]`

For CSV input, use dot-notation headers for nested fields (`props.year`, `icons.0`). Column
order is preserved; `--dryrun` prints what would be upserted without writing anything.

See `upsert-workflow.md` in the context repo for the full workflow guide.

### `wiki.js`
Module (not a standalone script) used by `upsert-entities.js` and `find-location.js` to
fetch coordinates from entity links. Dispatches by host:
- **Wikipedia** — cascade of seven strategies: `{{coord}}` template, river mouth
  handling, `latitude=`/`longitude=` infobox fields, German `breitengrad`/`längengrad`
  fields, `lat_deg`/`lat_min`/`lat_sec` DMS fields, `{{Wikidatacoord|Q...}}` template,
  and Wikidata search by title as a final fallback
- **Booking.com** — regex on `center=lat,lon` in URL
- **Airbnb** — regex on `"lat":...,"lng":...` in page source

Handles Wikipedia 429 rate limiting (waits 60 s, retries once). Returns `{ coords, location }`.

### `find-location.js`
Batch-fetches missing coordinates for existing entities that have a Wikipedia, Booking.com,
or Airbnb link. Skips pages tagged `no-coords`. Marks failed lookups with `coords: "not-found"`
to avoid re-attempting them on future runs.

Usage: `node find-location.js [list-name] [--dryrun] [--retry] [--test]`

- Omit `list-name` to process all eligible entities
- `--retry` also attempts entities previously marked `"not-found"`
- `--test` reports only — buckets eligible entities by list without writing anything
- `--dryrun` shows what would be written without committing

---

## Keys and Structure

### `rekey.js`
Regenerates `key` values for all entities in a list based on the page's tags
(`reference-key`, `reference-first`, `country-key`). Now delegates to `computeKey()`
in `utilities.js`. Accepts `--dryrun`.
Usage: `node rekey.js <list-name> [--dryrun]`

### `copy-city-to-reference.js`
Copies the `city` field to `reference` for all entities in a given list.
Usage: `node copy-city-to-reference.js <list-name>`

---

## References

### `add-reference-tag.js`
One-time setup script that empirically surveys reference field coverage per list and tags
pages as `reference` (≥90% of entities have a reference) or `reference-optional` (<90%).
Prints a full coverage table and skips pages already tagged. Safe to re-run — only adds
tags to previously untagged pages.

### `find-missing-references.js`
Audits all pages tagged `reference` for entities with a missing or blank reference field.
Auto-fixes cases where `city` is set (copies it to `reference`); prints the rest for
manual attention.

### `get-reference-from-name.js`
Extracts the first word of each entity's `name` as the `reference` field and strips it
from the name. Used to clean up list-prefixed entity names (e.g. driverless metro lines
stored as `"Tokyo Yurikamome"` → `reference: "Tokyo"`, `name: "Yurikamome"`).
Usage: `node get-reference-from-name.js <list-name>`

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

### `clear-wiki-embeddings.js`
Removes only the `wikiEmbedding` field from entities, leaving `wikiSummary` and `enrichedAt`
intact. Use before regenerating embeddings at a different dimension size.
Usage: `node clear-wiki-embeddings.js <list-name>`
       `node clear-wiki-embeddings.js --all`

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

### `natural-search.js`
Natural language search via the live andrewzc API. Sends the query to `POST /search`,
displays results, and prints the tool and args so you can see whether the router used
a database filter, a name search, or a semantic search.
Usage: `node natural-search.js <query> [limit]`

---

## Props Maintenance

### `delete-prop.js`
Deletes a prop from all entities in a list and removes it from the page's props schema.
Usage: `node delete-prop.js <list-name> <prop>`

### `rename-prop.js`
Renames a prop (or nested prop using dot notation) on all entities in a list, and updates
the page schema.
Usage: `node rename-prop.js <list-name> <old-prop> <new-prop>`
Example: `node rename-prop.js countries left-to-right.prefix left-to-right.year`

### `make-prop-numeric.js`
Converts string prop values to numbers for all entities in a list. Handles negative
numbers, dollar signs (`$4.22` → `4.22`), K suffix (`150K` → `150000`), and M suffix
(`1.23M` → `1230000`). Updates the page schema replacing `"string"` with `"number"`.
Usage: `node make-prop-numeric.js <list-name> <prop>`

---

## One-off Fixes

### `fix-copies.js`
Corrected coord and country errors on `eiffel-tower-tianducheng` and
`statue-of-liberty-paris`, and inserted three missing `copies` entities:
`eiffel-tower-las-vegas`, `eiffel-tower-tokyo`, and `statue-of-liberty-las-vegas`.
Not intended for re-use; kept for audit purposes.

---

## Stats and Reporting

### `completion-stats.js`
Prints a table of completion percentages (visited/total) per page, sorted by % done.
