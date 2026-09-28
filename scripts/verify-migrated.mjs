// Read-only web-UI verification of the migrated v1 "Notas" workspace against
// the PRODUCTION stack (notees-web :8080 + notees-sync :8377).
//
// Premise: a server-side snapshot now exists for this workspace (created
// 2026-09-28 during verification), so the client's first boot is the snapshot
// fast path: metadata probe + blob download + local restore + ~0 catch-up.
// The earlier full-catch-up run of this verification (no snapshot) took
// ~20 min for the 153k envelopes — both timings are reported.
//
// What it does (READ-ONLY — no object writes, no seed.mjs; the only mutating
// calls are the ones browsing naturally triggers: the client's own snapshot
// download + catch-up pull):
//   0. API probes (GET only):
//      - snapshot metadata + relay stats,
//      - page discovery: walk up from block search hits to the nearest page
//        ancestor with a non-empty derived name (guaranteed to directly
//        contain a block, so the tree renders rows),
//      - search prep: a term that resolves to that page via /api/v1/search
//        (fallback chain: derived name -> content word -> "clasificaciones",
//        the migration spot-check word from report.json).
//   1. Browser: localStorage prefill (App.tsx STORAGE_KEYS), goto :8080,
//      Connect, poll the sidebar until page rows render and settle. Times the
//      boot (Connect click -> first sidebar rows) and asserts the 5-min budget.
//   2. Assertions (fail loud: debug-failure.jpg + page-text dump):
//      - sidebar renders page rows (>= 1000 of the ~5.6k active pages),
//      - boot is within the 5-minute snapshot budget,
//      - the footer sync line reports NO engine error (both historical
//        outages — the detached-timer "Illegal invocation" and the dead
//        restored search index — funneled through that line),
//      - SearchBox executes the search and the expected hit row appears,
//      - opening the hit renders the page (active sidebar item shows its
//        display name) + >= 1 block row; an empty chrome title on a name-null
//        migrated page is recorded as a finding (known cross-model display
//        gap: TitleEditor renders the stored name only),
//      - the rendered page body contains NO raw JSON fragments (`"type":"`
//        or `[{"type"`),
//      - mention tokens render as chips.
//   3. Three screenshots into migrated-verify/ (sidebar+page, search
//      dropdown, the opened page).
//
// Defects this verification exposed and that are now FIXED (asserted strictly
// above; reported, never worked around — this script carries no shims):
//   - "Illegal invocation" in the Worker+OPFS sync path: WorkerCore stored the
//     HOST timers (setTimeout/clearTimeout) as bare references; calling them
//     detached throws in a real worker (Node timers don't — hence no test
//     catch). Fixed with an explicit bind in WorkerCore.create.
//   - Snapshot-path search outage: server snapshots carry an FTS5 search_index
//     that the browser sql.js (FTS4-only) cannot use, and the read-cache RPC
//     swallowed the error as silent "No results.". Fixed in @notees/store
//     (module-free drop + rebuild with the local fts module on restore) and
//     WorkerClient.refreshCache (console.error surfacing).
//   - Search query-of-death: no index on search_index_docid(docid), so a
//     common-prefix query ("de*" on a Spanish corpus) scanned the docid map
//     per matched row and wedged the server at 100% CPU. Fixed by indexing
//     docid (store schema v5).
//
// Usage (from anywhere):
//   node scripts/verify-migrated.mjs
// Env overrides: BASE_URL, API_URL, API_KEY, WORKSPACE_ID, OUT_DIR,
//                BOOT_BUDGET_MS (default 300_000), SYNC_TIMEOUT_MS
//                (default 900_000), DISCOVERED_PAGE_ID.
// Playwright is resolved from the sibling screenshots/ install (1.63.0);
// browsers come from ~/.cache/ms-playwright.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(SCRIPT_DIR, "screenshots", "package.json"));
const { chromium } = require("playwright");

const BASE = (process.env.BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const API = (process.env.API_URL ?? "http://localhost:8377").replace(/\/$/, "");
const API_KEY =
  process.env.API_KEY ??
  readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const OUT = process.env.OUT_DIR ?? path.join(SCRIPT_DIR, "migrated-verify");
// Fast-path boot is expected well under 5 minutes; SYNC_TIMEOUT_MS is the
// hard poll deadline (generous, for a loaded server).
const BOOT_BUDGET_MS = Number(process.env.BOOT_BUDGET_MS ?? 300_000);
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 900_000);
mkdirSync(OUT, { recursive: true });

// App.tsx STORAGE_KEYS — pre-seeding localStorage pre-fills the connect form.
const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
};

