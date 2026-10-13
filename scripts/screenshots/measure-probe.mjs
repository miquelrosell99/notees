// measure-probe.mjs — DURABLE live-chrome measurement probe.
//
// Measures the shell/page chrome spacing (and any extra selectors passed as
// CLI args) against the LOCAL live stack, in px, and dumps the numbers as
// JSON plus a screenshot. This is how "the padding looks wrong" reports get
// grounded before touching CSS — see docs/developers/ui-debugging.md.
//
// Usage (from THIS directory — playwright resolves here only):
//   node measure-probe.mjs [extraSelector ...]
//
// Auth, in order:
//   1. NOTEES_ADMIN_PASSWORD (+ NOTEES_ADMIN_EMAIL) → login API session
//      (the boot-probe idiom).
//   2. Fallback: a temporary session row is minted straight into the relay
//      DB (better-sqlite3 resolved from packages/store), used for the run,
//      and DELETED in a finally. The operator API key is NOT a UI credential
//      — account endpoints (listWorkspaces/fetchMe) answer it 401.
//
// Workspace law: always the test workspace — never the personal default.
// Env overrides: NOTEES_RELAY_DB, NOTEES_WEB, NOTEES_SYNC, NOTEES_THEME,
// NOTEES_SHOT_PATH.

import { chromium } from "playwright";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = process.env.NOTEES_SYNC ?? "http://localhost:8377";
const WEB = process.env.NOTEES_WEB ?? "http://localhost:8378";
const TEST_WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RELAY_DB = process.env.NOTEES_RELAY_DB ?? path.join(REPO_ROOT, "config/notees/sync/relay.db");
const SHOT = process.env.NOTEES_SHOT_PATH ?? "/tmp/measure-probe.jpg";
const extraSels = process.argv.slice(2);

const requireFromStore = createRequire(path.join(REPO_ROOT, "packages/store/package.json"));

/** The default chrome set — the recurring spacing questions. */
const DEFAULT_SET = [
  { name: "shell-topbar", sel: ".nt-topbar", firstButton: true },
  { name: "page-card", sel: ".nt-page-card" },
  { name: "node-topbar", sel: ".nt-node-topbar", firstButton: true },
  { name: "page-body", sel: ".nt-page--panelled .nt-page-body" },
  { name: "side-panel", sel: ".nt-page-side-panel" },
  { name: "context-panel", sel: ".nt-page-context" },
  { name: "sidebar", sel: ".nt-sidebar" },
  { name: "sidebar-bottom", sel: ".nt-sidebar-bottom" },
  { name: "sidebar-profile", sel: ".nt-sidebar-bottom .nt-profile" },
];

// ─── session acquisition ───────────────────────────────────────────────────

async function sessionFromLogin() {
  const password = process.env.NOTEES_ADMIN_PASSWORD;
  if (!password) return null;
  const email = process.env.NOTEES_ADMIN_EMAIL ?? firstUserEmail();
  const res = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const { token } = await res.json();
  if (typeof token !== "string" || token === "") throw new Error("login returned no token");
  return { token, cleanup: null };
}

function firstUserEmail() {
  const Database = requireFromStore("better-sqlite3");
  const db = new Database(RELAY_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT email FROM "user" ORDER BY created_at LIMIT 1').get();
    if (!row) throw new Error(`no user rows in ${RELAY_DB}`);
    return row.email;
  } finally {
    db.close();
  }
}

/** Mint a temporary session row in the relay DB; returns token + cleanup. */
function sessionFromDbMint() {
  const Database = requireFromStore("better-sqlite3");
  const db = new Database(RELAY_DB);
  const user = db.prepare('SELECT id FROM "user" ORDER BY created_at LIMIT 1').get();
  if (!user) {
    db.close();
    throw new Error(`no user rows in ${RELAY_DB}`);
  }
  const token = `nt_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  db.prepare(
    "INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hash, user.id, Date.now(), Date.now() + 24 * 3600 * 1000);
  db.close();
  return {
    token,
    cleanup() {
      const d = new Database(RELAY_DB);
      try {
        d.prepare("DELETE FROM session WHERE token_hash = ?").run(hash);
      } finally {
        d.close();
      }
    },
  };
}

// ─── probe ─────────────────────────────────────────────────────────────────

const auth = (await sessionFromLogin()) ?? sessionFromDbMint();
const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(
    ({ api, token, ws, theme }) => {
      localStorage.setItem("notees.serverUrl", api);
      localStorage.setItem("notees.sessionToken", token);
      localStorage.setItem("notees.workspaceId", ws);
      localStorage.setItem("notees.theme", theme);
    },
    { api: API, token: auth.token, ws: TEST_WS, theme: process.env.NOTEES_THEME ?? "dark" },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE-ERR", String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE-ERR", m.text().slice(0, 200));
  });
  await page.goto(WEB, { waitUntil: "commit", timeout: 60_000 });
  await page.waitForSelector(".nt-app", { timeout: 90_000 });

  // Full chrome needs a page open: Today (the day page) when the nav offers it.
  await page.waitForTimeout(10_000); // snapshot restore + sync settle — don't skimp
  const today = page.getByRole("button", { name: /^today$/i }).first();
  if (await today.count()) {
    await today.click();
    await page.waitForTimeout(6_000);
  }

  const set = [
    ...DEFAULT_SET,
    ...extraSels.map((sel) => ({ name: sel, sel })),
  ];
  const report = await page.evaluate((set) => {
    const round = (n) => Math.round(n * 10) / 10;
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: round(r.top), right: round(r.right),
        bottom: round(r.bottom), left: round(r.left),
        width: round(r.width), height: round(r.height),
      };
    };
    const boxOf = (el) => {
      const cs = getComputedStyle(el);
      return {
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        marginTop: cs.marginTop,
        gap: cs.gap,
      };
    };
    const out = {};
    for (const { name, sel, firstButton } of set) {
      const el = document.querySelector(sel);
      if (!el) {
        out[name] = null;
        continue;
      }
      const entry = { ...rectOf(el), ...boxOf(el) };
      if (firstButton) {
        const btn = el.querySelector("button");
        if (btn) entry.firstButtonTop = round(btn.getBoundingClientRect().top);
      }
      out[name] = entry;
    }
    // Derived gaps — the numbers a spacing report actually quotes.
    const g = (a, b) => (out[a] && out[b] ? round(out[b].top - out[a].bottom) : null);
    out.__gaps = {
      "topbar-bottom→card-top": g("shell-topbar", "page-card"),
      "card-top→node-topbar-btn": null,
      "node-topbar-bottom→body-top": g("node-topbar", "page-body"),
      "card-left→side-panel-left": null,
      "sidebar-bottom→viewport-bottom": null,
    };
    if (out["page-card"] && out["node-topbar"]?.firstButtonTop != null) {
      out.__gaps["card-top→node-topbar-btn"] = round(
        out["node-topbar"].firstButtonTop - out["page-card"].top,
      );
    }
    if (out["page-card"] && out["side-panel"]) {
      out.__gaps["card-left→side-panel-left"] = round(
        out["side-panel"].left - out["page-card"].left,
      );
    }
    if (out["sidebar-bottom"]) {
      out.__gaps["sidebar-bottom→viewport-bottom"] = round(1000 - out["sidebar-bottom"].bottom);
    }
    return out;
  }, set);
  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: SHOT, type: "jpeg", quality: 85 });
  console.log("screenshot:", SHOT);
} catch (err) {
  failed = true;
  console.error("MEASURE-PROBE-FAIL", String(err).slice(0, 300));
} finally {
  await browser.close();
  auth.cleanup?.();
  if (failed) process.exit(1);
}
