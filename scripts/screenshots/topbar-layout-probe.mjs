// Layout probe: inspect the NodeCollectionTopBar geometry in the test
// workspace — what the owner reported as "super broken" (split toolbar
// cluster, oddly tall tabs strip). Seeds a mention pair, opens the target,
// expands Backlinks, dumps the topbar children's boxes + a screenshot.
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
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const stamp = Date.now().toString(36);
const target = await (await fetch(API + "/api/objects", { method: "POST", headers: auth, body: JSON.stringify({ name: `ProbeTarget ${stamp}`, isEmbedded: false }) })).json();
const source = await (await fetch(API + "/api/objects", { method: "POST", headers: auth, body: JSON.stringify({ name: `ProbeSource ${stamp}`, isEmbedded: false, contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: target.id }] }) })).json();
console.log("seeded", target.id, source.id);

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(({ api, token, ws }) => {
    localStorage.setItem("notees.serverUrl", api);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
    localStorage.setItem("notees.theme", "dark");
  }, { api: API, token, ws: TEST_WS });
  const page = await context.newPage();
  await page.goto(`${WEB}/`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForSelector(".nt-app", { timeout: 60_000 });
  // Let the full log replay settle (the test-workspace boot contract — 12s)
  // BEFORE routing to the node, so the backlink counts read true.
  await page.waitForTimeout(12_000);
  await page.goto(`${WEB}/${target.id}`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForTimeout(4000);
  // Expand the page-level Unlinked mentions section (reliable in this
  // scenario: the source page's flattened title literally contains the
  // target's name) — its hosted collection renders the topbar under test.
  const unlinkedHeader = page.getByRole("button", { name: /Unlinked mentions/ }).first();
  if (await unlinkedHeader.count() > 0) {
    const expanded = await unlinkedHeader.getAttribute("aria-expanded");
    if (expanded === "false") await unlinkedHeader.click();
  }
  await page.waitForTimeout(1500);
  const layout = await page.evaluate(() => {
    const topbar = document.querySelector(".nt-node-collection-topbar");
    const dump = (el, depth) => {
      if (el === null || depth > 5) return null;
      const b = el.getBoundingClientRect();
      const text = (el.children.length === 0 ? (el.textContent ?? "").trim().slice(0, 30) : "");
      return {
        cls: el.className.toString().slice(0, 50),
        w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y),
        text,
        children: [...el.children].map((c) => dump(c, depth + 1)).filter((c) => c !== null && (c.w > 0 || c.children.length > 0)),
      };
    };
    return dump(topbar, 0);
  });
  console.log(JSON.stringify(layout, null, 1));
  await page.screenshot({ path: "scripts/screenshots/topbar-layout-probe.png", fullPage: false }).catch(() => {});
  console.log("PROBE-DONE");
} finally {
  // probe data cleanup
  await fetch(`${API}/api/objects/${source.id}`, { method: "DELETE", headers: auth }).catch(() => {});
  await fetch(`${API}/api/objects/${target.id}`, { method: "DELETE", headers: auth }).catch(() => {});
  await browser.close().catch(() => {});
}
