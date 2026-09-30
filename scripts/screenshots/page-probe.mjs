import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const login = await fetch("http://127.0.0.1:8377/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }) });
const { token } = await login.json();
await page.addInitScript(([url, t]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", "3b30e070-039b-47bc-ad0d-2440a2f173c5");
}, ["http://127.0.0.1:8377", token]);
await page.goto("http://127.0.0.1:8378", { waitUntil: "commit", timeout: 60_000 });
await page.waitForTimeout(11000);
// Open the Pages hub, then the first page in it.
await page.getByRole("button", { name: /^Pages$/ }).click();
await page.waitForTimeout(600);
await page.locator(".nt-hub-item").first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/page-dark.jpg", type: "jpeg", quality: 85 });
const body = await page.evaluate(() => document.body.innerText);
console.log("url:", await page.evaluate(() => location.pathname), "| metadata:", body.toLowerCase().includes("metadata"), "| linked refs:", body.toLowerCase().includes("linked references"));
await page.keyboard.press("Control+k");
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/palette-dark.jpg", type: "jpeg", quality: 85 });
console.log("palette open:", (await page.evaluate(() => document.body.innerText)).toLowerCase().includes("search"));
await browser.close();
