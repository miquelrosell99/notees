/**
 * Log-conformance repair (owner directive 2026-10-22: "repair the log") —
 * a kind-B in-place rewrite in the migrations.md sense, for envelopes that
 * were ACCEPTED into the relay log but can never apply under the current
 * strict appliers. Two poison shapes, both observed in the shared test
 * workspace (and diagnosed by a full scratch replay):
 *
 *  V1  class.setExtends naming a parent class whose create op lands LATER
 *      in the log (a probe deployed user classes extending Meeting 34s
 *      before Meeting's class.create was written). requireNode fails loud
 *      on every fresh replay — the browser worker wedges ("Backend
 *      unreachable — working locally") on first sync.
 *      Repair: drop the not-yet-existing parents from the payload (the op
 *      becomes "set extends to the parents that existed"; seq/id/HLC
 *      untouched). Later ops for the same class replay unchanged.
 *  V2  class.setExtends on a system class deviating from the seeded set
 *      (the system-extends lock, packages/store appliers) — e.g. a probe
 *      clearing Meeting's parents to [] while the seed freezes meeting →
 *      [event]. SystemExtendsLockError on every replay.
 *      Repair: rewrite parentClassIds to the seeded set (the lock forces
 *      that value anyway; every intermediate op becomes lock-legal and the
 *      converged state is the designed platform structure).
 *  V3  Dead envelopes — repair by DELETING the envelope from the log (the
 *      payload carries nothing neuterable):
 *      - object.delete naming a node that has NO create envelope in this
 *        workspace's log (foreign/double deletes — the graph-loadtest probe
 *        dropped 50k cleanup deletes for nodes that were never created
 *        HERE; every fresh replay below the snapshot horizon wedged on
 *        them). A delete whose target was never authored in this workspace
 *        is garbage, not history.
 *      - object.create that fails a write-time guard (MoveGuardError) with
 *        zero later ops referencing the node (a negative-test "bad claim"
 *        the server API accepted into the log without applying).
 *
 * Any OTHER violation aborts the run with a report — no guessing.
 *
 * DRY RUN by default: replays EVERY workspace's full log (snapshot + tail,
 * the sync-server hydration shape) through a scratch store, records every
 * per-envelope throw, prints the plan. --apply performs the rewrite (one
 * transaction), re-validates every touched envelope through the strict
 * payload schema, bumps restore_epoch, drops stale snapshots + derived
 * caches for the affected workspaces, then verifies with a fresh scratch
 * replay (zero throws). THE SYNC SERVER MUST BE STOPPED for --apply
 * (relay.db is the authority; law: never edit it while the server runs).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/repair-log-conformance.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store).
const require = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"),
);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import { payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_EXTENDS_IDS } from "../packages/domain/src/seeds.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";
import { RelayStorage } from "../apps/server/src/relay-storage.ts";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string | null;
  apply: boolean;
  force: boolean;
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
    force: argv.includes("--force"),
  };
}

// --- types --------------------------------------------------------------------

interface Violation {
  workspaceId: string;
  seq: number;
  envelopeId: string;
  opType: string;
  error: string;
  /** Parents named in the payload that did not exist at as-of apply time (V1). */
  missingParents: string[];
  /** The seeded parent set for a system-class lock violation (V2). */
  seededParents: string[] | null;
  /** V3: the envelope is dead — repair deletes it from the log. */
  dropEnvelope: boolean;
}

// --- scratch replay -----------------------------------------------------------

/** seq lookup — envelopes on the wire do not carry the server seq. */
let seqById: Map<string, number> = new Map();

function buildScratchStore(relay: RelayStorage, workspaceId: string, ctx: ResolveContext): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const db = (relay as unknown as { db: import("better-sqlite3").Database }).db;
  seqById = new Map(
    (db.prepare("SELECT id, seq FROM envelope WHERE workspace_id = ?").all(workspaceId) as Array<{ id: string; seq: number }>).map(
      (r) => [r.id, r.seq],
    ),
  );
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
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        // Record and continue: a failed op is never applied, so the as-of
        // state stays consistent for classifying the NEXT violation.
        pending.push(classify(workspaceId, envelope, error, ctx));
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

const pending: Violation[] = [];

interface ResolveContext {
  /** True when the workspace's log has an envelope creating this node. */
  hasCreate: (nodeId: string) => boolean;
  /** Ops (any seq) referencing this node beyond the given envelope. */
  laterRefs: (nodeId: string, excludeEnvelopeId: string) => number;
}

