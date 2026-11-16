#!/usr/bin/env node
/**
 * Refresh vendor/word/ from a notees-word checkout: build the localhost
 * flavor, copy the dist, snapshot the raw manifest template, and record
 * provenance. vendor/word is a built snapshot — never edit it by hand;
 * change the add-in in the notees-word repo and re-run this.
 *
 *   node scripts/sync-word-dist.mjs [--from <notees-word checkout>] [--no-build]
 *
 * --from defaults to the notees-word checkout next to this repo (../notees-word).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let from = join(cliRoot, "..", "notees-word");
let build = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--from") {
    from = args[i + 1] ?? "";
    i += 1;
  } else if (args[i] === "--no-build") {
    build = false;
  } else {
    console.error(`sync-word-dist: unknown argument "${args[i]}" (expected --from <path> | --no-build)`);
    process.exit(2);
  }
}

const sourceRoot = resolve(from);
const sourcePackagePath = join(sourceRoot, "package.json");
if (!existsSync(sourcePackagePath) || JSON.parse(readFileSync(sourcePackagePath, "utf8")).name !== "notees-word") {
  console.error(`sync-word-dist: ${sourceRoot} is not a notees-word checkout (pass --from <path>)`);
  process.exit(2);
}

if (build) {
  console.log(`sync-word-dist: building the localhost flavor in ${sourceRoot}`);
  const built = spawnSync("pnpm", ["build:localhost"], {
    cwd: sourceRoot,
    stdio: "inherit",
    // pnpm is a .cmd shim on Windows; a shell resolves it there.
    shell: process.platform === "win32",
  });
  if (built.status !== 0) {
    console.error("sync-word-dist: pnpm build:localhost failed");
    process.exit(built.status ?? 1);
  }
}

const dist = join(sourceRoot, "dist");
for (const required of ["index.html", "manifest.xml", join("lib", "office.js")]) {
  if (!existsSync(join(dist, required))) {
    console.error(`sync-word-dist: ${dist} is missing ${required} — build the add-in first`);
    process.exit(1);
  }
}

const commitRun = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" });
const commit = commitRun.status === 0 ? commitRun.stdout.trim() : "unknown";

const target = join(cliRoot, "vendor", "word");
rmSync(join(target, "dist"), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, join(target, "dist"), { recursive: true });
// The raw template (placeholders intact) — `notees word serve` renders it
// per port; dist/manifest.xml stays as the build-time render.
cpSync(join(sourceRoot, "manifest.xml"), join(target, "manifest.xml"));
writeFileSync(
  join(target, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      source: "miquelrosell99/notees-word",
      commit,
      build: "pnpm build:localhost",
      syncedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log(`sync-word-dist: vendor/word refreshed from notees-word @ ${commit}`);
