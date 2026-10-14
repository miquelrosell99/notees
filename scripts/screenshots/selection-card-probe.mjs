// Selection-card visibility probe: create a scratch page with 3 blocks in
// the TEST workspace, select all three in the UI, and verify the selection
// card actually RENDERS (pixel-samples the card's 2px top pad strip — if the
// underlay fell behind the opaque page-card backgrounds the strip reads as
// the page surface color; if it renders, the strip reads as the card tint).
// Hard timeouts; exits non-zero on failure; cleans up its scratch page.
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WEB = "http://localhost:8378";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2"; // the test workspace (law 8)
const KEY = (await import("node:fs")).readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();

const api = async (path, init) => {
  const r = await fetch(API + path, {
    method: init?.method ?? "GET",
    headers: { "x-api-key": KEY, "x-workspace-id": WS, "content-type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!r.ok) throw new Error(`api ${path}: ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};

const pageId = (await api("/api/objects", { method: "POST", body: { name: "Selection-card probe scratch", presentAsMain: true } })).id;
const blockIds = [];
try {
  for (const text of ["alpha", "beta", "gamma"]) {
    blockIds.push((await api("/api/objects", {
      method: "POST",
      body: { parentId: pageId, contentAst: [{ type: "text", text }] },
    })).id);
  }
  console.log("scratch page:", pageId, "blocks:", blockIds.length);

  const loginRes = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
  });
  if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
  const { token: SESSION } = await loginRes.json();

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pg = await context.newPage();
  const consoleErrors = [];
  pg.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  pg.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e).slice(0, 200)));
  await pg.addInitScript(([url, token, ws]) => {
    localStorage.setItem("notees.serverUrl", url);
    localStorage.setItem("notees.sessionToken", token);
    localStorage.setItem("notees.workspaceId", ws);
  }, [API, SESSION, WS]);

  await pg.goto(`${WEB}/${pageId}`, { waitUntil: "commit", timeout: 120_000 });
  // Wait for the three block rows to render (the deep link opens the page).
  await pg.waitForSelector(`[data-block-id="${blockIds[0]}"]`, { timeout: 60_000 });
  await pg.waitForSelector(`[data-block-id="${blockIds[2]}"]`, { timeout: 30_000 });
  console.log("page open with 3 blocks");

  // Select all three: click the first row, shift+click the third.
  const first = pg.locator(`[data-block-id="${blockIds[0]}"] .nt-block-content`);
  const third = pg.locator(`[data-block-id="${blockIds[2]}"] .nt-block-content`);
  await first.click();
  await third.click({ modifiers: ["Shift"] });
  await pg.waitForSelector(".nt-selection-outline", { timeout: 15_000 });
  console.log("selection card mounted");

  // Measure the card + the colors that decide visibility.
  const probe = await pg.evaluate(() => {
    const card = document.querySelector(".nt-selection-outline");
    if (card === null) throw new Error("no card");
    const r = card.getBoundingClientRect();
    const surface = card.closest(".nt-select-surface");
    const pageCard = card.closest(".nt-page");
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      cardBackground: getComputedStyle(card).backgroundColor,
      cardZIndex: getComputedStyle(card).zIndex,
      surfaceIsolation: surface === null ? "none" : getComputedStyle(surface).isolation,
      pageBackground: pageCard === null ? "none" : getComputedStyle(pageCard).backgroundColor,
    };
  });
  console.log("card probe:", JSON.stringify(probe));

  // Differential pixel check: sample a strip inside the card over the rows'
  // empty right side (short "alpha/beta/gamma" text), screenshot it WITH the
  // card and with the card display:none'd. If the underlay renders, the two
  // differ (tint vs the page behind); if it hides behind the page card's
  // opaque background, they are identical.
  const stripBox = await pg.evaluate(() => {
    const card = document.querySelector(".nt-selection-outline");
    if (card === null) throw new Error("no card");
    const r = card.getBoundingClientRect();
    return { x: r.right - 70, y: r.top + 3, width: 50, height: r.height - 6 };
  });
  const sample = async () => {
    const shot = await pg.screenshot({ clip: stripBox });
    return pg.evaluate(async (dataUrl) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      let rr = 0, gg = 0, bb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n += 1;
      }
      return [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)];
    }, `data:image/png;base64,${shot.toString("base64")}`);
  };
  const withCard = await sample();
  await pg.evaluate(() => {
    const card = document.querySelector(".nt-selection-outline");
    if (card !== null) card.style.display = "none";
  });
  const withoutCard = await sample();
  await pg.evaluate(() => {
    const card = document.querySelector(".nt-selection-outline");
    if (card !== null) card.style.display = "";
  });
  console.log("strip with card:", withCard, " without card:", withoutCard);
  const delta = Math.abs(withCard[0] - withoutCard[0]) + Math.abs(withCard[1] - withoutCard[1]) + Math.abs(withCard[2] - withoutCard[2]);
  if (delta < 12) throw new Error(`strip identical with/without the card (delta ${delta}) — the card renders INVISIBLE`);
  console.log(`strip delta ${delta} — the card is visibly tinting its region`);
  if (consoleErrors.length > 0) throw new Error("console errors: " + consoleErrors.join(" | "));
  console.log("PROBE-PASS: the selection card is visible");
  await browser.close();
} finally {
  await fetch(`${API}/api/objects/${pageId}`, {
    method: "DELETE",
    headers: { "x-api-key": KEY, "x-workspace-id": WS },
  }).catch(() => {});
  console.log("scratch page deleted");
}
