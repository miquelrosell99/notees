// R7 visual-QA probe (owner ruling 2026-10-20): the class page's expanded
// property config panel is CLASS-LEVEL ONLY — identity header, "For this
// class" group (default/required/enabled), "Edit definition…" + "Remove from
// class". Drives the vite dev server (default port 5399, OFFLINE store mode —
// never the shared 5199/5299 dev ports, never the live 8377/8378 stack)
// through the real UI: boots a local workspace, creates a class with text +
// object bindings, expands the panel, and captures the panel at 1440 + 390
// plus the S2 definition modal's target-classes editor (the unresolved-
// targets hint's new home). Evidence lands in scripts/screenshots/.runtime/r7/.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const WEB = process.env.PROBE_BASE ?? "http://localhost:5399";
const OUT = new URL("./.runtime/r7/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await context.newPage();
const consoleErrors = [];
pg.on("console", (m) => {
  const text = m.text();
  // Offline mode syncs fail by design — not a defect.
  if (m.type() === "error" && !text.includes("not connected to a sync server")) {
    consoleErrors.push(text.slice(0, 200));
  }
});
pg.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 240)));

const shot = (name) => pg.screenshot({ path: `${OUT}${name}.png` });
const fail = (msg) => {
  throw new Error(msg);
};

try {
  await pg.goto(`${WEB}/`, { waitUntil: "commit", timeout: 120_000 });
  await pg.getByRole("button", { name: /work offline/i }).waitFor({ timeout: 60_000 });
  await pg.getByRole("button", { name: /work offline/i }).click();
  await pg.waitForSelector(".nt-topbar", { timeout: 90_000 });
  await pg.waitForTimeout(1200);
  console.log("STAGE boot: offline workspace up");

  // --- create the "R7 Lab" class ------------------------------------------
  await pg.keyboard.press("Control+k");
  await pg.getByPlaceholder(/search pages, classes, actions/i).waitFor({ timeout: 15_000 });
  await pg.locator(".nt-palette-item", { hasText: "New class" }).first().click();
  const classModal = pg.getByRole("dialog");
  await classModal.getByPlaceholder("e.g. Character").fill("R7 Lab");
  await classModal.getByRole("button", { name: "Create class" }).click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);
  console.log("STAGE class created");

  // Helper: create+bind a property through the S6 popover → S1 modal.
  async function createBoundProperty(name, type) {
    const section = pg.locator("section.nt-propdefs");
    await section.getByRole("button", { name: "Add property" }).click();
    const pop = pg.getByRole("dialog", { name: "Add property" });
    await pop.getByPlaceholder("Search or create property…").fill(name);
    await pg.getByRole("button", { name: `Create property "${name}"` }).click();
    const modal = pg.getByRole("dialog", { name: "Create property" });
    if (type !== undefined && type !== "text") {
      const label = type === "datetime" ? "Date" : type.charAt(0).toUpperCase() + type.slice(1);
      await modal
        .locator("button[role='radio']")
        .filter({ hasText: new RegExp(`^${label}`) })
        .click();
    }
    await modal.getByRole("button", { name: "Create Property" }).click();
    await pg.waitForTimeout(900);
  }

  await createBoundProperty("Note", "text");
  await createBoundProperty("Link", "object");
  const names = await pg.locator(".nt-propdef-name").allTextContents();
  console.log("STAGE bindings:", JSON.stringify(names));
  if (names.length !== 2) fail(`expected 2 bindings, got ${JSON.stringify(names)}`);

  // --- expanded panel at 1440 ----------------------------------------------
  // Exercise the class-level fields: default value + Required.
  await pg.getByRole("button", { name: "Configure Note" }).click();
  await pg.waitForTimeout(400);
  const noteRow = pg.getByRole("listitem").filter({ hasText: /^Note/ });
  await noteRow.getByLabel(/Default for Note/).fill("Nothing yet");
  await noteRow.getByRole("checkbox", { name: /Required for Note/ }).click();
  await pg.locator(".nt-page-header").first().click(); // blur → write
  await pg.waitForTimeout(700);

  // Structural proof: the panel carries NO definition-level chrome.
  const panelAudit = await pg.evaluate(() => {
    const config = document.querySelector(".nt-propdef--expanded .nt-propdef-config");
    if (config === null) return null;
    return {
      hasRenameInput: config.querySelector("input[aria-label='Property name']") !== null,
      hasConvert: [...config.querySelectorAll("button")].some((b) => b.textContent === "Convert…"),
      groupLegends: [...config.querySelectorAll("legend")].map((l) => l.textContent),
      buttons: [...config.querySelectorAll("button")].map((b) => b.textContent?.trim()),
      labels: [...config.querySelectorAll("input, [role='switch'], [role='checkbox']")].map((el) =>
        el.getAttribute("aria-label"),
      ),
    };
  });
  console.log("STAGE panel audit:", JSON.stringify(panelAudit));
  if (panelAudit === null) fail("no expanded config panel found");
  if (panelAudit.hasRenameInput) fail("panel still carries the rename input");
  if (panelAudit.hasConvert) fail("panel still carries Convert…");
  if (panelAudit.groupLegends.length !== 1 || panelAudit.groupLegends[0] !== "For this class") {
    fail(`unexpected groups: ${JSON.stringify(panelAudit.groupLegends)}`);
  }
  await pg.evaluate(() => {
    document.querySelector(".nt-propdef--expanded")?.scrollIntoView({ block: "nearest" });
  });
  await pg.waitForTimeout(400);
  await shot("01-expanded-panel-1440");

  // --- the definition modal's target-classes editor -------------------------
  await pg.getByRole("button", { name: "Configure Link" }).click();
  await pg.waitForTimeout(400);
  const linkRow = pg.getByRole("listitem").filter({ hasText: /^Link/ });
  await linkRow.getByRole("button", { name: "Edit definition…" }).click();
  await pg.waitForTimeout(700);
  const modalAudit = await pg.evaluate(() => {
    const dialog = document.querySelector(".nt-property-settings");
    if (dialog === null) return null;
    return {
      heading: dialog.querySelector("h2")?.textContent,
      hasTargetClasses: [...dialog.querySelectorAll("button")].some(
        (b) => b.getAttribute("aria-label") === "Target classes",
      ),
      hasNameInput: dialog.querySelector("input[aria-label='Property name']") !== null,
      hints: [...dialog.querySelectorAll(".nt-property-create__hint")].map((h) => h.textContent),
    };
  });
  console.log("STAGE modal audit:", JSON.stringify(modalAudit));
  if (modalAudit === null) fail("definition modal did not open");
  if (!modalAudit.hasTargetClasses) fail("modal lacks the Target classes picker");
  if (!modalAudit.hasNameInput) fail("modal lacks the rename field");
  await shot("02-definition-modal-target-classes-1440");
  await pg.getByLabel("Close modal").click();
  await pg.waitForTimeout(400);

  // --- expanded panel at 390 + overflow proof -------------------------------
  await pg.setViewportSize({ width: 390, height: 844 });
  await pg.waitForTimeout(600);
  // The 390 layout opens the nav drawer over the content — toggle it shut.
  await pg.locator(".nt-topbar button").first().click();
  await pg.waitForTimeout(500);
  // Collapse + re-expand the Note row so its panel renders fresh at 390.
  await pg.evaluate(() => {
    document.querySelector(".nt-propdef--expanded .nt-propdef-main")?.click();
  });
  await pg.waitForTimeout(300);
  await pg.evaluate(() => {
    document.querySelector(".nt-propdef-main")?.click();
  });
  await pg.waitForTimeout(400);
  await pg.evaluate(() => {
    document.querySelector(".nt-propdef--expanded")?.scrollIntoView({ block: "nearest" });
  });
  await pg.waitForTimeout(400);
  await shot("03-expanded-panel-390");
  const overflow = await pg.evaluate(() => {
    const doc = document.scrollingElement;
    const config = document.querySelector(".nt-propdef--expanded .nt-propdef-config");
    return {
      documentOverflow: doc.scrollWidth - doc.clientWidth,
      config: config === null ? null : config.scrollWidth - config.clientWidth,
    };
  });
  console.log("STAGE 390 overflow:", JSON.stringify(overflow));
  if (overflow.documentOverflow > 0) {
    fail(`390px document overflows horizontally by ${overflow.documentOverflow}px`);
  }
  if (overflow.config !== null && overflow.config > 0) {
    fail(`expanded config overflows horizontally by ${overflow.config}px`);
  }

  if (consoleErrors.length > 0) {
    console.log("console errors (non-fatal, listed):", consoleErrors.slice(0, 8).join(" | "));
  }
  console.log("PROBE-PASS: captures in " + OUT);
} finally {
  await browser.close();
}
