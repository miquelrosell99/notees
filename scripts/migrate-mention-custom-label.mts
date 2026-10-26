/**
 * Mention custom-label rewrite: the mention token's captured `text` and the `displayText` override
 * retire. The replacement is ONE optional `customLabel` — the only text a
 * mention ever stores; the link's visible text is computed at render time
 * (customLabel ?? the target's current display name), so renames re-resolve
 * and no stored text can drift. The strict payload schema rejects the
 * retired keys outright (the no-backward-compatibility law), so a live relay
 * log still carrying them fails every strict replay (client wipe + resync
 * after the epoch bump) until rewritten in place.
 *
 * LOCKSTEP LAW: the TS reference ships first; GTK + Flutter ports must accept
 * `customLabel` (and reject the retired `text`/`displayText` keys) BEFORE
 * this migration runs against a live relay — a pre-batch client rejects the
 * rewritten envelopes and its sync stalls until updated. Run only after the
 * client tags (docs/developers/migrations.md §2).
 *
 * The mapping (audited per schema):
 *  - `displayText: "<non-empty>"` → `customLabel: "<same>"` (the one-off
 *    wording survives under its new name);
 *  - `text` (any value)            → STRIPPED (the captured surface form —
 *    its whole drift class dies with it);
 *  - `displayText: ""`             → dropped with the text (an empty override
 *    means the same as absent);
 *  - a token already carrying `customLabel` is left alone (idempotent re-run).
 *  Quote/heading CHILDREN recurse (mentions nest inside the only nested tokens).
 *
 * The migrations.md §B sequence this script implements:
 *  1. Plan from authority: scan the stored log rows for payloads whose
 *     contentAst carries a mention with a retired key (object.create/update,
 *     class.create/update — the only content-carrying op types). seq/id/HLC
 *     untouched; every surviving key untouched.
 *  2. Backup: relay.db (and the snapshot bytes being patched) to
 *     /tmp/…bak-<timestamp> before anything.
 *  3. IN-PLACE envelope rewrite, one transaction: the mapping above on every
 *     planned payload. Every rewritten envelope re-validates through
 *     `payloadSchemaFor(opType)` afterwards — that assertion is the point.
 *     NO compensation envelopes: the label moves INSIDE the same envelope, so
 *     full replays converge from the log ALONE.
 *  4. Snapshot patch: the newest snapshot is stale when its up_to_seq
 *     post-dates the first rewritten envelope — its node.content bytes get
 *     the same token rewrite, then reindexAllSearch rebuilds the FTS rows
 *     (a bare mention now indexes its target's resolved display name).
 *  5. Bump `restore_epoch`: without it, `applied_envelope` id-skips the
 *     rewritten envelopes on every replica that already saw the old versions
 *     and clients silently keep the old derivation.
 *  6. RESTART the sync server (migrations.md §B step 7).
 *  7. Verify, in the runbook's order: rewritten envelopes re-validate →
 *     fresh scratch replay of the FULL log with zero StoreError throws → no
 *     mention token in the replayed store carries a retired key.
 *
 * Idempotent: a second run finds no retired key and plans nothing.
 *
 * DRY RUN BY DEFAULT. --apply performs the rewrite, then verifies.
 * Defaults to EVERY workspace in the relay; --workspace <uuid> restricts.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-mention-custom-label.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import { payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { reindexAllSearch, Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

// --- the token rewrite --------------------------------------------------------

/** In-place rewrite of one token stream level; true when anything changed. */
function rewriteTokenLevel(tokens: unknown[]): boolean {
  let changed = false;
  for (const token of tokens) {
    if (typeof token !== "object" || token === null) continue;
    const t = token as Record<string, unknown>;
    if (t.type === "mention") {
      if (typeof t.text === "string") {
        delete t.text;
        changed = true;
      }
      if (typeof t.displayText === "string") {
        if (t.displayText !== "") {
          if (t.customLabel === undefined) t.customLabel = t.displayText;
        }
        delete t.displayText;
        changed = true;
      }
    }
    if (Array.isArray(t.children)) {
      if (rewriteTokenLevel(t.children as unknown[])) changed = true;
    }
  }
  return changed;
}

/** True when a contentAst carries a mention token with a retired key. */
function carriesRetiredMentionKeys(contentAst: unknown): boolean {
  if (!Array.isArray(contentAst)) return false;
  for (const token of contentAst) {
    if (typeof token !== "object" || token === null) continue;
    const t = token as Record<string, unknown>;
    if (
      t.type === "mention" &&
      (typeof t.text === "string" || typeof t.displayText === "string")
    ) {
      return true;
    }
    if (Array.isArray(t.children) && carriesRetiredMentionKeys(t.children)) return true;
  }
  return false;
}

