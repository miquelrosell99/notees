// Indent-rail probe: the collapse rail must (1) REACH the block's row
// bottom across its metadata sections (the line starts at the bullet), and
// (2) target per height: a click beside a direct child collapses THAT
// child's children, a click beside a childless block does nothing, and a
// click in the metadata gap (above the first child) collapses the owner's.
// TEST workspace; cleans up after itself.
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
const block = (parentId, text) =>
  api("/api/objects", { method: "POST", body: { parentId, contentAst: [{ type: "text", text }] } }).then((r) => r.id);

const pageId = (await api("/api/objects", { method: "POST", body: { name: "Rail probe scratch", presentAsMain: true } })).id;
let A, a2, a2a;
try {
  A = await block(pageId, "once");
  // A carries a text property so it renders a Properties section between the
  // row and the children — the gap the rail must cross.
  const schemaId = crypto.randomUUID();
  await api("/api/property-schemas", { method: "POST", body: { propertySchemaId: schemaId, name: "estado", type: "text" } });
  await api(`/api/objects/${A}/properties`, { method: "POST", body: { propertySchemaId: schemaId, value: "activo" } });
  a2 = await block(A, "nino");
  a2a = await block(a2, "misterio");
  const a2b = await block(A, "solo"); // childless direct child — its segment is a no-op
  await block(pageId, "catorce");
  console.log("structure: page[A(prop)[a2[a2a], a2b], B]");

  const loginRes = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
  });
  if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
  const { token: SESSION } = await loginRes.json();

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pg = await context.newPage();
  const consoleErrors = [];
  pg.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  pg.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
  await pg.addInitScript(([url, token, ws]) => {
    localStorage.setItem("notees.serverUrl", url);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
  }, [API, SESSION, WS]);

  await pg.goto(`${WEB}/${pageId}`, { waitUntil: "commit", timeout: 120_000 });
  await pg.waitForSelector(`[data-block-id="${A}"] .nt-block-children__rail`, { timeout: 60_000 });
  console.log("page open");

  const geom = () =>
    pg.evaluate(([aid, a2id, a2bid]) => {
      const q = (id) => document.querySelector(`[data-block-id="${id}"]`);
      const r = (id) => q(id).getBoundingClientRect();
      const rail = q(aid).querySelector(".nt-block-children__rail").getBoundingClientRect();
      const row = q(aid).querySelector(":scope > .nt-block-row").getBoundingClientRect();
      return {
        railTop: rail.top,
        railX: rail.left + 2,
        rowBottom: row.bottom,
        childrenTop: r(aid).bottom, // A's element bottom ≈ children container bottom
        firstChildTop: r(a2id).top,
        a2Top: r(a2id).top,
        a2bTop: r(a2bid).top,
      };
    }, [A, a2, a2b]);

  // ── 1. The rail reaches the row bottom, across the metadata gap ──
  {
    const g = await geom();
    console.log("rail geometry:", JSON.stringify(g, (k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));
    const gap = g.firstChildTop - g.rowBottom;
    if (gap < 10) throw new Error(`probe setup: expected a metadata gap above the children, got ${gap}`);
    if (Math.abs(g.railTop - g.rowBottom) > 3)
      throw new Error(`rail top ${g.railTop} does not reach the row bottom ${g.rowBottom} (gap ${gap})`);
    console.log(`rail reaches the bullet: top ${Math.round(g.railTop)} vs row bottom ${Math.round(g.rowBottom)}, across a ${Math.round(gap)}px metadata gap`);
  }

  const clickRailAt = async (y) => {
    const g = await geom();
    await pg.mouse.click(g.railX, y);
    await pg.waitForTimeout(250);
  };
  const visible = (id) => pg.evaluate((bid) => document.querySelector(`[data-block-id="${bid}"]`) !== null, id);

  // ── 2. Click beside a2 → a2's children collapse (NOT the owner A) ──
  {
    const g = await geom();
    await clickRailAt(g.a2Top + 8);
    const a2aGone = !(await visible(a2a));
    const a2Still = await visible(a2);
    console.log("click beside a2 → a2a hidden:", a2aGone, " a2 visible:", a2Still);
    if (!a2aGone) throw new Error("a2's children did not collapse");
    if (!a2Still) throw new Error("a2 itself must stay visible");
    if (!(await visible(A))) throw new Error("the owner A must stay visible");
  }

  // ── 3. Reload; click beside a2b (a childless DIRECT child) → nothing
  //    collapses ──
  await pg.reload({ waitUntil: "commit" });
  await pg.waitForSelector(`[data-block-id="${A}"] .nt-block-children__rail`, { timeout: 60_000 });
  {
    const g = await geom();
    await clickRailAt(g.a2bTop + 8);
    const allThere = (await visible(a2a)) && (await visible(a2)) && (await visible(a2b)) && (await visible(A));
    console.log("click beside childless a2b → everything still visible:", allThere);
    if (!allThere) throw new Error("a click beside a childless block collapsed something");
  }

  // ── 4. Reload; click in the metadata gap (above the first child) → the
  //    owner's children collapse ──
  await pg.reload({ waitUntil: "commit" });
  await pg.waitForSelector(`[data-block-id="${A}"] .nt-block-children__rail`, { timeout: 60_000 });
  {
    const g = await geom();
    const gapY = (g.rowBottom + g.firstChildTop) / 2;
    await clickRailAt(gapY);
    const a2Gone = !(await visible(a2));
    const aStill = await visible(A);
    console.log("click in the metadata gap → a2 (A's children) hidden:", a2Gone, " A visible:", aStill);
    if (!a2Gone) throw new Error("the owner's children did not collapse from the gap segment");
    if (!aStill) throw new Error("A itself must stay visible");
  }

  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.join(" | "));
  console.log("PROBE-PASS: the rail reaches the bullet and collapses per height");
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  console.log("scratch page deleted");
}
