// Screenshot capture for the Notees v2 web client against throwaway local
// containers (see run.sh). Captures every screen in both color schemes into
// OUT_DIR/<scheme>/*.jpg (JPEG keeps the committed artifacts small;
// deviceScaleFactor 2 for retina crispness). The app is light-only today, so
// the dark pass mirrors the light one — the scheme split is forward-looking,
// same convention as the sonarly sibling.
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:8480").replace(/\/$/, "");
const API = (process.env.API_URL ?? "http://127.0.0.1:8477").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error("API_KEY env var required");
const OUT = process.env.OUT_DIR ?? new URL("../../docs/img/screenshots/", import.meta.url).pathname;
const SCHEMES = (process.env.SCHEMES ?? "light,dark").split(",");
mkdirSync(OUT, { recursive: true });

// App.tsx STORAGE_KEYS — the bootstrap form persists these on connect, so
// pre-seeding localStorage pre-fills the form (serverUrl/apiKey/workspaceId).
const STORAGE_KEYS = { serverUrl: "notees.serverUrl", apiKey: "notees.apiKey", workspaceId: "notees.workspaceId" };

/** The server's stable default workspace id (apps/server/src/identity.ts). */
function deriveUuid(input) {
  const digest = createHash("sha256").update(input).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const WORKSPACE_ID = deriveUuid("notees:workspace:default");

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"],
});

// --- pre-auth: the bootstrap/connect form (fresh context, no localStorage) ---
for (const scheme of SCHEMES) {
  const dir = path.join(OUT, scheme);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".nt-bootstrap-form", { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(dir, "bootstrap.jpg"), type: "jpeg", quality: 90 });
  console.log(`captured ${scheme}/bootstrap.jpg`);
  await context.close();
}

// --- authenticated screens: one pass per color scheme ------------------------
for (const scheme of SCHEMES) {
  const dir = path.join(OUT, scheme);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  // The m1 web image has two bootstrap quirks the shim works around (app code
  // untouched): (1) HttpTransport captures the global fetch unbound
  // (packages/sync/src/transport.ts) so the Worker path dies with "Illegal
  // invocation" — binding fetch here fixes both modes; (2) OPFS detection is
  // then neutralized to force the in-process client, which works against the
  // live server in this build.
  await context.addInitScript(() => {
    const bound = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", { value: bound, writable: true, configurable: true });
    Object.defineProperty(StorageManager.prototype, "getDirectory", { value: undefined });
  });
  await context.addInitScript(
    ({ keys, serverUrl, apiKey, workspaceId }) => {
      localStorage.setItem(keys.serverUrl, serverUrl);
      localStorage.setItem(keys.apiKey, apiKey);
      localStorage.setItem(keys.workspaceId, workspaceId);
    },
    { keys: STORAGE_KEYS, serverUrl: API, apiKey: API_KEY, workspaceId: WORKSPACE_ID },
  );
  const page = await context.newPage();
  const kb = (f) => `${(statSync(path.join(dir, f)).size / 1024).toFixed(0)} KB`;

  async function settle(extra = 700) {
    await page.waitForTimeout(extra);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.mouse.move(2, 2);
  }

  async function shot(file) {
    await page.addStyleTag({ content: "::-webkit-scrollbar { display: none; }" }).catch(() => {});
    await settle();
    await page.screenshot({ path: path.join(dir, file), type: "jpeg", quality: 90 });
    console.log(`captured ${scheme}/${file} (${kb(file)})`);
  }

  /** Main-document scroll persists across page switches and click auto-scroll. */
  async function scrollMainTo(top) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
  }

  // Connect via the (pre-filled) bootstrap form.
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".nt-bootstrap-form", { timeout: 30_000 });
  await page.getByRole("button", { name: "Connect" }).click();
  // Worker-client boot pulls the whole workspace before "ready" renders; the
  // page list with seeded titles is the practical sync barrier.
  await page.waitForSelector(".nt-app", { timeout: 60_000 });
  await page.waitForSelector('.nt-page-item:has-text("Reading list")', { timeout: 60_000 });

  // 2. Sidebar page list + the meeting note (marks, mention chip, typed link).
  await page.locator('.nt-page-item:has-text("Weekly sync")').click();
  await page.waitForSelector('text=Reading group discusses', { timeout: 15_000 });
  await shot("workspace.jpg");

  // 6. DSL query in the SearchBox, results dropdown open.
  await page.locator(".nt-search-input").fill("class:source");
  await page.waitForSelector(".nt-search-results .nt-search-hit", { timeout: 15_000 });
  await shot("search.jpg");
  // Clear the box so the dropdown does not bleed into the next screens.
  await page.locator(".nt-search-input").fill("");
  await page.waitForSelector(".nt-search-results", { state: "detached", timeout: 15_000 }).catch(() => {});

  // 3. The source page: properties panel (authors/citekey/attachment chips).
  await page.locator('.nt-page-item:has-text("The Structure of Scientific Revolutions")').click();
  await page.waitForSelector('text=citekey', { timeout: 15_000 });
  await page.waitForSelector(".nt-chip", { timeout: 15_000 });
  await scrollMainTo(0);
  await shot("source.jpg");

  // 8. Person page with the "Linked references" section expanded (the book's
  // authors property edge points here).
  await page.locator('.nt-page-item:has-text("Thomas S. Kuhn")').click();
  await page.waitForSelector(".nt-properties-panel", { timeout: 15_000 });
  await page.getByRole("button", { name: /^Linked references/ }).click();
  await page.waitForSelector('.nt-section-item:has-text("Structure of Scientific Revolutions")', { timeout: 15_000 });
  await page.getByRole("button", { name: /^Linked references/ }).scrollIntoViewIfNeeded();
  await shot("linked-references.jpg");

  // 4. Class View of `source`: property bindings + expanded classed nodes.
  await page.locator('.nt-page-item:has-text("source")').click();
  await page.waitForSelector("text=Property bindings", { timeout: 15_000 });
  await page.locator('.nt-section-header:has-text("Classed nodes")').click();
  await page.waitForSelector(".nt-class-member", { timeout: 15_000 });
  await scrollMainTo(0);
  await shot("class-view.jpg");

  // 5. Whiteboard: canvas with three cards, shapes, and a stroke.
  await page.locator('.nt-page-item:has-text("Research whiteboard")').click();
  await page.waitForSelector('text=Paradigm shift', { timeout: 15_000 });
  await scrollMainTo(0);
  await shot("whiteboard.jpg");

  // 7. Live query blocks: list of sources + aggregate grid by node type.
  await page.locator('.nt-page-item:has-text("Reading list")').click();
  await page.waitForSelector(".nt-query-list", { timeout: 15_000 });
  await page.waitForSelector(".nt-query-table", { timeout: 15_000 });
  await scrollMainTo(0);
  await shot("query-block.jpg");

  await context.close();
}

await browser.close();
console.log("done ->", OUT);