/** Deep-verify: no mention token anywhere carries a retired key. */
function assertNoRetiredMentionKeys(contentAst: unknown, where: string): void {
  if (!Array.isArray(contentAst)) return;
  for (const token of contentAst) {
    if (typeof token !== "object" || token === null) continue;
    const t = token as Record<string, unknown>;
    if (t.type === "mention" && (typeof t.text === "string" || typeof t.displayText === "string")) {
      throw new Error(`verification failed: ${where} still carries a retired mention key`);
    }
    if (Array.isArray(t.children)) assertNoRetiredMentionKeys(t.children, where);
  }
}

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string | null;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? null,
    apply: argv.includes("--apply"),
  };
}

// --- planning -----------------------------------------------------------------

interface PlannedRewrite {
  seq: number;
  id: string;
  opType: string;
  payload: Record<string, unknown>;
}

function planWorkspace(
  relay: RelayStorage,
  workspaceId: string,
): { planned: PlannedRewrite[]; latestSeq: number } {
  const rows = relay.db
    .prepare(
      `SELECT seq, id, op_type, payload FROM envelope
       WHERE workspace_id = ? ORDER BY seq ASC`,
    )
    .all(workspaceId) as Array<{ seq: number; id: string; op_type: string; payload: string }>;
  const planned: PlannedRewrite[] = [];
  let latestSeq = 0;
  for (const row of rows) {
    latestSeq = row.seq;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (!carriesRetiredMentionKeys(payload.contentAst)) continue;
    planned.push({ seq: row.seq, id: row.id, opType: row.op_type, payload });
  }
  return { planned, latestSeq };
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaceIds =
      options.workspace !== null
        ? [options.workspace]
        : (
            relay.db
              .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
              .all() as Array<{ workspace_id: string }>
          ).map((row) => row.workspace_id);
    if (workspaceIds.length === 0) throw new Error("no workspaces in the relay log");

    const plans = new Map<string, { planned: PlannedRewrite[]; latestSeq: number }>();
    for (const workspaceId of workspaceIds) {
      plans.set(workspaceId, planWorkspace(relay, workspaceId));
    }

    let totalPlanned = 0;
    for (const [workspaceId, { planned }] of plans) {
      const snapshot = relay.latestSnapshot(workspaceId);
      const snapshotSeq = snapshot?.up_to_seq ?? 0;
      console.log(
        `workspace ${workspaceId}: log seq ${relay.latestSeq(workspaceId)}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}, ${planned.length} envelope(s) carry retired mention keys`,
      );
      totalPlanned += planned.length;
      if (planned.length > 0) {
        const firstSeq = Math.min(...planned.map((p) => p.seq));
        for (const p of planned.slice(0, 10)) {
          console.log(`    seq ${p.seq}  ${p.opType}`);
        }
        if (planned.length > 10) console.log(`    … and ${planned.length - 10} more`);
        console.log(
          `  snapshot ${snapshot !== null && snapshotSeq >= firstSeq ? `is STALE (up_to_seq ${snapshotSeq} >= first rewritten seq ${firstSeq}) — bytes patched with the same move` : "predates the first rewritten envelope — not stale"}.`,
        );
      }
    }

    if (totalPlanned === 0) {
      console.log("\nno envelope carries a retired mention key — the log is already clean.");
      return;
    }

    if (!options.apply) {
      console.log(
        `\ndry run — ${totalPlanned} envelope(s) across ${plans.size} workspace(s) would be rewritten. Re-run with --apply (backup → envelope rewrite → snapshot patch → epoch bump → verify).`,
      );
      return;
    }

    // --- apply ---------------------------------------------------------------

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-mention-custom-label-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-mention-custom-label-${stamp}`);

    for (const [workspaceId, { planned }] of plans) {
      if (planned.length === 0) continue;
      console.log(`\nworkspace ${workspaceId}:`);

      // Envelope rewrite, one transaction; every rewritten payload re-validates
      // through the strict schema — that assertion is the point.
      const rewrite = relay.db.transaction(() => {
        for (const p of planned) {
          const next = JSON.parse(JSON.stringify(p.payload)) as Record<string, unknown>;
          if (!rewriteTokenLevel((next as { contentAst?: unknown[] }).contentAst ?? [])) continue;
          const schema = payloadSchemaFor(p.opType)!;
          const check = schema.safeParse(next);
          if (!check.success) {
            throw new Error(
              `seq ${p.seq}: rewritten ${p.opType} payload no longer validates: ${check.error.message}`,
            );
          }
          relay.db
            .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND workspace_id = ?")
            .run(JSON.stringify(next), p.seq, workspaceId);
        }
      });
      rewrite();
      console.log(`  rewrote ${planned.length} envelope(s) in place; no compensation envelopes (the label moved inside the same envelope).`);

      // Snapshot patch: rewrite the node.content JSON with the same move, then
      // reindex every search row (a bare mention now indexes its target's
      // resolved display name — SCHEMA.md FTS spec 2026-10-26).
      const snapshot = relay.latestSnapshot(workspaceId);
      const firstSeq = Math.min(...planned.map((p) => p.seq));
      if (snapshot !== null && snapshot.up_to_seq >= firstSeq) {
        const snapshotFile = join(options.dataDir, "snapshots", `${snapshot.id}.db`);
        if (!existsSync(snapshotFile)) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
        copyFileSync(snapshotFile, `/tmp/snapshot-${snapshot.id}.bak-${stamp}`);
        patchSnapshot(snapshotFile);
        console.log(`  patched snapshot ${snapshot.id} (bytes backup at /tmp/snapshot-${snapshot.id}.bak-${stamp}).`);
      } else if (snapshot !== null) {
        console.log("  snapshot predates the first rewritten envelope — left untouched.");
      } else {
        console.log("  no snapshot — the next hydration replays the full log (slow path, correct by construction).");
      }

      // Epoch bump: every client wipes + resyncs from the rewritten log.
      const epoch = relay.bumpRestoreEpoch(workspaceId);
      console.log(`  restore_epoch bumped to ${epoch}.`);

      verify(relay, workspaceId);
    }
    console.log("\ndone. RESTART the sync server so its running derived store rehydrates from the rewritten log.");
  } finally {
    relay.close();
  }
}

/**
 * Apply the same move to a snapshot's bytes: rewrite the node.content JSON
 * (the only place contentAst survives inside a snapshot), then rebuild every
 * search row through reindexAllSearch (Store.open runs any pending schema
 * migrations first — additive, safe on a copy).
 */
function patchSnapshot(snapshotFile: string): void {
  const dir = mkdtempSync(join(tmpdir(), "notees-mention-snapshot-patch-"));
  const tempDb = join(dir, "snapshot.db");
  try {
    copyFileSync(snapshotFile, tempDb);

    {
      const raw = new Database(tempDb);
      try {
        const rows = raw.prepare("SELECT id, content FROM node").all() as Array<{ id: string; content: string }>;
        const update = raw.prepare("UPDATE node SET content = ? WHERE id = ?");
        let patched = 0;
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.content);
          } catch {
            continue;
          }
          if (!Array.isArray(parsed)) continue;
          if (!rewriteTokenLevel(parsed as unknown[])) continue;
          update.run(JSON.stringify(parsed), row.id);
          patched += 1;
        }
        console.log(`  snapshot content patched on ${patched} node row(s).`);
      } finally {
        raw.close();
      }
    }

    {
      const store = Store.open(betterSqlite3Backend(tempDb));
      try {
        reindexAllSearch(store.database);
      } finally {
        store.close();
      }
    }

    // Verify no retired key survives anywhere in the patched bytes.
    {
      const raw = new Database(tempDb, { readonly: true });
      try {
        const rows = raw.prepare("SELECT id, content FROM node").all() as Array<{ id: string; content: string }>;
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.content);
          } catch {
            continue;
          }
          assertNoRetiredMentionKeys(parsed, `snapshot node ${row.id}`);
        }
      } finally {
        raw.close();
      }
    }

    copyFileSync(tempDb, snapshotFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Post-rewrite verification (migrations.md §B step 8, in order):
 *  1. every envelope in the log re-validates through the strict payload
 *     schema (no retired mention key remains),
 *  2. a fresh scratch store replays the FULL log (snapshot + tail) with zero
 *     StoreError throws,
 *  3. no mention token in the replayed store's node content carries a
 *     retired key.
 */
function verify(relay: RelayStorage, workspaceId: string): void {
  const all = relay.allEnvelopes(workspaceId);
  for (const env of all) {
    if (!payloadSchemaFor(env.opType)!.safeParse(env.payload).success) {
      throw new Error(`verification failed: a ${env.opType} payload (${env.id}) no longer validates`);
    }
    assertNoRetiredMentionKeys((env.payload as Record<string, unknown>).contentAst, `envelope ${env.id}`);
  }
  console.log(`  verify: all ${all.length} envelope(s) validate clean (no retired mention key remains).`);

  const store = buildScratchStore(relay, workspaceId);
  try {
    const rows = store.database.prepare("SELECT id, content FROM node").all() as Array<{ id: string; content: string }>;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      assertNoRetiredMentionKeys(parsed, `replayed node ${row.id}`);
    }
    console.log(`  verify: full replay clean; no node content carries a retired mention key (${rows.length} row(s) checked).`);
  } finally {
    store.close();
  }
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
