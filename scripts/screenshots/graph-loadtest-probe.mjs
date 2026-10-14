// Stage-3 load-test probe: measure ONE graph renderer against the deployed
// stack (:8378 web, :8377 sync) in the TEST workspace, on a PERSISTENT
// playwright profile so renderer B's run reuses renderer A's synced IndexedDB
// (flip only the device flag between runs).
//
//   RENDERER=webgl|pixi node graph-loadtest-probe.mjs
//
// Emits one RESULT line (JSON) for the runner to collect, plus progress logs.
// Metrics: boot, graph first-paint (counts visible), settle (label-canvas
// checksum stability), 5s pan fps, 5s zoom fps, hover latency (label-canvas
// diff), console/page errors, final screenshot at /tmp/graph-loadtest-<r>.png.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = process.env.WEB_URL ?? "http://localhost:8378";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2"; // test workspace (law 8)
const RENDERER = process.env.RENDERER ?? "webgl";
const PROFILE = "/tmp/graph-loadtest-profile";
const PASSWORD =
  process.env.NOTEES_ADMIN_PASSWORD ??
  readFileSync("/etc/periphery/stacks/notees/config/notees/.admin_password", "utf8").trim();

const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: PASSWORD }),
});
const { token: SESSION } = await loginRes.json();
if (!SESSION) throw new Error("login failed: " + loginRes.status);

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1600, height: 1000 },
  args: ["--disable-dev-shm-usage", "--use-gl=angle", "--enable-unsafe-swiftshader"],
});
const page = context.pages()[0] ?? (await context.newPage());

const errors = [];
const allConsole = [];
page.on("console", (msg) => {
  const text = msg.text();
  allConsole.push(`${msg.type()}: ` + text.slice(0, 200));
  if (allConsole.length > 400) allConsole.shift();
  // GL ReadPixels stall warnings are a headless-swiftshader artifact of our
  // own label-canvas sampling — not a renderer defect.
  if (msg.type() !== "log" && !/GPU stall due to ReadPixels/.test(text)) {
    errors.push(`console.${msg.type()}: ` + text.slice(0, 200));
  }
});
page.on("pageerror", (err) => errors.push("pageerror: " + err.message.slice(0, 300)));
page.on("requestfailed", (req) => errors.push("requestfailed: " + req.url() + " " + (req.failure()?.errorText ?? "")));

await page.addInitScript(
  ([token, ws, renderer]) => {
    localStorage.setItem("notees.serverUrl", location.origin); // web proxies /api
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
    localStorage.setItem("notees.theme", "dark");
    localStorage.setItem("notees.settings.graphPrefs.full", JSON.stringify({ renderer }));
    // rAF frame counter for fps sampling.
    window.__frames = 0;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => native((ts) => { window.__frames += 1; cb(ts); });
  },
  [SESSION, WS, RENDERER],
);

const tBoot0 = Date.now();
await page.goto(WEB, { waitUntil: "commit", timeout: 120_000 });
let booted = false;
for (let i = 0; i < 540; i++) {
  await page.waitForTimeout(10_000);
  const len = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => -1);
  console.log(`boot t+${((Date.now() - tBoot0) / 1000).toFixed(0)}s bodyText=${len}`);
  // The shell (sidebar with real workspace data) renders at ~300 chars; the
  // main Today pane may stay blank for a long time while the worker applies
  // the 50k-op catch-up behind ensureDateChain. The graph view is reachable
  // from the shell, so 300 is the honest gate.
  if (len > 300) {
    booted = true;
    break;
  }
  // Liveness echo every 5 min: last console lines, so a silent stall is
  // diagnosable from the log.
  if (i > 0 && i % 30 === 29) {
    console.log(`boot console tail: ${JSON.stringify(allConsole.slice(-6))}`);
  }
}
if (!booted) {
  console.log("RESULT " + JSON.stringify({ renderer: RENDERER, bootTimeout: true, errors: errors.slice(0, 20), consoleTail: allConsole.slice(-30) }));
  await context.close();
  process.exit(2);
}
const bootMs = Date.now() - tBoot0;
await page.waitForTimeout(2000);

// --- graph open → first paint (counts line visible with real numbers) -------
// Click Graph, then wait for the counts line. The click is retried: with the
// worker busy applying catch-up, the first clicks may land before the router
// is fully responsive.
const tGraph0 = Date.now();
let firstPaintMs = null;
let counts = null;
for (let i = 0; i < 360; i++) {
  await page.click('text=Graph', { timeout: 5000 }).catch(() => {});
  counts = await page.evaluate(() => document.querySelector(".nt-graph__counts")?.textContent ?? null);
  if (counts !== null && /\d+ nodes/.test(counts)) {
    firstPaintMs = Date.now() - tGraph0;
    console.log(`first paint t+${(firstPaintMs / 1000).toFixed(1)}s counts="${counts}"`);
    break;
  }
  await page.waitForTimeout(10_000);
}
if (firstPaintMs === null) {
  console.log("RESULT " + JSON.stringify({ renderer: RENDERER, bootMs, graphOpenFailed: true, errors: errors.slice(0, 20) }));
  await context.close();
  process.exit(3);
}

