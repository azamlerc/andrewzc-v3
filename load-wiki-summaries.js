// Fetch Wikipedia summaries and OpenAI embeddings, storing wikiSummary,
// wikiEmbedding, and enrichedAt on each entity. Skips entities that already
// have a wikiEmbedding, so it's safe to run repeatedly.
//
// Usage:
//   node load-wiki-summaries.js              # enrich everything
//   node load-wiki-summaries.js <list-name>  # enrich one list only

import OpenAI from "openai";
import { fetchEntities, queryPages, bulkSetFields } from "./database.js";

const BATCH_SIZE        = 10;
const SLEEP_MS          = 1000;
const MAX_CONSECUTIVE_FAILURES = 5;  // exit if Wikipedia blocks us

const listName = process.argv[2] ?? null;

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY environment variable not set");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- fetch unenriched entities ----

let entities;

if (listName) {
  // Single list — guard against deprecated lists
  const [page] = await queryPages({ key: listName });
  if (page?.propertyOf) {
    console.error(`⚠️  "${listName}" is deprecated (propertyOf: ${page.propertyOf}). Skipping.`);
    process.exit(0);
  }
  entities = await fetchEntities({
    list:          listName,
    link:          { $regex: "wikipedia\\.org" },
    wikiEmbedding: { $exists: false },
  });
  console.log(`Found ${entities.length} unenriched entities in "${listName}"`);
} else {
  // All lists — exclude deprecated ones
  const deprecatedPages = await queryPages({ propertyOf: { $exists: true } });
  const deprecatedLists = deprecatedPages.map(p => p.key);
  entities = await fetchEntities({
    list:          { $nin: deprecatedLists },
    link:          { $regex: "wikipedia\\.org" },
    wikiEmbedding: { $exists: false },
  });
  console.log(`Found ${entities.length} unenriched entities across all lists`);
}

if (entities.length === 0) {
  console.log("✅ Nothing to do!");
  process.exit(0);
}

// ---- helpers ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWikiSummary(url) {
  const { hostname, pathname } = new URL(url);
  const lang  = hostname.match(/^([a-z]{2})\.wikipedia\.org$/)?.[1] ?? "en";
  const title = decodeURIComponent(pathname.split("/").at(-1));
  const apiUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=extracts&exintro=true&explaintext=true&titles=${encodeURIComponent(title)}`;

  const res = await fetch(apiUrl, { headers: { "User-Agent": "PersonalWebsiteBot/1.0 (andrewzc)" } });

  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(`HTTP ${res.status} from Wikipedia`);
  }

  const data    = await res.json();
  const extract = Object.values(data.query?.pages ?? {})[0]?.extract;
  if (!extract) return null;

  return extract.split("\n").filter(p => p.trim().length > 50).slice(0, 3).join(" ") || null;
}

async function fetchEmbeddings(texts) {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: texts });
  return res.data.map(item => item.embedding);
}

class RateLimitError extends Error {}

// ---- main loop ----

let processed          = 0;
let failed             = 0;
let consecutiveFailures = 0;

for (let i = 0; i < entities.length; i += BATCH_SIZE) {
  const batch      = entities.slice(i, i + BATCH_SIZE);
  const batchNum   = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(entities.length / BATCH_SIZE);
  console.log(`\nBatch ${batchNum}/${totalBatches} (${processed} saved so far)...`);

  const results = [];

  for (const entity of batch) {
    console.log(`  Fetching: ${entity.list}/${entity.name}`);
    try {
      const summary = await fetchWikiSummary(entity.link);
      if (summary) {
        results.push({ entity, summary });
        consecutiveFailures = 0;
      } else {
        failed++;
        consecutiveFailures++;
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`\n🚫 Wikipedia is rate limiting us (${err.message}).`);
        console.error(`   Take a break and try again later. Saved ${processed} entities so far.`);
        process.exit(1);
      }
      console.warn(`  ⚠️  Failed: ${entity.name} — ${err.message}`);
      failed++;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`\n🚫 ${consecutiveFailures} consecutive failures — Wikipedia may be blocking us.`);
      console.error(`   Take a break and try again later. Saved ${processed} entities so far.`);
      process.exit(1);
    }

    await sleep(SLEEP_MS);
  }

  if (results.length === 0) continue;

  const embeddings = await fetchEmbeddings(results.map(r => r.summary));

  await bulkSetFields(results.map(({ entity, summary }, j) => ({
    _id:    entity._id,
    fields: { wikiSummary: summary, wikiEmbedding: embeddings[j], enrichedAt: new Date() },
  })));

  processed += results.length;
  console.log(`  ✅ Saved ${results.length}`);
}

console.log(`\n✅ Done. Processed: ${processed}, Failed: ${failed}`);
