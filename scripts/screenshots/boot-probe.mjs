import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 140)));
await page.goto("http://127.0.0.1:8378", { waitUntil: "commit", timeout: 60_000 });
const urlBox = page.getByRole("textbox", { name: /server url/i });
await urlBox.waitFor({ timeout: 30_000 });
console.log("1. prefill:", await urlBox.inputValue());
// 2. User-typed localhost (their own device from any other machine) → auto-retry must save it.
await urlBox.fill("http://localhost:8377");
await page.getByRole("button", { name: /^continue$/i }).click();
const emailBox = page.getByRole("textbox", { name: /email/i });
await emailBox.waitFor({ timeout: 15_000 });
console.log("2. localhost:8377 → auto-retried to", await urlBox.inputValue(), "→ login screen shown:", await emailBox.isVisible());
console.log("   tabs:", await page.evaluate(() => [...document.querySelectorAll(".nt-tab")].map((t) => t.textContent).join("/")));
// 3. API-key tab visible.
await page.getByRole("tab", { name: /api key/i }).click();
console.log("3. api-key tab:", await page.getByRole("button", { name: /sign in with key/i }).isVisible());
console.log("console errors:", errors.length ? errors : "none");
await page.screenshot({ path: "/tmp/boot-after.jpg", type: "jpeg", quality: 85 });
await browser.close();
