// Fetch Wikipedia summaries and OpenAI embeddings, storing wikiSummary,
// wikiEmbedding, and enrichedAt on each entity.
//
// Skip logic:
//   - Entities with enrichedAt but no wikiSummary had no usable Wikipedia
//     extract — skipped entirely.
//   - Entities with wikiSummary but no wikiEmbedding need embedding only —
//     the Wikipedia fetch is skipped, just the embedding is generated.
//   - Entities with both are fully enriched — skipped entirely.
//
// This means after running clear-wiki-embeddings.js, re-running this script
// will regenerate only the embeddings without hitting Wikipedia again.
//
// Usage:
//   node load-wiki-summaries.js              # enrich everything
//   node load-wiki-summaries.js <list-name>  # enrich one list only

import OpenAI from "openai";
import { fetchEntities, queryPages, bulkSetFields } from "./database.js";

const BATCH_SIZE             = 10;
const SLEEP_MS               = 1000;
const MAX_CONSECUTIVE_ERRORS = 5;  // network/HTTP errors only, not missing extracts

const listName = process.argv[2] ?? null;

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY environment variable not set");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- fetch unenriched entities ----
// Fetches entities that either haven't been attempted yet, or have a summary
// but are missing an embedding (e.g. after clear-wiki-embeddings.js).

let entities;

if (listName) {
  const [page] = await queryPages({ key: listName });
  if (page?.propertyOf) {
    console.error(`⚠️  "${listName}" is deprecated (propertyOf: ${page.propertyOf}). Skipping.`);
    process.exit(0);
  }
  entities = await fetchEntities({
    list: listName,
    link: { $regex: "wikipedia\\.org" },
    $or:  [
      { enrichedAt: { $exists: false } },
      { wikiSummary: { $exists: true }, wikiEmbedding: { $exists: false } },
    ],
  });
  console.log(`Found ${entities.length} unenriched entities in "${listName}"`);
} else {
  const deprecatedPages = await queryPages({ propertyOf: { $exists: true } });
  const deprecatedLists = deprecatedPages.map(p => p.key);
  entities = await fetchEntities({
    list: { $nin: deprecatedLists },
    link: { $regex: "wikipedia\\.org" },
    $or:  [
      { enrichedAt: { $exists: false } },
      { wikiSummary: { $exists: true }, wikiEmbedding: { $exists: false } },
    ],
  });
  console.log(`Found ${entities.length} unenriched entities across all lists`);
}

if (entities.length === 0) {
  console.log("✅ Nothing to do!");
  process.exit(0);
}

// ---- helpers ----

class RateLimitError extends Error {}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Returns { summary } where summary is a string or null.
// null means the article exists but has no usable extract (redirect dead-end,
// disambiguation, stub, etc.) — this is not an error.
// Throws RateLimitError on HTTP 429/403.
// Throws on network errors.
async function fetchWikiSummary(url) {
  const { hostname, pathname } = new URL(url);
  const lang  = hostname.match(/^([a-z]{2})\.wikipedia\.org$/)?.[1] ?? "en";
  const title = decodeURIComponent(pathname.split("/").at(-1));
  const apiUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json` +
    `&prop=extracts&exintro=true&explaintext=true&redirects=true&titles=${encodeURIComponent(title)}`;

  const res = await fetch(apiUrl, { headers: { "User-Agent": "PersonalWebsiteBot/1.0 (andrewzc)" } });

  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(`HTTP ${res.status} from Wikipedia`);
  }

  const data    = await res.json();
  const extract = Object.values(data.query?.pages ?? {})[0]?.extract;
  if (!extract) return { summary: null };

  const summary = extract.split("\n")
    .filter(p => p.trim().length > 50)
    .filter(p => !/<[a-z]/i.test(p))   // drop paragraphs containing HTML tags
    .filter(p => !/^[^a-zA-Z]*$/.test(p))  // drop paragraphs with no letters at all
    .slice(0, 3).join(" ") || null;
  return { summary };
}

async function fetchEmbeddings(texts) {
  const res = await openai.embeddings.create({ model: "text-embedding-3-small", input: texts, dimensions: 512 });
  return res.data.map(item => item.embedding);
}

// ---- main loop ----

let processed          = 0;
let noExtract          = 0;
let consecutiveErrors  = 0;

for (let i = 0; i < entities.length; i += BATCH_SIZE) {
  const batch        = entities.slice(i, i + BATCH_SIZE);
  const batchNum     = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(entities.length / BATCH_SIZE);
  console.log(`\nBatch ${batchNum}/${totalBatches} (${processed} saved so far)...`);

  const withSummary    = [];  // { entity, summary } — will get embeddings
  const withoutSummary = [];  // { entity } — mark as attempted, no embedding

  for (const entity of batch) {
    console.log(`  Fetching: ${entity.list}/${entity.name}`);

    // Summary already stored — skip Wikipedia, just re-embed.
    if (entity.wikiSummary) {
      withSummary.push({ entity, summary: entity.wikiSummary });
      consecutiveErrors = 0;
      continue;
    }

    try {
      const { summary } = await fetchWikiSummary(entity.link);
      if (summary) {
        withSummary.push({ entity, summary });
      } else {
        withoutSummary.push({ entity });
        noExtract++;
      }
      consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`\n🚫 Wikipedia is rate limiting us (${err.message}).`);
        console.error(`   Take a break and try again later. Saved ${processed} entities so far.`);
        process.exit(1);
      }
      console.warn(`  ⚠️  Network error: ${entity.name} — ${err.message}`);
      consecutiveErrors++;
    }

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`\n🚫 ${consecutiveErrors} consecutive network errors — something may be wrong.`);
      console.error(`   Take a break and try again later. Saved ${processed} entities so far.`);
      process.exit(1);
    }

    await sleep(SLEEP_MS);
  }

  // Save entities with summaries (fetch embeddings first)
  if (withSummary.length > 0) {
    const embeddings = await fetchEmbeddings(withSummary.map(r => r.summary));
    await bulkSetFields(withSummary.map(({ entity, summary }, j) => ({
      _id:    entity._id,
      fields: { wikiSummary: summary, wikiEmbedding: embeddings[j], enrichedAt: new Date() },
    })));
    processed += withSummary.length;
    console.log(`  ✅ Saved ${withSummary.length}`);
  }

  // Mark entities with no extract as attempted (no embedding stored)
  if (withoutSummary.length > 0) {
    await bulkSetFields(withoutSummary.map(({ entity }) => ({
      _id:    entity._id,
      fields: { enrichedAt: new Date() },
    })));
    console.log(`  ⏭️  No extract for ${withoutSummary.length}`);
  }
}

console.log(`\n✅ Done. Saved: ${processed}, No extract: ${noExtract}`);
