// One-off verification probe (2026-10-23): the calendar events element —
// the quick-create pills row is gone, the events element renders with the
// Day/Week/Month zoom, and empty scopes read the honest line. TEST
// workspace only; screenshots land in /tmp.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stackDir = existsSync("/etc/periphery/stacks/notees") ? "/etc/periphery/stacks/notees" : repoRoot;
const API = process.env.NOTEES_API ?? "http://localhost:8377";
const WEB = process.env.NOTEES_WEB ?? "http://localhost:8378";
const WS = process.env.NOTEES_WORKSPACE ?? "c491595f-9f94-5ade-a620-e30ed063d8d2"; // TEST workspace only
const KEY = readFileSync(join(stackDir, "config/notees/sync/api_key.txt"), "utf8").trim();
const PASSWORD = readFileSync(join(stackDir, "config/notees/.admin_password"), "utf8").trim();
const OUT = "/tmp/events-element-probe";
mkdirSync(OUT, { recursive: true });

const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: PASSWORD }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
const { token: SESSION } = await loginRes.json();

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (err) => consoleErrors.push(String(err)));
await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, SESSION, WS]);
await page.goto(WEB, { waitUntil: "commit", timeout: 120_000 });
await page.waitForSelector(".nt-sidebar-nav", { timeout: 600_000 });

await page.locator(".nt-sidebar-nav .nt-side-row", { hasText: "Calendar" }).first().click();
await page.waitForSelector(".cal-grid", { timeout: 60_000 });

const result = await page.evaluate(() => {
    return {
      // The grid IS the calendar (owner 2026-10-24 pass 2): no side panel
      // at all — the journal owns the navigator + events panel.
      gridPresent: document.querySelector(".cal-grid") !== null,
      sidePanelGone: document.querySelector(".calendar-view__panel") === null,
      // The period navigator rides the top bar, centered: Today, the
      // chevrons, and the clickable panel/popup title buttons.
      periodNavPresent: document.querySelector(".calendar-view__period-nav") !== null,
      monthTitleButton: document.querySelector(
        ".calendar-view__period-nav .calendar-title-btn--month",
      ) !== null,
      yearTitleButton: document.querySelector(
        '.calendar-view__period-nav .calendar-title-btn[title="Open yearly page"]',
      ) !== null,
      ladder: [...document.querySelectorAll(".calendar-view__ladder button")].map((b) => b.textContent?.trim()),
      monthPressed: document.querySelector('.calendar-view__ladder button[aria-pressed="true"]')?.textContent?.trim(),
    };
  });
await page.screenshot({ path: join(OUT, "calendar-events.png") });

// Journal pass: no horizontal scroll (the flex min-width trap — the
// feed and the body row must shrink below intrinsic content width).
await page.locator(".nt-sidebar-nav .nt-side-row", { hasText: "Journal" }).first().click();
await page.waitForSelector(".journals-view", { timeout: 60_000 });
const journalOverflow = await page.evaluate(() => {
  const view = document.querySelector(".journals-view");
  return { scrollWidth: view.scrollWidth, clientWidth: view.clientWidth };
});
result.journalNoHScroll = journalOverflow.scrollWidth <= journalOverflow.clientWidth;
result.journalOverflow = journalOverflow;

console.log(JSON.stringify({ ...result, consoleErrors }, null, 2));
await browser.close();

const pass =
    result.gridPresent === true &&
    result.sidePanelGone === true &&
    result.periodNavPresent === true &&
    result.monthTitleButton === true &&
    result.yearTitleButton === true &&
    result.ladder.join(",") === "Day,Week,Month,Year" &&
    result.monthPressed === "Month" &&
    result.journalNoHScroll === true &&
    consoleErrors.length === 0;
console.log(pass ? "CALENDAR-PANEL-PROBE-PASS" : "CALENDAR-PANEL-PROBE-FAIL");
process.exit(pass ? 0 : 1);
