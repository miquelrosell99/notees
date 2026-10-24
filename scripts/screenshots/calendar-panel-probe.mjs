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
await page.waitForSelector(".calendar-view__panel .month-calendar", { timeout: 60_000 });

const result = await page.evaluate(() => {
    const panel = document.querySelector(".calendar-view__panel");
    return {
      // The grid IS the agenda (owner 2026-10-24): the right panel carries
      // the mini-month navigator only — no events element.
      gridPresent: document.querySelector(".cal-grid") !== null,
      miniMonthPresent: panel?.querySelector(".month-calendar") !== null,
      eventsElementGone: panel?.querySelector('.calendar-view__agenda') === null,
      ladder: [...document.querySelectorAll(".calendar-view__ladder button")].map((b) => b.textContent?.trim()),
      monthPressed: document.querySelector('.calendar-view__ladder button[aria-pressed="true"]')?.textContent?.trim(),
    };
  });
await page.screenshot({ path: join(OUT, "calendar-events.png") });

console.log(JSON.stringify({ ...result, consoleErrors }, null, 2));
await browser.close();

const pass =
    result.gridPresent === true &&
    result.miniMonthPresent === true &&
    result.eventsElementGone === true &&
    result.ladder.join(",") === "Day,Week,Month,Year" &&
    result.monthPressed === "Month" &&
    consoleErrors.length === 0;
console.log(pass ? "CALENDAR-PANEL-PROBE-PASS" : "CALENDAR-PANEL-PROBE-FAIL");
process.exit(pass ? 0 : 1);
