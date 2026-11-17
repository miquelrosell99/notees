import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT } from "../exit-codes.js";

/**
 * Per-user cache dir for the Word add-in: the rendered sideload manifest
 * and the serve lock live here. NOTEES_WORD_CACHE_DIR overrides (tests use
 * it); Windows lands under %LOCALAPPDATA% (Word runs there), elsewhere
 * under $XDG_CACHE_HOME or ~/.cache.
 */
export function wordCacheDir(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = platform()): string {
  const override = env.NOTEES_WORD_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  if (plat === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "notees", "word");
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "notees", "word");
}

/**
 * The built add-in dist, REQUIRED on disk: NOTEES_WORD_DIST > the nearest
 * `clients/word/dist` (a built in-tree add-in checkout) or
 * `word-snapshot/dist` (the committed snapshot beside the CLI) found walking
 * up from this module. Throws when absent — prefer `resolveWordStatics` at
 * call sites that can fall back to the bundle's embedded copy.
 */
export function resolveWordDistDir(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const override = env.NOTEES_WORD_DIST;
  if (override !== undefined && override.length > 0) return override;
  const walked = walkUpToWordDist(startDir);
  if (walked !== undefined) return walked;
  throw new CliError(
    EXIT.usage,
    "the Word add-in dist is not available (no clients/word/dist or word-snapshot/dist found) — " +
      "build the add-in (cd clients/word && pnpm build:localhost), or set NOTEES_WORD_DIST to a built dist directory",
  );
}

function walkUpToWordDist(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    // The monorepo layout: the add-in client lives at clients/word and
    // serves its dist/ in place once built. The committed snapshot beside
    // the CLI (word-snapshot/dist) keeps fresh checkouts and CI working
    // without an add-in build.
    const inTree = join(dir, "clients", "word", "dist");
    if (existsSync(inTree)) return inTree;
    const snapshot = join(dir, "word-snapshot", "dist");
    if (existsSync(snapshot)) return snapshot;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Where `notees word serve` reads its statics, in precedence order:
 * NOTEES_WORD_DIST > a `clients/word/dist` or `word-snapshot/dist` found
 * walking up from this module (the monorepo checkout) > the bundle's
 * embedded copy (the release bundle is a single cli.mjs with no snapshot —
 * the embedded map always exists there).
 */
export type WordStaticsResolution = { kind: "dir"; distDir: string } | { kind: "embedded" };

export function resolveWordStatics(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): WordStaticsResolution {
  const override = env.NOTEES_WORD_DIST;
  if (override !== undefined && override.length > 0) return { kind: "dir", distDir: override };
  const walked = walkUpToWordDist(startDir);
  if (walked !== undefined) return { kind: "dir", distDir: walked };
  return { kind: "embedded" };
}
