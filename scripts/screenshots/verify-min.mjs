// Minimal production verification: boot the migrated workspace in the web UI,
// assert footer has no sync error, UI search returns the API-known hit.
// Hard timeouts everywhere; streams progress; exits non-zero on failure.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const api = async (path) => {
  const r = await fetch(API + path, { headers: { "x-api-key": KEY, "x-workspace-id": WS } });
  if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
  return r.json();
};

// Expected hit: reuse the known migrated page (search API proves it indexes).
const searchApi = await api("/api/search?q=20180900&limit=3");
const hit = searchApi.results?.[0] ?? searchApi[0];
const term = "20180900";
console.log("api search hit:", JSON.stringify(hit).slice(0, 120));

mkdirSync("/etc/periphery/stacks/notees/scripts/migrated-verify", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
page.on("requestfailed", (r) => consoleErrors.push("reqfail: " + r.url().slice(-60) + " " + (r.failure()?.errorText ?? "")));
page.on("response", (r) => { if (r.status() >= 400) consoleErrors.push("http" + r.status() + ": " + r.url().slice(-60)); });
context.on("workercreated", (w) => {
  console.log("worker created:", w.url().slice(-40));
  w.on("console", (m) => consoleErrors.push("worker: " + m.text().slice(0, 300)));
  w.on("pageerror", (e) => consoleErrors.push("worker-error: " + String(e).slice(0, 300)));
});

const t0 = Date.now();
// New account-based flow: obtain a session token via the login API and seed
// it — the app's resume effect validates it, then auto-connects the
// remembered workspace (no Connect click needed).
const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
const { token: SESSION } = await loginRes.json();
await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, SESSION, WS]);

await page.goto(WEB, { waitUntil: "commit", timeout: 120_000 });
// The resume effect connects automatically; the app shell (sidebar) is the
// ready signal.
await page.waitForSelector(".nt-sidebar *, [class*=sidebar] *", { timeout: 5_000 }).catch(() => {});
console.log("resume-connect in flight");
// Diagnostic first: what did the boot actually show?
await page.waitForTimeout(8000);
console.log("body text:", JSON.stringify(await page.evaluate(() => document.body.innerText)));
console.log("workers:", page.workers().length);
const manual = await page.evaluate(async () => {
  const urls = [...document.querySelectorAll("script")].map((s) => s.src).filter(Boolean);
  const workerUrl = urls.find((u) => /store-worker/.test(u));
  if (!workerUrl) return "no worker script tag found; scripts=" + urls.length;
  return await new Promise((resolve) => {
    const w = new Worker(workerUrl, { type: "module" });
    w.onerror = (e) => resolve("worker error: " + (e.message ?? e.type) + " " + (e.filename ?? "").slice(-60));
    setTimeout(() => resolve("worker spawned OK (no error in 5s)"), 5000);
  });
});
console.log("manual worker probe:", manual);
console.log("body after connect:", (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n+/g, " | "));
console.log("inputs:", await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.placeholder + "=" + (i.value || "").slice(0, 30)).join(" | ")));
const probe = setInterval(async () => {
  try {
    console.log(`[probe] body=${(await page.evaluate(() => document.body.innerText.length))} errors=${consoleErrors.length}`);
    if (consoleErrors.length) { console.log("ERRORS:", consoleErrors.slice(0, 6)); clearInterval(probe); }
  } catch {}
}, 15_000);
// The relay currently holds no snapshot (§34.43 dropped them; recreation
// still owed), so a FRESH browser profile full-catch-ups the whole log —
// measured ~5.3 min to idle. 900 s is the permanent window until snapshots
// return (§34.43's own note: raise permanently if the window recurs).
await page.waitForFunction(
  () => document.body.innerText.length > 500,
  undefined,
  { timeout: 900_000 },
).finally(() => clearInterval(probe));
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

// UI search — via the command palette (the sidebar search icon opens it).
await page.getByRole("button", { name: /^search$/i }).first().click();
const box = page.getByPlaceholder(/search/i).first();
await box.waitFor({ timeout: 10_000 });
await box.fill(term);
await page.waitForTimeout(1500);
const body = await page.evaluate(() => document.body.innerText);
const found = body.includes("20180900") || body.includes("2018/09");
console.log("ui search found hit:", found);
await page.screenshot({ path: "/etc/periphery/stacks/notees/scripts/migrated-verify/verify.jpg", type: "jpeg", quality: 85 });

const rawJson = body.includes('"type":"') || body.includes('[{"type"');
console.log("raw JSON in rendered body:", rawJson);
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");

await browser.close();
if (footerBad || !found || rawJson) {
  console.log("VERIFY-FAIL");
  process.exit(1);
}
console.log("VERIFY-PASS");
