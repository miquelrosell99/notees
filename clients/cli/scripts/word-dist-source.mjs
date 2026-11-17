#!/usr/bin/env node
/**
 * Where the Word add-in statics live — one rule shared by
 * scripts/gen-word-embedded.mjs and test/word-embedded.test.ts, so the
 * embedded bundle and its freshness gate can never disagree.
 *
 * Resolution (first hit wins), relative to the CLI root:
 *   1. `<cliRoot>/../word` — the in-tree add-in client (clients/word) with
 *      a built `dist/` (a gitignored build output of
 *      `pnpm build:localhost`). A dev checkout that built the add-in serves
 *      exactly what the add-in repo produces.
 *   2. `<cliRoot>/word-snapshot` — the committed snapshot (dist/ + the raw
 *      manifest.xml + PROVENANCE.json), tracked so CI, fresh checkouts, and
 *      the gate always embed statics without building the add-in.
 *
 * Returns the source dir (the one containing dist/ and manifest.xml), or
 * undefined when neither exists.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveWordDistSource(cliRoot) {
  const inTree = join(cliRoot, "..", "word");
  if (existsSync(join(inTree, "dist"))) return inTree;
  const snapshot = join(cliRoot, "word-snapshot");
  if (existsSync(join(snapshot, "dist"))) return snapshot;
  return undefined;
}
