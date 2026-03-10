// check-pages.js
// Compares static .html pages against their dynamic equivalents at localhost,
// and upgrades matching links in a category page.
//
// Usage:
//   node check-pages.js <category.html> [--fix] [--base=http://localhost/andrewzc]
//
// - Finds all links in <category.html> that still point to <page>.html
// - For each, reads the static file and loads the dynamic page in a headless
//   browser (Playwright) so that JavaScript renders the content
// - Extracts the contents of <div class="items ..."> from each
// - Reports similarity (identical / N lines differ / completely different)
// - With --fix: rewrites matching links to page.html?id=<page>
//
// Requires: npm install playwright && npx playwright install chromium

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { chromium } from "playwright";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fix  = args.includes("--fix");
const baseArg = args.find(a => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length).replace(/\/$/, "") : "http://localhost/andrewzc";
const categoryArg = args.find(a => !a.startsWith("--"));

if (!categoryArg) {
  console.error("Usage: node check-pages.js <category> [--fix] [--base=http://localhost/andrewzc]");
  process.exit(1);
}

// ─── Resolve category file path ───────────────────────────────────────────────
// Accept just the page name (e.g. "trains") and resolve it relative to the
// sibling andrewzc.net directory, or a full/relative path for flexibility.

const SITE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../andrewzc.net");

function resolveCategoryPath(arg) {
  // Already an absolute path
  if (arg.startsWith("/")) return arg;
  // Relative path with a slash in it — resolve from cwd
  if (arg.includes("/")) return path.resolve(process.cwd(), arg);
  // Bare name like "trains" or "trains.html" — look in sibling andrewzc.net
  const name = arg.endsWith(".html") ? arg : `${arg}.html`;
  return path.join(SITE_DIR, name);
}

const categoryPath = resolveCategoryPath(categoryArg);

let categoryHtml;
try {
  categoryHtml = readFileSync(categoryPath, "utf8");
} catch (e) {
  console.error(`Could not read ${categoryPath}: ${e.message}`);
  process.exit(1);
}

// ─── Find static links ────────────────────────────────────────────────────────

// Match href="something.html" but NOT href="page.html?..." or external links
const linkRe = /href="(?!page\.html\?|https?:\/\/)([a-zA-Z0-9_-]+)\.html"/g;
const staticLinks = [];
let m;
while ((m = linkRe.exec(categoryHtml)) !== null) {
  staticLinks.push(m[1]);
}

const unique = [...new Set(staticLinks)];
console.log(`\nCategory: ${path.basename(categoryPath)}`);
console.log(`Found ${unique.length} static link(s) to check.\n`);

if (unique.length === 0) process.exit(0);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dir = path.dirname(categoryPath);

/**
 * Extract the innerHTML of the first <div class="items ..."> block from a
 * raw HTML string. Uses bracket-counting — no DOM parser needed.
 */
function extractItemsFromString(html) {
  const openRe = /<div\b[^>]*\bclass="[^"]*\bitems\b[^"]*"[^>]*>/i;
  const match = openRe.exec(html);
  if (!match) return null;

  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;

  while (i < html.length && depth > 0) {
    if (html[i] === "<") {
      if (html.slice(i, i + 2) === "</") {
        const end = html.indexOf(">", i);
        if (end !== -1) {
          const tag = html.slice(i + 2, end).trim().split(/\s/)[0].toLowerCase();
          if (tag === "div") depth--;
          i = end + 1;
          continue;
        }
      } else {
        const end = html.indexOf(">", i);
        if (end !== -1) {
          const inner = html.slice(i + 1, end);
          const tag = inner.trim().split(/\s/)[0].toLowerCase();
          const selfClosing = inner.trimEnd().endsWith("/") ||
            ["br","hr","img","input","meta","link"].includes(tag);
          if (!selfClosing && tag === "div") depth++;
          i = end + 1;
          continue;
        }
      }
    }
    i++;
  }

  return normalize(html.slice(start, i - (depth === 0 ? "</div>".length : 0)));
}

