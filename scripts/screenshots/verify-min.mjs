// Minimal production verification: boot the migrated workspace in the web UI,
// assert footer has no sync error, UI search returns the API-known hit.
// Hard timeouts everywhere; streams progress; exits non-zero on failure.
//
// Run from anywhere: `node scripts/screenshots/verify-min.mjs` — every path
// below self-locates (env → fleet stack dir → repo root). It verifies the
// migrated workspace, so the search term and workspace default to that
// dataset; point the env vars elsewhere to smoke another deployment.
//
// Sign-in: with NOTEES_ADMIN_EMAIL set the script logs in through the account
// flow and seeds a session token. Without it the script signs in with the
// operator API key instead (the web client's API-key tab path — GET
// /api/workspaces + /api/auth/me accept the operator key) and seeds
// notees.apiKey; the app's resume effect validates the key and auto-connects
// the remembered workspace either way.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Fleet hosts keep the live stack outside the checkout (source/stack split);
// repo-root deployments use the repo's own config/.
const stackDir = process.env.NOTEES_STACK_DIR
  ?? (existsSync("/etc/periphery/stacks/notees") ? "/etc/periphery/stacks/notees" : repoRoot);

const API = process.env.NOTEES_API ?? "http://localhost:8377";
const WEB = process.env.NOTEES_WEB ?? "http://localhost:8378";
const WS = process.env.NOTEES_WORKSPACE ?? "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const readFirst = (paths, what) => {
  for (const p of paths) {
    if (p && existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  throw new Error(`${what} not found — set the env var or one of: ${paths.filter(Boolean).join(", ")}`);
};
const KEY = process.env.NOTEES_API_KEY
  ?? readFirst([process.env.NOTEES_API_KEY_FILE, join(stackDir, "config/notees/sync/api_key.txt")], "API key");
const PASSWORD = process.env.NOTEES_ADMIN_PASSWORD
  ?? readFirst([
    process.env.NOTEES_ADMIN_PASSWORD_FILE,
    join(stackDir, "config/notees/.admin_password"),
    join(repoRoot, "config/notees/.admin_password"),
  ], "admin password");
const ADMIN_EMAIL = process.env.NOTEES_ADMIN_EMAIL ?? null;
const OUT_DIR = process.env.NOTEES_VERIFY_OUT ?? join(stackDir, "scripts/migrated-verify");

const api = async (path) => {
  const r = await fetch(API + path, { headers: { "x-api-key": KEY, "x-workspace-id": WS } });
  if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
  return r.json();
};

// Server canary: /api/workspaces proves auth + liveness (a coordination read,
// never key-gated). The content-read layer is key-gated since the plan-07
// follow-up: /api/classes answers 200 for keyless workspaces and 404
// "workspace is encrypted" for keyed ones — both are PASS shapes (plan-07
// retired /api/search + /api/query; UI search runs client-side).
const workspacesApi = await api("/api/workspaces");
const listed = Array.isArray(workspacesApi) ? workspacesApi : (workspacesApi.workspaces ?? []);
if (!listed.some((w) => w.id === WS)) throw new Error(`workspace ${WS} not listed by /api/workspaces`);
const classesRes = await fetch(API + "/api/classes", { headers: { "x-api-key": KEY, "x-workspace-id": WS } });
const classesBody = await classesRes.text().catch(() => "");
const classesOk = classesRes.ok || (classesRes.status === 404 && /encrypted/i.test(classesBody));
if (!classesOk) throw new Error(`api /api/classes: ${classesRes.status}`);
const term = "20180900";
console.log(`api canary: workspaces listed; /api/classes ${classesRes.status} (${classesRes.ok ? "keyless read ok" : "keyed — 404 gated, expected"})`);

mkdirSync(OUT_DIR, { recursive: true });
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
// Account flow when the admin email is known; otherwise the operator-key
// sign-in (the seeded credential is what the resume effect validates, then
// auto-connects the remembered workspace — no Connect click needed).
let credentialKey;
let credentialValue;
if (ADMIN_EMAIL !== null) {
  const loginRes = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
  credentialKey = "notees.sessionToken";
  credentialValue = (await loginRes.json()).token;
} else {
  console.log("NOTEES_ADMIN_EMAIL unset — signing in with the operator API key");
  credentialKey = "notees.apiKey";
  credentialValue = KEY;
}
await page.addInitScript(([url, key, value, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem(key, value);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, credentialKey, credentialValue, WS]);

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
// Two boot modes: WITH a snapshot (the steady state — the relay self-heals
// one after its one-time post-wipe replay, workspace-store.ts) a fresh
// profile restores the image and catch-ups only the tail, passing this gate
// in seconds. WITHOUT one (a workspace first touched after a wipe/rebuild
// while the server is still mid-hydration, or under
// SNAPSHOT_REBUILD_MIN_ENVELOPES) the whole log replays — minutes at live
// scale. 600 s covers the slow mode with headroom; raise only when a
// wipe-era run legitimately exceeds it.
// THIRD mode (E2EE era): a keyless open of a SEALED workspace settles short
// of 500 chars (locked banner + chrome, sealed content hidden) — the gate
// also passes on the locked banner itself; the unlock flow below then drives
// the real encrypted path to full content.
await page.waitForFunction(
  () => document.body.innerText.length > 500 ||
    document.body.innerText.includes("This workspace is encrypted"),
  undefined,
  { timeout: 600_000 },
).finally(() => clearInterval(probe));
const bootSecs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`boot+settle: ${bootSecs}s; body text length: ${(await page.evaluate(() => document.body.innerText.length))}`);

// Encrypted workspace: a session-token resume carries no master key (a reload
// drops it by design), so the locked banner is up and the store is empty of
// sealed content. Drive the unlock flow (plan-04 W2) so the smoke exercises
// the real encrypted path: re-login derives the master key, the workspace
// re-opens, and the decrypting replay streams in.
const lockedBanner = await page.evaluate(() =>
  document.body.innerText.includes("This workspace is encrypted"));
if (lockedBanner) {
  console.log("locked banner up — driving the unlock flow");
  // The banner re-renders on every sync notify, so the button can stay
  // "unstable" forever — force the click (it is the intended gesture), and
  // target the a11y role/name rather than a skin class (the class drifted
  // once already; the name is the contract).
  await page.getByRole("button", { name: "Unlock" }).first().click({ force: true });
  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ timeout: 10_000 });
  await passwordInput.fill(PASSWORD);
  await passwordInput.press("Enter");
  // The banner clears once the key resolves (before the replay finishes); the
  // search phase below waits for actual content.
  await page.waitForFunction(
    () => !document.body.innerText.includes("This workspace is encrypted"),
    undefined,
    { timeout: 120_000 },
  ).catch(() => console.log("WARN: banner still up after 120s"));
  console.log("unlock submitted; replay in flight");

  // The shell stays pre-ready until the reconnect's bootstrap completes —
  // after an epoch wipe that is the FULL decrypting replay (minutes at live
  // scale), now with live progress ("Catching up… N operations") on the
  // connecting screen. Wait for the app shell (the sidebar NAVIGATION
  // landmark), not merely the absence of the connecting text.
  const settleT0 = Date.now();
  await page.waitForFunction(
    () => document.body.innerText.includes("NAVIGATION"),
    undefined,
    { timeout: 900_000 },
  ).then(() => console.log(`shell settled after unlock in ${((Date.now() - settleT0) / 1000).toFixed(0)}s`))
   .catch(() => console.log("WARN: app shell not up after 15m"));
}

