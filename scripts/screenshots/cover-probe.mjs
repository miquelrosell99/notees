// Cover-resolution probe: fresh profile → login → open Bulbasaur → report
// whether the CoverCard renders the image or the placeholder, and why.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const KEY = (await import("node:fs")).readFileSync(
  "/etc/periphery/stacks/notees/config/notees/sync/api_key.txt",
  "utf8",
).trim();

const login = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "miquelroselltarrago@gmail.com",
    password: process.env.NOTEES_ADMIN_PASSWORD ?? "",
  }),
});
if (!login.ok) throw new Error(`login: ${login.status}`);
const { token: SESSION } = await login.json();

mkdirSync("/tmp/cover-probe", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const failures = [];
const allRequests = [];
page.on("request", (r) => allRequests.push(`${r.method()} ${r.url().replace("http://localhost:8377", "").replace("http://localhost:8378", "").slice(0, 70)}`));
page.on("requestfailed", (r) => failures.push(`reqfail ${r.url().slice(-60)} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400) failures.push(`http${r.status()} ${r.url().slice(-70)}`);
});
page.on("console", (m) => m.type() === "error" && failures.push(`console: ${m.text().slice(0, 160)}`));

await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
  // Force in-process mode (no worker/OPFS) for this run.
  try { navigator.storage.getDirectory = undefined; } catch { /* ignore */ }
}, [API, SESSION, WS]);

await page.goto(WEB, { waitUntil: "commit", timeout: 120_000 });
// settle: sidebar + sync idle in the footer
await page.waitForSelector(".nt-sidebar *, [class*=sidebar] *", { timeout: 30_000 }).catch(() => {});
for (let i = 0; i < 30; i += 1) {
  const footer = await page.evaluate(() => document.body.innerText.match(/Sync: [a-z]+/)?.[0] ?? "");
  if (footer.includes("idle")) break;
  await page.waitForTimeout(2000);
}
console.log("footer:", await page.evaluate(() => document.body.innerText.match(/Sync: [a-z]+/)?.[0] ?? "n/a"));

// open Bulbasaur via UI search (the exact "Bulbasaur" hit — not "Bulbasaur artwork")
await page.locator("input").first().fill("Bulbasaur");
await page.waitForTimeout(2500);
await page.getByText("Bulbasaur", { exact: true }).nth(1).click();
await page.waitForTimeout(1500);
// wait for the cover card to resolve (image fetch is async)
let state = null;
for (let i = 0; i < 10; i += 1) {
  await page.waitForTimeout(1500);
  state = await page.evaluate(() => {
    const img = document.querySelector(".nt-covercard__img");
    const ph = document.querySelector(".nt-covercard__placeholder");
    return {
      header: document.querySelector("h1, [class*=title]")?.textContent?.slice(0, 40) ?? null,
      img: img !== null,
      imgSrc: img?.getAttribute("src")?.slice(0, 40) ?? null,
      placeholder: ph !== null,
      hint: document.querySelector(".nt-covercard__placeholder-hint")?.textContent ?? null,
      cardText: document.querySelector(".nt-covercard")?.textContent?.slice(0, 120) ?? null,
    };
  });
  if (state.img || state.placeholder) break;
}
console.log("card state:", JSON.stringify(state, null, 2));

// Sync-traffic forensics: capture batch payload op histograms + catch-up sizes
// (listeners attach BEFORE the bisect below reads the tallies).
const assetRequests = [];
page.on("response", (r) => {
  if (r.url().includes("/api/assets")) assetRequests.push(`${r.status()} ${r.url().replace("http://localhost:8377", "")}`);
});
const batchOps = {};
page.on("request", (req) => {
  if (req.method() === "POST" && req.url().includes("/relay/v2/batch")) {
    req.postDataJSON()?.envelopes?.forEach?.((e) => { batchOps[e.opType] = (batchOps[e.opType] ?? 0) + 1; });
  }
});
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/snapshot/data")) console.log("RESP snapshot/data status:", res.status(), "len:", res.headers()["content-length"] ?? "?");
  if (u.includes("/catch-up")) console.log("RESP catch-up status:", res.status());
  if (u.includes("/api/assets/") && !u.includes("/info")) console.log("RESP assets fetch status:", res.status());
});

// Bisect: set a cover through the app's own flow (picker file input).
try {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles("/tmp/cover-probe/probe.png", { timeout: 5000 });
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({
    img: document.querySelector(".nt-covercard__img") !== null,
    hint: document.querySelector(".nt-covercard__placeholder-hint")?.textContent ?? null,
  }));
  console.log("after UI-set cover:", JSON.stringify(after));
  console.log("/api/assets requests:", assetRequests.length ? assetRequests.slice(0, 8) : "NONE");
  console.log("batch op histogram:", JSON.stringify(batchOps));
} catch (e) {
  console.log("UI cover-set failed:", String(e).slice(0, 140));
}

// Decisive control: the Assets hub (sidebar nav) renders asset thumbnails
// through the SAME assetImageUrl path.
await page.goto(`${WEB}/`, { waitUntil: "commit", timeout: 60_000 });
await page.waitForSelector(".nt-sidebar *, [class*=sidebar] *", { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.getByText("Assets", { exact: true }).first().click().catch((e) => console.log("hub click:", String(e).slice(0, 80)));
await page.waitForTimeout(8000);
const hub = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("img")].filter((i) => (i.getAttribute("src") ?? "").startsWith("data:image"));
  return {
    dataImages: imgs.length,
    assetChips: document.body.innerText.match(/artwork/g)?.length ?? 0,
    bodySnippet: document.body.innerText.slice(0, 300),
  };
});
console.log("assets hub:", JSON.stringify(hub));
console.log("/api/assets requests:", assetRequests.length ? assetRequests.slice(0, 10) : "NONE");
console.log("network/console failures:", failures.length ? failures.slice(0, 12) : "none");
const relayReqs = allRequests.filter((u) => /relay|snapshot|catch-up|api\/assets/.test(u));
console.log("relay/asset requests:", relayReqs.length);
for (const u of relayReqs.slice(0, 25)) console.log("  ", u);

await page.screenshot({ path: "/tmp/cover-probe/assets-hub.png" });
await browser.close();
console.log(state.img ? "COVER-PROBE-PASS" : "COVER-PROBE-FAIL");
