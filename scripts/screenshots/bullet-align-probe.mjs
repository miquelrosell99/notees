import { chromium } from "playwright";
const BASE = process.env.PROBE_BASE ?? "http://localhost:8378";
const PAGE_ID = process.env.PROBE_PAGE_ID;
if (!PAGE_ID) throw new Error("PROBE_PAGE_ID is required");
const CLICK_RAIL = process.env.PROBE_CLICK_RAIL === "1";
const browser = await chromium.launch({ headless: true });
const login = await fetch("http://localhost:8377/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }) });
const { token } = await login.json();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", ws);
}, ["http://localhost:8377", token, "c491595f-9f94-5ade-a620-e30ed063d8d2"]);
await page.goto(`${BASE}/${PAGE_ID}`, { waitUntil: "commit", timeout: 60_000 });
await page.waitForSelector(".nt-block-row", { timeout: 40_000 });
await page.waitForTimeout(3000);

const measure = () => page.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll(".nt-block-row")) {
    const dot = row.querySelector(":scope > .nt-block-grip .nt-bullet-dot");
    const content = row.querySelector(":scope > .nt-block-content");
    if (!dot || !content) continue;
    const range = document.createRange();
    range.selectNodeContents(content);
    const lineRect = Array.from(range.getClientRects()).sort(
      (a, b) => a.top - b.top || a.left - b.left,
    )[0];
    if (!lineRect) continue;
    const dotRect = dot.getBoundingClientRect();
    out.push({
      text: content.textContent.trim().slice(0, 40),
      dotCenter: +(dotRect.top + dotRect.height / 2).toFixed(2),
      lineCenter: +(lineRect.top + lineRect.height / 2).toFixed(2),
      delta: +((dotRect.top + dotRect.height / 2) - (lineRect.top + lineRect.height / 2)).toFixed(2),
      lineHeight: +lineRect.height.toFixed(2),
    });
    if (out.length >= 6) break;
  }
  return out;
});

console.log("BEFORE:", JSON.stringify(await measure(), null, 1));

if (CLICK_RAIL) {
  const railInfo = await page.evaluate(() => {
    const rail = document.querySelector(".nt-block-children__rail");
    if (!rail) return null;
    const r = rail.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
  });
  console.log("RAIL:", JSON.stringify(railInfo));
  if (railInfo) {
    await page.mouse.click(railInfo.x, railInfo.y);
    await page.waitForTimeout(800);
    const childrenAfter = await page.evaluate(() => document.querySelectorAll(".nt-block-children").length);
    const collapsedRing = await page.evaluate(() => document.querySelectorAll(".nt-bullet--collapsed").length);
    console.log("AFTER RAIL CLICK — children containers:", childrenAfter, "| collapsed bullets:", collapsedRing);
    await page.screenshot({ path: "/tmp/rail-after-click.jpg", type: "jpeg", quality: 85 });
  }
}

await page.screenshot({ path: "/tmp/bullet-align.jpg", type: "jpeg", quality: 85 });
await browser.close();
