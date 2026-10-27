// Shared probe browser helper — every scripts/screenshots probe MUST launch
// through here. Two guarantees:
//
//  1. The browser is killed on ANY process exit (normal, error, SIGINT,
//     SIGTERM, and even kill -9 / OOM-adjacent deaths where the OS still runs
//     exit handlers is NOT guaranteed — see 2). The exit handler is
//     synchronous (process.kill, not the async browser.close) so it fires
//     under `process.on("exit")`.
//  2. A probe that somehow still leaks (session host killed with -9 leaves no
//     exit handler running) is reaped by reap-orphan-chrome.mjs on the cron
//     schedule — that reaper is the backstop, this helper is the first line.
import { chromium } from "playwright";

/** Launch a probe browser with guaranteed teardown. Returns the browser. */
export async function launchProbeBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const proc = typeof browser.process === "function" ? browser.process() : undefined;
  const pid = proc?.pid;
  const hardKill = () => {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead — nothing to kill.
      }
    }
  };
  process.once("exit", hardKill);
  const release = () => process.removeListener("exit", hardKill);
  browser.on("disconnected", release);
  return browser;
}
