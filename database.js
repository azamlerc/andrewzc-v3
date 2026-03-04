import "dotenv/config";
import { MongoClient } from "mongodb";
import { parseCoords } from "./utilities.js";

// ---- config ----
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || "andrewzc";
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI");

// ---- internal helpers ----

function track(doc) {
  const changed = new Set();
  const deleted = new Set();

  const proxy = new Proxy(doc, {
    set(target, prop, value) {
      if (prop === "_id") { target[prop] = value; return true; }
      target[prop] = value;
      changed.add(prop);
      deleted.delete(prop);
      return true;
    },
    deleteProperty(target, prop) {
      if (prop === "_id") return true;
      if (prop in target) delete target[prop];
      deleted.add(prop);
      changed.add(prop);
      return true;
    },
  });

  const delta = () => {
    const $set = {}, $unset = {};
    for (const k of changed) {
      if (k === "_id") continue;
      if (deleted.has(k) || proxy[k] === undefined) $unset[k] = 1;
      else $set[k] = proxy[k];
    }
    const update = {};
    if (Object.keys($set).length)   update.$set   = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return update;
  };

  const clear = () => { changed.clear(); deleted.clear(); };
  return { doc: proxy, delta, clear, changedCount: () => changed.size };
}

async function withDb(fn) {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  try {
    const db       = client.db(MONGODB_DB);
    const pages    = db.collection("pages");
    const entities = db.collection("entities");
    return await fn({ db, pages, entities });
  } finally {
    await client.close();
  }
}

async function queryEntities({ entities }, filter, { sort, limit } = {}) {
  let cur = entities.find(filter);
  if (sort)  cur = cur.sort(sort);
  if (limit) cur = cur.limit(limit);
  return cur.toArray();
}

async function bulkSaveEntities({ entities }, trackedDocs, { ordered = false, chunkSize = 1000 } = {}) {
  const docs = trackedDocs.filter(Boolean);
  if (docs.length === 0) return { insertedCount: 0, modifiedCount: 0, matchedCount: 0 };

  let insertedCount = 0, modifiedCount = 0, matchedCount = 0;

  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = docs.slice(i, i + chunkSize);
    const ops = [];

    for (const tracked of batch) {
      const doc    = tracked.doc;
      const update = tracked.delta();
      const isNew  = !!doc.__isNew;
      delete doc.__isNew;

      if (isNew) { ops.push({ insertOne: { document: doc } }); continue; }
      if (!Object.keys(update).length) continue;
      if (!doc._id) throw new Error(`Cannot bulk update without _id for ${doc.list}/${doc.key || doc.name}`);

      ops.push({ updateOne: { filter: { _id: doc._id }, update } });
    }

    if (ops.length === 0) continue;

    const res = await entities.bulkWrite(ops, { ordered });
    insertedCount += res.insertedCount || 0;
    modifiedCount += res.modifiedCount || 0;
    matchedCount  += res.matchedCount  || 0;

    for (const tracked of batch) {
      if (tracked?.clear) tracked.clear();
    }
  }

  return { insertedCount, modifiedCount, matchedCount };
}

// ---- public API ----

/**
 * Convert a coords string to a GeoJSON Point, or null if unparseable.
 * Coordinates are in [lon, lat] order as GeoJSON requires.
 */
export function geoPointFromCoords(coords) {
  const ll = parseCoords(coords);
  if (!ll) return null;
  return { type: "Point", coordinates: [ll.lon, ll.lat] };
}

/**
 * Fetch a single entity by list and key. Returns null if not found.
 */
export async function fetchEntity(list, key) {
  return await withDb(async ({ entities }) => entities.findOne({ list, key }));
}

/**
 * Fetch entities matching a filter without modifying them.
 * Use when the transform is async and processEntities isn't a fit.
 */
export async function fetchEntities(filter, options = {}) {
  return await withDb(async (ctx) => queryEntities(ctx, filter, options));
}

/**
 * Fetch pages matching a MongoDB filter.
 */
export async function queryPages(filter = {}) {
  return await withDb(async ({ pages }) => pages.find(filter).toArray());
}

/**
 * Bulk-save a list of { _id, fields } pairs as $set updates.
 * Pairs with fetchEntities for async workflows (e.g. network-enriched data).
 */
export async function bulkSetFields(updates) {
  if (updates.length === 0) return;
  return await withDb(async ({ entities }) => {
    const ops = updates.map(({ _id, fields }) => ({
      updateOne: { filter: { _id }, update: { $set: fields } },
    }));
    return entities.bulkWrite(ops, { ordered: false });
  });
}

/**
 * Run an Atlas vector search against the wikiEmbedding index, with page info joined.
 * Returns results with { _id, name, list, icons, score, pageInfo } shape.
 *
 * @param {Array}  queryVector  - Embedding vector to search with
 * @param {Object} options
 * @param {string} options.listFilter - Restrict results to this list (optional)
 * @param {number} options.limit      - Number of results to return (default: 10)
 */
