#!/usr/bin/env node
// Reaper for leaked headless-chromium probe browsers. Screenshot probes
// (scripts/screenshots/*-probe.mjs) launch Playwright's chromium; when a
// probe session dies without cleanup (kill -9, OOM killer, crashed session)
// the browser tree is reparented to PID 1 and leaks. This script kills any
// process running the ms-playwright chromium binary that is older than the
// max probe age — live probes never outlive it, so anything older is a leak.
// The match is anchored to the Playwright cache path, so system browsers
// (gotenberg's chromium, the desktop Chrome) are never touched.
import { execFileSync } from "node:child_process";

const MAX_AGE_SECONDS = 30 * 60;

const out = execFileSync("ps", ["-eo", "pid,etimes,args"], { encoding: "utf8" });
const kills = [];
for (const line of out.split("\n").slice(1)) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (m === null) continue;
  const pid = Number(m[1]);
  const age = Number(m[2]);
  const args = m[3] || "";
  if (!args.includes("/ms-playwright/chromium-")) continue;
  if (age < MAX_AGE_SECONDS) continue;
  kills.push(pid);
}
for (const pid of kills) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the listing and the kill — the reaper's own race.
  }
}
console.log(
  kills.length === 0
    ? "reaper: no leaked probe browsers"
    : `reaper: killed ${kills.length} leaked process(es): ${kills.join(", ")}`,
);
