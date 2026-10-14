// Sidebar-height probe: which right sidebar "adapts to the amount of cards"?
// Boots ONE offline session, creates three real pages, opens each in the
// right rail via the Shift+click bullet gesture (the real card path), then
// measures:
//   A. the app rail (.nt-right-card) vs its flex parent (.nt-body) at 3
//      cards and again after closing all three via their Close buttons;
//   B. the nodeview context column (.nt-page-context) vs .nt-page-body.
// A fixed-height sidebar reads equal to its parent's height regardless of
// card count; a content-adaptive one shrinks with fewer cards.
// "Work offline" device-local workspace (no account needed; the layout
// components + CSS are identical).
import { chromium } from "playwright";

const WEB = "http://localhost:8378";
const TITLES = ["Sidebar probe A", "Sidebar probe card 1", "Sidebar probe card 2"];
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const pg = await context.newPage();
const consoleErrors = [];
pg.on("console", (m) => {
  const text = m.text();
  // Offline mode syncs fail by design (NullTransport) — not a defect.
  if (m.type() === "error" && !text.includes("not connected to a sync server")) {
    consoleErrors.push(text.slice(0, 160));
  }
});
pg.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));

async function createPageViaPalette(title) {
  await pg.keyboard.press("Control+k");
  const input = pg.getByPlaceholder(/search pages, classes, actions/i);
  await input.waitFor({ timeout: 10_000 });
  await input.fill(title);
  await pg.waitForTimeout(400);
  await pg.locator(".nt-palette-item", { hasText: `Create page "${title}"` }).first().click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(600);
}

async function openPageViaPalette(title) {
  await pg.keyboard.press("Control+k");
  const input = pg.getByPlaceholder(/search pages, classes, actions/i);
  await input.waitFor({ timeout: 10_000 });
  await input.fill(title);
  await pg.waitForTimeout(600);
  // The page result row (not the "Create page …" command).
  await pg
    .locator(".nt-palette-item", { hasText: title })
    .filter({ hasNotText: /create/i })
    .first()
    .click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);
}

async function addBlockAndPeek() {
  // The ghost row's add button creates a block; typing fills it; clicking
  // the header exits edit mode; Shift+click the new block's bullet peeks it
  // into the right rail (the real card path).
  await pg.locator(".nt-ghost-row__add").first().click();
  await pg.waitForTimeout(400);
  await pg.keyboard.type("peek block");
  await pg.waitForTimeout(400);
  await pg.locator(".nt-page-header").first().click();
  await pg.waitForTimeout(400);
  await pg.locator(".nt-block:not(.nt-block--title) .nt-bullet").first().click({ modifiers: ["Shift"] });
  await pg.waitForTimeout(500);
}

const geom = () =>
  pg.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      return el === null ? null : el.getBoundingClientRect();
    };
    const dims = (r) => (r === null ? null : { top: Math.round(r.top), height: Math.round(r.height) });
    return {
      body: dims(rect(".nt-body")),
      rail: dims(rect(".nt-right-card")),
      pageBody: dims(rect(".nt-page-body")),
      context: dims(rect(".nt-page-context")),
      railCards: document.querySelectorAll(".nt-sidebar-card").length,
    };
  });

try {
  await pg.goto(`${WEB}/`, { waitUntil: "commit", timeout: 120_000 });
  await pg.getByRole("button", { name: /work offline/i }).waitFor({ timeout: 60_000 });
  await pg.getByRole("button", { name: /work offline/i }).click();
  await pg.waitForSelector(".nt-topbar", { timeout: 90_000 });
  await pg.waitForTimeout(1500);

  // Three pages; each peeks a block into the rail via Shift+click.
  for (const title of TITLES) {
    await createPageViaPalette(title);
    await addBlockAndPeek();
  }
  const three = await geom();
  console.log("3 rail cards: ", JSON.stringify(three));

  await openPageViaPalette(TITLES[0]);

  // 3 → 1 card (closing the last card hides the panel, so stop at one).
  for (let i = 0; i < TITLES.length - 1; i += 1) {
    await pg.getByRole("button", { name: "Close card" }).first().click();
    await pg.waitForTimeout(300);
  }
  const one = await geom();
  console.log("1 rail card:  ", JSON.stringify(one));

  // 1 → 0: the panel hides with the last card; reopen it for the
  // placeholder state.
  await pg.getByRole("button", { name: "Close card" }).first().click();
  await pg.waitForTimeout(300);
  await pg.getByRole("button", { name: "Toggle right sidebar" }).click();
  await pg.waitForTimeout(500);
  const zero = await geom();
  console.log("0 rail cards: ", JSON.stringify(zero));

  const report = (label, g) => {
    if (g.rail === null || g.body === null) throw new Error(`${label}: rail/body missing`);
    const delta = Math.abs(g.rail.height - g.body.height);
    console.log(`${label}: rail ${g.rail.height} vs body ${g.body.height} (Δ${delta}), cards ${g.railCards}`);
    return delta;
  };
  const d3 = report("three cards", three);
  const d1 = report("one card  ", one);
  const d0 = report("zero cards", zero);
  console.log(`VERDICT rail: fixed-height (Δ equal across card counts): ${d3 === d1 && d1 === d0} (Δ ${d3}/${d1}/${d0})`);
  console.log(`VERDICT context: fixed-height: ${three.context !== null && Math.abs(three.context.height - three.pageBody.height) <= 2} (context ${three.context?.height} vs pageBody ${three.pageBody?.height})`);
  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.slice(0, 5).join(" | "));
  console.log("PROBE-PASS: measured");
} finally {
  await browser.close();
}