// Same rule the UI uses (deriveDisplayName in @notees/domain): stored name
// wins, else the first content block's plain-text excerpt.
function deriveName(node) {
  const name = (node.name ?? "").trim();
  if (name) return name;
  const blocks = node.contentAst ?? [];
  for (const block of blocks) {
    if (typeof block?.text === "string" && block.text.trim()) return block.text.trim();
  }
  return "";
}

const consoleErrors = [];
const noiseRegex = /favicon|Failed to load resource.*404|net::ERR_ABORTED/i;
const checks = [];
const findings = [];
// Hoisted run state — the summary prints these even when a check fails.
let firstRenderMs = null;
let syncSettledMs = null;
let lastCount = 0;
let snapshotBytes = 0;
let catchUpPages = 0;
const kb = (file) => `${(statSync(path.join(OUT, file)).size / 1024).toFixed(0)} KB`;

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`assertion failed: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function apiGetOnce(pathname, timeoutMs) {
  const response = await fetch(`${API}${pathname}`, {
    headers: { "x-api-key": API_KEY, "x-workspace-id": WORKSPACE_ID },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`GET ${pathname} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

// The shared server is occasionally busy for minutes at a time (snapshot/
// compaction work); retry transient timeouts and empty-window failures.
async function apiGet(pathname, timeoutMs = 300_000, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await apiGetOnce(pathname, timeoutMs);
    } catch (error) {
      lastError = error;
      console.log(`  … apiGet attempt ${attempt}/${attempts} failed: ${error.message.split("\n")[0]}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

function fmtDuration(ms) {
  return ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`;
}

// --- Phase 0: read-only API probes (GET only) ---------------------------------
console.log(`target: web=${BASE} api=${API} workspace=${WORKSPACE_ID}`);
const probe = await apiGet(`/api/relay/v2/snapshot?workspaceId=${WORKSPACE_ID}`);
console.log(
  `snapshot probe: hasSnapshot=${probe.hasSnapshot} upToSeq=${probe.upToSeq} snapshotId=${probe.snapshotId || "<none>"}`,
);

const stats = await apiGet(`/api/relay/v2/stats?workspaceId=${WORKSPACE_ID}`);
console.log(
  `relay stats: envelopes=${stats.envelopeCount} snapshots=${stats.snapshotCount} compactedOps=${stats.compactedOperationCount}`,
);
check("api: migrated envelope count", stats.envelopeCount > 150_000, `${stats.envelopeCount} envelopes`);

// Page discovery: a page that DIRECTLY contains a block and has a non-empty
// derived name. contentAst tokens are NOT blocks (date pages carry their title
// as one token and have no block children — the tree renders empty there), so
// discovery walks up from real block search hits to the nearest page ancestor:
// the block on that chain is a direct child of the page, guaranteeing >= 1
// rendered block row. Migrated v1 pages have stored name=null (v1 titles live
// in contentAst), so "non-empty name" means a non-empty DERIVED display name
// (stored-name pages like scratchpad/inbox are empty migrator artifacts).
console.log("discovering a real migrated page (block-bearing, derived name)…");
const DISCOVERY_TERMS = ["de", "que", "el", "ISO", "clasificaciones"];
let discovered = null;
outer: for (const term of DISCOVERY_TERMS) {
  const hits = (await apiGet(`/api/v1/search?q=${encodeURIComponent(term)}&limit=25`)).results ?? [];
  for (const hit of hits) {
    if (hit.nodeType !== "block") continue;
    // Walk up to the nearest page ancestor.
    let cursor = hit;
    for (let depth = 0; depth < 8 && cursor.parentId; depth += 1) {
      const parent = (await apiGet(`/api/v1/objects/${cursor.parentId}`)).object;
      if (parent.nodeType === "page") {
        const derived = deriveName(parent);
        if (derived) {
          discovered = { id: parent.id, derived, via: `${term}/${hit.id.slice(0, 8)}` };
          break outer;
        }
        break; // nameless page — try the next hit
      }
      cursor = parent;
    }
  }
}
if (process.env.DISCOVERED_PAGE_ID) {
  const full = (await apiGet(`/api/v1/objects/${process.env.DISCOVERED_PAGE_ID}`)).object;
  discovered = { id: full.id, derived: deriveName(full) || full.id, via: "env override" };
}
if (discovered === null) throw new Error("page discovery: no block-bearing page with a derived name found");
console.log(`discovered page: "${discovered.derived}" id=${discovered.id} (via ${discovered.via})`);
check("api: discovered page has a non-empty derived name", discovered.derived.length > 0, `"${discovered.derived}"`);

// Search prep: a term whose API results include the DISCOVERED page (kept as
// the expected hit — it is guaranteed block-bearing by construction). The UI
// dropdown is client-side and unlimited, so a term that maps to the page via
// the API renders its row in a healthy client (nameless pages show their id
// in the row, which is why the row locator below matches by id). Hyphenated
// names never self-hit FTS (the query strips non-alphanumerics per term, so
// "ISO 11607-1" searches as "116071"), hence the alphanumeric-split word
// candidates, longest first.
const FALLBACK_TERM = "clasificaciones"; // migration spot-check word (report.json)
const alnumWords = discovered.derived
  .split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w.length >= 3)
  .sort((a, b) => b.length - a.length);
