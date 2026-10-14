// One-shot verification for the experimental Pixi graph renderer: seed the
// graphPrefs renderer flag via localStorage (device setting), open the graph
// in the TEST workspace against a LOCAL preview build (the deployed stack
// still carries the pre-Pixi bundle), and confirm the graph paints, the
// canvas2d label overlay still draws, and the console stays clean.
// Auth: the host-local admin credential (config/notees/.admin_password per
// the deployment runbook — exported as NOTEES_ADMIN_PASSWORD by the caller),
// exchanged for a session against the sync server (the preview proxies /api).
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = process.env.WEB_URL ?? "http://localhost:8478"; // vite preview of the local build
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2"; // test workspace (law 8)

const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
const { token: SESSION } = await loginRes.json();
if (!SESSION) throw new Error("login failed: " + loginRes.status);

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--use-gl=angle", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const errors = [];
page.on("console", (msg) => { if (msg.type() !== "log") errors.push(`console.${msg.type()}: ` + msg.text()); });
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
page.on("requestfailed", (req) => errors.push("requestfailed: " + req.url() + " " + (req.failure()?.errorText ?? "")));

await page.addInitScript(([token, ws]) => {
  // Same-origin server (the preview proxies /api to the sync server) — the
  // sync server's CORS allow-list only carries the deployed origin.
  localStorage.setItem("notees.serverUrl", location.origin);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
  localStorage.setItem("notees.theme", "dark");
  // The flag under test — the full graph surface's device prefs.
  localStorage.setItem("notees.settings.graphPrefs.full", JSON.stringify({ renderer: "pixi" }));
}, [SESSION, WS]);

await page.goto(WEB, { waitUntil: "commit", timeout: 120000 });
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  const len = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => -1);
  console.log(`boot t+${(i + 1) * 5}s bodyText=${len}`);
  if (len > 500) break;
}
await page.waitForTimeout(2000);
await page.click('text=Graph', { timeout: 15000 });

// Sample the GL canvas + the label overlay (same 2D-copy trick as the diag probe).
const sample = async (label) => {
  const info = await page.evaluate(() => {
    const canvas = document.querySelector(".nt-graph__canvas");
    const counts = document.querySelector(".nt-graph__counts")?.textContent ?? null;
    const glError = document.querySelector(".nt-graph--error")?.textContent ?? null;
    let lit = -1;
    let litLabels = -1;
    if (canvas !== null) {
      const c2 = document.createElement("canvas");
      c2.width = 200; c2.height = 125;
      const ctx = c2.getContext("2d");
      ctx.drawImage(canvas, 0, 0, 200, 125);
      const d = ctx.getImageData(0, 0, 200, 125).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) n++;
      }
      lit = n;
      const lc = document.querySelector(".nt-graph__labels");
      if (lc !== null) {
        const c3 = document.createElement("canvas");
        c3.width = 200; c3.height = 125;
        const ctx3 = c3.getContext("2d");
        ctx3.drawImage(lc, 0, 0, 200, 125);
        const d3 = ctx3.getImageData(0, 0, 200, 125).data;
        let m = 0;
        for (let i = 3; i < d3.length; i += 4) { if (d3[i] > 10) m++; }
        litLabels = m;
      }
    }
    return { counts, glError, lit, litLabels, hasCanvas: canvas !== null };
  });
  console.log(label, JSON.stringify(info));
  return info;
};

const shots = [];
for (const [wait, label] of [[4000, "t+4s"], [6000, "t+10s"], [10000, "t+20s"], [10000, "t+30s"]]) {
  await page.waitForTimeout(wait);
  shots.push(await sample(label));
}
const shotPath = "/tmp/graph-pixi-probe.png";
await page.screenshot({ path: shotPath });

// Zoom into detail LOD: focus the surface and zoom in — edges, arrowheads,
// and full-size node circles only render at overview/detail zoom.
await page.click(".nt-graph__canvas", { position: { x: 800, y: 500 } });
for (let i = 0; i < 24; i++) {
  await page.keyboard.press("Equal");
  await page.waitForTimeout(250);
}
await page.waitForTimeout(1500);
const zoomed = await sample("zoomed-in");
await page.screenshot({ path: "/tmp/graph-pixi-probe-zoomed.png" });
console.log("zoomed:", JSON.stringify(zoomed));
console.log("lit samples:", shots.map((s) => s.lit).join(", "));
console.log("label samples:", shots.map((s) => s.litLabels).join(", "));
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
console.log("screenshots:", shotPath, "/tmp/graph-pixi-probe-zoomed.png");
await browser.close();
