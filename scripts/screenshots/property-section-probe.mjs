// S5/S6 visual-QA probe: drives the vite dev server (port 5299, OFFLINE
// store mode — never the shared 8377/8378 stack) through the real UI:
// creates classes + property bindings, captures the redesigned class
// properties section (collapsed rows, config panel, inherited group, add
// popover), the block-to-property drag affordance, and proves the 390px
// class page cannot scroll horizontally.
// Evidence lands in scripts/screenshots/.runtime/s6/.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const WEB = process.env.PROBE_BASE ?? "http://localhost:5299";
const OUT = new URL("./.runtime/s6/", import.meta.url).pathname;
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

  // --- create the "Base" class (the inherited source) ----------------------
  await pg.keyboard.press("Control+k");
  await pg.getByPlaceholder(/search pages, classes, actions/i).waitFor({ timeout: 15_000 });
  await pg.locator(".nt-palette-item", { hasText: "New class" }).first().click();
  const classModal = pg.getByRole("dialog");
  await classModal.getByPlaceholder("e.g. Character").fill("Base");
  await classModal.getByRole("button", { name: "Create class" }).click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);
  console.log("STAGE base class created");

  // One binding on Base: "Base note" (text).
  const defsSection = () => pg.locator("section.nt-propdefs");
  await defsSection().getByRole("button", { name: "Add property" }).click();
  let popover = pg.getByRole("dialog", { name: "Add property" });
  await popover.getByPlaceholder("Search or create property…").fill("Base note");
  await pg.getByRole("button", { name: 'Create property "Base note"' }).click();
  let createModal = pg.getByRole("dialog", { name: "Create property" });
  await createModal.getByRole("button", { name: "Create Property" }).click();
  await pg.waitForTimeout(900);
  console.log("STAGE base binding added:", await pg.locator(".nt-propdef-name").allTextContents());

  // --- create the "Review" class ------------------------------------------
  await pg.keyboard.press("Control+k");
  await pg.getByPlaceholder(/search pages, classes, actions/i).waitFor({ timeout: 15_000 });
  await pg.locator(".nt-palette-item", { hasText: "New class" }).first().click();
  await pg.getByPlaceholder("e.g. Character").fill("Review");
  await pg.getByRole("button", { name: "Create class" }).click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);

  // Helper: create+bind a property through the S6 popover → S1 modal.
  async function createBoundProperty(name, type) {
    const section = pg.locator("section.nt-propdefs");
    await section.getByRole("button", { name: "Add property" }).click();
    const pop = pg.getByRole("dialog", { name: "Add property" });
    await pop.getByPlaceholder("Search or create property…").fill(name);
    await pg.getByRole("button", { name: `Create property "${name}"` }).click();
    const modal = pg.getByRole("dialog", { name: "Create property" });
    if (type !== undefined && type !== "text") {
      // The radiogroup labels (datetime rides as "Date"); the radios are
      // named by label + description text.
      const label = type === "datetime" ? "Date" : type.charAt(0).toUpperCase() + type.slice(1);
      await modal.locator("button[role='radio']", { hasText: new RegExp(`^${label}`) }).click();
    }
    await modal.getByRole("button", { name: "Create Property" }).click();
    await pg.waitForTimeout(900);
  }

  await createBoundProperty("Summary", "text");
  await createBoundProperty("Verdict", "select");
  await createBoundProperty("Reviewed at", "datetime");
  const names = await pg.locator(".nt-propdef-name").allTextContents();
  console.log("STAGE review bindings:", JSON.stringify(names));
  if (names.length !== 3) fail(`expected 3 bindings, got ${JSON.stringify(names)}`);

  // Rename Summary to a very long name (truncation evidence).
  await pg.getByRole("button", { name: "Configure Summary" }).click();
  const nameInput = pg.getByLabel("Property name");
  await nameInput.fill("A genuinely long property name that must truncate cleanly");
  await pg.locator(".nt-page-header").first().click(); // blur → write
  await pg.waitForTimeout(700);
  console.log("STAGE long rename written");

  // Verdict: disable (dimmed row); set a default on the long one + Required.
  // Rows stay independently expanded — scope every query to its row.
  await pg.getByRole("button", { name: "Configure Verdict" }).click();
  await pg.waitForTimeout(400);
  const verdictRow = pg.getByRole("listitem").filter({ hasText: /^Verdict/ });
  await verdictRow.getByRole("switch", { name: "Disabled Enabled" }).click();
  await pg.waitForTimeout(700);
  const longRow = pg.getByRole("listitem").filter({ hasText: /A genuinely long/ });
  await longRow.getByLabel(/Default for A genuinely long/).fill("Nothing to say");
  await longRow.getByRole("checkbox", { name: /Required for A genuinely long/ }).click();
  await pg.locator(".nt-page-header").first().click();
  await pg.waitForTimeout(700);
  console.log("STAGE flags written");
  const dimCheck = await pg.evaluate(() =>
    [...document.querySelectorAll(".nt-propdef")].map((li) => ({
      name: li.querySelector(".nt-propdef-name")?.textContent,
      inactive: li.classList.contains("nt-propdef--inactive"),
      opacity: getComputedStyle(li.querySelector(".nt-propdef-name") ?? li).opacity,
    })),
  );
  console.log("STAGE dim check:", JSON.stringify(dimCheck));
  if (!dimCheck.some((r) => r.name === "Verdict" && r.inactive === true)) {
    fail("Verdict binding did not go inactive (Enabled switch write failed)");
  }

  // --- extends Base (the Inherited group) ----------------------------------
  await pg.getByRole("button", { name: "Add class extension" }).click();
  const picker = pg.getByRole("dialog", { name: "Select node" });
  await picker.getByLabel("Search classes").fill("Base");
  await pg.waitForTimeout(500);
  await picker.getByText("Base", { exact: true }).first().click();
  await pg.waitForTimeout(900);
  const inheritedHeader = pg.getByRole("button", { name: /Inherited/i });
  console.log("STAGE inherited present:", await inheritedHeader.count());
  await inheritedHeader.click(); // expand the Inherited group
  await pg.waitForTimeout(500);

  // --- captures: 1440 -------------------------------------------------------
  // Collapse every expanded row, then the section itself, for a clean state.
  for (const name of [/Configure A genuinely long/, /Configure Verdict/]) {
    const btn = pg.getByRole("button", { name });
    if ((await btn.getAttribute("aria-expanded")) === "true") await btn.click();
    await pg.waitForTimeout(300);
  }
  await pg.getByRole("button", { name: /Class properties/i }).click();
  await pg.waitForTimeout(400);
  await pg.getByRole("button", { name: /Class properties/i }).click();
  await pg.waitForTimeout(500);
  // Collapsed rows, one hovered (grip + ⋯ revealed).
  await pg.locator(".nt-propdef-row").first().hover();
  await pg.waitForTimeout(400);
  await shot("01-collapsed-rows-hover-1440");
  // The dimmed (inactive) row, hovered: identity chrome still reveals.
  await pg.locator(".nt-propdef-row", { hasText: "Verdict" }).first().hover();
  await pg.waitForTimeout(400);
  await shot("01b-collapsed-rows-inactive-hover-1440");

  // Config panel open (the long-name row: every group visible).
  await pg.getByRole("button", { name: /Configure A genuinely long/ }).click();
  await pg.waitForTimeout(500);
  await shot("02-config-panel-1440");

  // The datetime row's type-specific group. DOM-dispatched clicks: the
  // sidebar re-measures under Playwright's pointer and role-clicks land
  // unreliably here. The long row collapses first so the datetime config
  // rides near the top of the (internally scrolling) side panel.
  const toggleRow = (name) =>
    pg.evaluate((n) => {
      const btn = [...document.querySelectorAll(".nt-propdef-main")].find((b) =>
        b.textContent?.includes(n),
      );
      if (btn === undefined) throw new Error(`row not found: ${n}`);
      btn.click();
    }, name);
  await toggleRow("A genuinely long"); // collapse the long row
  await toggleRow("Reviewed at");
  await pg.waitForTimeout(500);
  await pg.evaluate(() => {
    document
      .querySelector(".nt-propdef--expanded .nt-propdef-config")
      ?.scrollIntoView({ block: "nearest" });
  });
  await pg.waitForTimeout(400);
  await shot("03-config-panel-datetime-1440");
  await toggleRow("Reviewed at"); // collapse
  await pg.waitForTimeout(300);

  // Inherited group populated.
  await shot("04-inherited-1440");

  // The add popover (search + create row).
  await defsSection().getByRole("button", { name: "Add property" }).click();
  popover = pg.getByRole("dialog", { name: "Add property" });
  await popover.getByPlaceholder("Search or create property…").fill("Impact");
  await pg.waitForTimeout(400);
  await shot("05-add-popover-1440");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(300);

  // --- S5: block-to-property drag on a page --------------------------------
  await pg.keyboard.press("Control+k");
  await pg.getByPlaceholder(/search pages, classes, actions/i).waitFor({ timeout: 15_000 });
  await pg.getByPlaceholder(/search pages, classes, actions/i).fill("Drag lab");
  await pg.waitForTimeout(500);
  await pg.locator(".nt-palette-item", { hasText: 'Create page "Drag lab"' }).first().click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);
  // Add the text property via the panel (creates the empty placeholder).
  // The panel may start collapsed — expand it.
  const propsHeader = pg.getByRole("button", { name: /^Properties( \d+)?$/i });
  if ((await propsHeader.count()) > 0 && (await propsHeader.getAttribute("aria-expanded")) === "false") {
    await propsHeader.first().click();
    await pg.waitForTimeout(500);
  }
  // Give the page the Review class: its bound text property renders as an
  // EMPTY field — the canonical drop-target surface for S5.
  await pg.getByRole("button", { name: "Add class" }).click();
  const classPicker = pg.getByRole("dialog", { name: "Select node" });
  await classPicker.getByPlaceholder(/search/i).fill("Review");
  await pg.waitForTimeout(600);
  await classPicker.getByText("Review", { exact: true }).first().click();
  await pg.waitForTimeout(1000);
  console.log("STAGE panel rows:", await pg.locator("li.nt-property").allTextContents());
  // Two body blocks.
  for (const text of ["First body block", "Second body block"]) {
    await pg.locator(".nt-ghost-row__add").first().click();
    await pg.waitForTimeout(400);
    await pg.keyboard.type(text);
    await pg.waitForTimeout(300);
    await pg.locator(".nt-page-header").first().click();
    await pg.waitForTimeout(400);
  }
  await shot("06-page-before-drag-1440");

  // Drag the first block's grip onto the text-property row.
  const grip = pg.locator(".nt-block:not(.nt-block--title) .nt-block-grip").first();
  const gripBox = await grip.boundingBox();
  const valueCell = pg.locator(".nt-property-text").first();
  const cellBox = await valueCell.boundingBox();
  if (gripBox === null || cellBox === null) fail("drag targets not measurable");
  await pg.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await pg.mouse.down();
  // Move in steps so dnd-kit's PointerSensor tracks the drag.
  for (let i = 1; i <= 10; i += 1) {
    await pg.mouse.move(
      gripBox.x + ((cellBox.x + cellBox.width / 2 - gripBox.x) * i) / 10,
      gripBox.y + ((cellBox.y + cellBox.height / 2 - gripBox.y) * i) / 10,
    );
    await pg.waitForTimeout(60);
  }
  await pg.waitForTimeout(400);
  const affordance = await pg.evaluate(() => {
    const row = document.querySelector(".nt-property--droppable, .nt-property--drop-over");
    return row === null ? null : row.className;
  });
  console.log("STAGE drag affordance class:", affordance);
  await shot("07-drag-over-affordance-1440");
  await pg.mouse.up();
  await pg.waitForTimeout(900);
  // After the drop: the block renders as the carrier in the panel row.
  await shot("08-after-drop-1440");
  const carried = await pg.evaluate(() => {
    const row = document.querySelector(".nt-property-text");
    return row === null ? null : row.textContent;
  });
  console.log("STAGE after-drop row text:", carried?.slice(0, 120));

  // --- 768 + 390 ------------------------------------------------------------
  await pg.setViewportSize({ width: 768, height: 900 });
  await pg.waitForTimeout(600);
  await shot("09-page-768");

  await pg.setViewportSize({ width: 390, height: 844 });
  await pg.waitForTimeout(600);
  await shot("10-page-390");

  // The class page at 390 + the horizontal-overflow proof.
  await pg.keyboard.press("Control+k");
  await pg.getByPlaceholder(/search pages, classes, actions/i).waitFor({ timeout: 15_000 });
  await pg.getByPlaceholder(/search pages, classes, actions/i).fill("Review");
  await pg.waitForTimeout(600);
  await pg.locator(".nt-palette-item", { hasText: "Review" }).filter({ hasNotText: /create/i }).first().click();
  await pg.waitForSelector(".nt-page-body", { timeout: 30_000 });
  await pg.waitForTimeout(800);
  await pg.getByRole("button", { name: /Class properties/i }).click();
  await pg.waitForTimeout(400);
  await shot("11-class-page-390");
  const overflow = await pg.evaluate(() => {
    const doc = document.scrollingElement;
    const sections = [...document.querySelectorAll("section.nt-propdefs, section.nt-propdefs-inherited")].map(
      (el) => ({ scroll: el.scrollWidth, client: el.clientWidth }),
    );
    return {
      documentOverflow: doc.scrollWidth - doc.clientWidth,
      sections,
    };
  });
  console.log("STAGE 390 overflow:", JSON.stringify(overflow));
  if (overflow.documentOverflow > 0) fail(`390px document overflows horizontally by ${overflow.documentOverflow}px`);
  for (const s of overflow.sections) {
    if (s.scroll > s.client) fail(`section overflows: ${JSON.stringify(s)}`);
  }

  if (consoleErrors.length > 0) {
    console.log("console errors (non-fatal, listed):", consoleErrors.slice(0, 8).join(" | "));
  }
  console.log("PROBE-PASS: captures in " + OUT);
} finally {
  await browser.close();
}
