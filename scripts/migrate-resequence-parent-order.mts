/**
 * Parent-order resequencing: the live
 * relay log carries out-of-order `object.create` envelopes — a child create
 * whose `payload.parentId`'s own first create appears LATER in the log (a
 * bulk-import session's racing batches; the import's idempotent re-create
 * cascade let tolerant replicas self-heal, but STRICT log-order replay fails
 * with "object.create: parent … does not exist", blocking every Path A
 * migration's pre-ingest replay gate).
 *
 * `migrate-repair-parent-order.mts` established why the strip+move repair
 * cannot replay here: an embedded block can only receive a block parent AT
 * BIRTH (the create payload is the sole carrier) — so the birth payloads must
 * be preserved and the ORDER repaired. This script rewrites seqs:
 *
 *  1. Scan (two-pass, readonly): classify `object.create` envelopes whose
 *     payload.parentId's first-create seq > their own seq (payload id field
 *     `objectId`; class creates parent-resolve but are roots themselves).
 *  2. Classify each offender against the CONVERGED tree (the server derived
 *     DB — the authority captured before the server stops):
 *      - converged parent == payload parent  → RESEQUENCE candidate (the
 *        birth edge is true; ordering alone is broken);
 *      - converged parentless                → STRIP-ONLY (the edge is dead —
 *        a later re-create born the node parentless; stripping parentId in
 *        place converges it exactly, no ordering constraint);
 *      - anything else                        → BLOCKER (unknown corruption).
 *  3. Window: the minimal contiguous seq range [windowStart..windowEnd]
 *     covering every candidate AND every node in its ancestor chain up to
 *     the entry roots (creates whose parent first-created before the
 *     window). A stable topological sort inside the window (Kahn, min-heap
 *     on original seq) orders parent-before-child; unrelated envelopes keep
 *     their relative order.
 *  4. Rewrite: the new order is [below-window by seq] ++ [window, topologically
 *     sorted] ++ [above-window by seq] — i.e. a PERMUTATION INSIDE THE WINDOW
 *     RANGE ONLY (same envelope count, same slot): every seq outside the
 *     window is unchanged, so snapshot split points below the window stay
 *     exact. PAYLOADS ARE NEVER TOUCHED — envelope ids, HLCs, actors ride.
 *     seq reassignment: negate all seqs (no PK collisions), then assign the
 *     new positives, one transaction.
 *  5. Snapshots: any snapshot with up_to_seq inside or after the window is
 *     stale (its split point now lands inside the permuted block) — backed
 *     up and dropped; earlier snapshots stay valid (id-based applied_envelope
 *     + unchanged below-window splits). Epoch: bumped for EVERY workspace
 *     with an envelope in the window (a global seq permutation invalidates
 *     in-window client cursors). On restart the server re-saves a snapshot
 *     after hydrating.
 *  6. Conformance quarantine (the rehearsal discovery): the racing window
 *     was not the log's only strict-replay poison. The tolerant hydration
 *     (skip-on-StoreError) masked 29 further envelopes the strict appliers
 *     can NEVER apply, order-independently (move/update write-time guard
 *     breaches the converged tree already superseded, property.set payloads
 *     with invalid uuids or dead node refs, class.setExtends lock breaches).
 *     A thrown envelope is atomic — it never applied anywhere — so the
 *     quarantine DELETES them (repair-log-conformance.mts V3's precedent,
 *     generalized: the tolerant derived DB proves they applied nowhere, so
 *     the converged state rides untouched). Diagnosis runs over the
 *     post-reseq tail (tolerant replay, every failure collected); the
 *     deleted envelopes' touched nodes join the authority gate, and anything
 *     that still throws after quarantine aborts before the epoch bump.
 *  7. Verify (mandatory): strict scratch-replay of snapshot+tail into a fresh
 *     store — zero StoreError throws, zero offenders on the two-pass re-scan,
 *     and every repaired child (plus every node a quarantined envelope
 *     touched) reads back its exact converged parent/embedding, cross-checked
 *     against the derived DB authority. Idempotent: a second run plans
 *     nothing.
 *
 * --apply enforces the stopped server exactly like the sibling script
 * (/:8377 health probe + relay write-lock probe; the port probe skips
 * --data-dir under the OS temp dir) and backs up relay.db first
 * (relay.db.bak-YYYYMMDD-HHMMSS in the data dir).
 *
 * DRY RUN BY DEFAULT: prints the window (range + envelope count), the
 * offender classification, sample seq assignments, and writes nothing.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-resequence-parent-order.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

import { copyFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import { payloadSchemaFor } from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const HEALTH_URL = "http://127.0.0.1:8377/healthz";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? DEFAULT_WORKSPACE,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  const rows = relay.db
    .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
    .all() as Array<{ workspace_id: string }>;
  return rows.map((row) => row.workspace_id);
}

// --- scanning -----------------------------------------------------------------

interface StoredRow {
  seq: number;
  id: string;
  workspace_id: string;
  op_type: string;
  payload: string;
}

/** The node id a create payload declares (objectId | id | classId). */
function createIdOf(opType: string, payload: Record<string, unknown>): string | undefined {
  if (opType !== "object.create" && opType !== "class.create") return undefined;
  const id = payload.objectId ?? payload.id ?? payload.classId;
  return typeof id === "string" ? id : undefined;
}

