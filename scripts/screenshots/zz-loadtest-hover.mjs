// Hover-latency diagnostic for the graph load test. The label-canvas checksum
// proved insensitive (hover may not alter the label overlay when labels are
// already dense), so this detects hover via a SCREENSHOT clip diff around the
// cursor: node hover repaints the neighborhood in the accent color on the GL
// canvas, and page.screenshot captures the composited frame (drawImage on a
// WebGL canvas without preserveDrawingBuffer reads blank — screenshots do not).
//
//   RENDERER=webgl|pixi node zz-loadtest-hover.mjs
// Assumes the graph is opened at /graph after boot; drives its own session.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:8377";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const RENDERER = process.env.RENDERER ?? "webgl";
const PASSWORD =
  process.env.NOTEES_ADMIN_PASSWORD ??
  readFileSync("/etc/periphery/stacks/notees/config/notees/.admin_password", "utf8").trim();

const { token: SESSION } = await (
  await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: PASSWORD }),
  })
).json();

const context = await chromium.launchPersistentContext("/tmp/graph-loadtest-profile", {
  headless: true,
  viewport: { width: 1600, height: 1000 },
  args: ["--disable-dev-shm-usage", "--use-gl=angle", "--enable-unsafe-swiftshader"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.addInitScript(
  ([token, ws, renderer]) => {
    localStorage.setItem("notees.serverUrl", location.origin);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
    localStorage.setItem("notees.theme", "dark");
    localStorage.setItem("notees.settings.graphPrefs.full", JSON.stringify({ renderer }));
  },
  [SESSION, WS, RENDERER],
);

await page.goto("http://localhost:8378/graph", { waitUntil: "commit", timeout: 120_000 });
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  const counts = await page.evaluate(() => document.querySelector(".nt-graph__counts")?.textContent ?? null);
  if (counts !== null && /25,\d{3} edges/.test(counts)) break;
}
await page.click('button[aria-label="Recenter"]').catch(() => {});
await page.waitForTimeout(2000);
// Zoom in a little so nodes have visible radius (overview at 50k renders
// sub-pixel points without per-node hover affordance).
await page.mouse.move(800, 500);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(2000);

const clipHash = async (x, y) => {
  const buf = await page.screenshot({ clip: { x: x - 100, y: y - 100, width: 200, height: 200 } });
  let h = 0;
  for (const b of buf) h = (h * 31 + b) % 1_000_003;
  return h;
};

const positions = [
  [800, 500],
  [640, 420],
  [960, 580],
  [700, 650],
  [900, 380],
  [800, 620],
  [760, 400],
];
const results = [];
for (const [x, y] of positions) {
  await page.mouse.move(x + 8, y + 8);
  await page.waitForTimeout(400);
  const before = await clipHash(x, y);
  const t0 = Date.now();
  let latency = null;
  for (let i = 0; i < 100; i++) {
    await page.mouse.move(i % 2 === 0 ? x : x + 2, i % 2 === 0 ? y : y + 2);
    const h = await clipHash(x, y);
    if (h !== before) {
      latency = Date.now() - t0;
      break;
    }
    await page.waitForTimeout(100);
  }
  results.push({ position: [x, y], latencyMs: latency });
  console.log(`hover @${x},${y}: ${latency === null ? "no reaction in 10s" : `${latency}ms`}`);
  if (latency !== null) break; // one clean measurement is enough
}
await page.screenshot({ path: `/tmp/graph-loadtest-hover-${RENDERER}.png` });
console.log("HOVER_RESULT " + JSON.stringify({ renderer: RENDERER, results }));
await context.close();
