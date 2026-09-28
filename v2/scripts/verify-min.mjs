// Minimal production verification: boot the migrated workspace in the web UI,
// assert footer has no sync error, UI search returns the API-known hit.
// Hard timeouts everywhere; streams progress; exits non-zero on failure.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:8080";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const api = async (path) => {
  const r = await fetch(API + path, { headers: { "x-api-key": KEY, "x-workspace-id": WS } });
  if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
  return r.json();
};

// Expected hit: reuse the known migrated page (search API proves it indexes).
const searchApi = await api("/api/v1/search?q=20180900&limit=3");
const hit = searchApi.results?.[0] ?? searchApi[0];
const term = "20180900";
console.log("api search hit:", JSON.stringify(hit).slice(0, 120));

mkdirSync("/etc/periphery/stacks/notees/v2/scripts/migrated-verify", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));

const t0 = Date.now();
await page.addInitScript(([url, key, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.apiKey", key);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, KEY, WS]);

await page.goto(WEB, { waitUntil: "domcontentloaded", timeout: 30_000 });
// Connect button (bootstrap prefilled from localStorage).
const connect = page.getByRole("button", { name: /connect/i });
if (await connect.count() > 0) await connect.first().click();

// Wait for the sidebar to render rows (snapshot restore + settle).
await page.waitForSelector("[class*=sidebar] *, .nt-sidebar *", { timeout: 5_000 }).catch(() => {});
await page.waitForFunction(
  () => document.body.innerText.length > 500,
  { timeout: 240_000 },
);
const bootSecs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`boot+settle: ${bootSecs}s; body text length: ${(await page.evaluate(() => document.body.innerText.length))}`);

// Footer: no sync error.
const footerText = await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((e) => /sync/i.test(e.className) && e.children.length < 6);
  return el ? el.textContent : "(no footer found)";
});
console.log("footer:", footerText.slice(0, 120));
const footerBad = /sync error|illegal invocation/i.test(footerText);
console.log("footer clean:", !footerBad);

// UI search.
const box = page.getByPlaceholder(/search/i).first();
if (await box.count() === 0) {
  console.log("SEARCH-BOX-NOT-FOUND (list available inputs below)");
  console.log(await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.placeholder).join(" | ")));
  throw new Error("no search input");
}
await box.fill(term);
await page.waitForTimeout(4000);
const body = await page.evaluate(() => document.body.innerText);
const found = body.includes("20180900");
console.log("ui search found hit:", found);
await page.screenshot({ path: "/etc/periphery/stacks/notees/v2/scripts/migrated-verify/verify.jpg", type: "jpeg", quality: 85 });

const rawJson = body.includes('"type":"') || body.includes('[{"type"');
console.log("raw JSON in rendered body:", rawJson);
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");

await browser.close();
if (footerBad || !found || rawJson) {
  console.log("VERIFY-FAIL");
  process.exit(1);
}
console.log("VERIFY-PASS");
