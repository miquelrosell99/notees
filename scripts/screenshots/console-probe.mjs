import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(m.text().slice(0, 300)); });
page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e).slice(0, 400)));
const login = await fetch("http://127.0.0.1:8377/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }) });
const { token } = await login.json();
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", ws);
}, ["http://127.0.0.1:8377", token, "3b30e070-039b-47bc-ad0d-2440a2f173c5"]);
await page.goto("http://127.0.0.1:8378/06a50e97-1d75-7419-8000-620911cd34c9", { waitUntil: "commit", timeout: 60_000 });
await page.waitForTimeout(15000);
console.log(JSON.stringify(logs.slice(0, 10), null, 1));
console.log("body children:", await page.evaluate(() => document.body.innerText.slice(0, 200)));
await browser.close();