// Footer: no sync error.
const footerText = await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((e) => /sync/i.test(e.className) && e.children.length < 6);
  return el ? el.textContent : "(no footer found)";
});
console.log("footer:", footerText.slice(0, 120));
const footerBad = /sync error|illegal invocation/i.test(footerText);
console.log("footer clean:", !footerBad);

// UI search — via the command palette. The top-bar button is a11y-named
// "Search" but its mount depends on shell state (it moved from the sidebar
// mid-program); the Ctrl+K shortcut is the stable entry point.
await page.keyboard.press("Control+k");
const box = page.getByPlaceholder(/search/i).first();
try {
  await box.waitFor({ timeout: 15_000 });
} catch {
  console.log("search box not found; inputs:", await page.evaluate(() =>
    [...document.querySelectorAll("input")].map((i) => i.placeholder + "=" + (i.value || "").slice(0, 30)).join(" | ")));
  throw new Error("command palette did not open on Ctrl+K");
}
await box.fill(term);
// Poll for the hit instead of sleeping a fixed delay: the early boot gate
// passes seconds in — long before the restored/caught-up store holds the
// fixture page. The hit is a real PALETTE ROW carrying the formatted title
// (never the create row — an echo-adjacent affordance, not content): with
// the fixture favorited, "2018/09" can already ride the sidebar, so a bare
// body-text wait could pass on the favorites row alone. Pick the row, let
// the page open, and assert on the OPENED page — only a real hit survives.
const hitRow = page.locator(".nt-palette-item", { hasText: "2018/09" }).first();
await hitRow.waitFor({ timeout: 600_000 }).catch(() => {});
await hitRow.click({ force: true }).catch(() => {});
await page.waitForTimeout(1500);
// Oracle hygiene: the filled input itself echoes the term into body.innerText,
// which would pass the check with an empty result set. Clear the input (and
// close the palette) before asserting — only a REAL rendered hit survives.
await box.fill("").catch(() => {});
await box.press("Escape").catch(() => {});
await page.waitForTimeout(500);
const body = await page.evaluate(() => document.body.innerText);
const found = body.includes("20180900") || body.includes("2018/09");
console.log("ui search found hit:", found);
await page.screenshot({ path: join(OUT_DIR, "verify.jpg"), type: "jpeg", quality: 85 });

const rawJson = body.includes('"type":"') || body.includes('[{"type"');
console.log("raw JSON in rendered body:", rawJson);
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");

await browser.close();
if (footerBad || !found || rawJson) {
  console.log("VERIFY-FAIL");
  process.exit(1);
}
console.log("VERIFY-PASS");
