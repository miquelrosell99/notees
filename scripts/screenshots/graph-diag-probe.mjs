// One-shot diagnostic: open the graph view in the TEST workspace, capture
// console/page errors, and sample the canvas over time (blank? moving? settled?).
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
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

await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
  localStorage.setItem("notees.theme", "dark");
}, [API, SESSION, WS]);

await page.goto(WEB, { waitUntil: "commit", timeout: 120000 });
// Boot can take minutes on a fresh headless profile (WASM + sync); watch progress.
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  const len = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => -1);
  console.log(`boot t+${(i + 1) * 5}s bodyText=${len}`);
  if (len > 500) break;
}
await page.waitForTimeout(2000);
await page.click('text=Graph', { timeout: 15000 });

// Sample the canvas pixels + counts line over time.
const sample = async (label) => {
  const info = await page.evaluate(() => {
    const canvas = document.querySelector(".nt-graph__canvas");
    const counts = document.querySelector(".nt-graph__counts")?.textContent ?? null;
    const loading = document.querySelector(".loading-screen")?.textContent ?? null;
    const glError = document.querySelector(".nt-graph--error")?.textContent ?? null;
    let lit = -1;
    let litLabels = -1;
    if (canvas !== null) {
      // sample via 2D copy (webgl canvas without preserveDrawingBuffer reads
      // blank — so draw the webgl canvas onto a 2d canvas via drawImage,
      // which composites the last presented frame)
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
    const workers = performance.getEntriesByType("resource").map((r) => r.name).filter((n) => /worker|engine/i.test(n));
    return { counts, loading, glError, lit, litLabels, hasCanvas: canvas !== null, workers };
  });
  console.log(label, JSON.stringify(info));
  return info;
};

const shots = [];
for (const [wait, label] of [[3000, "t+3s"], [5000, "t+8s"], [8000, "t+16s"], [10000, "t+26s"], [10000, "t+36s"]]) {
  await page.waitForTimeout(wait);
  shots.push(await sample(label));
}
await page.screenshot({ path: "/tmp/graph-diag-final.png" });
// Movement check: are later samples still changing?
console.log("lit samples:", shots.map((s) => s.lit).join(", "));
console.log("errors:", errors.length ? errors.slice(0, 10) : "none");
await browser.close();