function classify(
  workspaceId: string,
  envelope: any,
  error: unknown,
  ctx: ResolveContext,
): Violation {
  const message = error instanceof Error ? error.message : String(error);
  const base: Violation = {
    workspaceId,
    seq: seqById.get(envelope.id) ?? -1,
    envelopeId: envelope.id,
    opType: envelope.opType,
    error: message,
    missingParents: [],
    seededParents: null,
    dropEnvelope: false,
  };
  if (envelope.opType === "class.setExtends") {
    const missing = /node ([0-9a-f-]{36}) does not exist/.exec(message);
    if (missing !== null) {
      const parents: string[] = envelope.payload?.parentClassIds ?? [];
      const named = missing[1]!;
      if (parents.includes(named)) {
        base.missingParents = [named];
        return base;
      }
      return base;
    }
    if (error instanceof Error && error.name === "SystemExtendsLockError") {
      const seeded = SYSTEM_CLASS_EXTENDS_IDS[envelope.payload?.classId];
      base.seededParents = seeded === undefined ? [] : [...seeded];
      return base;
    }
    return base;
  }
  // V3a: a delete whose target was never created in this workspace is
  // foreign garbage — the envelope is deleted from the log.
  if (envelope.opType === "object.delete" && /node .* does not exist/.test(message)) {
    const target = envelope.payload?.objectId as string | undefined;
    if (target !== undefined && !ctx.hasCreate(target)) {
      base.dropEnvelope = true;
      return base;
    }
    return base;
  }
  // V3b: a create that fails a write-time guard, with no later ops carrying
  // the would-be node — the envelope is dead weight, deleted from the log.
  if (envelope.opType === "object.create" && error instanceof Error) {
    const objectId = envelope.payload?.objectId as string | undefined;
    if (objectId !== undefined && ctx.laterRefs(objectId, envelope.id) === 0) {
      base.dropEnvelope = true;
      return base;
    }
    return base;
  }
  return base;
}

// --- apply --------------------------------------------------------------------

