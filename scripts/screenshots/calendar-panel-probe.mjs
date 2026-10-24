// One-off verification probe (2026-10-23; the time-grid + agenda pass
// 2026-10-24; the URL-addressable routing pass 2026-10-24): the calendar
// events element — the quick-create pills row is gone, the calendar renders
// the Day/Week time grid, the Month/Year grids, or the Agenda column per
// the zoom, and the ladder reads five options. Routing: opening the
// calendar claims /calendar/<zoom>/<day>, and a deep link boots straight
// into the zoom + day in the path.
// TEST workspace only; screenshots land in /tmp.
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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
// The auth seed rides the CONTEXT: the deep-link pass below opens a second
// page in this context and boots authenticated the same way.
await context.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, SESSION, WS]);
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (err) => consoleErrors.push(String(err)));
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
      ladder: [...document.querySelectorAll(".calendar-view__ladder button")].map((b) => b.getAttribute("aria-label")),
      monthChecked: document.querySelector('.calendar-view__ladder .selection-button__option--selected')?.getAttribute("aria-label"),
    };
  });

  // Routing pass (owner 2026-10-24 — the calendar is URL-addressable): the
  // bare sidebar entry CLAIMS the URL — /calendar/<zoom>/<day>, the zoom in
  // the path — and the tab title names the surface + the visible period.
  result.route = await page.evaluate(() => ({
    pathname: window.location.pathname,
    title: document.title,
  }));
  await page.screenshot({ path: join(OUT, "calendar-events.png") });

  // Deep-link pass: a fresh page in the SAME context boots straight into
  // /calendar/week/2026-10-20 — the week zoom renders and the selected day
  // is the 20th.
  const deepPage = await context.newPage();
  await deepPage.goto(new URL("/calendar/week/2026-10-20", WEB).toString(), {
    waitUntil: "commit",
    timeout: 120_000,
  });
  await deepPage.waitForSelector(".cal-timegrid", { timeout: 600_000 });
  result.deepLink = await deepPage.evaluate(() => ({
    pathname: window.location.pathname,
    weekColumns: document.querySelectorAll(".cal-timegrid__day").length,
    selectedDay:
      document.querySelector(".cal-timegrid__day--selected")?.getAttribute("data-day") ?? null,
    title: document.title,
  }));
  await deepPage.close();

// Day-zoom pass: the TimeGrid renders its own root (.cal-timegrid), the
// 24h grid always there (owner 2026-10-24, the Google time-grid register).
await page.locator(".calendar-view__ladder").getByRole("radio", { name: "Day", exact: true }).first().click();
await page.waitForSelector(".cal-timegrid", { timeout: 60_000 });
result.dayZoom = await page.evaluate(() => {
  const grid = document.querySelector(".cal-timegrid");
  return {
    rootPresent: grid !== null,
    hourCells: grid?.querySelectorAll(".cal-timegrid__hour").length ?? 0,
    nowLine: grid?.querySelector(".cal-timegrid__now") !== null,
  };
});
await page.screenshot({ path: join(OUT, "calendar-day-timegrid.png") });

// Week-zoom pass: seven day columns in one time grid.
await page.locator(".calendar-view__ladder").getByRole("radio", { name: "Week", exact: true }).first().click();
await page.waitForSelector(".cal-timegrid", { timeout: 60_000 });
result.weekZoom = await page.evaluate(() => ({
  dayColumns: document.querySelectorAll(".cal-timegrid__day").length,
}));
await page.screenshot({ path: join(OUT, "calendar-week-timegrid.png") });

// Agenda pass: the days-with-events column renders its own root
// (.cal-agenda).
await page.locator(".calendar-view__ladder").getByRole("radio", { name: "Agenda", exact: true }).first().click();
await page.waitForSelector(".cal-agenda", { timeout: 60_000 });
result.agendaZoom = await page.evaluate(() => {
  const agenda = document.querySelector(".cal-agenda");
  return {
    rootPresent: agenda !== null,
    empty: agenda?.textContent?.includes("No events.") ?? false,
    nowLine: agenda?.querySelector(".cal-agenda__now") !== null,
  };
});
await page.screenshot({ path: join(OUT, "calendar-agenda.png") });

