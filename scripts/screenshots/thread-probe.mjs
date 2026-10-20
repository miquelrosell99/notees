// Edit-thread probe (the measured overlay): while
// a block is in edit mode, the page body draws ONE SVG polyline
// (EditThread.tsx) from the top-level ancestor's bullet to the editing
// block's bullet — down each bullet's column, a rounded right turn at each
// level change — a SEPARATE overlay, never the tree's own indent rail
// highlighted:
//   1. editing a3 (chain A → a2 → a3): the overlay exists with a 2-turn
//      path; the stroke is the accent; the svg is pointer-events: none.
//   2. the tree chrome is untouched: every rail rests (A's rail reads as
//      C's), the grip pseudos grow nothing.
//   3. geometry: the path starts at A's bullet center, ends at a3's, and
//      x strictly increases per level.
//   4. the ANCESTORS' chevrons stay hidden while a descendant edits (the
//      focus-within reveal is row-scoped).
//   5. the thread follows the caret: editing a top-level block draws
//      nothing; editing a2b draws A → a2b (one turn).
//   6. the overlay passes clicks through — the rail's fold still fires
//      beneath it.
//   7. editing chrome stays on the editing row: the subtree dots don't
//      accent (the descendant-selector bug stays fixed).
// TEST workspace; cleans up after itself.
import { chromium } from "playwright";
const ADMIN_EMAIL = process.env.NOTEES_ADMIN_EMAIL;
if (!ADMIN_EMAIL) throw new Error("NOTEES_ADMIN_EMAIL is required (the admin login email)");

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