export async function vectorSearch(queryVector, { listFilter = null, limit = 10 } = {}) {
  return await withDb(async ({ entities }) => {
    const pipeline = [
      {
        $vectorSearch: {
          index: "wikiEmbeddings",
          path:  "wikiEmbedding",
          queryVector,
          numCandidates: limit * 5,
          limit,
        },
      },
      { $project: { name: 1, list: 1, icons: 1, score: { $meta: "vectorSearchScore" } } },
    ];

    if (listFilter) pipeline.splice(1, 0, { $match: { list: listFilter } });

    pipeline.push(
      { $lookup: { from: "pages", localField: "list", foreignField: "key", as: "pageInfo" } },
      { $unwind: { path: "$pageInfo", preserveNullAndEmptyArrays: true } }
    );

    return entities.aggregate(pipeline).toArray();
  });
}

/**
 * Fetch completion stats (visited/total) for all lists that have a `been` field,
 * joined with page name and icon. Returns array sorted by percent done descending.
 */
export async function fetchCompletionStats() {
  return await withDb(async ({ db }) => {
    const stats = await db.collection("entities").aggregate([
      { $match: { been: { $exists: true } } },
      { $group: {
        _id: "$list",
        total:   { $sum: 1 },
        visited: { $sum: { $cond: ["$been", 1, 0] } },
      }},
      { $lookup: { from: "pages", localField: "_id", foreignField: "key", as: "page" } },
      { $unwind: { path: "$page", preserveNullAndEmptyArrays: true } },
      { $project: {
        list:        "$_id",
        total:       1,
        visited:     1,
        name:        { $ifNull: ["$page.name", "$_id"] },
        icon:        { $ifNull: ["$page.icon", ""] },
        percentDone: { $multiply: [{ $divide: ["$visited", "$total"] }, 100] },
      }},
      { $sort: { percentDone: -1 } },
    ]).toArray();
    return stats;
  });
}

/**
 * Set a field on a page document.
 *
 * @param {string} key    - Page key
 * @param {Object} fields - Fields to $set
 */
export async function updatePage(key, fields) {
  return await withDb(async ({ pages }) =>
    pages.updateOne({ key }, { $set: fields })
  );
}

/**
 * Insert a new entity document. Returns the inserted document with _id.
 *
 * @param {Object} doc - Entity document (without _id)
 */
export async function insertEntity(doc) {
  return await withDb(async ({ entities }) => {
    const res = await entities.insertOne(doc);
    return { ...doc, _id: res.insertedId };
  });
}

/**
 * Append a value to an array field on an entity, or set it as a new single-element array.
 *
 * @param {ObjectId} _id   - Entity _id
 * @param {string}   field - Dot-notation field path (e.g. "props.metro-prices")
 * @param {*}        value - Value to push
 * @param {boolean}  exists - Whether the array already exists
 */
export async function pushToEntityField(_id, field, value, exists) {
  return await withDb(async ({ entities }) => {
    const update = exists
      ? { $push: { [field]: value } }
      : { $set:  { [field]: [value] } };
    return entities.updateOne({ _id }, update);
  });
}

/**
 * Process entities matching a filter, applying a transform to each, then bulk-saving changes.
 *
 * @param {Object}   filter      - MongoDB query filter
 * @param {Function} transformFn - Mutates each entity doc; may delete properties
 * @param {Object}   options     - { sort, limit, chunkSize, dryRun }
 * @returns {{ processed, modified, skipped }}
 */
export async function processEntities(filter, transformFn, options = {}) {
  const { sort, limit, chunkSize = 1000, dryRun = false } = options;

  return await withDb(async (ctx) => {
    const docs = await queryEntities(ctx, filter, { sort, limit });
    console.log(`Found ${docs.length} entities matching filter`);
    if (docs.length === 0) return { processed: 0, modified: 0, skipped: 0 };

    const tracked = [];
    let processed = 0, modified = 0, skipped = 0;

    for (const doc of docs) {
      const t = track(doc);
      t.doc.__isNew = false;
      try {
        transformFn(t.doc);
        processed++;
        if (t.changedCount() > 0) { tracked.push(t); modified++; }
        else skipped++;
      } catch (err) {
        console.error(`Error processing entity ${doc.key || doc.name}:`, err.message);
        skipped++;
      }
    }

    console.log(`Processed: ${processed}, Modified: ${modified}, Skipped: ${skipped}`);

    if (!dryRun && tracked.length > 0) {
      console.log(`Saving ${tracked.length} modified entities...`);
      const result = await bulkSaveEntities(ctx, tracked, { ordered: false, chunkSize });
      console.log(`Saved: inserted=${result.insertedCount}, modified=${result.modifiedCount}`);
    } else if (dryRun) {
      console.log(`[DRY RUN] Would have saved ${tracked.length} entities`);
    }

    return { processed, modified, skipped };
  });
}
