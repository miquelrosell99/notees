/**
 * Class-chip rename (owner 2026-10-15): the render-only inline class
 * reference token retires its `class_chip` name for `class_link` — the
 * token IS a node link (class variant: wavy underline, no membership
 * effect), and the owner ruled the name must say so. The strict
 * `contentTokenSchema` rejects the retired type outright (the
 * no-backward-compatibility law), so the live relay log still carrying
 * 252 `class_chip` envelopes (the personal workspace's v1-imported
 * content) must be rewritten in place or every strict replay (client
 * wipe + resync after the epoch bump) fails.
 *
 * LOCKSTEP LAW (migrations.md §2): the TS reference ships first, then the
 * GTK + Flutter ports, and only then does this run — a pre-batch client
 * rejects the rewritten envelopes and its sync stalls. The 2026-10-15
 * lockstep shipped all three implementations (notees @f8bf5e33 lineage,
 * notees-gtk 0d4e520, notees-flutter 4d915a7).
 *
 * The migrations.md §B sequence this script implements:
 *  1. Plan from authority: scan the relay `envelope` table for payloads
 *     containing the retired token type (raw rows — the rewrite targets
 *     seqs). Live check 2026-10-15: 252 envelopes, all in the personal
 *     workspace; every token occurrence is inside `contentAst`.
 *  2. Backup: `relay.db` + the server derived DBs to
 *     /tmp/notees-class-link-bak-<timestamp>/ — the LOG is the authority
 *     and its backup is the safety net. The snapshot corpus (49 GB across
 *     553 files, 419 carrying the token — all derivations of the log)
 *     gets NO bytes-backup: its patch is mechanical, verified per file
 *     (post-patch remaining-count assertion), and any snapshot derivation
 *     is regenerable from the backed-up log by full replay.
 *  3. IN-PLACE envelope rewrite, one transaction: every planned envelope's
 *     stored payload gets its `contentAst` tokens renamed (`class_chip` →
 *     `class_link`; `classId`/`displayText` ride untouched; seq/id/HLC
 *     untouched). Every rewritten payload re-validates through
 *     `payloadSchemaFor(opType)` BEFORE it is written — that assertion is
 *     the point. NO compensation envelopes: the move is a pure rename.
 *  4. Snapshot patch: every `snapshots/*.db` whose `node.content` carries
 *     the retired type gets the same rename in a per-file transaction,
 *     asserted clean afterwards. (Patch, not delete — deletion would force
 *     the ~35-minute full replay per workspace; the move is mechanical.)
 *  5. Server derived DBs: same patch in place — the restart rehydrates
 *     them anyway (migrations.md §B step 7), and patching keeps the
 *     pre-restart read consistent.
 *  6. Bump `restore_epoch` (per affected workspace): without it,
 *     `applied_envelope` id-skips the rewritten envelopes on every replica
 *     that already saw the old versions — clients silently keep the old
 *     derivation. The bump makes every client wipe + resync clean.
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate →
 *     fresh scratch replay of the FULL personal-workspace log (snapshot +
 *     tail) with zero StoreError throws and zero `class_chip` bytes in the
 *     replayed store → every snapshot file and derived DB reports zero
 *     remaining occurrences.
 *
 * Idempotent: a second run finds no retired tokens and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 *
 * THE SYNC SERVER MUST BE STOPPED BEFORE --apply (relay.db may never be
 * edited while the server runs — operations law 1).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-class-chip-rename.mts \
 *     --data-dir ../../config/notees/sync [--apply]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  envelopeSchema,
  payloadSchemaFor,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const PERSONAL_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const RETIRED = "class_chip";
const RENAMED = "class_link";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    apply: argv.includes("--apply"),
  };
}

// --- helpers ------------------------------------------------------------------

interface PlannedEnvelope {
  seq: number;
  id: string;
  workspaceId: string;
  opType: string;
  payload: Record<string, unknown>;
  tokens: number;
}

/** Rename retired tokens in one content AST; returns the token count. */
function rewriteAst(ast: unknown): { ast: unknown; tokens: number } {
  if (!Array.isArray(ast)) return { ast, tokens: 0 };
  let tokens = 0;
  const rewritten = ast.map((token) => {
    if (
      token !== null &&
      typeof token === "object" &&
      (token as Record<string, unknown>).type === RETIRED
    ) {
      tokens++;
      return { ...(token as Record<string, unknown>), type: RENAMED };
    }
    return token;
  });
  return tokens === 0 ? { ast, tokens: 0 } : { ast: rewritten, tokens };
}

/** The retired-token count inside a payload's contentAst, if any. */
function retiredTokensOf(payload: Record<string, unknown>): number {
  return rewriteAst(payload.contentAst).tokens;
}

