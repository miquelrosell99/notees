// One-shot: measure the active tab's TEXT-run center vs the indicator center.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const TEST_WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const STACK = "/etc/periphery/stacks/notees/config/notees";
const PASSWORD = readFileSync(`${STACK}/.admin_password`, "utf8").trim();
const login = await fetch(API + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: PASSWORD }) });
const { token } = await login.json();
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(({ api, token, ws }) => {
    localStorage.setItem("notees.serverUrl", api); localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws); localStorage.setItem("notees.theme", "dark");
  }, { api: API, token, ws: TEST_WS });
  const page = await context.newPage();
  await page.goto(`${WEB}/`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForSelector(".nt-app", { timeout: 60_000 });
  await page.waitForTimeout(12_000);
  // Any page with an expanded hosted section: open the most recent ProbeTarget.
  const res = await fetch(`${API}/api/objects?q=ProbeTarget&limit=1`, { headers: { authorization: `Bearer ${token}` } });
  const list = await res.json();
  const objs = list.objects ?? list;
  const target = objs[0]?.id;
  if (!target) { console.log("no probe target found"); process.exit(1); }
  await page.goto(`${WEB}/${target}`, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForTimeout(4000);
  const unlinked = page.getByRole("button", { name: /Unlinked mentions/ }).first();
  if (await unlinked.count() > 0 && (await unlinked.getAttribute("aria-expanded")) === "false") await unlinked.click();
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const tab = document.querySelector('.tabs__tab[data-state="active"]');
    const indicator = document.querySelector(".tabs__indicator");
    if (!tab || !indicator) return { error: "missing elements" };
    const label = tab.querySelector(".tabs__tab-label");
    const first = label?.firstChild;
    let textRect = null;
    if (first && first.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.selectNodeContents(first);
      textRect = r.getBoundingClientRect();
    }
    const ir = indicator.getBoundingClientRect();
    const lr = label.getBoundingClientRect();
    return {
      text: textRect ? { x: textRect.x, w: textRect.width, cx: textRect.x + textRect.width / 2 } : null,
      labelCx: lr.x + lr.width / 2,
      indicatorCx: ir.x + ir.width / 2,
      deltaTextVsIndicator: textRect ? Math.round((ir.x + ir.width / 2) - (textRect.x + textRect.width / 2)) : null,
    };
  });
  console.log(JSON.stringify(m, null, 1));
} finally {
  await browser.close().catch(() => {});
}