// --- data convergence: wait until the projection sees the full seed ---------
// Blocks never become graph NODES, so the gate is the EDGE count (~25k
// mention edges + the pre-existing baseline edges). The worker may still be
// applying the catch-up behind first paint; interaction metrics must only
// start from full data.
{
  const t0 = Date.now();
  for (let i = 0; i < 720; i++) {
    counts = await page.evaluate(() => document.querySelector(".nt-graph__counts")?.textContent ?? null);
    const m = counts?.match(/([\d,]+) edges/);
    const edges = m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
    if (edges >= 25000) {
      console.log(`data converged after ${((Date.now() - t0) / 1000).toFixed(0)}s counts="${counts}"`);
      break;
    }
    if (i % 12 === 11) console.log(`converge t+${((Date.now() - t0) / 1000).toFixed(0)}s counts="${counts}"`);
    await page.waitForTimeout(10_000);
  }
}

// --- sampling helpers --------------------------------------------------------
// Label-canvas checksum (downscaled alpha sum) — the WebGL canvas reads blank
// via drawImage without preserveDrawingBuffer, so the label overlay + the DOM
// counts line are the reliable settle/hover signals (diag-probe precedent).
const labelChecksum = () =>
  page.evaluate(() => {
    const lc = document.querySelector(".nt-graph__labels");
    if (lc === null) return -1;
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 125;
    const ctx = c.getContext("2d");
    ctx.drawImage(lc, 0, 0, 200, 125);
    const d = ctx.getImageData(0, 0, 200, 125).data;
    let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum = (sum + d[i]) % 1_000_003;
    return sum;
  });

const graphInfo = () =>
  page.evaluate(() => ({
    counts: document.querySelector(".nt-graph__counts")?.textContent ?? null,
    error: document.querySelector(".nt-graph--error")?.textContent ?? null,
  }));

const countsText = async () => (await graphInfo()).counts;

// --- settle: checksum stable for 5 consecutive 1s samples (cap 180s) --------
let settleMs = null;
{
  let stable = 0;
  let last = null;
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) {
    const sum = await labelChecksum();
    if (sum === last && sum >= 0) stable += 1;
    else stable = 0;
    last = sum;
    if (stable >= 4) {
      settleMs = Date.now() - t0;
      break;
    }
    await page.waitForTimeout(1000);
  }
  console.log(`settle ${settleMs === null ? "NOT-SETTLED in 180s" : `${(settleMs / 1000).toFixed(1)}s`}`);
}

// --- physics spread: at 50k nodes every vertex starts stacked in one blob;
// give the force layout time to expand before camera-fixing and measuring.
{
  const spreadWait = parseInt(process.env.SPREAD_WAIT_MS ?? "150000", 10);
  console.log(`step: spread wait ${spreadWait}ms`);
  await page.waitForTimeout(spreadWait);
}

// --- fixed camera: dock recenter, then identical zoom for both renderers -----
console.log("step: recenter");
await page.click('button[aria-label="Recenter"]', { timeout: 15_000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `/tmp/graph-loadtest-${RENDERER}-settled.png` }).catch(() => {});
console.log("step: recenter done");

const frames = () => page.evaluate(() => window.__frames).catch(() => 0);

// --- pan fps: 5s middle-drag across the canvas --------------------------------
const panFps = await (async () => {
  const f0 = await frames();
  await page.mouse.move(800, 500);
  await page.mouse.down({ button: "middle" });
  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(800 - 24 * i, 500 - 6 * i);
    await page.waitForTimeout(200);
  }
  await page.mouse.up({ button: "middle" });
  const f1 = await frames();
  const fps = (f1 - f0) / 5;
  console.log(`pan ${fps.toFixed(1)} fps (${f1 - f0} frames / 5s)`);
  return fps;
})();

// --- zoom fps: 5s of wheel bursts over the canvas ------------------------------
const zoomFps = await (async () => {
  console.log("step: zoom");
  await page.mouse.move(800, 500);
  const f0 = await frames();
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(500);
  }
  const f1 = await frames();
  const fps = (f1 - f0) / 5;
  console.log(`zoom ${fps.toFixed(1)} fps (${f1 - f0} frames / 5s)`);
  return fps;
})();

// --- hover latency: label canvas reacts to a mousemove near center ------------
// Tries several positions — after the zoom phase the view is zoomed in, but a
// position can still land on empty canvas. First position that flips the
// label checksum wins; null means no position registered within its budget.
console.log("step: hover");
const hoverMs = await (async () => {
  const positions = [
    [800, 500],
    [700, 450],
    [900, 550],
    [650, 600],
    [950, 400],
  ];
  for (const [x, y] of positions) {
    const before = await labelChecksum();
    const t0 = Date.now();
    await page.mouse.move(x - 5, y + 5);
    await page.mouse.move(x, y);
    for (let i = 0; i < 30; i++) {
      const sum = await labelChecksum();
      if (sum !== before && sum >= 0) return Date.now() - t0;
      await page.waitForTimeout(100);
    }
  }
  return null;
})().then((v) => {
  console.log(v === null ? "hover not registered at any position" : `hover ${(v / 1000).toFixed(2)}s`);
  return v;
});

await page.waitForTimeout(1000);
const final = await graphInfo();
const shot = `/tmp/graph-loadtest-${RENDERER}.png`;
await page.screenshot({ path: shot });
console.log(`counts final: "${final.counts}" error: ${final.error ?? "none"}`);

const result = {
  renderer: RENDERER,
  bootMs,
  firstPaintMs,
  settleMs,
  panFps: Math.round(panFps * 10) / 10,
  zoomFps: Math.round(zoomFps * 10) / 10,
  hoverMs,
  counts: final.counts,
  graphError: final.error,
  errorCount: errors.length,
  errors: errors.slice(0, 15),
  screenshot: shot,
};
console.log("RESULT " + JSON.stringify(result));
await context.close();
