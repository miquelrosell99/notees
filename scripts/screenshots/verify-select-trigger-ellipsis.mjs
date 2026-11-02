// Verify probe: the kit SelectTrigger label clips a long node title with an
// ellipsis (owner report 2026-11-02: the Edit Link modal's target line read
// as a hard cut / overflow instead of "…"). Seeds a long-titled target page
// in the disposable TEST workspace, authors a mention of it through the
// app's own editor (the client write path), opens Edit Link from the chip's
// context menu, asserts the trigger label's computed style clips, cleans up.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const TEST_WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const STACK = "/etc/periphery/stacks/notees/config/notees";
const PASSWORD = readFileSync(`${STACK}/.admin_password`, "utf8").trim();
const EMAIL = "miquelroselltarrago@gmail.com";

const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const { token } = await login.json();

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined || method === "DELETE" ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`,
      "x-workspace-id": TEST_WS,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const run = Date.now().toString(36);
const LONG_TITLE = `The adjunctive use of systemic antibiotics in the treatment of very long protocol titles that must clip ${run}`;
// T: the long-titled target. R: the container page; B: an empty child block
// (gains the mention of T in the editor).
const T = await api("POST", "/api/objects", { contentAst: [{ type: "text", text: LONG_TITLE }] });
const R = await api("POST", "/api/objects", { contentAst: [{ type: "text", text: `Ellipsis probe ${run}` }] });
const B = await api("POST", "/api/objects", { parentId: R.id, isEmbedded: true, contentAst: [] });
console.log(JSON.stringify({ T: T.id, R: R.id, B: B.id }));

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1720, height: 1000 } });
  await context.addInitScript(({ api, token, ws }) => {
    localStorage.setItem("notees.serverUrl", api); localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws); localStorage.setItem("notees.theme", "dark");
  }, { api: API, token, ws: TEST_WS });
  const page = await context.newPage();
  page.on("crash", () => console.log("PAGE CRASHED"));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 200)); });

  await page.goto(`${WEB}/${R.id}`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForSelector(".nt-app", { timeout: 60_000 });
  await page.waitForTimeout(8_000);

  // Author B's content: click the empty block row, "@" + pick T.
  const bRow = page.locator(`[data-block-id="${B.id}"]`).first();
  await bRow.click();
  const editable = page.locator('[aria-label="Block content"]').first();
  await editable.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(600);
  const query = LONG_TITLE.slice(0, 40);
  await page.keyboard.type(`@${query}`, { delay: 60 });
  await page.waitForSelector(".node-result-item", { timeout: 10_000 });
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  // Leave edit mode by blurring (click away from the block).
  await page.locator("h1, .nt-page-title, text=/Ellipsis probe/").first().click().catch(() => {});
  await page.mouse.click(860, 700).catch(() => {});
  await page.waitForTimeout(2_000);

  // The chip: B's whole content is the link to T. Right-click for the
  // node-link context menu, choose Edit link…
  const chip = page.locator("button.nt-link").first();
  await chip.waitFor({ state: "visible", timeout: 15_000 });
  await chip.click({ button: "right" });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `scripts/screenshots/out/ellipsis-ctx-${run}.png` });
  const editEntry = page.locator(".context-menu >> text=/Edit link/").first();
  await editEntry.waitFor({ state: "visible", timeout: 10_000 });
  await editEntry.click();
  await page.waitForSelector(".link-edit-modal", { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: `scripts/screenshots/out/ellipsis-modal-${run}.png` });

  // Assert the trigger label clips: ellipsis computed style + no overflow.
  const check = await page.evaluate(() => {
    const value = document.querySelector(".link-edit-modal .select-trigger__value");
    const label = value?.firstElementChild;
    const trigger = document.querySelector(".link-edit-modal .select-trigger");
    const modal = document.querySelector(".link-edit-modal .modal__content, .link-edit-modal");
    if (!value || !label || !trigger || !modal) return { found: false };
    const cs = getComputedStyle(label);
    const t = trigger.getBoundingClientRect();
    const m = modal.getBoundingClientRect();
    return {
      found: true,
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      whiteSpace: cs.whiteSpace,
      labelClipped: label.scrollWidth > label.clientWidth,
      labelText: (label.textContent ?? "").slice(0, 60),
      triggerWithinModal: t.right <= m.right + 1 && t.left >= m.left - 1,
      modalWidth: Math.round(m.width),
      triggerWidth: Math.round(t.width),
    };
  });
  console.log("TRIGGER_CHECK:", JSON.stringify(check));
  const pass =
    check.found === true &&
    check.textOverflow === "ellipsis" &&
    check.overflow === "hidden" &&
    check.whiteSpace === "nowrap" &&
    check.labelClipped === true &&
    check.triggerWithinModal === true;
  console.log(pass ? "PROBE-PASS" : "PROBE-FAIL");
} finally {
  await browser.close().catch(() => {});
  for (const id of [B.id, R.id, T.id]) {
    // DELETE wants a JSON body when content-type is set — send {}.
    await fetch(`${API}/api/objects/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-workspace-id": TEST_WS },
      body: "{}",
    }).then((r) => { if (!r.ok) console.log("cleanup fail", id, r.status); }).catch((e) => console.log("cleanup fail", id, e.message));
  }
  console.log("CLEANED");
}
