// Dialog-radius evidence probe — the `/`-filter palette chrome and a fleet
// Modal, captured at 1440 with the computed border-radius read live.
// Evidence for the 2026-10-22 dialog-corner ruling (28px → 16px).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:8377";
const WEB = "http://localhost:5199";
const TEST_WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const STACK = "/etc/periphery/stacks/notees/config/notees";
const PASSWORD = readFileSync(`${STACK}/.admin_password`, "utf8").trim();
const EMAIL = "miquelroselltarrago@gmail.com";

const login = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const { token } = await login.json();
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ({ api, token, ws }) => {
      localStorage.setItem("notees.serverUrl", api);
      localStorage.setItem("notees.sessionToken", token);
      localStorage.setItem("notees.workspaceId", ws);
      localStorage.setItem("notees.theme", "dark");
    },
    { api: API, token, ws: TEST_WS },
  );
  const page = await context.newPage();
  await page.goto(`${WEB}/`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForSelector(".nt-app", { timeout: 60_000 });
  await page.waitForTimeout(12_000);

  // 1) The command palette (.nt-modal chrome).
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".nt-modal", { timeout: 15_000 });
  await page.waitForTimeout(600);
  const palette = await page.evaluate(() => getComputedStyle(document.querySelector(".nt-modal")).borderRadius);
  await page.screenshot({ path: "/tmp/dialog-radius-palette.png" });

  // 2) A fleet Modal (the class-create dialog, opened from the palette).
  await page.keyboard.type("new class");
  await page.waitForTimeout(400);
  const row = page.locator(".nt-palette-item-label", { hasText: "New class" }).first();
  await row.click();
  await page.waitForSelector(".modal", { timeout: 15_000 });
  await page.waitForTimeout(600);
  const fleet = await page.evaluate(() => getComputedStyle(document.querySelector(".modal")).borderRadius);
  await page.screenshot({ path: "/tmp/dialog-radius-fleet-modal.png" });

  console.log(JSON.stringify({ paletteRadius: palette, fleetModalRadius: fleet }));
  console.log(
    palette === "16px" && fleet === "16px"
      ? "PROBE-PASS: both dialog surfaces ride the 16px dialog register"
      : "PROBE-FAIL",
  );
} finally {
  await browser.close().catch(() => {});
}
