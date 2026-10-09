// Probe template — the copy-paste starting point for UI diagnosis against the
// LOCAL live stack (notees-sync :8377 + notees-web :8378). See
// docs/developers/ui-debugging.md for the workflow, the rules, and the
// gotchas. Copy this file to a scratch name, edit the STEPS section, run it
// from THIS directory (playwright is a dependency of scripts/screenshots
// only — `node <file>.mjs` from anywhere else cannot resolve it), delete it
// when done. Probes are diagnostic tools; only this template is durable.
//
// Auth: the bootstrap localStorage pre-seed only PRE-FILLS the connect form
// in the current build — drive the login flow (boot-probe.mjs idiom) like
// below. The operator API key (config/notees/sync/api_key.txt) is for the
// object-API calls a probe may need (fixtures, lookups), not for the UI
// login, which is the owner's email/password (the gitignored probe scripts
// carry it; never commit credentials).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const KEY = readFileSync(
  new URL("../../config/notees/sync/api_key.txt", import.meta.url),
  "utf8",
).trim();

// App.tsx STORAGE_KEYS — the bootstrap form pre-fills from these.
const STORAGE_KEYS = {
  serverUrl: "notees.serverUrl",
  apiKey: "notees.apiKey",
  workspaceId: "notees.workspaceId",
};

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await context.addInitScript(
  ({ keys, api, theme }) => {
    localStorage.setItem(keys.serverUrl, api);
    if (theme) localStorage.setItem("notees.theme", theme); // "dark" | "light"
  },
  { keys: STORAGE_KEYS, api: API, theme: "dark" },
);
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE-ERR", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("PAGE-ERR", String(e).slice(0, 200)));

await page.goto(WEB, { waitUntil: "commit", timeout: 60_000 });

// ─── sign in (boot-probe.mjs idiom) ───────────────────────────────────────
await page.getByRole("textbox", { name: /server url/i }).waitFor({ timeout: 30_000 });
await page.getByRole("button", { name: /^continue$/i }).click();
await page.getByRole("textbox", { name: /email/i }).waitFor({ timeout: 15_000 });
// await page.getByRole("textbox", { name: /email/i }).fill(<owner email>);
// await page.getByRole("textbox", { name: /password/i }).fill(<owner password>);
// await page.getByRole("button", { name: /^sign in$/i }).click();
// The workspace picker heading is "Your workspaces". Click the target card:
// await page.getByText(/Your workspaces/i).waitFor({ timeout: 30_000 });
// await page.getByRole("button", { name: /Notas/ }).first().click();

// ─── STEPS: edit from here ────────────────────────────────────────────────
// await page.waitForTimeout(12_000); // snapshot restore + sync settle — don't skimp

// Screenshot whatever surface you need:
// await page.screenshot({ path: "/tmp/probe.jpg", type: "jpeg", quality: 90 });

// Dump computed styles when a color/size looks wrong (this is how the kit
// SelectTrigger's missing background reset was found):
// const info = await page.evaluate(() => {
//   const el = document.querySelector(".some-selector");
//   if (!el) return "not found";
//   const cs = getComputedStyle(el);
//   return { background: cs.backgroundColor, width: cs.width, className: el.className };
// });
// console.log(JSON.stringify(info, null, 2));
// ─── end STEPS ────────────────────────────────────────────────────────────

await browser.close();
console.log("probe done");
