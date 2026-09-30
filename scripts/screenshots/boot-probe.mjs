import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem("notees.theme", t), theme);
  await page.goto("http://127.0.0.1:8378", { waitUntil: "commit", timeout: 60_000 });
  await page.getByRole("textbox", { name: /server url/i }).waitFor({ timeout: 30_000 });
  await page.getByRole("textbox", { name: /server url/i }).fill("http://127.0.0.1:8377");
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("textbox", { name: /email/i }).waitFor({ timeout: 15_000 });
  await page.getByRole("textbox", { name: /email/i }).fill("miquelroselltarrago@gmail.com");
  await page.getByRole("textbox", { name: /password/i }).fill("M&&72RF^D&3ah1J");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // Workspace picker
  await page.getByText(/Choose a workspace/i).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `/tmp/ws-${theme}.jpg`, type: "jpeg", quality: 85 });
  await page.getByRole("button", { name: /Notas/ }).first().click();
  await page.waitForTimeout(12000); // snapshot restore + settle
  await page.screenshot({ path: `/tmp/app-${theme}.jpg`, type: "jpeg", quality: 85 });
  const body = await page.evaluate(() => document.body.innerText);
  console.log(theme, "booted:", body.includes("NAVIGATION"), "| notas:", body.includes("Notas"), "| footer sync:", /Sync: (idle|syncing)/.test(body));
  await ctx.close();
}
await browser.close();
