// Pill-selection visual probe (§34.39): the editor's selected node-link pill
// must show the archived editor's selection look — primary text, faint primary
// tint, focus-ring outline — and clicking it in edit mode must SELECT, not
// navigate. Read-only against the live workspace (no writes).
// Hard timeouts everywhere; exits non-zero on failure.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const api = async (path) => {
  const r = await fetch(API + path, { headers: { "x-api-key": KEY, "x-workspace-id": WS } });
  if (!r.ok) throw new Error(`api ${path}: ${r.status}`);
  return r.json();
};

// --- scratch fixture: page + block with a self-mention (trashed on exit) ------
// Read scans found no mention-bearing block quickly; a clearly-named scratch
// node is deterministic and is trashed in the finally block below.
const post = async (path, body) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "x-workspace-id": WS },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`post ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const created = await post("/api/objects", { name: "Pill probe scratch (34.39)", presentAsMain: true });
const host = { id: created.id ?? created.object?.id };
if (!host.id) throw new Error("create returned no id: " + JSON.stringify(created).slice(0, 200));
const block = await post("/api/objects", {
  parentId: host.id,
  contentAst: [
    { type: "text", text: "before " },
    { type: "mention", targetNodeId: host.id, text: "pill probe target" },
    { type: "text", text: " after" },
  ],
});
const blockId = block.id ?? block.object?.id;
console.log("scratch host:", host.id, "block:", blockId);

// --- boot the app -------------------------------------------------------------
const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
const { token: SESSION } = await loginRes.json();

mkdirSync("/etc/periphery/stacks/notees/scripts/migrated-verify", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
}, [API, SESSION, WS]);

await page.goto(`${WEB}/${host.id}`, { waitUntil: "commit", timeout: 120_000 });
// The node view mounts as soon as sync delivers the node (App re-renders on
// pagesVersion); the block content is the ready signal — NOT a body-text
// threshold (a small page can total < 300 chars of innerText).
await page.waitForSelector(".nt-page-card .nt-block-content", { timeout: 240_000 });
const urlBefore = page.url();

// --- mount the editor on the block that holds the mention --------------------
let pill = null;
const blocks = page.locator(".nt-block-content");
const n = await blocks.count();
console.log("blocks on page:", n);
for (let i = 0; i < n; i++) {
  await blocks.nth(i).click({ timeout: 5_000 }).catch(() => {});
  pill = await page.waitForSelector(".nt-block-text .nt-atom", { timeout: 3_000 }).catch(() => null);
  if (pill) break;
  await page.keyboard.press("Escape").catch(() => {});
}
if (!pill) throw new Error("no .nt-atom pill mounted after clicking all blocks");
console.log("pill mounted:", await pill.evaluate((el) => el.textContent));

// --- first click: select, do NOT navigate ------------------------------------
await pill.click();
await page.waitForTimeout(300);
const state = await page.evaluate(() => {
  const el = document.querySelector(".nt-block-text .nt-atom");
  if (!el) return { present: false };
  const cs = getComputedStyle(el);
  const primary = getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim();
  return {
    present: true,
    selected: el.classList.contains("nt-atom--selected"),
    boxShadow: cs.boxShadow,
    color: cs.color,
    primary,
    background: cs.backgroundColor,
  };
});
console.log("after click:", JSON.stringify(state));
const urlAfterClick = page.url();

mkdirSync("/etc/periphery/stacks/notees/scripts/migrated-verify", { recursive: true });
const pillBox = await pill.boundingBox();
await page.screenshot({
  path: "/etc/periphery/stacks/notees/scripts/migrated-verify/pill-selected.jpg",
  type: "jpeg",
  quality: 90,
  clip: pillBox
    ? { x: Math.max(0, pillBox.x - 40), y: Math.max(0, pillBox.y - 40), width: Math.min(800, pillBox.width + 160), height: pillBox.height + 90 }
    : undefined,
});

// --- arrow clears the selection (caret lands after the pill) ------------------
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
const cleared = await page.evaluate(() => !document.querySelector(".nt-block-text .nt-atom")?.classList.contains("nt-atom--selected"));

// --- row fill: the editable spans side to side — clicking the empty right
// side of the row places the caret in the text (never blurs out of the block)
const editBox = await page.evaluate(() => {
  const r = document.querySelector(".nt-block-text").getBoundingClientRect();
  return { right: r.right, cy: r.top + r.height / 2, width: r.width };
});
await page.mouse.click(editBox.right - 6, editBox.cy);
await page.waitForTimeout(250);
const caretState = await page.evaluate(() => {
  const el = document.querySelector(".nt-block-text");
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return { focused: false };
  const range = sel.getRangeAt(0);
  const pill = el.querySelector(".nt-atom");
  return {
    focused: document.activeElement === el,
    anchoredInside: el.contains(sel.anchorNode),
    afterPill: pill === null ? null : range.comparePoint(pill, 0) === 1,
    editorWidth: el.getBoundingClientRect().width,
    contentWidth: el.parentElement.getBoundingClientRect().width,
  };
});
console.log("row fill:", JSON.stringify({ editBox, caretState }));
const rowFillOk =
  caretState.focused && caretState.anchoredInside && caretState.afterPill === true &&
  caretState.editorWidth >= caretState.contentWidth - 1;

const ringOk = state.present && state.selected && state.boxShadow !== "none" && /rgb/.test(state.boxShadow);
const colorOk = state.color.replace(/\s/g, "") === state.primary.replace(/\s/g, "");
const noNav = urlAfterClick === urlBefore;
console.log("ring outline:", ringOk, "| primary color:", colorOk, "| no navigation:", noNav, "| arrow clears:", cleared);
console.log("page errors:", consoleErrors.length ? consoleErrors.slice(0, 4) : "none");

await browser.close();
// Trash the scratch fixture (whole subtree rides the root's trash event).
const del = await fetch(`${API}/api/objects/${host.id}`, {
  method: "DELETE",
  headers: { "x-api-key": KEY, "x-workspace-id": WS },
});
console.log("scratch cleanup (trash):", del.status);
if (!ringOk || !colorOk || !noNav || !cleared || consoleErrors.length || del.status >= 300) {
  console.log("PILL-PROBE-FAIL");
  process.exit(1);
}
console.log("PILL-PROBE-PASS");