// Back to the month grid for the journal/day-page passes below.
await page.locator(".calendar-view__ladder").getByRole("radio", { name: "Month", exact: true }).first().click();
await page.waitForSelector(".cal-grid", { timeout: 60_000 });

// Journal pass: no horizontal scroll (the flex min-width trap — the
// feed and the body row must shrink below intrinsic content width).
await page.locator(".nt-sidebar-nav .nt-side-row", { hasText: "Journal" }).first().click();
await page.waitForSelector(".journals-view", { timeout: 60_000 });
const journalOverflow = await page.evaluate(() => {
  const view = document.querySelector(".journals-view");
  const offenders = [];
  document.querySelectorAll(".journals-view *").forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1) {
      offenders.push({
        cls: (el.getAttribute("class") || el.tagName).slice(0, 60),
        sw: el.scrollWidth,
        cw: el.clientWidth,
      });
    }
  });
  return {
    scrollWidth: view.scrollWidth,
    clientWidth: view.clientWidth,
    offenders: offenders.slice(0, 8),
  };
});
result.journalNoHScroll = journalOverflow.scrollWidth <= journalOverflow.clientWidth;
result.journalOverflow = journalOverflow;

// Day-page pass: the stepper rides the main top bar's right cluster
// (chevrons around the bordered Today); Next materializes + opens the
// following day.
await page.locator(".nt-sidebar-nav .nt-side-row", { hasText: "Today" }).first().click();
await page.waitForSelector(".day-page-header", { timeout: 60_000 });
result.dayStepper = await page.evaluate(() => {
  const stepper = document.querySelector(".day-stepper");
  return {
    present: stepper !== null,
    inSurfaceTopBar: stepper?.closest(".surface-topbar") !== null && stepper?.closest(".surface-topbar") !== undefined,
    buttons: stepper ? [...stepper.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")) : [],
  };
});
const titleBefore = await page.locator(".day-page-header__title").first().textContent();
await page.getByRole("button", { name: "Next day" }).click();
await page.waitForTimeout(1500);
const titleAfter = await page.locator(".day-page-header__title").first().textContent();
result.dayStepAdvances = titleAfter !== titleBefore;
result.dayTitles = { before: titleBefore, after: titleAfter };

console.log(JSON.stringify({ ...result, consoleErrors }, null, 2));
await browser.close();

const pass =
    result.gridPresent === true &&
    result.sidePanelGone === true &&
    result.periodNavPresent === true &&
    result.monthTitleButton === true &&
    result.yearTitleButton === true &&
    result.ladder.join(",") === "Day,Week,Month,Year,Agenda" &&
    result.monthChecked === "Month" &&
    typeof result.route?.pathname === "string" &&
    result.route.pathname.startsWith("/calendar/month/") &&
    typeof result.route.title === "string" &&
    result.route.title.endsWith("— Calendar") &&
    result.deepLink?.pathname === "/calendar/week/2026-10-20" &&
    result.deepLink?.weekColumns === 7 &&
    result.deepLink?.selectedDay === "2026-10-20" &&
    result.deepLink?.title.endsWith("— Calendar") &&
    result.dayZoom?.rootPresent === true &&
    result.dayZoom?.hourCells === 24 &&
    result.weekZoom?.dayColumns === 7 &&
    result.agendaZoom?.rootPresent === true &&
    result.journalNoHScroll === true &&
    result.dayStepper?.present === true &&
    result.dayStepper?.inSurfaceTopBar === true &&
    result.dayStepAdvances === true &&
    consoleErrors.length === 0;
console.log(pass ? "CALENDAR-PANEL-PROBE-PASS" : "CALENDAR-PANEL-PROBE-FAIL");
process.exit(pass ? 0 : 1);