interface Offender {
  seq: number;
  envelopeId: string;
  childId: string;
  parentId: string;
  payload: Record<string, unknown>;
}

interface ScanResult {
  /** first-create seq per node id (object + class creates). */
  firstSeq: Map<string, number>;
  /** parent declared by a node's FIRST create (object creates only). */
  firstParent: Map<string, string | null>;
  /** The row of each node's first create. */
  firstRow: Map<string, StoredRow>;
  offenders: Offender[];
  neverCreated: Array<{ seq: number; childId: string; parentId: string }>;
}

function scanWorkspace(rows: StoredRow[]): ScanResult {
  const result: ScanResult = {
    firstSeq: new Map(),
    firstParent: new Map(),
    firstRow: new Map(),
    offenders: [],
    neverCreated: [],
  };
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const id = createIdOf(row.op_type, payload);
    if (id === undefined) continue;
    if (!result.firstSeq.has(id)) {
      result.firstSeq.set(id, row.seq);
      result.firstRow.set(id, row);
      result.firstParent.set(id, typeof payload.parentId === "string" ? payload.parentId : null);
    }
  }
  for (const row of rows) {
    if (row.op_type !== "object.create") continue;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const childId = payload.objectId;
    const parentId = payload.parentId;
    if (typeof childId !== "string" || typeof parentId !== "string") continue;
    const parentSeq = result.firstSeq.get(parentId);
    if (parentSeq === undefined) {
      result.neverCreated.push({ seq: row.seq, childId, parentId });
      continue;
    }
    if (parentSeq <= row.seq) continue;
    result.offenders.push({ seq: row.seq, envelopeId: row.id, childId, parentId, payload });
  }
  return result;
}

// --- planning -----------------------------------------------------------------

interface SeqPlan {
  /** The resequencing window. */
  windowStart: number;
  windowEnd: number;
  /** Every envelope (all workspaces) inside the window, in NEW order. */
  windowOrder: StoredRow[];
  /** Offenders whose birth edge is true — fixed by ordering. */
  candidates: Offender[];
  /** Offenders whose edge is dead — fixed by a parentId strip (no ordering). */
  stripOnly: Offender[];
  /** Expected converged parent per repaired child (the authority). */
  expectedParent: Map<string, string | null>;
  blockers: string[];
}

/**
 * Build the resequencing plan for one workspace's offenders. `convergedParent`
 * returns the derived projection's parent_id (undefined = no projection —
 * treat the payload edge as true).
 */
function buildSeqPlan(rows: StoredRow[], scan: ScanResult, convergedParent: (id: string) => string | null | undefined): SeqPlan {
  const plan: SeqPlan = {
    windowStart: Infinity,
    windowEnd: 0,
    windowOrder: [],
    candidates: [],
    stripOnly: [],
    expectedParent: new Map(),
    blockers: [],
  };

  for (const offender of scan.offenders) {
    const converged = convergedParent(offender.childId);
    if (converged === undefined || converged === offender.parentId) {
      plan.candidates.push(offender);
      plan.expectedParent.set(offender.childId, offender.parentId);
    } else if (converged === null) {
      plan.stripOnly.push(offender);
      plan.expectedParent.set(offender.childId, null);
    } else {
      plan.blockers.push(
        `seq ${offender.seq}: child ${offender.childId} converged parent is ${converged}, ` +
          `neither the payload parent ${offender.parentId} nor parentless — unknown corruption, refusing`,
      );
    }
  }

  if (plan.candidates.length === 0) return plan;

  plan.windowStart = Math.min(...plan.candidates.map((o) => o.seq));

  // Window end: every ancestor chain up to its entry root (a node whose own
  // parent first-created before the window). Cycles/never-created abort.
  const chainMax = (startParent: string, childSeq: number): number => {
    let max = 0;
    let current: string | null = startParent;
    const seen = new Set<string>();
    for (;;) {
      if (current === null) return max;
      if (seen.has(current)) {
        plan.blockers.push(`seq ${childSeq}: ancestor cycle at ${current}`);
        return max;
      }
      seen.add(current);
      const seq = scan.firstSeq.get(current);
      if (seq === undefined) {
        plan.blockers.push(`seq ${childSeq}: ancestor ${current} is never created`);
        return max;
      }
      if (seq < plan.windowStart) return max; // entry root — before the window
      max = Math.max(max, seq);
      current = scan.firstParent.get(current) ?? null;
    }
  };
  for (const offender of plan.candidates) {
    plan.windowEnd = Math.max(plan.windowEnd, chainMax(offender.parentId, offender.seq), offender.seq);
  }
  return plan;
}

