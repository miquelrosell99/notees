// Hairline diagnostic v2: open the owner's real page (read-only, no writes)
// and scan the whole nodeview for full-width 1px horizontal rules (borders /
// gradient backgrounds). Logs each candidate's selector path + box.
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const TARGET = process.env.PROBE_TARGET ?? "Proyecto Transición a MDR";

const loginRes = await fetch(API + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
const { token: SESSION } = await loginRes.json();

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
await page.addInitScript(([url, token, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", token);
  localStorage.setItem("notees.workspaceId", ws);
  localStorage.setItem("notees.theme", "dark");
}, [API, SESSION, WS]);
try {
  await page.goto(WEB, { waitUntil: "commit", timeout: 120000 });
  await page.waitForFunction(() => document.body.innerText.length > 500, undefined, { timeout: 900000 });
  await page.waitForTimeout(2000);
  await page.goto(`${WEB}/${process.env.PROBE_NODE ?? ""}`, { waitUntil: "commit", timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.length > 500, undefined, { timeout: 900000 });
  await page.waitForTimeout(3000);

  const sections = await page.evaluate(() => {
    return [...document.querySelectorAll("section.node-metadata-section")].map((sec) => {
      const block = sec.closest(".nt-block");
      const rowText = block?.querySelector(".nt-block-content")?.textContent?.slice(0, 50) ?? null;
      return {
        header: sec.querySelector(".node-view-section__header")?.textContent?.trim().replace(/\s+/g, " ") ?? null,
        blockText: rowText,
        classes: block?.className ?? null,
      };
    });
  });
  for (const sec of sections) console.log("SECTION:", JSON.stringify(sec));
  const report = await page.evaluate(() => {
    const hits = [];
    const path = (el) => {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) seg += "#" + cur.id;
        if (cur.classList && cur.classList.length) seg += "." + [...cur.classList].slice(0, 3).join(".");
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    };
    const scope = document.querySelector(".nt-nodeview-body") ?? document.body;
    for (const el of scope.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const bg = cs.backgroundImage || "";
      const grad = bg.includes("linear-gradient");
      const r = el.getBoundingClientRect();
      const bgc = cs.backgroundColor;
      const sliver = r.height <= 3 && r.width >= 200 && bgc !== "rgba(0, 0, 0, 0)" && bgc !== "transparent";
      if (r.width < 200) continue; // hairline candidates span real width
      if (bt > 0 || bb > 0 || grad || sliver) {
        hits.push({
          sel: path(el),
          borderTop: cs.borderTopWidth,
          borderBottom: cs.borderBottomWidth,
          gradient: grad ? bg.slice(0, 80) : null,
          sliver,
          bgColor: sliver ? bgc : null,
          box: `${Math.round(r.width)}x${Math.round(r.height)}@y${Math.round(r.top)}`,
        });
      }
    }
    return hits;
  });
  for (const h of report) console.log(JSON.stringify(h));
  await page.screenshot({ path: "/tmp/hairline-probe2.png" });
  console.log("HAIRLINE-PROBE-DONE", report.length, "candidates");
} finally {
  await browser.close();
}
