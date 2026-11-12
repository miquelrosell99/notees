// Geometry probe: measure the SearchField adornment insets on the LIVE stack
// (test workspace only — nothing is written to the graph). Reports wrapper
// box, icon box, clear-button box, and the computed padding of the pill.
import { chromium } from "playwright";
const API = "http://localhost:8377", WEB = "http://localhost:8378";
const TEST_WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const KEY = (await import("fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ email: process.env.NOTEES_ADMIN_EMAIL ?? "admin@localhost", password: process.env.NOTEES_ADMIN_PASSWORD }) });
const { token } = await login.json();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url); localStorage.setItem("notees.sessionToken", t); localStorage.setItem("notees.workspaceId", ws);
}, [API, token, TEST_WS]);
await page.goto(WEB, { waitUntil: "commit", timeout: 60000 });
await page.waitForTimeout(20000);

const measure = async (label, selector, typeValue) => {
  const field = page.locator(selector).first();
  if (await field.count() === 0) { console.log(`${label}: NOT FOUND (${selector})`); return; }
  if (typeValue !== undefined) await field.fill(typeValue);
  await page.waitForTimeout(300);
  const m = await field.evaluate((el) => {
    const pill = el.closest(".search-field");
    const icon = pill?.querySelector(".search-field__icon");
    const clear = pill?.querySelector(".search-field__clear");
    const r = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { x: Math.round(b.x * 10) / 10, w: Math.round(b.width * 10) / 10, padL: cs.paddingLeft, padR: cs.paddingRight, gap: cs.columnGap }; };
    return { pill: r(pill), icon: r(icon), clear: r(clear) };
  });
  console.log(label, JSON.stringify(m, null, 1));
};

// 1. The Search page (md pill, has × once typed)
await page.goto(WEB + "/search", { waitUntil: "commit" }).catch(() => {});
await page.waitForTimeout(4000);
await measure("SearchPage-md", 'input[aria-label="Search everything"]', "mariano");

// 2. The Sources hub toolbar (sm pill with ×)
await page.goto(WEB + "/sources", { waitUntil: "commit" }).catch(() => {});
await page.waitForTimeout(4000);
await measure("SourcesToolbar-sm", 'input[aria-label="Search sources"]', "mariano");

// 3. The command palette (borderless md pill, palette has no ×; just the lens)
await page.goto(WEB, { waitUntil: "commit" }).catch(() => {});
await page.waitForTimeout(6000);
await page.keyboard.press("Control+k").catch(() => {});
await page.keyboard.press("Meta+k").catch(() => {});
await page.waitForTimeout(1000);
await measure("CommandPalette-borderless", 'input[aria-label="Command palette search"]');

await browser.close();