// A parentless create is a Page (Revision 12: standalone by definition;
// `presentAsMain` retired). `name` seeds the initial text content
// (title-is-content).
const pageId = (await api("/api/objects", { method: "POST", body: { name: "Thread probe scratch" } })).id;
let A, a2, a3, a2b, B, C, c1;
try {
  A = await block(pageId, "alfa");
  a2 = await block(A, "bravo");
  a3 = await block(a2, "misterio");
  a2b = await block(A, "delta"); // non-path direct child of A
  B = await block(pageId, "echo"); // non-path top-level block
  C = await block(pageId, "foxtrot");
  c1 = await block(C, "golf"); // non-chain rail reference (C's rail rests)
  console.log("structure: page[A[a2[a3], a2b], B, C[c1]] — edit target: a3");

  const loginRes = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
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

  const expect = (cond, msg) => {
    if (!cond) throw new Error("ASSERT: " + msg);
    console.log("ok —", msg);
  };

  // One read of the whole thread state: the overlay path (+ its parsed
  // points and turn count), the chrome-resting proofs, the ancestor
  // chevrons, and the dot opacities — all host-relative.
  const state = (ids) =>
    pg.evaluate(([aid, a2id, a3id, a2bid, bid, cid]) => {
      const host = document.querySelector(".nt-edit-thread-host");
      if (host === null) return { host: false };
      const svg = host.querySelector(":scope > .nt-edit-thread-overlay");
      let path = null;
      if (svg !== null) {
        const p = svg.querySelector("path");
        path = {
          d: p?.getAttribute("d") ?? null,
          qCount: (p?.getAttribute("d").match(/Q/g) ?? []).length,
          stroke: p === null || p === undefined ? null : getComputedStyle(p).stroke,
        };
        if (path.d !== null) {
          const nums = path.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
          path.pts = [];
          for (let i = 0; i + 1 < nums.length; i += 2) path.pts.push({ x: nums[i], y: nums[i + 1] });
        }
      }
      const center = (bid) => {
        const b = host.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-bullet`);
        if (b === null) return null;
        const r = b.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        return { x: r.left + r.width / 2 - h.left, y: r.top + r.height / 2 - h.top };
      };
      const railBg = (bid) => getComputedStyle(host.querySelector(`[data-block-id="${bid}"] .nt-block-children__rail`)).backgroundImage;
      const chevronOpacity = (bid) => {
        const c = host.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-block-chevron`);
        return c === null ? null : getComputedStyle(c).opacity;
      };
      const dotOpacity = (bid) => {
        const d = host.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-bullet-dot`);
        return d === null ? null : getComputedStyle(d).opacity;
      };
      const gripArms = (bid) => {
        const g = host.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-block-grip`);
        return { before: getComputedStyle(g, "::before").content, after: getComputedStyle(g, "::after").content };
      };
      // Alignment: the rail button straddles the
      // container's left edge (the grid centerline — the bullet column)
      // and draws its 2px hairline gradient-centered, so the button's
      // center IS the bullet column. Paint order: the overlay rides
      // z-index 1 (above the positioned rail button, below the z-2
      // bullets/chevrons).
      const railEl = host.querySelector(`[data-block-id="${aid}"] .nt-block-children__rail`);
      const bulletA = host.querySelector(`[data-block-id="${aid}"] > .nt-block-row .nt-bullet`);
      const railRect = railEl.getBoundingClientRect();
      const bulletRect = bulletA.getBoundingClientRect();
      const chevronA2El = host.querySelector(`[data-block-id="${a2id}"] > .nt-block-row .nt-block-chevron`);
      return {
        host: true,
        svg: svg === null ? false : { pointerEvents: getComputedStyle(svg).pointerEvents, zIndex: getComputedStyle(svg).zIndex },
        path,
        railA: railBg(aid),
        railC: railBg(cid),
        railVsBullet: +(railRect.left + railRect.width / 2 - (bulletRect.left + bulletRect.width / 2)).toFixed(2),
        bulletZ: getComputedStyle(bulletA).zIndex,
        chevronZ: chevronA2El === null ? null : getComputedStyle(chevronA2El).zIndex,
        armsA2: gripArms(a2id),
        chevronA: chevronOpacity(aid),
        chevronA2: chevronOpacity(a2id),
        dotA2: dotOpacity(a2id),
        dotA3: dotOpacity(a3id),
        dotA2b: dotOpacity(a2bid),
        dotB: dotOpacity(bid),
        centerA: center(aid),
        centerA2: center(a2id),
        centerA3: center(a3id),
        centerA2b: center(a2bid),
      };
    }, ids);

  // ── 1–4. edit the deepest block: the overlay draws the chain ──
  await pg.click(`[data-block-id="${a3}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${a3}"].nt-block--editing`, { timeout: 10_000 });
  await pg.waitForSelector(".nt-edit-thread-overlay path", { timeout: 10_000 });
  await pg.waitForTimeout(350); // chevron/dot opacities ride short transitions
  let s = await state([A, a2, a3, a2b, B, C]);

  expect(s.host && s.svg !== false, "the overlay svg mounts in the select surface");
  expect(s.svg.pointerEvents === "none", "the overlay is pointer-events: none");
  expect(s.path !== null && s.path.qCount === 2, `the path takes a turn per level change (2 turns for A → a2 → a3; d=${s.path?.d})`);
  expect(s.path.pts.length >= 6, "the path carries the rounded-corner segments");
  {
    const start = s.path.pts[0];
    const end = s.path.pts[s.path.pts.length - 1];
    const near = (p, c) => Math.abs(p.x - c.x) <= 2 && Math.abs(p.y - c.y) <= 2;
    expect(near(start, s.centerA), "the thread starts at the TOP block's bullet center");
    expect(near(end, s.centerA3), "the thread ends at the editing block's bullet center");
    const xs = [s.centerA.x, s.centerA2.x, s.centerA3.x];
    expect(xs[0] < xs[1] && xs[1] < xs[2], "each level change turns to the right");
  }
  // The stroke is the accent: read the editing dot's own accent color.
  const strokeIsAccent = await pg.evaluate(() => {
    const host = document.querySelector(".nt-edit-thread-host");
    const editing = host.querySelector(".nt-block--editing > .nt-block-row .nt-bullet-dot");
    const path = host.querySelector(".nt-edit-thread-overlay path");
    return getComputedStyle(path).stroke === getComputedStyle(editing).backgroundColor;
  });
  expect(strokeIsAccent, "the thread stroke is the accent color");

  expect(s.railA === s.railC, "the tree's own rails stay resting — the thread is a separate overlay");
  expect(s.armsA2.before === "none" && s.armsA2.after === "none", "no CSS pseudo arms ride the grips");
  expect(Math.abs(s.railVsBullet) <= 1.2, `the rail rides the parent bullet column (offset ${s.railVsBullet}px)`);
  expect(s.svg.zIndex === "1", "the overlay rides z-index 1 — above the rails (a positioned button), below the dots");
  expect(s.bulletZ === "2" && s.chevronZ === "2", "the bullets and the hover chevron paint above the thread");
  expect(s.chevronA === "0" && s.chevronA2 === "0", "the ancestors' chevrons stay hidden while a descendant edits");

  // ── 5a. the caret follows: a top-level edit draws nothing ──
  await pg.click(`[data-block-id="${B}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${B}"].nt-block--editing`, { timeout: 10_000 });
  await pg.waitForTimeout(200);
  s = await state([A, a2, a3, a2b, B, C]);
  expect(s.svg === false, "editing a top-level block draws no thread (no ancestors)");

  // ── 5b. editing a2b draws A → a2b (one turn) ──
  await pg.click(`[data-block-id="${a2b}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${a2b}"].nt-block--editing`, { timeout: 10_000 });
  await pg.waitForSelector(".nt-edit-thread-overlay path", { timeout: 10_000 });
  s = await state([A, a2, a3, a2b, B, C]);
  expect(s.path !== null && s.path.qCount === 1, "editing a2b draws one turn (A → a2b)");
  {
    const end = s.path.pts[s.path.pts.length - 1];
    expect(Math.abs(end.x - s.centerA2b.x) <= 2 && Math.abs(end.y - s.centerA2b.y) <= 2,
      "the thread ends at the editing block's bullet");
  }

  // ── 6. the overlay passes clicks through: the rail's fold still fires ──
  {
    await pg.click(`[data-block-id="${a3}"] .nt-block-content`);
    await pg.waitForSelector(`[data-block-id="${a3}"].nt-block--editing`, { timeout: 10_000 });
    await pg.waitForSelector(".nt-edit-thread-overlay path", { timeout: 10_000 });
    const geom = await pg.evaluate(([aid, a2id]) => {
      const rail = document.querySelector(`[data-block-id="${aid}"] .nt-block-children__rail`).getBoundingClientRect();
      const bullet = document.querySelector(`[data-block-id="${a2id}"] > .nt-block-row .nt-bullet`).getBoundingClientRect();
      return { railX: rail.left + 4, y: bullet.top + bullet.height / 2 };
    }, [A, a2]);
    await pg.mouse.click(geom.railX, geom.y);
    await pg.waitForTimeout(300);
    const folded = await pg.evaluate(([a2id, a3id]) => {
      const chevron = document.querySelector(`[data-block-id="${a2id}"] .nt-block-chevron`);
      return {
        expanded: chevron?.getAttribute("aria-expanded"),
        a3Gone: document.querySelector(`[data-block-id="${a3id}"]`) === null,
        threadGone: document.querySelector(".nt-edit-thread-overlay") === null,
        url: location.pathname,
      };
    }, [a2, a3]);
    expect(folded.expanded === "false", "the click reached the rail — a2 folded");
    expect(folded.a3Gone, "a2's subtree hid with the fold");
    expect(folded.threadGone, "the fold unmounted the editor — the thread tore down");
    expect(folded.url === `/${pageId}`, "no zoom — the URL stays on the page");
  }

  // ── 7. the editing accent stays on the editing row (subtree regression) ──
  {
    await pg.click(`[data-block-id="${a2}"] .nt-block-content`);
    await pg.waitForSelector(`[data-block-id="${a2}"].nt-block--editing`, { timeout: 10_000 });
    await pg.waitForTimeout(350);
    s = await state([A, a2, a3, a2b, B, C]);
    expect(s.dotA2 === "1", "the editing block's own dot carries the accent (opacity 1)");
    expect(s.dotA3 !== "1", "the editing block's CHILD dot stays resting (the subtree-accent bug stays fixed)");
    expect(s.dotA2b !== "1", "the sibling row's dot stays resting");
  }

  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.join(" | "));
  console.log("PROBE-PASS: the overlay thread draws the ancestor path with rounded turns, leaves the tree chrome resting, passes clicks through, and follows the caret");
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  console.log("scratch page deleted");
}
