import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const login = await fetch("http://127.0.0.1:8377/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }) });
const { token } = await login.json();
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", ws);
}, ["http://127.0.0.1:8377", token, "3b30e070-039b-47bc-ad0d-2440a2f173c5"]);
await page.goto("http://127.0.0.1:8378/000f60e3-00c3-4948-a626-f687223ec757", { waitUntil: "commit", timeout: 60_000 });
await page.waitForTimeout(11000);
const info = await page.evaluate(() => {
  const classesRow = document.querySelector(".nt-classes-row");
  return {
    classesRow: classesRow ? classesRow.innerText.slice(0, 200) : null,
    pills: document.querySelectorAll(".nt-classes-row .pill").length,
    metadataText: (document.querySelector(".node-metadata-section")?.innerText ?? "").slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