/**
 * Stable topological order for the window: constraints are parent-first-create
 * → child-create (only when the parent's first create is itself in the
 * window); Kahn with a min-heap on original seq keeps unrelated envelopes in
 * their original relative order. Returns the window rows in new order.
 */
function topoSortWindow(windowRows: StoredRow[], scan: ScanResult): StoredRow[] {
  const inWindow = new Map<number, StoredRow>(windowRows.map((row) => [row.seq, row]));
  const indegree = new Map<number, number>(windowRows.map((row) => [row.seq, 0]));
  const dependents = new Map<number, number[]>();

  for (const row of windowRows) {
    if (row.op_type !== "object.create") continue;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const parentId = payload.parentId;
    if (typeof parentId !== "string") continue;
    const parentSeq = scan.firstSeq.get(parentId);
    if (parentSeq === undefined || !inWindow.has(parentSeq)) continue;
    // Depend on the parent's FIRST-create row (the replay anchor), not on any
    // duplicate re-create riding the window.
    const parentRow = scan.firstRow.get(parentId)!;
    indegree.set(row.seq, (indegree.get(row.seq) ?? 0) + 1);
    const list = dependents.get(parentRow.seq) ?? [];
    list.push(row.seq);
    dependents.set(parentRow.seq, list);
  }

  // Min-heap on original seq (ready set).
  const ready: number[] = [...indegree.entries()].filter(([, d]) => d === 0).map(([seq]) => seq);
  ready.sort((a, b) => a - b);
  const emitted: StoredRow[] = [];
  while (ready.length > 0) {
    const seq = ready.shift()!;
    const row = inWindow.get(seq)!;
    emitted.push(row);
    for (const dep of dependents.get(seq) ?? []) {
      const left = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, left);
      if (left === 0) {
        // Insertion-sorted push (window sizes are small enough).
        const at = ready.findIndex((s) => s > dep);
        if (at === -1) ready.push(dep);
        else ready.splice(at, 0, dep);
      }
    }
  }
  if (emitted.length !== windowRows.length) {
    throw new Error(`topological sort emitted ${emitted.length}/${windowRows.length} — constraint cycle in the window`);
  }
  return emitted;
}