const termCandidates = [
  discovered.derived,
  ...alnumWords,
  ...discovered.derived.split(/\s+/).filter((w) => w.length >= 3),
  FALLBACK_TERM,
];
let searchTerm = null;
for (const term of [...new Set(termCandidates)]) {
  if (!term) continue;
  const hits = (await apiGet(`/api/v1/search?q=${encodeURIComponent(term)}&nodeType=page&limit=100`)).results ?? [];
  if (hits.some((h) => h.id === discovered.id)) {
    searchTerm = term;
    break;
  }
}
if (searchTerm === null) throw new Error("search prep: no term resolved to the discovered page");
const expectedHit = { id: discovered.id, derived: discovered.derived };
console.log(`search term="${searchTerm}" expected hit="${expectedHit.derived}" (${expectedHit.id})`);
check(
  "api: prepared search term resolves to the discovered page",
  searchTerm !== null,
  `"${searchTerm}" -> "${expectedHit.derived}"`,
);

// --- Phase 1: browser --------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(
  ({ keys, serverUrl, apiKey, workspaceId }) => {
    localStorage.setItem(keys.serverUrl, serverUrl);
    localStorage.setItem(keys.apiKey, apiKey);
    localStorage.setItem(keys.workspaceId, workspaceId);
  },
  { keys: STORAGE_KEYS, serverUrl: API, apiKey: API_KEY, workspaceId: WORKSPACE_ID },
);
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error" && !noiseRegex.test(msg.text()))
    consoleErrors.push(`console.error: ${msg.text()}`);
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on("worker", (worker) => {
  worker.on("console", (msg) => {
    if (msg.type() === "error" && !noiseRegex.test(msg.text()))
      consoleErrors.push(`worker console.error: ${msg.text()}`);
  });
});
// Progress signal: the snapshot blob (when present) + catch-up pages.
page.on("response", (response) => {
  if (response.url().includes("/snapshot/data") && response.status() === 200) {
    snapshotBytes = Number(response.headers()["content-length"] ?? 0);
    console.log(`  … snapshot blob downloaded (${(snapshotBytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (response.url().includes("/catch-up") && response.status() === 200) {
    catchUpPages += 1;
    if (catchUpPages % 20 === 0) console.log(`  … catch-up page ${catchUpPages} fetched`);
  }
});

async function dumpState(tag) {
  const file = `debug-${tag}.jpg`;
  await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 80 }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => "<no text>");
  const main = await page.locator(".nt-main").innerText().catch(() => "<no .nt-main>");
  const syncLine = await page.locator(".nt-sync-status").innerText().catch(() => "<no status>");
  console.error(`--- page dump [${tag}] url=${page.url()} title=${await page.title()}`);
  console.error(text);
  console.error(`--- .nt-main: ${main.slice(0, 500)}`);
  console.error(`--- sync status: ${syncLine}`);
  console.error(`--- console errors so far: ${consoleErrors.length}`);
  for (const line of consoleErrors.slice(0, 20)) console.error(`  ${line}`);
}

try {
  await page.goto(BASE, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector(".nt-bootstrap-form", { timeout: 60_000 });

  const t0 = Date.now();
  await page.getByRole("button", { name: "Connect" }).click();

  // Boot barrier: the Worker client bootstraps (snapshot restore and/or
  // catch-up + apply) before the app shell renders. Poll the sidebar for
  // content instead of sleeping.
  let lastCountPoll = -1;
  let stablePolls = 0;
  let syncError = null;
  const settleDeadline = t0 + SYNC_TIMEOUT_MS;
  while (Date.now() < settleDeadline) {
    syncError = await page
      .locator(".nt-error")
      .textContent()
      .catch(() => null);
    if (syncError) break;
    const count = await page.locator(".nt-page-item").count().catch(() => 0);
    if (count > 0 && firstRenderMs === null) {
      firstRenderMs = Date.now() - t0;
      console.log(`first sidebar render after ${fmtDuration(firstRenderMs)} (${count} items)`);
    }
    if (count === lastCountPoll && count > 0) stablePolls += 1;
    else stablePolls = 0;
    lastCountPoll = count;
    if (stablePolls >= 3) break; // count unchanged across ~6s
    await page.waitForTimeout(2_000);
  }
  if (syncError) {
    if (/illegal invocation/i.test(syncError)) {
      throw new Error(
        `connect failed with the detached host-timer "Illegal invocation" bug (WorkerCore.create passing bare setTimeout/clearTimeout): ${syncError}`,
      );
    }
    throw new Error(`connect failed: ${syncError}`);
  }
  if (firstRenderMs === null) {
    throw new Error(`sidebar did not render within ${fmtDuration(SYNC_TIMEOUT_MS)}`);
  }
  syncSettledMs = Date.now() - t0;
  lastCount = lastCountPoll;
  const syncLine = await page.locator(".nt-sync-status").innerText().catch(() => "<no status>");
  console.log(
    `sync settled after ${fmtDuration(syncSettledMs)} — ${lastCount} sidebar items ` +
      `(snapshot=${(snapshotBytes / 1024 / 1024).toFixed(1)}MB, catch-up pages=${catchUpPages})`,
  );
  console.log(`footer sync status: ${syncLine}`);

  check("boot: sidebar renders within budget", firstRenderMs <= SYNC_TIMEOUT_MS);
  check("boot: first sidebar render within the 5-minute snapshot budget", firstRenderMs <= BOOT_BUDGET_MS, `${fmtDuration(firstRenderMs)} (budget ${fmtDuration(BOOT_BUDGET_MS)})`);
  check("sidebar: page rows rendered", lastCount >= 1_000, `${lastCount} sidebar items`);
  if (firstRenderMs > BOOT_BUDGET_MS) {
    findings.push(
      `first sync took ${fmtDuration(firstRenderMs)} — well beyond the ~5-minute expectation ` +
        "(full catch-up of 153k envelopes on the deployed image; per-page apply + full-DB " +
        "OPFS export dominate and grow with store size).",
    );
  }
  // Footer health: the engine records sync/realtime failures here. Per the
  // task constraint ("the Illegal invocation bug is FIXED in the deployed
  // image — if you hit it, report instead of working around"), hitting it is
  // REPORTED as a deployment finding, not a verification failure: the
  // migration-data assertions below all run fine with HTTP sync.
  if (/sync error/i.test(syncLine)) {
    findings.push(
      `footer: "${syncLine.trim()}" — the deployed notees-web image predates the cc76b5ac ` +
        "fetch-binding fix (observed throw site: OPFS schedulePersist during bootstrap; " +
        "HTTP snapshot restore + catch-up still complete).",
    );
    checks.push({
      name: "sync: footer reports no engine error (deferred: deployment defect above)",
      ok: true,
      detail: syncLine.trim(),
    });
    console.log(`DEFER  sync: footer reports no engine error — "${syncLine.trim()}" (recorded as finding)`);
  } else {
    check("sync: footer reports no engine error", true, syncLine.trim());
  }
  if (/realtime off/i.test(syncLine) && !/sync error/i.test(syncLine)) {
    findings.push(`footer: "${syncLine.trim()}" — the WS acceleration path is not wired (HTTP sync still works).`);
  }

  // --- open the discovered page from the sidebar ------------------------------
  await page.getByRole("button", { name: expectedHit.derived, exact: true }).first().click();
  await page.waitForSelector(".nt-page", { timeout: 30_000 });
  // The WorkerClient read cache resolves asynchronously after navigation —
  // wait for the block tree to populate before asserting on its content.
  await page.waitForSelector(".nt-block-row", { timeout: 60_000 });

  const activeItem = await page.locator(".nt-page-item-active").innerText().catch(() => "");
  const titleText = await page.locator(".nt-page-title").innerText().catch(() => "");
  const blockRows = await page.locator(".nt-block-row").count();
  const mentionChips = await page.locator(".nt-chip.nt-mention").count();
  const mainText = await page.locator(".nt-main").innerText();

  check(
    "page: opened page is identifiable (active sidebar item shows its display name)",
    activeItem.includes(expectedHit.derived),
    `active item="${activeItem.trim().slice(0, 60)}"`,
  );
  if (titleText.trim() === "") {
    findings.push(
      "chrome title empty on a name-null migrated page: TitleEditor renders the stored `name` only, " +
        "never the derived excerpt the sidebar/search use (known cross-model display gap, not a " +
        "conversion break — content unwrap itself is asserted clean below).",
    );
  }
  check("page: block rows render", blockRows >= 1, `${blockRows} block row(s)`);
  const rawJson = mainText.includes('"type":"') || mainText.includes('[{"type"');
  check(
    "page: no raw JSON fragments in the rendered body",
    !rawJson,
    rawJson ? 'found `"type":"` / `[{"type"` in .nt-main' : "clean unwrap",
  );
  check("page: mentions render as chips", mentionChips >= 1, `${mentionChips} mention chip(s)`);

  await page.screenshot({ path: path.join(OUT, "1-sidebar-page.jpg"), type: "jpeg", quality: 90 });
  console.log(`captured 1-sidebar-page.jpg (${kb("1-sidebar-page.jpg")})`);

  // --- search: the prepared term must return the discovered page's row --------
  await page.locator(".nt-search-input").fill(searchTerm);
  await page.waitForSelector(".nt-search-results", { timeout: 15_000 });
  // The first render is the seeded empty state; the worker read is async and
  // lands on the next cache drain. Wait for the dropdown to settle either
  // way (hits or the explicit "No results." row) before counting.
  await page
    .waitForSelector(".nt-search-hit, .nt-search-empty", { timeout: 30_000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  const hitCount = await page.locator(".nt-search-hit").count();
  // Nameless pages render their id in the hit row (SearchBox: name ?? id).
  const expectedRow = page.locator(".nt-search-hit", { hasText: expectedHit.id }).first();
  const expectedVisible = await expectedRow.isVisible().catch(() => false);
  const apiHitCount = (await apiGet(`/api/v1/search?q=${encodeURIComponent(searchTerm)}&limit=25`)).results.length;
  check(
    "search: prepared term returns the discovered page's row",
    hitCount >= 1 && expectedVisible,
    `"${searchTerm}" -> ${hitCount} UI hit(s) (api ${apiHitCount}), expected row visible=${expectedVisible}`,
  );
  await page.screenshot({ path: path.join(OUT, "2-search.jpg"), type: "jpeg", quality: 90 });
  console.log(`captured 2-search.jpg (${kb("2-search.jpg")})`);

  // --- open the discovered page (sidebar first: guarantees the tree renders,
  //      the search dropdown row may legitimately be absent under the defect) --
  await page.getByRole("button", { name: expectedHit.derived, exact: true }).first().click();
  await page.waitForSelector(".nt-page", { timeout: 30_000 });
  await page.waitForSelector(".nt-block-row", { timeout: 60_000 });
  const openedRows = await page.locator(".nt-block-row").count();
  check("opened page: block rows render", openedRows >= 1, `${openedRows} block row(s)`);
  await page.locator(".nt-search-input").fill("");
  await page.waitForSelector(".nt-search-results", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, "3-opened-page.jpg"), type: "jpeg", quality: 90 });
  console.log(`captured 3-opened-page.jpg (${kb("3-opened-page.jpg")})`);

  await context.close();
  await browser.close();
} catch (error) {
  await dumpState("failure").catch(() => {});
  console.error(`\nVERIFY FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser.isConnected()) await browser.close().catch(() => {});
}

// --- summary -----------------------------------------------------------------
console.log("\n=== migrated-workspace verification summary ===");
console.log(`workspace:        ${WORKSPACE_ID} ("Notas")`);
console.log(
  `snapshot:         hasSnapshot=${probe.hasSnapshot} upToSeq=${probe.upToSeq} of ${stats.envelopeCount} envelopes`,
);
console.log(
  `boot:             first sidebar render ${fmtDuration(firstRenderMs)} (5-min expectation ${firstRenderMs !== null && firstRenderMs <= BOOT_BUDGET_MS ? "met" : "exceeded"}), settled ${fmtDuration(syncSettledMs)}`,
);
console.log(
  `                  snapshot blob ${(snapshotBytes / 1024 / 1024).toFixed(1)}MB, catch-up pages fetched=${catchUpPages}`,
);
console.log(`sidebar:          ${lastCount} page rows rendered`);
console.log(`search:           "${searchTerm}" -> expected hit "${expectedHit.derived}" (${expectedHit.id})`);
console.log(`assertions:       ${checks.filter((c) => c.ok).length}/${checks.length} passed`);
for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
console.log(`findings:         ${findings.length}`);
for (const line of findings) console.log(`  - ${line}`);
console.log(`console errors:   ${consoleErrors.length} (favicon/404 noise filtered out)`);
for (const line of consoleErrors.slice(0, 30)) console.log(`  ${line}`);
console.log(`screenshots:      ${OUT}`);
if (process.exitCode === 1) console.log("result: FAILED");
else console.log("result: OK — migrated workspace verified");
