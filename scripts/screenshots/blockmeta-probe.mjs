import { chromium } from "playwright";
const PAGE = process.env.PROBE_PAGE;
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.goto("http://127.0.0.1:8378/login", { waitUntil: "commit", timeout: 60_000 });
const urlBox = page.getByRole("textbox", { name: /server url/i });
await urlBox.waitFor({ timeout: 30_000 });
await urlBox.fill("http://127.0.0.1:8377");
await page.getByRole("button", { name: /^continue$/i }).click();
await page.getByRole("textbox", { name: /email/i }).waitFor({ timeout: 15_000 });
await page.getByRole("textbox", { name: /email/i }).fill("miquelroselltarrago@gmail.com");
await page.getByRole("textbox", { name: /password/i }).fill(process.env.NOTEES_ADMIN_PASSWORD ?? "");
await page.getByRole("button", { name: /^sign in$/i }).click();
await page.waitForURL(/\/workspaces$/, { timeout: 20_000 });
await page.getByRole("button", { name: /open notas/i }).click();
await page.waitForSelector(".nt-topbar", { timeout: 40_000 });
await page.waitForTimeout(5000);
await page.goto(`http://127.0.0.1:8378/${PAGE}`);
await page.waitForTimeout(5000);
const info = await page.evaluate(() => {
  const blocks = Array.from(document.querySelectorAll("[data-block-id]")).map((el) => {
    const meta = el.querySelector(":scope > .node-metadata-section");
    return {
      text: el.querySelector(".nt-block-content")?.textContent?.slice(0, 40) ?? null,
      hasMetadata: meta !== null,
      metaText: meta?.textContent?.slice(0, 60) ?? null,
    };
  });
  return blocks;
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: "/tmp/block-meta.jpg", type: "jpeg", quality: 85 });
await browser.close();
