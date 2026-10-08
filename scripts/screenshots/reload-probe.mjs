import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 300)));
await page.goto("http://localhost:8378/login", { waitUntil: "commit", timeout: 60_000 });
const urlBox = page.getByRole("textbox", { name: /server url/i });
await urlBox.waitFor({ timeout: 30_000 });
await urlBox.fill("http://localhost:8377");
await page.getByRole("button", { name: /^continue$/i }).click();
await page.getByRole("textbox", { name: /email/i }).waitFor({ timeout: 15_000 });
await page.getByRole("textbox", { name: /email/i }).fill("miquelroselltarrago@gmail.com");
await page.getByRole("textbox", { name: /password/i }).fill(process.env.NOTEES_ADMIN_PASSWORD ?? "");
await page.getByRole("button", { name: /^sign in$/i }).click();
await page.waitForURL(/\/workspaces$/, { timeout: 20_000 });
await page.waitForTimeout(1000);
await page.reload({ waitUntil: "commit" });
for (const wait of [2000, 3000, 5000]) {
  await page.waitForTimeout(wait);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220);
  console.log(`t+${wait}: url=${page.url()} text="${text}"`);
}
await page.screenshot({ path: "/tmp/reload-workspaces.jpg", type: "jpeg", quality: 85 });
await browser.close();