// --- scratch replay (the strict gate) -------------------------------------------

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
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        store.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`strict replay failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- conformance quarantine ------------------------------------------------------

interface TailFailure {
  id: string;
  opType: string;
  error: string;
  affected: string[];
}

/** Node ids a payload names (the rows a deleted envelope would have touched). */
function affectedNodeIdsOf(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of ["objectId", "classId", "id", "parentId", "afterId", "beforeId"]) {
    const value = payload[key];
    if (typeof value === "string" && /^[0-9a-f-]{30,}$/.test(value)) ids.add(value);
  }
  return [...ids];
}

/**
 * Tolerant snapshot+tail replay that COLLECTS every throwing envelope
 * (the diagnosis pass; the strict gate aborts on the first, this one skips
 * and records — the same shape the sync server's hydration uses).
 */
function diagnoseTail(relay: RelayStorage, workspaceId: string): TailFailure[] {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let cursor = snapshot?.up_to_seq ?? 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
  }
  const failures: TailFailure[] = [];
  let pageCursor = cursor;
  for (;;) {
    const page = relay.catchUp(workspaceId, pageCursor, 10_000);
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        failures.push({
          id: envelope.id,
          opType: envelope.opType,
          error: error instanceof Error ? error.message : String(error),
          affected: affectedNodeIdsOf(envelope.payload as Record<string, unknown>),
        });
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    pageCursor = page.nextAfterSeq;
  }
  store.close();
  return failures;
}

/** Parent/embedding authority for a set of nodes, read from the frozen derived DB. */
function captureAuthority(
  dataDir: string,
  workspaceId: string,
  nodeIds: Iterable<string>,
): Map<string, { parent: string | null; emb: number | null }> {
  const out = new Map<string, { parent: string | null; emb: number | null }>();
  const derivedFile = join(dataDir, "derived", `${workspaceId}.db`);
  if (!existsSync(derivedFile)) return out;
  const derived = new Database(derivedFile, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>;
  try {
    const stmt = derived.prepare("SELECT parent_id, is_embedded FROM node WHERE id = ?");
    for (const id of nodeIds) {
      const row = stmt.get(id) as { parent_id: string | null; is_embedded: number } | undefined;
      if (row !== undefined) out.set(id, { parent: row.parent_id, emb: row.is_embedded });
    }
  } finally {
    derived.close();
  }
  return out;
}

// --- server-stopped gate ---------------------------------------------------------

async function assertServerStopped(dataDir: string): Promise<void> {
  const isScratchDir = resolve(dataDir).startsWith(tmpdir());
  if (!isScratchDir) {
    let alive = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        alive = (await fetch(HEALTH_URL, { signal: controller.signal })).ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(
        "refusing to --apply: the sync server answers on :8377 — the relay log must not be rewritten under it.\n" +
          "  stop:  docker compose stop notees-sync   (from the stack folder)\n" +
          "  start: docker compose start notees-sync  (after the migration verifies)",
      );
    }
  }

  const probePath = join(dataDir, "relay.db");
  if (existsSync(probePath)) {
    const probe = new Database(probePath) as InstanceType<typeof Database>;
    try {
      probe.pragma("busy_timeout = 1500");
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("CREATE TABLE IF NOT EXISTS __repair_parent_order_probe (x INTEGER)");
      probe.exec("DROP TABLE __repair_parent_order_probe");
      probe.exec("COMMIT");
    } catch (error) {
      try {
        probe.exec("ROLLBACK");
      } catch {
        // best effort
      }
      throw new Error(
        `refusing to --apply: the relay database is locked (${error instanceof Error ? error.message : String(error)}) — ` +
          "stop whatever holds it (the sync server: docker compose stop notees-sync) and re-run",
      );
    } finally {
      probe.close();
    }
  }
}

// --- snapshot handling -------------------------------------------------------------

/**
 * After a seq permutation, snapshots whose up_to_seq falls inside or after
 * the window have stale split points — back up the bytes and drop them.
 * Earlier snapshots stay valid (below-window splits are unchanged and the
 * store's applied_envelope is id-based).
 */
function dropStaleSnapshots(relay: RelayStorage, dataDir: string, windowStart: number): string[] {
  const stale = relay.db
    .prepare("SELECT id, workspace_id, up_to_seq FROM snapshot WHERE up_to_seq >= ?")
    .all(windowStart) as Array<{ id: string; workspace_id: string; up_to_seq: number }>;
  for (const row of stale) {
    const bytes = relay.readSnapshotData(row.id);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (bytes !== null) writeFileSync(`/tmp/snapshot-${row.id}.bak-${stamp}`, bytes);
    relay.db.prepare("DELETE FROM snapshot WHERE id = ?").run(row.id);
    try {
      unlinkSync(join(dataDir, "snapshots", `${row.id}.db`));
    } catch {
      // Bytes already gone.
    }
    console.log(
      `  snapshot ${row.id} (workspace ${row.workspace_id}, up_to_seq ${row.up_to_seq}) inside/after the window — ` +
        `backed up to /tmp/snapshot-${row.id}.bak-${stamp} and dropped.`,
    );
  }
  return stale.map((row) => row.id);
}

// --- main ---------------------------------------------------------------------------

/**
 * The conformance quarantine arm, standalone: diagnose the tail (tolerant
 * replay, every failure collected) and — on --apply — DELETE every envelope
 * the strict appliers can never apply. A thrown envelope is atomic and the
 * tolerant derived DB proves it never applied anywhere, so the converged
 * state rides untouched (repair-log-conformance V3's precedent, generalized
 * from guard-failing creates to every op shape). Returns the authority rows
 * for the touched nodes (frozen derived DB) when it deletes.
 */
function runQuarantine(
  relay: RelayStorage,
  dataDir: string,
  workspaceId: string,
  apply: boolean,
): { changed: boolean; authority: Map<string, { parent: string | null; emb: number | null }> } {
  const failures = diagnoseTail(relay, workspaceId);
  if (failures.length === 0) {
    return { changed: false, authority: new Map() };
  }
  const byKind = new Map<string, number>();
  for (const failure of failures) {
    byKind.set(failure.opType, (byKind.get(failure.opType) ?? 0) + 1);
  }
  console.log(`\n  quarantine: ${failures.length} tail envelope(s) the strict appliers can never apply:`);
  for (const [kind, count] of byKind) console.log(`    ${count} × ${kind}`);
  for (const failure of failures.slice(0, 8)) {
    console.log(`    ${failure.opType} ${failure.id.slice(0, 13)}… — ${failure.error.split("\n")[0]!.slice(0, 110)}`);
  }
  if (failures.length > 8) console.log(`    … and ${failures.length - 8} more (listed by kind above)`);
  if (!apply) {
    console.log("  dry run — the quarantine would DELETE these envelopes (they applied nowhere — the tolerant authority proves it).");
    return { changed: false, authority: new Map() };
  }
  const del = relay.db.transaction(() => {
    const stmt = relay.db.prepare("DELETE FROM envelope WHERE id = ?");
    for (const failure of failures) {
      const result = stmt.run(failure.id);
      if (result.changes !== 1) {
        throw new Error(`quarantine: expected to delete exactly 1 envelope (${failure.id}), changed ${result.changes}`);
      }
    }
  });
  del();
  console.log(
    `  quarantined (deleted) ${failures.length} never-applicable envelope(s) — strict replay could never apply them; ` +
      "the tolerant authority proves they never did.",
  );
  const touched = new Set<string>();
  for (const failure of failures) {
    for (const id of failure.affected) touched.add(id);
  }
  return { changed: true, authority: captureAuthority(dataDir, workspaceId, touched) };
}

function resequenceWorkspace(
  relay: RelayStorage,
  dataDir: string,
  workspaceId: string,
  apply: boolean,
): {
  changed: boolean;
  windowStart: number;
  windowEnd: number;
  expectedParent: Map<string, string | null>;
  authority: Map<string, { parent: string | null; emb: number | null }>;
} {
  const snapshot = relay.latestSnapshot(workspaceId);
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(`\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`);

  const rows = relay.db
    .prepare(
      `SELECT seq, id, workspace_id, op_type, payload FROM envelope
       WHERE workspace_id = ? AND op_type IN ('object.create','class.create') ORDER BY seq ASC`,
    )
    .all(workspaceId) as StoredRow[];
  const scan = scanWorkspace(rows);

  if (scan.neverCreated.length > 0) {
    console.log(`\n  ${scan.neverCreated.length} create(s) name a parent that is NEVER created — this script does not repair those:`);
    for (const entry of scan.neverCreated.slice(0, 10)) {
      console.log(`    seq ${entry.seq}  child ${entry.childId}  parent ${entry.parentId} (absent from the log)`);
    }
    throw new Error("never-created parents present — repair aborted (these need a different remedy)");
  }

  if (scan.offenders.length === 0) {
    console.log("  nothing to resequence — no out-of-order object.create in this workspace.");
    // The workspace can still carry conformance poison the strict gate can
    // never pass (the quarantine arm stands alone — repair-log-conformance
    // territory): diagnose; on --apply delete + verify. This is the path that
    // completes a workspace a previous repair left mid-flight.
    const quarantine = runQuarantine(relay, dataDir, workspaceId, apply);
    if (quarantine.changed) {
      return {
        changed: true,
        windowStart: Infinity,
        windowEnd: 0,
        expectedParent: new Map(),
        authority: quarantine.authority,
      };
    }
    return { changed: false, windowStart: Infinity, windowEnd: 0, expectedParent: new Map(), authority: new Map() };
  }

  // The converged projection (the server derived DB) is the authority for the
  // classification. Absent (scratch dirs): the payload edge is assumed true.
  const derivedFile = join(dataDir, "derived", `${workspaceId}.db`);
  let convergedParent: (id: string) => string | null | undefined;
  let closeDerived: () => void = () => undefined;
  if (existsSync(derivedFile)) {
    const derived = new Database(derivedFile, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>;
    const stmt = derived.prepare("SELECT parent_id FROM node WHERE id = ?");
    convergedParent = (id) => {
      const row = stmt.get(id) as { parent_id: string | null } | undefined;
      return row === undefined ? undefined : row.parent_id;
    };
    closeDerived = () => derived.close();
  } else {
    convergedParent = () => undefined;
  }

  let plan: SeqPlan;
  try {
    plan = buildSeqPlan(rows, scan, convergedParent);
  } finally {
    closeDerived();
  }

  if (plan.blockers.length > 0) {
    console.log(`\n  ${plan.blockers.length} blocker(s):`);
    for (const blocker of plan.blockers) console.log(`    ${blocker}`);
    if (apply) throw new Error("plan blocked — refusing to write (nothing was modified)");
    console.log("  dry run: --apply would refuse until the blockers are resolved.");
    return { changed: false, windowStart: Infinity, windowEnd: 0, expectedParent: new Map(), authority: new Map() };
  }

  console.log(`\n  planned resequence: ${plan.candidates.length} candidate(s) (birth edge true — order repair), ${plan.stripOnly.length} strip-only (dead edge).`);
  for (const offender of plan.stripOnly) {
    console.log(`    strip-only seq ${offender.seq}  child ${offender.childId} (converged parentless)`);
  }

  if (plan.candidates.length === 0 && plan.stripOnly.length === 0) {
    return { changed: false, windowStart: Infinity, windowEnd: 0, expectedParent: new Map(), authority: new Map() };
  }

  // The window envelopes: ALL workspaces' envelopes in the range (seq is a
  // global ordering authority; other workspaces ride along in stable order).
  let windowRows: StoredRow[] = [];
  if (plan.candidates.length > 0) {
    windowRows = relay.db
      .prepare(
        `SELECT seq, id, workspace_id, op_type, payload FROM envelope
         WHERE seq >= ? AND seq <= ? ORDER BY seq ASC`,
      )
      .all(plan.windowStart, plan.windowEnd) as StoredRow[];
    plan.windowOrder = topoSortWindow(windowRows, scan);
  }

  // Quarantine MANIFEST (read-only, both modes): the tolerant diagnosis over
  // the tail as it stands — the envelope set the strict appliers can never
  // apply. The dry run prints it for owner review BEFORE any outage; --apply
  // re-diagnoses after the reseq (authoritative — the sets matched on the
  // live rehearsal: the reseq permutes creates, it cannot unmask new throws)
  // and deletes that set.
  const manifest = runQuarantine(relay, dataDir, workspaceId, false);

  if (!apply) {
    if (plan.candidates.length > 0) {
      console.log(
        `\n  window [${plan.windowStart}..${plan.windowEnd}]: ${windowRows.length} envelope(s) — a permutation inside the range ` +
          "(payloads untouched; seqs outside the window unchanged).",
      );
      const moved = plan.windowOrder.filter((row, index) => row.seq !== windowRows[index]!.seq);
      console.log(`  ${moved.length} of ${windowRows.length} window envelope(s) change position; sample assignments:`);
      for (const row of moved.slice(0, 10)) {
        const newSeq = plan.windowStart + plan.windowOrder.indexOf(row);
        console.log(`    seq ${row.seq} → ${newSeq}  ${row.op_type} ${row.id.slice(0, 13)}…`);
      }
      if (moved.length > 10) console.log(`    … and ${moved.length - 10} more`);
    }
    console.log("  dry run — re-run with --apply to perform the resequencing (server stopped: backup → reseq → quarantine → epoch → verify).");
    return { changed: false, windowStart: plan.windowStart, windowEnd: plan.windowEnd, expectedParent: plan.expectedParent, authority: new Map() };
  }

  // --- apply ---------------------------------------------------------------

  // 1. Strip-only rewrites: parentId off the dead-edge creates (payloads
  //    otherwise untouched; strict-schema re-validated).
  if (plan.stripOnly.length > 0) {
    const strip = relay.db.transaction(() => {
      for (const offender of plan.stripOnly) {
        const { parentId: _retired, ...surviving } = offender.payload;
        const check = payloadSchemaFor("object.create")!.safeParse(surviving);
        if (!check.success) {
          throw new Error(`seq ${offender.seq}: stripped object.create payload no longer validates: ${check.error.message}`);
        }
        const result = relay.db
          .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND id = ? AND workspace_id = ?")
          .run(JSON.stringify(surviving), offender.seq, offender.envelopeId, workspaceId);
        if (result.changes !== 1) {
          throw new Error(`seq ${offender.seq}: expected to strip exactly 1 envelope, changed ${result.changes}`);
        }
      }
    });
    strip();
    console.log(`  stripped parentId from ${plan.stripOnly.length} dead-edge create envelope(s) in place.`);
  }

  // 2. The seq permutation, window rows only (outside-window seqs are the
  //    identity — never touched): negate the window rows (unique negatives,
  //    no PK collisions), then assign the topological order's positives. The
  //    result is a pure permutation inside [windowStart..windowEnd].
  if (plan.candidates.length > 0) {
    const remap = relay.db.transaction(() => {
      const negate = relay.db.prepare("UPDATE envelope SET seq = -seq WHERE id = ?");
      const assign = relay.db.prepare("UPDATE envelope SET seq = ? WHERE id = ?");
      for (const row of plan.windowOrder) negate.run(row.id);
      plan.windowOrder.forEach((row, index) => {
        const newSeq = plan.windowStart + index;
        const result = assign.run(newSeq, row.id);
        if (result.changes !== 1) {
          throw new Error(`envelope ${row.id}: expected to reassign exactly 1 row, changed ${result.changes}`);
        }
      });
      const leftover = relay.db.prepare("SELECT COUNT(*) AS n FROM envelope WHERE seq < 0").get() as { n: number };
      if (leftover.n !== 0) {
        throw new Error(`${leftover.n} window envelope(s) still hold a negative seq after the remap`);
      }
    });
    remap();
    const movedCount = plan.windowOrder.filter((row, index) => row.seq !== plan.windowStart + index).length;
    console.log(
      `  resequenced window [${plan.windowStart}..${plan.windowEnd}]: ${windowRows.length} envelope(s) permuted ` +
        `(${movedCount} changed position; payloads/ids/HLCs untouched).`,
    );
  }

  // 3. Stale snapshots (up_to_seq inside/after the window) — backed up + dropped.
  dropStaleSnapshots(relay, dataDir, plan.windowStart);

  // 4. Conformance quarantine: re-diagnose the POST-reseq tail (authoritative)
  //    and DELETE every envelope the strict appliers can never apply.
  const quarantine = runQuarantine(relay, dataDir, workspaceId, true);
  const touched = new Set<string>(quarantine.authority.keys());
  if (quarantine.changed && !manifest.changed) {
    console.log("  note: the pre-reseq manifest found nothing to quarantine — the authoritative post-reseq diagnosis stands.");
  }
  // The offender children themselves join the authority gate. Candidates
  // gate parent AND embedding (the reseq preserves their birth payloads, so
  // the converged embedding must match the derived DB exactly). Strip-only
  // children gate parent only — their embedding in the derived DB is a
  // tolerated-skip artifact (the dead-edge birth's payload is gone; whatever
  // the later re-create carried won), while the strict replay converges the
  // stripped create's own flag.
  for (const childId of plan.expectedParent.keys()) touched.add(childId);

  // 5. Authority rows for every touched node (offender children + quarantine
  //    touched), captured from the frozen derived DB — the verify gate.
  const authority = captureAuthority(dataDir, workspaceId, touched);
  for (const offender of plan.stripOnly) {
    const entry = authority.get(offender.childId);
    if (entry !== undefined) authority.set(offender.childId, { parent: entry.parent, emb: null });
  }

  return {
    changed: true,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    expectedParent: plan.expectedParent,
    authority,
  };
}

/** Post-write verification for one workspace: strict replay with ZERO throws,
 *  zero offenders on the re-scan, every repaired child under its converged
 *  parent, and every authority-touched node's parent/embedding matching the
 *  frozen derived DB. */
function verifyResequenced(
  relay: RelayStorage,
  dataDir: string,
  workspaceId: string,
  expectedParent: Map<string, string | null>,
  authority: Map<string, { parent: string | null; emb: number | null }>,
): void {
  const store = buildScratchStore(relay, workspaceId);
  try {
    const stmt = store.database.prepare("SELECT parent_id, is_embedded FROM node WHERE id = ?");
    for (const [childId, expected] of expectedParent) {
      const row = stmt.get(childId) as { parent_id: string | null; is_embedded: number } | undefined;
      if (row === undefined) {
        throw new Error(`verification failed: child ${childId} absent from the strict replay`);
      }
      if (row.parent_id !== expected) {
        throw new Error(`verification failed: child ${childId} parent_id = ${row.parent_id}, expected ${expected}`);
      }
    }
    console.log(
      `verify: strict replay clean — ${expectedParent.size} repaired child(ren) under their converged parents ` +
        `(${[...expectedParent.values()].filter((p) => p === null).length} parentless by design).`,
    );
    const mismatches: string[] = [];
    for (const [id, want] of authority) {
      const row = stmt.get(id) as { parent_id: string | null; is_embedded: number } | undefined;
      if (row === undefined) continue; // node absent from the strict replay too (deleted later in the log)
      const embBad = want.emb !== null && row.is_embedded !== want.emb;
      if (row.parent_id !== want.parent || embBad) {
        mismatches.push(
          `${id}: replay {parent:${row.parent_id}, emb:${row.is_embedded}} != authority {parent:${want.parent}, emb:${want.emb ?? "?"}}`,
        );
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `verification failed: ${mismatches.length} authority-touched node(s) diverge from the derived DB:\n  ${mismatches.join("\n  ")}`,
      );
    }
    if (authority.size > 0) {
      console.log(`verify: ${authority.size} authority-touched node(s) match the derived DB (parent + embedding).`);
    }
  } finally {
    store.close();
  }

  // Re-scan arm: zero out-of-order creates remain.
  const rows = relay.db
    .prepare(
      `SELECT seq, id, workspace_id, op_type, payload FROM envelope
       WHERE workspace_id = ? AND op_type IN ('object.create','class.create') ORDER BY seq ASC`,
    )
    .all(workspaceId) as StoredRow[];
  const recheck = scanWorkspace(rows);
  if (recheck.neverCreated.length > 0) {
    throw new Error(`verification failed: ${recheck.neverCreated.length} never-created parent(s) remain`);
  }
  if (recheck.offenders.length > 0) {
    throw new Error(`verification failed: ${recheck.offenders.length} out-of-order create(s) remain after the reseq`);
  }
  console.log("verify: two-pass re-scan finds zero out-of-order creates.");

  // Cross-check against the frozen derived DB authority (read-only).
  const derivedFile = join(dataDir, "derived", `${workspaceId}.db`);
  if (existsSync(derivedFile)) {
    const derived = new Database(derivedFile, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>;
    try {
      const stmt = derived.prepare("SELECT parent_id FROM node WHERE id = ?");
      const mismatches: string[] = [];
      for (const [childId, expected] of expectedParent) {
        const row = stmt.get(childId) as { parent_id: string | null } | undefined;
        if (row !== undefined && row.parent_id !== expected) {
          mismatches.push(`${childId}: authority ${row.parent_id} != expected ${expected}`);
        }
      }
      if (mismatches.length > 0) {
        throw new Error(`verification failed: ${mismatches.length} child(ren) diverge from the derived authority:\n  ${mismatches.join("\n  ")}`);
      }
      console.log("verify: replayed parents match the derived-DB authority for every repaired child.");
    } finally {
      derived.close();
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `parent-order resequencing: ${workspaces.length} workspace(s) (${options.apply ? "--apply" : "dry run"})`,
    );

    if (options.apply) {
      await assertServerStopped(options.dataDir);
    }

    // One backup covers everything (the relay is one file); naming follows
    // the existing relay.db.bak-YYYYMMDD-HHMMSS files.
    if (options.apply) {
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      relay.db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(join(options.dataDir, "relay.db"), join(options.dataDir, `relay.db.bak-${stamp}`));
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = join(options.dataDir, `relay.db${suffix}`);
        if (existsSync(sidecar)) copyFileSync(sidecar, join(options.dataDir, `relay.db.bak-${stamp}${suffix}`));
      }
      console.log(`\nbackup: ${join(options.dataDir, `relay.db.bak-${stamp}`)} (+ -wal/-shm sidecars when present)`);
    }

    // Plan + apply per workspace; the WINDOW is global so a later workspace's
    // plan sees the post-remap seqs — plans are computed one at a time and
    // each returns its expectation + authority maps for verify.
    const affected = new Map<
      string,
      { expectedParent: Map<string, string | null>; authority: Map<string, { parent: string | null; emb: number | null }> }
    >();
    let windowStart = Infinity;
    let windowEnd = 0;
    for (const workspaceId of workspaces) {
      const outcome = resequenceWorkspace(relay, options.dataDir, workspaceId, options.apply);
      if (outcome.changed) {
        windowStart = Math.min(windowStart, outcome.windowStart);
        windowEnd = Math.max(windowEnd, outcome.windowEnd);
        affected.set(workspaceId, { expectedParent: outcome.expectedParent, authority: outcome.authority });
      }
    }

    if (!options.apply) {
      return;
    }

    if (affected.size === 0) {
      console.log("\nnothing changed — no resequencing was applied.");
      return;
    }

    // Epoch: bump every workspace that has an envelope inside the window (its
    // client's cursor may point inside the permuted range). A strip-only
    // change has no window — bump that workspace directly.
    if (windowStart !== Infinity) {
      const bumped = relay.db
        .prepare(
          `SELECT DISTINCT workspace_id FROM envelope WHERE seq >= ? AND seq <= ? ORDER BY workspace_id`,
        )
        .all(windowStart, windowEnd) as Array<{ workspace_id: string }>;
      for (const { workspace_id } of bumped) {
        const epoch = relay.bumpRestoreEpoch(workspace_id);
        console.log(`restore_epoch bumped to ${epoch} (workspace ${workspace_id}).`);
      }
    }
    for (const workspaceId of [...affected.keys()].sort()) {
      const windowed =
        windowStart !== Infinity &&
        relay.db
          .prepare("SELECT 1 FROM envelope WHERE workspace_id = ? AND seq >= ? AND seq <= ? LIMIT 1")
          .get(workspaceId, windowStart, windowEnd) !== undefined;
      if (windowed) continue; // bumped in the window pass
      const epoch = relay.bumpRestoreEpoch(workspaceId);
      console.log(`restore_epoch bumped to ${epoch} (workspace ${workspaceId}, strip-only change).`);
    }

    // Verify every workspace the plan touched (strict replay + re-scan +
    // derived-authority cross-check). Runs BEFORE the done message so any
    // failure aborts with the backup intact.
    for (const [workspaceId, expectations] of affected) {
      verifyResequenced(
        relay,
        options.dataDir,
        workspaceId,
        expectations.expectedParent,
        expectations.authority,
      );
    }

    console.log(
      "\ndone. START the sync server again (docker compose start notees-sync) — it rehydrates from the resequenced log; " +
        "clients converge via the restore_epoch wipe + resync.",
    );
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
