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
 * The vendored add-in dist (`vendor/word/dist`). Resolution: NOTEES_WORD_DIST
 * > the nearest `vendor/word/dist` found walking up from this module (the
 * repo checkout; the single-file release bundle has no vendor tree, so an
 * installed bundle needs NOTEES_WORD_DIST pointed at a synced snapshot).
 */
export function resolveWordDistDir(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  const override = env.NOTEES_WORD_DIST;
  if (override !== undefined && override.length > 0) return override;
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "vendor", "word", "dist");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    EXIT.usage,
    "the Word add-in dist is not available (no vendor/word/dist found) — run scripts/sync-word-dist.mjs from a source checkout, or set NOTEES_WORD_DIST to a built dist directory",
  );
}
