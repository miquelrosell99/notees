/**
 * ui-session — the canonical authenticated app boot for UI diagnosis.
 *
 * THE CONNECT-SCREEN TRAP: any fresh browser
 * profile lands on the app's Connect screen, and agents that don't know
 * the resume contract loop there forever. This module is the ONE way to
 * boot the app for diagnosis: it signs in through the relay's login API,
 * seeds the three localStorage keys the resume effect reads, navigates,
 * and ASSERTS the workspace rendered — throwing with the exact recovery
 * hints if the Connect screen is still up.
 *
 * Usage (from scripts/screenshots/, where playwright resolves):
 *
 *   import { bootApp } from "./ui-session.mjs";
 *   const { page, browser } = await bootApp();          // env-driven
 *   const { page } = await bootApp({ headless: true }); // per-call overrides
 *
 * Env (every value has a fleet-host default — see resolveConfig):
 *   NOTEES_SERVER / NOTEES_WEB / NOTEES_WORKSPACE / NOTEES_API_KEY (+_FILE) /
 *   NOTEES_ADMIN_EMAIL / NOTEES_ADMIN_PASSWORD (+_FILE) / NOTEES_VERIFY_OUT
 *
 * Contract this encodes (mirrors verify-min.mjs, the screenshot probes):
 *   1. Login via POST /api/auth/login (email + admin password) → session token.
 *      Never brute-force the sign-in form: repeated bad passwords trip a
 *      per-email rate limit (429, 15-minute lockout). If the admin password
 *      is not at hand, the fallback is the bootstrap's API-key tab with the
 *      operator key — see docs/developers/ui-diagnosis.md.
 *   2. addInitScript seeds notees.serverUrl / notees.sessionToken /
 *      notees.workspaceId BEFORE any app script runs; the resume effect
 *      validates the token and auto-connects — no Connect click exists in
 *      this flow because none is needed.
 *   3. The ready signal is the app shell (sidebar chrome), not the URL: a
 *      fresh profile full-catch-ups the whole relay log before content —
 *      minutes on a big workspace. waitForAppReady polls the body instead
 *      of sleeping a fixed time.
 */

import { chromium } from "playwright";
import fs from "node:fs";
const ADMIN_EMAIL = process.env.NOTEES_ADMIN_EMAIL;
if (!ADMIN_EMAIL) throw new Error("NOTEES_ADMIN_EMAIL is required (the admin login email)");

const API_KEY_FILE =
  "/etc/periphery/stacks/notees/config/notees/sync/api_key.txt";

export function resolveConfig(overrides = {}) {
  const env = process.env;
  const apiKey =
    env.NOTEES_API_KEY ?? (fs.existsSync(API_KEY_FILE) ? fs.readFileSync(API_KEY_FILE, "utf8").trim() : undefined);
  const passwordFile = "/etc/periphery/stacks/notees/config/notees/.admin_password";
  const password =
    env.NOTEES_ADMIN_PASSWORD ??
    env.NOTEES_ADMIN_PASSWORD_FILE ??
    (fs.existsSync(passwordFile) ? fs.readFileSync(passwordFile, "utf8").trim() : undefined);
  return {
    serverUrl: overrides.serverUrl ?? env.NOTEES_SERVER ?? "http://localhost:8377",
    webUrl: overrides.webUrl ?? env.NOTEES_WEB ?? "http://localhost:8378",
    workspaceId: overrides.workspaceId ?? env.NOTEES_WORKSPACE ?? "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    apiKey,
    adminEmail: overrides.adminEmail ?? env.NOTEES_ADMIN_EMAIL ?? ADMIN_EMAIL,
    adminPassword: password,
    headless: overrides.headless ?? true,
  };
}

/** Sign in through the relay API (never the form — rate limits). */
export async function loginSession(config) {
  if (!config.adminPassword) {
    throw new Error(
      "ui-session: no admin password (NOTEES_ADMIN_PASSWORD/_FILE). " +
        "Fallback without it: the bootstrap's API-key tab with the operator key — " +
        "see docs/developers/ui-diagnosis.md.",
    );
  }
  const res = await fetch(`${config.serverUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  if (!res.ok) throw new Error(`ui-session: login ${res.status} against ${config.serverUrl}`);
  const { token } = await res.json();
  return token;
}

/**
 * Boot the app into the workspace. Resolves { browser, page, config } with
 * the page past the Connect screen and the app shell rendered (or throws —
 * never leaves an agent parked at Connect).
 */
export async function bootApp(overrides = {}) {
  const config = resolveConfig(overrides);
  const token = await loginSession(config);
  const browser = await chromium.launch({ headless: config.headless, args: ["--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("[ui-session] pageerror:", String(e).slice(0, 200)));
  await page.addInitScript(
    ([url, t, ws]) => {
      localStorage.setItem("notees.serverUrl", url);
      localStorage.setItem("notees.sessionToken", t);
      localStorage.setItem("notees.workspaceId", ws);
    },
    [config.serverUrl, token, config.workspaceId],
  );
  await page.goto(config.webUrl, { waitUntil: "commit", timeout: 120_000 });
  await waitForAppReady(page, config);
  return { browser, page, config };
}

/**
 * The ready assertion — the anti-loop guard. Throws with recovery hints
 * instead of leaving the caller staring at the Connect screen.
 */
export async function waitForAppReady(page, config, timeoutMs = 900_000) {
  const t0 = Date.now();
  let sawConnect = false;
  while (Date.now() - t0 < timeoutMs) {
    const state = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        len: text.length,
        connect: /Connect to a Notees sync server/i.test(text),
        sidebar: document.querySelector(".nt-sidebar *, [class*=sidebar] *") !== null,
      };
    }).catch(() => ({ len: 0, connect: false, sidebar: false }));
    if (state.sidebar && state.len > 500) return state;
    if (state.connect) sawConnect = true;
    await page.waitForTimeout(5_000);
  }
  const hints = [
    "ui-session: the app never left the boot/connect state.",
    sawConnect
      ? "- The Connect screen stayed up: the localStorage seed did not apply (addInitScript must run BEFORE goto) or the session token was rejected (check loginSession against " + config.serverUrl + ")."
      : "- Never even reached the Connect screen: check the web server (" + config.webUrl + ") answers.",
    "- Workspace " + config.workspaceId + ": a fresh profile full-catch-ups the whole relay log before content — minutes on a big workspace; the timeout is " + timeoutMs / 1000 + "s.",
    "- Do NOT work offline for diagnosis and do NOT click through the sign-in form (rate limits) — see docs/developers/ui-diagnosis.md.",
  ];
  throw new Error(hints.join("\n"));
}

/** CLI smoke: boot, print one line of state, exit. `node ui-session.mjs`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { page, browser } = await bootApp();
  const state = await page.evaluate(() => ({
    len: document.body.innerText.length,
    title: document.title,
  }));
  console.log("ui-session OK:", JSON.stringify(state));
  await browser.close();
}
