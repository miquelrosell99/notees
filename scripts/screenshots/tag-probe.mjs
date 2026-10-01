import { chromium } from "playwright";
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
await page.waitForTimeout(6000);
// Open today's page via the calendar (ensure-chain creates it), then edit a block.
await page.getByRole("button", { name: "Toggle calendar" }).click();
await page.waitForTimeout(700);
await page.locator(".calendar-popup .calendar-day.today").click();
await page.waitForTimeout(4500);
const addBlock = page.locator(".nt-add-block").first();
if (await addBlock.isVisible().catch(() => false)) {
  await addBlock.click();
  await page.waitForTimeout(800);
} else {
  // Page already has content: click into the last block and append a new line via Enter.
  await page.locator("[data-block-id] .nt-block-content").last().dispatchEvent("click");
  const editable0 = page.locator("[contenteditable='true']").last();
  await editable0.waitFor({ timeout: 5000 });
  await editable0.click();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}
await page.locator("[data-block-id] .nt-block-content").last().dispatchEvent("click");
const editable = page.locator("[contenteditable='true']").last();
await editable.waitFor({ timeout: 5000 });
await editable.click();
await page.keyboard.type("#probetag");
await page.waitForTimeout(700);
console.log("capture popup visible:", await page.locator(".nt-capture-popup").isVisible().catch(() => false));
await page.keyboard.press("Enter");
await page.waitForTimeout(1800);
const metas = await page.locator(".nt-block > .node-metadata-section").allTextContents();
console.log("block metadata sections:", metas.map((t) => t.slice(0, 100)));
await page.screenshot({ path: "/tmp/tag-probe.jpg", type: "jpeg", quality: 85 });
await browser.close();
