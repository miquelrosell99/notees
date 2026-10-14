// Edit-vs-selection probe: with blocks selected, ONE full click on another
// block must enter edit mode (and clear the selection). Reproduces the real
// input-event sequence (moves + down/up) against the deployed stack and
// reports what the first click actually does. TEST workspace; cleans up.
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();

const api = async (path, init) => {
  const r = await fetch(API + path, {
    method: init?.method ?? "GET",
    headers: { "x-api-key": KEY, "x-workspace-id": WS, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
  return r.json();
};
const block = (parentId, text) =>
  api("/api/objects", { method: "POST", body: { parentId, contentAst: [{ type: "text", text }] } }).then((r) => r.id);

const pageId = (await api("/api/objects", { method: "POST", body: { name: "Edit-select probe scratch", presentAsMain: true } })).id;
try {
  const ids = [];
  for (const t of ["one", "two", "three"]) ids.push(await block(pageId, t));

  const loginRes = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
  });
  const { token: SESSION } = await loginRes.json();

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pg = await ctx.newPage();
  await pg.addInitScript(([u, t, w]) => {
    localStorage.setItem("notees.serverUrl", u);
    localStorage.setItem("notees.sessionToken", t);
    localStorage.setItem("notees.workspaceId", w);
  }, [API, SESSION, WS]);
  await pg.goto(`${WEB}/${pageId}`, { waitUntil: "commit", timeout: 120_000 });
  await pg.waitForSelector(`[data-block-id="${ids[2]}"] .nt-block-content`, { timeout: 60_000 });

  const state = () =>
    pg.evaluate(() => ({
      editors: document.querySelectorAll(".nt-block-text").length,
      selected: document.querySelectorAll(".nt-block--selected").length,
      bar: document.querySelector(".nt-selection-bar") !== null,
      active: document.activeElement === null ? "null" : `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 40)}`,
      outlines: document.querySelectorAll(".nt-selection-outline").length,
    }));

  // Select rows 0-1 with ctrl+clicks (no edit mode involved), then probe
  // several single-click targets.
  await pg.keyboard.press("Escape");
  const row = (i) => pg.locator(`[data-block-id] .nt-block-content`).nth(i);
  await row(0).click({ modifiers: ["Control"] });
  await row(1).click({ modifiers: ["Control"] });
  await pg.waitForTimeout(200);
  console.log("after ctrl+click rows 0-1:", JSON.stringify(await state()));

  // 1. Steady click on a third (unselected) row.
  await row(2).click();
  await pg.waitForTimeout(250);
  const s1 = await state();
  console.log("click unselected row 2:", JSON.stringify(s1));

  if (s1.editors === 1 && !s1.bar) {
    // 2. Re-select; click a row INSIDE the selection.
    await pg.keyboard.press("Escape");
    await row(0).click({ modifiers: ["Control"] });
    await row(1).click({ modifiers: ["Control"] });
    await row(1).click();
    await pg.waitForTimeout(250);
    console.log("click selected row 1:", JSON.stringify(await state()));

    // 3. Re-select via DRAG-SELECT (the owner's path), then one click on a
    // different row: the release-row swallow must not eat it.
    await pg.keyboard.press("Escape");
    const b0 = await row(0).boundingBox();
    const b1 = await row(1).boundingBox();
    await pg.mouse.move(b0.x + 30, b0.y + b0.height / 2);
    await pg.mouse.down();
    await pg.mouse.move(b1.x + 30, b1.y + b1.height / 2, { steps: 4 });
    await pg.mouse.up();
    await pg.waitForTimeout(250);
    const selState = await state();
    console.log("after drag-select:", JSON.stringify(selState));
    await row(2).click();
    await pg.waitForTimeout(250);
    const s3 = await state();
    console.log("one click after drag-select on row 2:", JSON.stringify(s3));
    if (s3.editors !== 1) throw new Error("the click after a drag-select did not edit");
  } else {
    await pg.screenshot({ path: "/tmp/edit-select-fail.png" });
    console.log("REPRODUCED: first click did not edit");
  }
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  console.log("scratch page deleted");
}
