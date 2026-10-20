// Edit-thread probe: while a block is in edit mode, the ancestor chain from
// the top-level block down to the editing block wears the accent thread
// (owner 2026-10-20, app.css "the edit thread"):
//   1. every chain level's indent rail takes the hover-weight accent hairline
//      (the 1px-3px gradient), non-chain rails stay on the resting hairline;
//   2. each path link (and the editing block) grows a horizontal elbow from
//      the rail column into its bullet (::after on the bullet); non-path
//      rows grow none — including the chain's TOP block (its rail starts the
//      thread; the body container above it is not a .nt-block-children);
//   3. the elbow is pointer-events: none — a click on the strip reaches the
//      rail beneath (folds the child), never the bullet (zoom);
//   4. the thread follows the caret (editing a sibling tears the old thread
//      down) and ends AT the editing block (its own subtree stays resting).
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

// A parentless create is a Page (Revision 12: standalone by definition;
// `presentAsMain` retired). `name` seeds the initial text content
// (title-is-content).
const pageId = (await api("/api/objects", { method: "POST", body: { name: "Thread probe scratch" } })).id;
let A, a2, a3, a2b, B, C, c1;
try {
  A = await block(pageId, "alfa");
  a2 = await block(A, "bravo");
  a3 = await block(a2, "charlie");
  a2b = await block(A, "delta"); // non-path direct child of A
  B = await block(pageId, "echo"); // non-path top-level block
  C = await block(pageId, "foxtrot");
  c1 = await block(C, "golf"); // non-chain rail reference (C's rail rests)
  console.log("structure: page[A[a2[a3], a2b], B, C[c1]] — edit target: a3");

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

  // In-page helpers: the rail gradient signature (accent carries a 3px stop,
  // the resting hairline ends at 2px), the elbow read (::after on the path
  // link's grip) and the stud read (::before on the ancestor's grip).
  const thread = () =>
    pg.evaluate(([aid, a2id, a3id, a2bid, bid, cid, c1id]) => {
      const q = (id) => document.querySelector(`[data-block-id="${id}"]`);
      const railBg = (id) => getComputedStyle(q(id).querySelector(".nt-block-children__rail")).backgroundImage;
      const arm = (pseudo) => (id) => {
        // Both arms ride the GRIP (the bullet's own ::after is the retired
        // ring — banned by the no-ring-hooks register).
        const grip = q(id).querySelector(":scope > .nt-block-row .nt-block-grip");
        if (grip === null) return { grip: false };
        const cs = getComputedStyle(grip, pseudo);
        if (cs.content === "none") return { content: "none" };
        return { content: cs.content, pointerEvents: cs.pointerEvents };
      };
      const elbow = arm("::after");
      const stud = arm("::before");
      return {
        editingA3: q(a3id).classList.contains("nt-block--editing"),
        railA: railBg(aid),
        railA2: railBg(a2id),
        railC: railBg(cid),
        elbowA: elbow(aid),
        elbowA2: elbow(a2id),
        elbowA3: elbow(a3id),
        elbowA2b: elbow(a2bid),
        elbowB: elbow(bid),
        elbowC1: elbow(c1id),
        studA: stud(aid),
        studA2: stud(a2id),
        studA3: stud(a3id),
        studA2b: stud(a2bid),
        studB: stud(bid),
        studC1: stud(c1id),
      };
    }, [A, a2, a3, a2b, B, C, c1]);

  const elbowBox = (id) =>
    pg.evaluate((bid) => {
      const grip = document.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-block-grip`);
      const bullet = document.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-bullet`);
      const cs = getComputedStyle(grip, "::after");
      const rg = grip.getBoundingClientRect();
      const rb = bullet.getBoundingClientRect();
      return {
        leftOffset: parseFloat(cs.left),
        width: parseFloat(cs.width),
        top: rg.top + parseFloat(cs.top),
        height: parseFloat(cs.height),
        bulletCenterY: rb.top + rb.height / 2,
      };
    }, id);

  const studBox = (id) =>
    pg.evaluate((bid) => {
      const grip = document.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-block-grip`);
      const cs = getComputedStyle(grip, "::before");
      return {
        width: parseFloat(cs.width),
        topOffset: parseFloat(cs.top), // rel. the grip's padding box (22px tall)
        height: parseFloat(cs.height),
      };
    }, id);

  const dotOpacity = (id) =>
    pg.evaluate((bid) => {
      const dot = document.querySelector(`[data-block-id="${bid}"] > .nt-block-row .nt-bullet-dot`);
      return getComputedStyle(dot).opacity;
    }, id);

  const expect = (cond, msg) => {
    if (!cond) throw new Error("ASSERT: " + msg);
    console.log("ok —", msg);
  };

  // ── enter edit on a3 (the deepest block) ──
  await pg.click(`[data-block-id="${a3}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${a3}"].nt-block--editing`, { timeout: 10_000 });
  let t = await thread();

  expect(t.editingA3, "a3 is in edit mode");
  expect(/3px/.test(t.railA) && /3px/.test(t.railA2), "the chain rails (A, a2) wear the accent hairline");
  expect(!/3px/.test(t.railC), "the non-chain rail (C) stays on the resting hairline");
  expect(t.elbowA.content === "none", "the chain's top block (A) grows no elbow — its rail starts the thread");
  expect(t.elbowA2.content !== "none", "the path link a2 grows an elbow");
  expect(t.elbowA3.content !== "none", "the editing block a3 grows an elbow");
  expect(t.elbowA2b.content === "none" && t.elbowB.content === "none" && t.elbowC1.content === "none",
    "non-path rows (a2b, B, c1) grow no elbow");
  expect(t.elbowA2.pointerEvents === "none", "the elbow is pointer-events: none");

  // ── elbow geometry: from the rail column into the bullet's center ──
  {
    const b2 = await elbowBox(a2);
    const b3 = await elbowBox(a3);
    expect(Math.abs(b2.width - 31) <= 1 && Math.abs(b2.height - 2) <= 0.5,
      `a2's elbow reads ${Math.round(b2.width)}x${Math.round(b2.height)} (31x2 expected)`);
    expect(Math.abs(b2.leftOffset - -22) <= 1, "a2's elbow starts at the rail column (22px left of the grip)");
    expect(Math.abs(b2.top + b2.height / 2 - b2.bulletCenterY) <= 1.5, "a2's elbow rides the bullet's vertical center");
    expect(Math.abs(b3.width - 31) <= 1 && Math.abs(b3.height - 2) <= 0.5,
      `a3's elbow reads ${Math.round(b3.width)}x${Math.round(b3.height)} (31x2 expected)`);
  }

  // ── the stud: each ancestor drops a vertical from its dot into its rail,
  //    so the thread passes THROUGH every path bullet ──
  expect(t.studA.content !== "none" && t.studA2.content !== "none",
    "the ancestors (A, a2) grow the stud below their bullets");
  expect(t.studA3.content === "none", "the editing block grows no stud — the thread ends at its dot");
  expect(t.studA2b.content === "none" && t.studB.content === "none" && t.studC1.content === "none",
    "non-path rows grow no stud");
  expect(t.studA.pointerEvents === "none", "the stud is pointer-events: none");
  {
    const s = await studBox(A);
    expect(Math.abs(s.width - 2) <= 0.5, `A's stud reads ${s.width}px wide (2px expected)`);
    expect(Math.abs(s.topOffset - 12) <= 1.5, `A's stud starts just below the dot (top ${Math.round(s.topOffset)}, ~12 expected)`);
    expect(s.height >= 12 && s.height <= 26,
      `A's stud spans a half line-height past the row bottom (${Math.round(s.height)}px — resolved from 0.5lh + 6px)`);
  }

  // ── editing chrome stays on the editing ROW: the subtree must not accent ──
  await pg.click(`[data-block-id="${a2}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${a2}"].nt-block--editing`, { timeout: 10_000 });
  await pg.waitForTimeout(350); // the dot opacity rides a short transition — read it settled
  {
    const own = await dotOpacity(a2);
    const child = await dotOpacity(a3);
    const sibling = await dotOpacity(a2b);
    expect(own === "1", "the editing block's own dot carries the accent (opacity 1)");
    expect(child !== "1", "the editing block's CHILD dot stays resting (the subtree-accent bug stays fixed)");
    expect(sibling !== "1", "the sibling row's dot stays resting");
  }

  // ── the thread follows the caret: editing a sibling tears it down ──
  await pg.click(`[data-block-id="${B}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${B}"].nt-block--editing`, { timeout: 10_000 });
  t = await thread();
  expect(!/3px/.test(t.railA) && !/3px/.test(t.railA2), "editing a top-level sibling accents no rail");
  expect(t.elbowA2.content === "none" && t.elbowA3.content === "none", "the old thread's elbows are gone");

  // ── the thread ends AT the editing block: its own subtree stays resting ──
  await pg.click(`[data-block-id="${a2b}"] .nt-block-content`);
  await pg.waitForSelector(`[data-block-id="${a2b}"].nt-block--editing`, { timeout: 10_000 });
  t = await thread();
  expect(/3px/.test(t.railA), "editing a2b accents A's rail (a2b is a direct child of A)");
  expect(!/3px/.test(t.railA2), "a2b's own (childless) subtree adds nothing; a2's rail stays resting");
  expect(t.elbowA2b.content !== "none", "the editing block a2b grows its elbow into the thread");

  // ── the elbow strip must not eat the rail's fold click (no zoom) ──
  {
    await pg.click(`[data-block-id="${a3}"] .nt-block-content`);
    await pg.waitForSelector(`[data-block-id="${a3}"].nt-block--editing`, { timeout: 10_000 });
    const geom = await pg.evaluate(([aid, a2id]) => {
      const rail = document.querySelector(`[data-block-id="${aid}"] .nt-block-children__rail`).getBoundingClientRect();
      const bullet = document.querySelector(`[data-block-id="${a2id}"] > .nt-block-row .nt-bullet`).getBoundingClientRect();
      return { railX: rail.left + 4, elbowY: bullet.top + bullet.height / 2 };
    }, [A, a2]);
    // A click on the elbow's strip (over the rail column, at a2's row): must
    // reach the RAIL (fold a2 → a3 disappears), never the bullet (zoom).
    await pg.mouse.click(geom.railX, geom.elbowY);
    await pg.waitForTimeout(300);
    const folded = await pg.evaluate(([a2id, a3id]) => {
      const chevron = document.querySelector(`[data-block-id="${a2id}"] .nt-block-chevron`);
      return { expanded: chevron?.getAttribute("aria-expanded"), a3Gone: document.querySelector(`[data-block-id="${a3id}"]`) === null, url: location.pathname };
    }, [a2, a3]);
    expect(folded.expanded === "false", "the click reached the rail — a2 folded");
    expect(folded.a3Gone, "a2's subtree hid with the fold");
    expect(folded.url === `/${pageId}`, "no zoom — the URL stays on the page");
  }

  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.join(" | "));
  console.log("PROBE-PASS: the edit thread lights the ancestor chain, elbows into the path bullets, passes clicks through, and follows the caret");
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, { method: "DELETE", headers: { "x-api-key": KEY, "x-workspace-id": WS } }).catch(() => {});
  console.log("scratch page deleted");
}