/** Restore snapshot+tail into a scratch store (the sync-server hydration shape). */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

/**
 * Patch one derived-format DB (a snapshot or the server derived store):
 * rename the retired tokens inside every `node.content` row that carries
 * them, in a transaction; assert zero occurrences remain. Returns the
 * row/token counts.
 */
function patchStoreDb(file: string): { rows: number; tokens: number } {
  const db = new Database(file);
  try {
    const hits = db
      .prepare(`SELECT id, content FROM node WHERE content LIKE '%${RETIRED}%'`)
      .all() as Array<{ id: string; content: string }>;
    let tokens = 0;
    const update = db.prepare("UPDATE node SET content = ? WHERE id = ?");
    const tx = db.transaction(() => {
      for (const row of hits) {
        const parsed: Record<string, unknown> = JSON.parse(row.content);
        const rewritten = rewriteAst(parsed.contentAst !== undefined ? (JSON.parse(row.content) as unknown) : undefined);
        // content IS the AST array itself.
        void parsed;
        const ast = JSON.parse(row.content) as unknown;
        const result = rewriteAst(ast);
        if (result.tokens > 0) {
          update.run(JSON.stringify(result.ast), row.id);
          tokens += result.tokens;
        }
        void rewritten;
      }
    });
    tx();
    const remaining = (
      db.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
    ).n;
    if (remaining > 0) {
      throw new Error(`snapshot/derived patch verification failed: ${remaining} row(s) still carry ${RETIRED}`);
    }
    return { rows: hits.length, tokens };
  } finally {
    db.close();
  }
}