// Normalize for comparison: strip runtime-only attributes, trim lines, drop blank lines
function normalize(html) {
  return html
    .replace(/\s+data-[a-z][a-z0-9-]*="[^"]*"/g, "") // strip data-* attributes (e.g. data-view-href)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("\n");
}

function diffScore(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLen = Math.max(aLines.length, bLines.length);
  if (maxLen === 0) return { different: 0, total: 0, pct: 0 };
  let different = 0;
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) different++;
  }
  return { different, total: maxLen, pct: Math.round(100 * different / maxLen) };
}

// ─── Process pages ────────────────────────────────────────────────────────────

const results = { identical: [], different: [], error: [] };

const browser = await chromium.launch();
const context = await browser.newContext();
const browserPage = await context.newPage();

// Silence console noise from the pages we load
browserPage.on("console", () => {});
browserPage.on("pageerror", () => {});

for (const pageId of unique) {
  const staticPath = path.join(dir, `${pageId}.html`);
  const dynamicUrl = `${BASE}/page.html?id=${pageId}`;

  // Read static file
  let staticHtml;
  try {
    staticHtml = readFileSync(staticPath, "utf8");
  } catch {
    results.error.push({ pageId, reason: "static file not found" });
    console.log(`  ✗ ${pageId} — static file not found`);
    continue;
  }

  // Load dynamic page and wait for .items to appear
  let dynamicItemsHtml;
  try {
    await browserPage.goto(dynamicUrl, { waitUntil: "networkidle", timeout: 15_000 });
    const itemsEl = await browserPage.$(".items");
    if (!itemsEl) {
      results.error.push({ pageId, reason: "no .items div in dynamic page (may not be in DB yet)" });
      console.log(`  ✗ ${pageId} — no .items div in dynamic page`);
      continue;
    }
    dynamicItemsHtml = normalize(await itemsEl.innerHTML());
  } catch (e) {
    results.error.push({ pageId, reason: `browser error: ${e.message}` });
    console.log(`  ✗ ${pageId} — browser error: ${e.message}`);
    continue;
  }

  const staticItems = extractItemsFromString(staticHtml);
  if (!staticItems) {
    results.error.push({ pageId, reason: "no .items div in static file" });
    console.log(`  ✗ ${pageId} — no .items div in static file`);
    continue;
  }

  if (staticItems === dynamicItemsHtml) {
    results.identical.push(pageId);
    console.log(`  ✓ ${pageId} — identical`);
  } else {
    const { different, total, pct } = diffScore(staticItems, dynamicItemsHtml);
    results.different.push({ pageId, different, total, pct });
    console.log(`  ≠ ${pageId} — ${different}/${total} lines differ (${pct}%)`);
  }
}

await browser.close();

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Identical:   ${results.identical.length}`);
console.log(`Different:   ${results.different.length}`);
console.log(`Errors:      ${results.error.length}`);

if (results.different.length) {
  console.log(`\nDifferent pages:`);
  for (const { pageId, different, total, pct } of results.different) {
    console.log(`  ${pageId}: ${different}/${total} lines differ (${pct}%)`);
  }
}

if (results.error.length) {
  console.log(`\nErrors:`);
  for (const { pageId, reason } of results.error) {
    console.log(`  ${pageId}: ${reason}`);
  }
}

// ─── Fix ──────────────────────────────────────────────────────────────────────

if (fix && results.identical.length > 0) {
  let updated = categoryHtml;
  for (const pageId of results.identical) {
    updated = updated.replaceAll(`href="${pageId}.html"`, `href="page.html?id=${pageId}"`);
  }
  if (updated !== categoryHtml) {
    writeFileSync(categoryPath, updated, "utf8");
    console.log(`\n✅ Updated ${results.identical.length} link(s) in ${path.basename(categoryPath)}`);
  }
} else if (results.identical.length > 0) {
  console.log(`\nRun with --fix to update ${results.identical.length} identical link(s) in ${path.basename(categoryPath)}`);
}
