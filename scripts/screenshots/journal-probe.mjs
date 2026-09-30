import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
page.on("pageerror", (e) => console.log("page error:", String(e).slice(0, 200)));
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

// 1. Default boot view = journals feed
console.log("url after enter:", page.url());
console.log("journals view:", await page.locator(".journals-view").isVisible());
console.log("journal entries:", await page.locator(".journal-entry").count());
const anchor = await page.locator(".journal-entry[data-anchor='true']").count();
console.log("anchor entry present:", anchor === 1);
await page.screenshot({ path: "/tmp/journal-feed.jpg", type: "jpeg", quality: 85 });

// 2. Calendar popup
await page.getByRole("button", { name: "Toggle calendar" }).click();
await page.waitForTimeout(600);
const popup = page.locator(".calendar-popup");
console.log("calendar popup:", await popup.isVisible());
console.log("has-note days:", await popup.locator(".calendar-day.has-note").count());
await page.screenshot({ path: "/tmp/calendar-popup.jpg", type: "jpeg", quality: 85 });
// Pick today → opens today's page in page view
const todayBtn = popup.locator(".calendar-day.today");
await todayBtn.click();
await page.waitForTimeout(4000);
console.log("url after picking today:", page.url());
console.log("page view title:", await page.locator(".nt-page-title, .nt-page-title-link").first().textContent());

// 3. /journal route + reload
await page.goto("http://127.0.0.1:8378/journal");
await page.waitForTimeout(5000);
console.log("url at /journal:", page.url());
console.log("journals visible at /journal:", await page.locator(".journals-view").isVisible());
await page.reload({ waitUntil: "commit" });
await page.waitForTimeout(9000);
console.log("url after reload:", page.url());
console.log("journals visible after reload:", await page.locator(".journals-view").isVisible());

// 4. /inbox route + reload
await page.goto("http://127.0.0.1:8378/inbox");
await page.waitForTimeout(4000);
console.log("inbox hub:", await page.locator(".nt-hub").isVisible());
await page.reload({ waitUntil: "commit" });
await page.waitForTimeout(8000);
console.log("url after inbox reload:", page.url());
console.log("inbox hub after reload:", await page.locator(".nt-hub").isVisible());
await browser.close();