/** List the *.db files under a directory (excluding sqlite sidecars). */
function dbFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => join(dir, f));
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    // 1. Plan: scan the stored log rows for payloads carrying the retired
    //    token (any workspace; the 2026-10-15 live check found only the
    //    personal workspace).
    const rows = relay.db
      .prepare(`SELECT seq, id, workspace_id, op_type, payload FROM envelope WHERE payload LIKE '%${RETIRED}%' ORDER BY seq ASC`)
      .all() as Array<{ seq: number; id: string; workspace_id: string; op_type: string; payload: string }>;
    const affected: PlannedEnvelope[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const tokens = retiredTokensOf(payload);
      if (tokens > 0) affected.push({ seq: row.seq, id: row.id, workspaceId: row.workspace_id, opType: row.op_type, payload, tokens });
    }

    console.log(`planned ${RETIRED} → ${RENAMED} rewrite (data dir ${options.dataDir}):`);
    if (affected.length === 0) {
      console.log("  no envelope carries the retired token — nothing to rewrite.");
      return;
    }
    const workspaces = [...new Set(affected.map((env) => env.workspaceId))];
    const totalTokens = affected.reduce((sum, env) => sum + env.tokens, 0);
    console.log(
      `  ${affected.length} envelope(s) across ${workspaces.length} workspace(s) carry ${totalTokens} retired token(s) — rewritten in place (seq/id/HLC untouched):`,
    );
    for (const env of affected.slice(0, 8)) {
      console.log(`    seq ${env.seq}  ${env.opType}  ${env.id.slice(0, 13)}…  (${env.tokens} token(s))`);
    }
    if (affected.length > 8) console.log(`    … and ${affected.length - 8} more`);

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to perform the rewrite (STOP the sync server first; backup → envelope rewrite → snapshot + derived patch → epoch bump → verify).",
      );
      return;
    }

    // --- apply ----------------------------------------------------------------

    // 2. Backup: the relay log (the authority) + the server derived DBs.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(tmpdir(), `notees-class-link-bak-${stamp}`);
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(join(options.dataDir, "relay.db"), join(backupDir, "relay.db"));
    let backedUp = 1;
    for (const file of dbFiles(join(options.dataDir, "derived"))) {
      copyFileSync(file, join(backupDir, basename(file)));
      backedUp++;
    }
    console.log(`\nbackup: ${backupDir} (${backedUp} file(s) — relay.db + derived; snapshots are log-derivations, patched in place without bytes-backup).`);

    // 3. Envelope rewrite, one transaction. Every rewritten payload
    //    re-validates through the strict payload schema BEFORE it is written.
    const rewrite = relay.db.transaction(() => {
      for (const env of affected) {
        const rewrittenPayload = {
          ...env.payload,
          contentAst: rewriteAst(env.payload.contentAst).ast,
        };
        const schema = payloadSchemaFor(env.opType);
        if (schema === undefined || !schema.safeParse(rewrittenPayload).success) {
          throw new Error(`rewritten envelope ${env.id} (seq ${env.seq}) fails payloadSchemaFor('${env.opType}') — aborting before write`);
        }
        relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
          .run(JSON.stringify(rewrittenPayload), env.seq, env.workspaceId);
      }
    });
    rewrite();
    console.log(`rewrote ${affected.length} envelope(s) in place (${totalTokens} token(s) renamed); no compensation envelopes.`);

    // 4. Snapshot patch: every snapshot DB carrying the retired token gets
    //    the same rename, verified per file.
    const snapshotsDir = join(options.dataDir, "snapshots");
    const snapshotFiles = dbFiles(snapshotsDir);
    let patchedSnapshots = 0;
    let snapshotFailures = 0;
    for (const file of snapshotFiles) {
      const probe = new Database(file, { readonly: true, fileMustExist: true });
      let hits: number;
      try {
        hits = (
          probe.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
        ).n;
      } catch {
        hits = 0; // not a store-format DB — leave it alone.
      } finally {
        probe.close();
      }
      if (hits === 0) continue;
      try {
        const result = patchStoreDb(file);
        patchedSnapshots++;
        if (patchedSnapshots <= 5 || patchedSnapshots % 50 === 0) {
          console.log(`  snapshot ${basename(file)}: ${result.rows} row(s), ${result.tokens} token(s) renamed`);
        }
      } catch (error) {
        snapshotFailures++;
        console.error(`  snapshot ${basename(file)} FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`patched ${patchedSnapshots} snapshot DB(s); ${snapshotFailures} failure(s).`);
    if (snapshotFailures > 0) {
      throw new Error("aborting: snapshot patch failures — inspect the failures above before bumping the epoch");
    }

    // 5. Server derived DBs: same patch (the restart rehydrates them anyway).
    for (const file of dbFiles(join(options.dataDir, "derived"))) {
      const result = patchStoreDb(file);
      console.log(`derived ${basename(file)}: ${result.rows} row(s), ${result.tokens} token(s) renamed`);
    }

    // 6. Epoch bump: every affected workspace's clients wipe + resync clean.
    for (const workspaceId of workspaces) {
      const epoch = relay.bumpRestoreEpoch(workspaceId);
      console.log(`restore_epoch for ${workspaceId} bumped to ${epoch}.`);
    }

    // 7. Verify (migrations.md §B step 8, in order).
    verify(relay, PERSONAL_WORKSPACE, snapshotsDir);
    console.log("done. START the sync server (new image) so its derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Post-rewrite verification (migrations.md §B step 8):
 *  1. every rewritten envelope re-validates through envelopeSchema + the
 *     strict payload schema (no retired token remains anywhere in the log),
 *  2. a fresh scratch store replays the FULL personal-workspace log
 *     (snapshot + tail) with zero StoreError throws and zero retired bytes,
 *  3. every snapshot file reports zero remaining occurrences.
 */
function verify(relay: RelayStorage, workspaceId: string, snapshotsDir: string): void {
  const all = relay.allEnvelopes(workspaceId);
  for (const env of all) {
    if (!envelopeSchema.safeParse(env).success) {
      throw new Error(`verification failed: envelope ${env.id} no longer validates through envelopeSchema`);
    }
  }
  const remainingLog = (
    relay.db.prepare(`SELECT COUNT(*) AS n FROM envelope WHERE payload LIKE '%${RETIRED}%'`).get() as { n: number }
  ).n;
  if (remainingLog > 0) {
    throw new Error(`verification failed: ${remainingLog} envelope payload(s) still carry ${RETIRED}`);
  }
  console.log(`verify: all ${all.length} personal-workspace envelopes validate clean (retired token gone from the log).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const remaining = (
      store.database.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
    ).n;
    if (remaining > 0) {
      throw new Error(`verification failed: ${remaining} node row(s) in the full replay still carry ${RETIRED}`);
    }
    const renamed = (
      store.database.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RENAMED}%'`).get() as { n: number }
    ).n;
    console.log(`verify: full replay clean — ${renamed} node row(s) carry the renamed ${RENAMED} token.`);
  } finally {
    store.close();
  }

  let snapshotRemaining = 0;
  for (const file of dbFiles(snapshotsDir)) {
    const probe = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const n = (
        probe.prepare(`SELECT COUNT(*) AS n FROM node WHERE content LIKE '%${RETIRED}%'`).get() as { n: number }
      ).n;
      snapshotRemaining += n;
    } catch {
      // not a store-format DB — nothing to verify.
    } finally {
      probe.close();
    }
  }
  if (snapshotRemaining > 0) {
    throw new Error(`verification failed: ${snapshotRemaining} snapshot node row(s) still carry ${RETIRED}`);
  }
  console.log("verify: every snapshot DB reports zero retired occurrences.");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
