// Drop-targets probe: replicate the owner's scenario — a page with a deep
// subtree (A with children a2 with child a2a), then B, then C — and drag C
// to the divider just before B at three indentation bands:
//   shallow  → C becomes a top-level sibling right before B
//   depth-1  → C lands as A's last child (after a2's subtree)
//   depth-2  → C lands as a child of a2a
// Also verifies the indicator LINE paints at the indicator block's ELEMENT
// bottom (after the entire element), not at its text row's bottom, and that
// no drop indicator survives the drop. TEST workspace; cleans up after itself.
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
  if (!r.ok) throw new Error(`api ${path}: ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};
const block = (parentId, text) =>
  api("/api/objects", { method: "POST", body: { parentId, contentAst: [{ type: "text", text }] } }).then((r) => r.id);

const pageId = (await api("/api/objects", { method: "POST", body: { name: "Drop-targets probe scratch", presentAsMain: true } })).id;
let A, a2, a2a, B, C;
try {
  A = await block(pageId, "once");
  a2 = await block(A, "nino");
  a2a = await block(a2, "misterio");
  B = await block(pageId, "catorce");
  C = await block(pageId, "trece");
  console.log("structure: page[A[a2[a2a]], B, C]");

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
  await pg.waitForSelector(`[data-block-id="${C}"] .nt-block-grip`, { timeout: 60_000 });
  console.log("page open");

  // Magenta accent makes the 2px indicator lines machine-detectable.
  await pg.evaluate(() => document.documentElement.style.setProperty("--color-accent", "rgb(255, 0, 255)"));

  const NAMES = () => ({ [A]: "A", [a2]: "a2", [a2a]: "a2a", [B]: "B", [C]: "C" });

  const dividerGeom = () =>
    pg.evaluate(([bid]) => {
      const b = document.querySelector(`[data-block-id="${bid}"]`).getBoundingClientRect();
      return { dividerY: b.top - 2, shallowX: b.left + 3 };
    }, [B]);

  const depthXs = () =>
    pg.evaluate(([a2id, a2aid]) => {
      const r = (id) => document.querySelector(`[data-block-id="${id}"]`).getBoundingClientRect();
      return { depth1X: r(a2id).left + 3, depth2ChildX: r(a2aid).left + 52 };
    }, [a2, a2a]);

  /** The live indicator: which block, which intent, row vs element bottom. */
  const indicator = () =>
    pg.evaluate((names) => {
      const el = document.querySelector(".nt-drop-above, .nt-drop-below, .nt-drop-child");
      if (el === null) return null;
      const match = el.className.match(/nt-drop-\w+/);
      const id = el.getAttribute("data-block-id");
      const row = el.querySelector(":scope > .nt-block-row");
      return {
        label: (names[id] ?? id) + ":" + (match === null ? "?" : match[0]),
        id,
        intent: match === null ? "?" : match[0].replace("nt-drop-", ""),
        rowBottom: row === null ? el.getBoundingClientRect().bottom : row.getBoundingClientRect().bottom,
        elementBottom: el.getBoundingClientRect().bottom,
        elementLeft: el.getBoundingClientRect().left,
        elementWidth: el.getBoundingClientRect().width,
      };
    }, NAMES());

  /** Magenta horizontal-line rows (viewport y's) within a clip box. */
  const magentaRowsIn = async (box, minRun = 80) => {
    const shot = await pg.screenshot({ clip: box });
    return pg.evaluate(async ({ dataUrl, base, minRun }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const rows = new Set();
      for (let y = 0; y < img.height; y += 1) {
        let run = 0;
        for (let x = 0; x < img.width; x += 1) {
          const i = (y * img.width + x) * 4;
          const magenta = d[i] > 200 && d[i + 2] > 200 && d[i + 1] < 90;
          run = magenta ? run + 1 : 0;
          if (run >= minRun) {
            rows.add(Math.round(y + base));
            break;
          }
        }
      }
      return [...rows];
    }, { dataUrl: `data:image/png;base64,${shot.toString("base64")}`, base: box.y, minRun });
  };

  /** Assert the line paints at the ELEMENT bottom, not the ROW bottom. */
  const assertElementEdgeLine = async (ind) => {
    const box = {
      x: ind.elementLeft,
      y: ind.rowBottom - 4,
      width: Math.min(ind.elementWidth, 700),
      height: ind.elementBottom + 6 - (ind.rowBottom - 4),
    };
    const rows = await magentaRowsIn(box);
    console.log(`line geometry (${ind.label}): magenta rows`, rows, " rowBottom", Math.round(ind.rowBottom), " elementBottom", Math.round(ind.elementBottom));
    const gap = ind.elementBottom - ind.rowBottom;
    if (!rows.some((r) => Math.abs(r - ind.elementBottom) <= 3))
      throw new Error(`no indicator line at the ELEMENT bottom (${ind.elementBottom}); rows=${rows}`);
    if (gap > 10 && rows.some((r) => Math.abs(r - ind.rowBottom) <= 3))
      throw new Error(`indicator line still paints at the ROW bottom (${ind.rowBottom}) — the mid-element bug`);
  };

  const dragTo = async (x, y) => {
    const grip = await pg.locator(`[data-block-id="${C}"] .nt-block-grip`).boundingBox();
    await pg.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await pg.mouse.down();
    await pg.mouse.move(grip.x + grip.width / 2 + 8, grip.y, { steps: 2 });
    await pg.mouse.move(x, y, { steps: 6 });
    await pg.mouse.move(x + 1, y, { steps: 1 });
  };
  const finishDrag = async () => {
    await pg.mouse.up();
    await pg.waitForTimeout(400);
  };

  const tree = async () => {
    const kids = async (id) => (await api(`/api/objects/${id}/children`)).children.map((k) => k.id);
    return { page: await kids(pageId), A: await kids(A), a2: await kids(a2), a2a: await kids(a2a) };
  };
  // Moves ride the op log, not the REST surface — recreate C at the page's
  // end between bands instead of moving it back.
  const recreateC = async () => {
    await fetch(`${API}/api/objects/${C}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
    C = await block(pageId, "trece");
    await pg.waitForSelector(`[data-block-id="${C}"] .nt-block-grip`, { timeout: 15_000 });
  };

  // ── Band 1: shallow x → top-level sibling right before B; the line rides
  //    the indicator's ELEMENT bottom (A's subtree is tall — the old build
  //    painted it at A's text-row bottom, far above the pointer). ──
  {
    const g = await dividerGeom();
    await dragTo(g.shallowX, g.dividerY);
    const ind = await indicator();
    console.log("band shallow, live indicator:", ind?.label);
    if (ind === null) throw new Error("no drop indicator live at the divider");
    if (ind.id !== A && ind.id !== B) throw new Error(`unexpected indicator ${ind.label}`);
    if (ind.intent !== "below" && ind.intent !== "above") throw new Error(`unexpected intent ${ind.label}`);
    await assertElementEdgeLine(ind);
    await finishDrag();
    const t = await tree();
    console.log("band shallow, page order:", t.page.map((id) => (id === A ? "A" : id === B ? "B" : id === C ? "C" : "?")).join(","));
    if (!(t.page.indexOf(C) === t.page.indexOf(B) - 1)) throw new Error("C did not land right before B");
  }

  // ── Band 2: depth-1 x → A's last child (after a2's subtree) ──
  await recreateC();
  {
    const g = await dividerGeom();
    const xs = await depthXs();
    await dragTo(xs.depth1X, g.dividerY);
    const ind = await indicator();
    console.log("band depth-1, live indicator:", ind?.label);
    await finishDrag();
    const t = await tree();
    console.log("band depth-1, A children:", t.A.map((id) => (id === a2 ? "a2" : id === C ? "C" : "?")).join(","));
    if (!(t.A[t.A.length - 1] === C)) throw new Error("C did not land as A's last child");
  }

  // ── Band 3: depth-2 child x → child of a2a (a CHILDESS block — the owner
  //    case: the child intent must render as a LINE at the element bottom,
  //    starting at the child indent — no vertical bar on the row) ──
  await recreateC();
  {
    const g = await dividerGeom();
    const xs = await depthXs();
    await dragTo(xs.depth2ChildX, g.dividerY);
    const ind = await indicator();
    console.log("band depth-2, live indicator:", ind?.label);
    if (ind === null || ind.intent !== "child") throw new Error(`expected a child intent, got ${ind?.label}`);
    const indFresh = await indicator();
    // The portaled line paints above the chip, so the full run is visible.
    const rows = await magentaRowsIn({
      x: indFresh.elementLeft,
      y: indFresh.rowBottom - 4,
      width: Math.min(indFresh.elementWidth, 700),
      height: indFresh.elementBottom + 6 - (indFresh.rowBottom - 4),
    });
    console.log("band depth-2, magenta rows:", rows, "elementBottom", Math.round(ind.elementBottom));
    if (!rows.some((r) => Math.abs(r - ind.elementBottom) <= 3))
      throw new Error(`no child line at the element bottom (${ind.elementBottom}); rows=${rows}`);
    await finishDrag();
    const t = await tree();
    console.log("band depth-2, a2a children:", t.a2a.map((id) => (id === C ? "C" : "?")).join(","));
    if (!(t.a2a.length === 1 && t.a2a[0] === C)) throw new Error("C did not land as a child of a2a");
  }

  // ── No stuck indicator after the drops ──
  const stuck = await pg.evaluate(
    () => document.querySelectorAll(".nt-drop-above, .nt-drop-below, .nt-drop-child").length,
  );
  console.log("stuck indicators after drops:", stuck);
  if (stuck !== 0) throw new Error("a drop indicator survived the drop");

  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.join(" | "));
  console.log("PROBE-PASS: multi-level drop targets at one divider, element-edge lines, clean release");
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  console.log("scratch page deleted");
}
