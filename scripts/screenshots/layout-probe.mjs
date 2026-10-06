import { chromium } from "playwright";
const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
const { token: SESSION } = await loginRes.json();
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, SESSION, WS]);
await page.goto(WEB, { waitUntil: "commit", timeout: 120_000 });
await page.waitForFunction(() => document.body.innerText.length > 500, undefined, { timeout: 900_000 });
// Let the background catch-up settle so pages/properties render fully.
await page.waitForTimeout(12000);
console.log("booted");

// 1. Today via the sidebar entry (owner: Today row before Journal).
await page.getByRole("button", { name: /^today$/i }).first().click();
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/v-day.jpg", type: "jpeg", quality: 85 });
console.log("day header:", await page.evaluate(() => {
  const h = document.querySelector(".day-page-header");
  return h ? h.textContent.replace(/\s+/g, " ").slice(0, 120) : "(none)";
}));

// 2. A regular page with properties (Bulbasaur from the recents list).
await page.goto(WEB + "/");
await page.waitForTimeout(4000);
const bulba = page.getByRole("button", { name: /Bulbasaur/i }).first();
await bulba.click();
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/v-page.jpg", type: "jpeg", quality: 85 });
console.log("panel:", await page.evaluate(() => document.querySelector(".nt-page-side-panel") !== null));
console.log("node topbar:", await page.evaluate(() => document.querySelector(".nt-node-topbar") !== null));
console.log("topbar switcher:", await page.evaluate(() => document.querySelector(".nt-node-topbar__right .view-toolbar") !== null));

// 3. Collapse the sidebar → top bar selector + New/Search buttons.
await page.getByRole("button", { name: /hide sidebar/i }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/v-collapsed.jpg", type: "jpeg", quality: 85 });
console.log("collapsed topbar buttons:", await page.evaluate(() =>
  [...document.querySelectorAll(".nt-topbar-left button")].map((b) => b.getAttribute("aria-label")).join(" | ")));
await browser.close();