function applyRepairs(
  relay: RelayStorage,
  violations: Violation[],
  optionsDataDir: string,
): void {
  const db = (relay as unknown as { db: import("better-sqlite3").Database }).db;
  const select = db.prepare("SELECT seq, payload, op_type FROM envelope WHERE id = ?");
  const update = db.prepare("UPDATE envelope SET payload = ? WHERE id = ?");

  const tx = db.transaction(() => {
    for (const v of violations) {
      const row = select.get(v.envelopeId) as { seq: number; payload: string; op_type: string } | undefined;
      if (row === undefined) throw new Error(`envelope ${v.envelopeId} not found`);
      if (v.dropEnvelope) {
        // V3: dead envelope — remove it from the log entirely.
        db.prepare("DELETE FROM envelope WHERE id = ?").run(v.envelopeId);
        continue;
      }
      const payload = JSON.parse(row.payload);
      if (v.seededParents !== null) {
        // V2: the lock forces the seeded set — converge the payload to it.
        payload.parentClassIds = [...v.seededParents];
      } else if (v.missingParents.length > 0) {
        // V1: drop the parents that did not exist as-of the op.
        payload.parentClassIds = (payload.parentClassIds as string[]).filter(
          (p) => !v.missingParents.includes(p),
        );
      } else {
        throw new Error(`no repair strategy for envelope ${v.envelopeId} (${v.error})`);
      }
      // The strict payload schema must accept the repaired envelope.
      payloadSchemaFor(row.op_type as never).parse(payload);
      update.run(JSON.stringify(payload), v.envelopeId);
    }
  });
  tx();

  // Epoch bump: every replica wipes + resyncs from the rewritten log.
  for (const ws of new Set(violations.map((v) => v.workspaceId))) {
    const epoch = relay.bumpRestoreEpoch(ws);
    console.log(`workspace ${ws}: restore_epoch -> ${epoch}`);
    // Stale snapshots embed the poisoned derivation — drop rows + bytes (the
    // affected workspaces replay in seconds; deletion beats byte-patching).
    const snaps = db
      .prepare("SELECT id FROM snapshot WHERE workspace_id = ?")
      .all(ws) as Array<{ id: string }>;
    const dropRow = db.prepare("DELETE FROM snapshot WHERE id = ?");
    for (const snap of snaps) {
      dropRow.run(snap.id);
      const file = join(optionsDataDir, "snapshots", `${snap.id}.db`);
      if (existsSync(file)) rmSync(file);
      console.log(`  dropping stale snapshot ${snap.id}`);
    }
    const derived = join(optionsDataDir, "derived", `${ws}.db`);
    if (existsSync(derived)) {
      console.log(`  dropping derived cache ${ws}.db`);
      rmSync(derived);
    }
  }
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  if (options.apply && !options.force) {
    // The sync server must be stopped before relay.db is edited.
    try {
      const { execSync } = require("node:child_process") as typeof import("node:child_process");
      const out = execSync("docker inspect -f '{{.State.Running}}' notees-sync 2>/dev/null || true", {
        encoding: "utf8",
      }).trim();
      if (out === "true") {
        throw new Error("notees-sync is RUNNING — stop it first: docker compose stop notees-sync");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("notees-sync is RUNNING")) throw error;
      // docker unavailable — --force is the escape hatch.
      console.log("docker check unavailable; proceeding (relay.db edit while the server");
      console.log("runs is unsafe — stop it first if it is running).");
    }
  }

  const db = (relay as unknown as { db: import("better-sqlite3").Database }).db;
  const workspaceRows = db
    .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
    .all() as Array<{ workspace_id: string }>;
  const workspaceIds = (options.workspace !== null
    ? workspaceRows.filter((r) => r.workspace_id === options.workspace)
    : workspaceRows
  ).map((r) => r.workspace_id);
  if (workspaceIds.length === 0) throw new Error("no workspaces matched");

  // Reference lookups for the V3 strategies, built in ONE pass over the
  // workspace's envelopes (per-violation SQL LIKE scans are O(n²) — 50k
  // violations × a full table scan each does not finish).
  const createdNodes = new Set<string>();
  const refCounts = new Map<string, number>();
  const buildRefIndex = (ws: string): void => {
    createdNodes.clear();
    refCounts.clear();
    const rows = db
      .prepare("SELECT op_type, payload, affected_node_ids FROM envelope WHERE workspace_id = ?")
      .all(ws) as Array<{ op_type: string; payload: string; affected_node_ids: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      if (row.op_type === "object.create" || row.op_type === "class.create") {
        const id = payload.objectId ?? payload.classId;
        if (typeof id === "string") createdNodes.add(id);
      }
      for (const key of ["objectId", "classId", "parentId"] as const) {
        const id = payload[key];
        if (typeof id === "string") refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
      }
      if (Array.isArray(payload.parentClassIds)) {
        for (const id of payload.parentClassIds as string[]) {
          refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
        }
      }
      // affected_node_ids is deliberately NOT counted: every envelope
      // touching a node carries it (derived metadata), which double-counts
      // the envelope itself and defeats the "any OTHER op references it"
      // test. Payload fields are where genuine cross-envelope references
      // live; the post-repair verify replay catches a wrong drop anyway.
    }
  };
  const ctxFor = (ws: string): ResolveContext => ({
    hasCreate: (nodeId) => createdNodes.has(nodeId),
    laterRefs: (nodeId) => (refCounts.get(nodeId) ?? 0) - 1,
  });

  pending.length = 0;
  const all: Violation[] = [];
  for (const ws of workspaceIds) {
    const before = pending.length;
    buildRefIndex(ws);
    buildScratchStore(relay, ws, ctxFor(ws));
    const found = pending.slice(before);
    const count = relay.envelopeCount(ws);
    console.log(`workspace ${ws}: ${count} envelopes, ${found.length} violation(s)`);
    for (const v of found.slice(0, 12)) {
      console.log(
        `  seq=${v.seq} ${v.opType} ${v.envelopeId}\n    ${v.error}` +
          (v.missingParents.length > 0 ? `\n    V1 drop parents: ${v.missingParents.join(", ")}` : "") +
          (v.seededParents !== null ? `\n    V2 seeded set: [${v.seededParents.join(", ")}]` : "") +
          (v.dropEnvelope ? `\n    V3 drop envelope` : ""),
      );
    }
    if (found.length > 12) console.log(`  … and ${found.length - 12} more`);
    all.push(...found);
  }

  const repairable = all.filter(
    (v) => v.dropEnvelope || v.missingParents.length > 0 || v.seededParents !== null,
  );
  const unknown = all.filter(
    (v) => !v.dropEnvelope && v.missingParents.length === 0 && v.seededParents === null,
  );
  if (unknown.length > 0) {
    console.log(`\n${unknown.length} UNREPAIRABLE violation(s) — no strategy; aborting before any write.`);
    for (const v of unknown.slice(0, 10)) console.log(`  seq=${v.seq} ${v.opType}: ${v.error}`);
    process.exit(1);
  }
  if (repairable.length === 0) {
    console.log("\nlog is clean — nothing to repair.");
    return;
  }
  if (!options.apply) {
    console.log(`\nDRY RUN: ${repairable.length} envelope(s) repairable. Re-run with --apply (server stopped) to write.`);
    return;
  }

  // Backup before the write (law: backup relay.db before touching it).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `/tmp/repair-log-conformance-bak-${stamp}`;
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(join(options.dataDir, "relay.db"), join(backupDir, "relay.db"));
  console.log(`backup: ${backupDir}/relay.db`);

  applyRepairs(relay, repairable, options.dataDir);

  // Verify: fresh scratch replay — zero throws expected now.
  pending.length = 0;
  for (const ws of new Set(repairable.map((v) => v.workspaceId))) {
    buildRefIndex(ws);
    buildScratchStore(relay, ws, ctxFor(ws));
  }
  if (pending.length > 0) {
    console.log(`\nVERIFY FAILED — ${pending.length} violation(s) remain after repair:`);
    for (const v of pending) console.log(`  seq=${v.seq} ${v.opType}: ${v.error}`);
    process.exit(1);
  }
  console.log(`\nVERIFY-PASS: fresh replay of the repaired log applies with zero throws.`);
  console.log("Next: restart the sync server (docker compose up -d notees-sync) so the");
  console.log("derived store rehydrates, then run scripts/screenshots/verify-min.mjs.");
}

main();
