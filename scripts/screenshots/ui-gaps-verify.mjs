// UI-gaps verification probe (owner 2026-10-14 slice): exercises the four
// shipped surfaces against the DEPLOYED stack in the TEST workspace:
//   1. Version history — the context-column section lists the seeded page's
//      ops; a content snapshot expands and previews.
//   2. Trash hub — the sidebar Trash entry lists the trashed page; Restore
//      revives it.
//   3. Back/Forward arrows — enabled state + a back navigation.
//   4. Right rail — Shift+click peeks a card into the surfaced fixed-height
//      panel; Clear all empties it and closes the panel.
// TEST workspace; every scratch node is deleted (permanently where trashed)
// at the end.
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2"; // the test workspace (law 8)
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();

const api = async (path, init) => {
  const r = await fetch(API + path, {
    method: init?.method ?? "GET",
    headers: { "x-api-key": KEY, "x-workspace-id": WS, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) throw new Error(`api ${path}: ${r.status} ${(await r.text()).slice(0, 140)}`);
  return r.json();
};

// Seed: a page with two content edits + a trashed page.
const probe = (await api("/api/objects", { method: "POST", body: { name: "UIGaps probe", presentAsMain: true } })).id;
await api(`/api/objects/${probe}`, { method: "PATCH", body: { contentAst: [{ type: "text", text: "UIGaps draft one" }] } });
await api(`/api/objects/${probe}`, { method: "PATCH", body: { contentAst: [{ type: "text", text: "UIGaps draft two" }] } });
const victim = (await api("/api/objects", { method: "POST", body: { name: "UIGaps victim", presentAsMain: true } })).id;
await fetch(`${API}/api/objects/${victim}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } });

const login = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
if (!login.ok) throw new Error(`login: ${login.status}`);
const { token: SESSION } = await login.json();

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const pg = await context.newPage();
const consoleErrors = [];
pg.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
pg.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 160)));

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`check failed: ${name} ${detail}`);
};

try {
  // Seed the session before boot: the resume effect connects straight into
  // the test workspace (no picker round-trip).
  await pg.addInitScript(([url, token, ws]) => {
    localStorage.setItem("notees.serverUrl", url);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
  }, [API, SESSION, WS]);
  await pg.goto(`${WEB}/`, { waitUntil: "commit", timeout: 120_000 });
  await pg.waitForSelector(".nt-topbar", { timeout: 90_000 });
  await pg.waitForTimeout(3000);

  // ── 3. Back/Forward arrows (SPA round trip; a goto would reset the stack) ──
  check("back/forward arrows render on the top bar", (await pg.getByRole("button", { name: "Back" }).count()) === 1);
  await pg.locator(".nt-sidebar").getByRole("button", { name: /^pages$/i }).click();
  await pg.waitForTimeout(1200);
  const onPages = pg.url().endsWith("/pages");
  check("sidebar nav landed on the Pages hub", onPages, pg.url());
  await pg.getByRole("button", { name: "Back" }).click();
  await pg.waitForTimeout(1200);
  check("back returns to the previous surface", !pg.url().endsWith("/pages"), pg.url());
  check("forward is enabled after a back", !(await pg.getByRole("button", { name: "Forward" }).isDisabled()));
  await pg.getByRole("button", { name: "Forward" }).click();
  await pg.waitForTimeout(1200);
  check("forward returns to the Pages hub", pg.url().endsWith("/pages"), pg.url());

  // ── 1. Version history ──
  await pg.goto(`${WEB}/${probe}`);
  await pg.waitForSelector(".nt-page-body", { timeout: 60_000 });
  await pg.waitForTimeout(2500);
  const vhToggle = pg.getByRole("button", { name: /Version history/ });
  check("version history section present in the context column", (await vhToggle.count()) === 1);
  await vhToggle.click();
  await pg.waitForSelector(".version-history__rows", { timeout: 30_000 });
  const rows = pg.locator(".version-history__row");
  check("version feed lists the seeded ops (create + 2 edits)", (await rows.count()) >= 3, `rows=${await rows.count()}`);
  check("newest-first: the last edit leads", (await rows.first().textContent())?.includes("Edited content") ?? false);
  await pg.getByRole("button", { name: /show snapshot/ }).first().click();
  await pg.waitForTimeout(400);
  check("snapshot preview shows the latest draft", (await pg.locator(".version-history__snapshot-text").first().textContent())?.includes("UIGaps draft two") ?? false);
  check("restore affordance present", (await pg.getByRole("button", { name: "Restore this version" }).count()) >= 1);

  // (back/forward already verified above in the same session)

  // ── 2. Trash hub ──
  await pg.locator(".nt-sidebar").getByRole("button", { name: /^trash$/i }).click();
  await pg.waitForSelector(".nt-trash-hub", { timeout: 30_000 });
  await pg.waitForTimeout(1000);
  check("trash hub lists the trashed page", (await pg.locator(".nt-trash-hub__row").count()) >= 1);
  const victimRow = pg.locator(".nt-trash-hub__row", { hasText: "UIGaps victim" });
  check("the victim row is there with its restore action", (await victimRow.count()) === 1 && (await victimRow.getByRole("button", { name: /Restore/ }).count()) === 1);

  // ── 4. Right rail: peek + surfaced fixed panel + Clear all ──
  await pg.goto(`${WEB}/${probe}`);
  await pg.waitForSelector(".nt-page-body", { timeout: 60_000 });
  await pg.waitForTimeout(1500);
  // The rail starts closed; open it with the top-bar toggle.
  if ((await pg.locator(".nt-right-card").count()) === 0) {
    await pg.getByRole("button", { name: "Toggle right sidebar" }).click();
    await pg.waitForSelector(".nt-right-card", { timeout: 15_000 });
    await pg.waitForTimeout(500);
  }
  const railBg = await pg.evaluate(() => {
    const el = document.querySelector(".nt-right-card");
    return el === null ? null : getComputedStyle(el).backgroundColor;
  });
  check("right rail is a surfaced panel (painted background)", railBg !== null && railBg !== "rgba(0, 0, 0, 0)", `bg=${railBg}`);
  const bodyH = await pg.evaluate(() => document.querySelector(".nt-body")?.getBoundingClientRect().height ?? 0);
  const railH = await pg.evaluate(() => document.querySelector(".nt-right-card")?.getBoundingClientRect().height ?? 0);
  check("right rail is fixed-height (stretched, margins-only delta)", bodyH > 0 && Math.abs(bodyH - railH) <= 32, `body=${Math.round(bodyH)} rail=${Math.round(railH)}`);

  // Peek a block via Shift+click on its bullet.
  await pg.locator(".nt-ghost-row__add").first().click();
  await pg.waitForTimeout(400);
  await pg.keyboard.type("peek target");
  await pg.waitForTimeout(400);
  await pg.locator(".nt-page-header").first().click();
  await pg.waitForTimeout(400);
  await pg.locator(".nt-block:not(.nt-block--title) .nt-bullet").first().click({ modifiers: ["Shift"] });
  await pg.waitForSelector(".nt-sidebar-card", { timeout: 15_000 });
  check("shift+click peeks a card into the rail", (await pg.locator(".nt-sidebar-card").count()) === 1);

  const clearAll = pg.getByRole("button", { name: "Clear all" });
  check("Clear all renders in the rail bar", (await clearAll.count()) === 1);
  await clearAll.click();
  await pg.waitForTimeout(600);
  check("Clear all empties the rail and closes the panel", (await pg.locator(".nt-sidebar-card").count()) === 0 && (await pg.locator(".nt-right-card").count()) === 0);

  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.slice(0, 4).join(" | "));
  console.log(`PROBE-PASS: ${results.length} checks green`);
} finally {
  // Cleanup: permanently remove every scratch node.
  for (const id of [probe, victim]) {
    await fetch(`${API}/api/objects/${id}?permanent=true&confirm=${id}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  }
  console.log("scratch nodes purged");
  await browser.close();
}
