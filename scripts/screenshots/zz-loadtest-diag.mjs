// Short diagnostic: open the deployed app on the load-test profile, dump the
// loading-screen text + full console stream for ~5 min. Answers "what is the
// boot actually doing?" without touching the stack.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:8377";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const PASSWORD =
  process.env.NOTEES_ADMIN_PASSWORD ??
  readFileSync("/etc/periphery/stacks/notees/config/notees/.admin_password", "utf8").trim();

const { token: SESSION } = await (
  await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: PASSWORD }),
  })
).json();

const context = await chromium.launchPersistentContext("/tmp/graph-loadtest-profile", {
  headless: true,
  viewport: { width: 1600, height: 1000 },
  args: ["--disable-dev-shm-usage", "--use-gl=angle", "--enable-unsafe-swiftshader"],
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("console", (msg) => console.log(`[console.${msg.type()}]`, msg.text().slice(0, 300)));
page.on("pageerror", (err) => console.log("[pageerror]", err.message.slice(0, 300)));

await page.addInitScript(
  ([token, ws]) => {
    localStorage.setItem("notees.serverUrl", location.origin);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
    localStorage.setItem("notees.theme", "dark");
  },
  [SESSION, WS],
);

await page.goto("http://localhost:8378", { waitUntil: "commit", timeout: 120_000 });
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(10_000);
  const info = await page.evaluate(() => ({
    text: (document.body?.innerText ?? "").slice(0, 400),
    len: document.body?.innerText?.length ?? 0,
  })).catch((e) => ({ text: String(e), len: -1 }));
  console.log(`t+${(i + 1) * 10}s len=${info.len} text=${JSON.stringify(info.text.slice(0, 240))}`);
  if (info.len > 500) break;
}
await context.close();
