import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const login = await fetch("http://localhost:8377/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }) });
const { token } = await login.json();
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", ws);
}, ["http://localhost:8377", token, "c491595f-9f94-5ade-a620-e30ed063d8d2"]); // the test workspace (owner rule 2026-10-09 — never the "Notas" default)
await page.goto(`http://localhost:8378/${process.env.PROBE_PAGE_ID}`, { waitUntil: "commit", timeout: 60_000 });
await page.waitForTimeout(20000);
const info = await page.evaluate(() => {
  const classesRow = document.querySelector(".nt-classes-row");
  return {
    classesRow: classesRow ? classesRow.innerText.slice(0, 200) : null,
    pills: document.querySelectorAll(".nt-classes-row .pill").length,
    metadataText: (document.querySelector(".node-metadata-section")?.innerText ?? "").slice(0, 300),
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: "/tmp/table-check.jpg", type: "jpeg", quality: 85 });
await browser.close();
