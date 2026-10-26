/**
 * Parent-order repair (the 2026-10-26 audit): the live relay log carries
 * out-of-order `object.create` envelopes — a child create whose
 * `payload.parentId`'s own first create appears LATER in the log (a
 * bulk-import session's batches raced; the import client re-issued creates
 * idempotently, so the tolerant replicas self-healed, but STRICT log-order
 * replay fails with "object.create: parent … does not exist" and the
 * pre-ingest replay gate every Path A migration applies blocks).
 *
 * The repair (migrations.md Path A log rewrite, sanctioned one-time in-place):
 *  1. Scan (two-pass, readonly): classify `object.create` envelopes whose
 *     `parentId`'s first create seq > their own seq. The payload id field is
 *     `objectId` (node creates) OR `id` OR `classId` (class creates); class
 *     creates are roots and never offenders, but they DO parent-resolve.
 *  2. Rewrite IN PLACE (same seq, same envelope id): strip `parentId` from
 *     each offending envelope (a parentless create is always legal — the
 *     date-chain lock explicitly admits it as the self-heal shape). Every
 *     rewritten payload re-validates through payloadSchemaFor before write.
 *  3. APPEND one `object.move {objectId, parentId}` per repair at the tail
 *     (deterministic UUIDv5 envelope ids — `repair-parent-order:<ws>:<child>`
 *     under a fixed namespace — so re-runs insert-idempotent via
 *     RelayStorage.ingest's INSERT OR IGNORE; HLC = workspace max + n so the
 *     move wins the parent LWW at replay). The moves replay after both nodes
 *     exist, restoring the tree edge under a strict applier.
 *     Guard caveat:
 *     a parentless is_embedded = 1 node ACQUIRES the standalone claim when
 *     first parented by a move, and a standalone (is_embedded = 0) node can
 *     only move under a parent that renders document chrome — so the move
 *     THROWS MoveGuardError when the parent is a class or an embedded block.
 *     The scan classifies every planned move against that guard (via
 *     rendersWithDocumentChrome on the converged parent row) and --apply
 *     refuses to write anything when any move is classified dirty — the
 *     post-write scratch-replay gate is the second net.
 *  4. Move targets come from the CONVERGED tree (the server derived DB), not
 *     blindly from the create payload: a child the converged projection holds
 *     parentless gets NO move (rewrite only); a child whose converged parent
 *     differs from the create payload's gets a move to the CONVERGED parent
 *     (listed loudly). Any later object.move touching a child with a
 *     different parent would be reverted by the tail move → hard abort.
 *  5. Snapshot: when the newest snapshot does not contain every node a
 *     planned move references (child + parent), snapshot+tail replay cannot
 *     serve strict clients (the move would throw NotFoundError against the
 *     restored rows) → the snapshot row + bytes are backed up and DELETED
 *     (a snapshot is an optimization, never authority — the next hydration
 *     replays the full log, the documented slow path). When every referenced
 *     node IS in the snapshot the rows make the moves ordinary reparents
 *     (the child is already parented there — no first-parenting guard) and
 *     the snapshot stays.
 *  6. Bump restore_epoch per rewritten workspace (clients wipe + resync).
 *  7. Verify (the migration tooling gate): a FRESH scratch store replays
 *     snapshot+tail with zero StoreError throws, every repaired child reads
 *     back its expected parent_id, and the two-pass re-scan finds zero
 *     offenders.
 *
 * Idempotent: a second run's scan finds every first create already parentless
 * → plans nothing (the appended moves ride the log un-referenced). One move
 * PER CHILD: the idempotent re-create cascade can leave two out-of-order
 * creates for the same child — the first occurrence carries the move, the
 * duplicates are stripped only (their deterministic envelope ids would
 * otherwise collide and ingest would silently drop them). A zero-repair run
 * over a workspace that already carries this script's repair moves is a
 * RESUME of a run that died between ingest and the tail stages: it executes
 * the snapshot-probe / epoch / verify stages instead of short-circuiting.
 *
 * --apply enforces the sync server is STOPPED (a /healthz liveness probe on
 * :8377 plus a write-lock probe on the target relay.db; the port probe is
 * skipped for --data-dir under the OS temp dir — the scratch/test shape,
 * where the lock probe still guards). It prints the exact stop/start commands.
 *
 * DRY RUN BY DEFAULT: prints the full offender list (seq, child, parent,
 * parentSeq) + the per-move guard classification and writes nothing.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-repair-parent-order.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// better-sqlite3 is not a root dependency (it lives under @notees/store) —
// resolve it from the store package, the same binary the server runs.
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "../packages/store/package.json"));
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import {
  parseDateNodeId,
  dateChainParentId,
  rendersWithDocumentChrome,
} from "../packages/domain/src/index.ts";
import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a4";
const DEVICE = "migrate-repair-parent-order";
const CLIENT = "migrate-repair-parent-order";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const HEALTH_URL = "http://127.0.0.1:8377/healthz";
/** Fixed namespace for the deterministic envelope ids (UUIDv5). */
const ID_NAMESPACE = "01940000-0000-7000-8000-0000000000b7";

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

// --- planning -----------------------------------------------------------------

export interface StoredRow {
  seq: number;
  id: string;
  workspace_id: string;
  op_type: string;
  payload: string;
}

export interface PlannedRepair {
  seq: number;
  envelopeId: string;
  childId: string;
  /** The parentId the offending create payload carries (the tree edge to restore). */
  originalParentId: string;
  /** First-create seq of the original parent (always > seq for an offender). */
  parentSeq: number;
  /** The create payload (rewritten copy strips parentId). */
  payload: Record<string, unknown>;
  /**
   * The parent the appended move targets — the CONVERGED parent when the
   * derived projection is available; null = the converged tree holds the
   * child parentless → rewrite only, no move.
   */
  moveTarget: string | null;
  /** moveTarget resolved from the converged projection (vs the payload default). */
  targetSource: "converged" | "payload" | "none";
  /** Classifies against the object.move write-time guards; "clean" = replays. */
  guard: "clean" | "risk";
  guardNote: string;
}

export interface RepairPlan {
  repairs: PlannedRepair[];
  /** Hard-abort conditions found during planning (never-written apply). */
  blockers: string[];
  /** Never-created parents (a class of corruption this script does NOT repair). */
  neverCreated: Array<{ seq: number; childId: string; parentId: string }>;
}

/** The node id a create payload declares (objectId | id | classId). */
function createIdOf(opType: string, payload: Record<string, unknown>): string | undefined {
  if (opType !== "object.create" && opType !== "class.create") return undefined;
  const id = payload.objectId ?? payload.id ?? payload.classId;
  return typeof id === "string" ? id : undefined;
}

/**
 * The pure two-pass classifier over stored rows (exported for the planner
 * test). Pass 1 records every node's first-create seq; pass 2 flags
 * `object.create` rows whose payload.parentId first-create seq is LATER.
 * `lookup` resolves a node's converged {isClass, isEmbedded, parentId} (the
 * server derived DB, or a tolerant create-only projection) — used for the
 * move-guard classification and the converged move target. `convergedParent`
 * returns the derived projection's parent_id for a child, or undefined when
 * no projection is available.
 */
export function planRepairs(
  rows: StoredRow[],
  lookup: (id: string) => { isClass: boolean; isEmbedded: number; parentId: string | null } | null,
  convergedParent: (id: string) => string | null | undefined,
): RepairPlan {
  const firstSeq = new Map<string, number>();
  for (const row of rows) {
    const id = createIdOf(row.op_type, JSON.parse(row.payload) as Record<string, unknown>);
    if (id === undefined) continue;
    if (!firstSeq.has(id)) firstSeq.set(id, row.seq);
  }

  const plan: RepairPlan = { repairs: [], blockers: [], neverCreated: [] };
  const firstRepairSeqByChild = new Map<string, number>();
  for (const row of rows) {
    if (row.op_type !== "object.create") continue;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const childId = payload.objectId;
    const parentId = payload.parentId;
    if (typeof childId !== "string" || typeof parentId !== "string") continue;
    const parentSeq = firstSeq.get(parentId);
    if (parentSeq === undefined) {
      plan.neverCreated.push({ seq: row.seq, childId, parentId });
      continue;
    }
    if (parentSeq <= row.seq) continue;

    // The converged tree decides the move target (when a projection exists).
    const converged = convergedParent(childId);
    let moveTarget: string | null;
    let targetSource: PlannedRepair["targetSource"];
    if (converged === undefined) {
      moveTarget = parentId;
      targetSource = "payload";
    } else if (converged === null) {
      moveTarget = null;
      targetSource = "converged";
    } else {
      moveTarget = converged;
      targetSource = "converged";
    }

    // Guard classification, mirroring applyObjectMove's write-time checks for
    // a node our rewritten create leaves parentless. The effective embedding
    // bit rides the payload (explicit isEmbedded; a parentless create defaults
    // it to 0 — the applier's context default).
    let guard: PlannedRepair["guard"] = "clean";
    let guardNote = "move replays clean";
    if (moveTarget !== null) {
      const childEmb = payload.isEmbedded === false ? 0 : payload.isEmbedded === true ? 1 : 0;
      const dateShape = parseDateNodeId(childId);
      if (dateShape !== null && moveTarget !== dateChainParentId(childId)) {
        guard = "risk";
        guardNote = `date-chain lock: ${childId} may only live at ${dateChainParentId(childId)}, move targets ${moveTarget}`;
      } else {
        const parentRow = lookup(moveTarget);
        if (parentRow === null) {
          guard = "risk";
          guardNote = `move target ${moveTarget} not found in the converged projection`;
        } else {
          const grandparent = parentRow.parentId === null ? null : lookup(parentRow.parentId);
          const parentIsPage = rendersWithDocumentChrome(
            {
              isClass: parentRow.isClass,
              parentId: parentRow.parentId,
              isEmbedded: parentRow.isEmbedded,
            },
            grandparent === null
              ? null
              : { isClass: grandparent.isClass, parentId: grandparent.parentId, isEmbedded: grandparent.isEmbedded },
          );
          // First-parenting guard: an embedded-flagged node ACQUIRES the
          // standalone claim (claimsMain) and a standalone node requires a
          // page parent — either way a non-page parent throws MoveGuardError.
          // (The parentlessRole-block class exemption is a derived-DB-only
          // refinement; without it we classify conservatively.)
          if (!parentIsPage && childEmb === 0) {
            guard = "risk";
            guardNote = "standalone claim (isEmbedded false): the move guard requires a parent that renders document chrome";
          } else if (!parentIsPage && childEmb === 1) {
            guard = "risk";
            guardNote =
              "treat-as-main on first parenting: an is_embedded = 1 parentless node acquires the standalone claim via the move, which the guard rejects under a non-page parent";
          }
        }
      }
    } else {
      guardNote = "no move appended — the converged tree holds the child parentless";
    }

    // One move per child: the idempotent re-create cascade can leave TWO
    // out-of-order creates for the same child (a racing batch re-issue), and
    // the deterministic envelope ids are keyed by child — a second move would
    // collide and ingest would silently drop it. The first occurrence carries
    // the move; duplicates are still stripped in place (strict replay needs
    // every offending envelope parentless at its position) but emit nothing.
    const firstSeqForChild = firstRepairSeqByChild.get(childId);
    if (firstSeqForChild !== undefined) {
      moveTarget = null;
      targetSource = "none";
      guard = "clean";
      guardNote = `duplicate out-of-order create for ${childId} — the first occurrence (seq ${firstSeqForChild}) carries the move; this one is stripped only`;
    } else {
      firstRepairSeqByChild.set(childId, row.seq);
    }

    plan.repairs.push({
      seq: row.seq,
      envelopeId: row.id,
      childId,
      originalParentId: parentId,
      parentSeq,
      payload,
      moveTarget,
      targetSource,
      guard,
      guardNote,
    });
  }

  // A tail move must never revert a later reparent: any object.move after the
  // offender's seq touching the child with a different parent is a hard abort.
  const laterMoves = rows.filter((row) => row.op_type === "object.move" && row.seq > 0);
  for (const repair of plan.repairs) {
    if (repair.moveTarget === null) continue;
    for (const row of laterMoves) {
      if (row.seq <= repair.seq) continue;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (payload.objectId !== repair.childId) continue;
      if (payload.parentId !== repair.moveTarget) {
        plan.blockers.push(
          `seq ${row.seq}: object.move already reparents ${repair.childId} to ${String(payload.parentId)} ` +
            `after the out-of-order create — the appended tail move (→ ${repair.moveTarget}) would revert it`,
        );
      }
    }
  }
  return plan;
}

// --- projections ---------------------------------------------------------------

type NodeLookup = (id: string) => { isClass: boolean; isEmbedded: number; parentId: string | null } | null;

/**
 * The converged-node lookup: the server derived DB when its file exists
 * (fast path — the tolerant projection every replica agrees with today),
 * else a tolerant create-only replay of the log into a scratch store (the
 * same skip-on-StoreError hydration shape the sync server uses). The
 * create-only replay is sufficient for the guard classification: parent
 * chains and class flags all ride creates/updates already applied there.
 */
function openNodeLookup(relay: RelayStorage, workspaceId: string, dataDir: string): {
  lookup: NodeLookup;
  convergedParent: (id: string) => string | null | undefined;
  close: () => void;
} {
  const derivedFile = join(dataDir, "derived", `${workspaceId}.db`);
  if (existsSync(derivedFile)) {
    const db = new Database(derivedFile, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>;
    const stmt = db.prepare("SELECT is_class, is_embedded, parent_id FROM node WHERE id = ?");
    return {
      lookup: (id) => {
        const row = stmt.get(id) as { is_class: number; is_embedded: number; parent_id: string | null } | undefined;
        return row === undefined
          ? null
          : { isClass: row.is_class === 1, isEmbedded: row.is_embedded, parentId: row.parent_id };
      },
      convergedParent: (id) => {
        const row = stmt.get(id) as { parent_id: string | null } | undefined;
        return row === undefined ? undefined : row.parent_id;
      },
      close: () => db.close(),
    };
  }

  // Fallback: tolerant create-only projection (test/scratch data dirs).
  const store = Store.open(betterSqlite3Backend(":memory:"));
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      if (envelope.opType !== "object.create" && envelope.opType !== "class.create") continue;
      try {
        store.apply(envelope);
      } catch {
        // Tolerant hydration shape: skip what cannot apply (the out-of-order
        // creates themselves — their parents are what we classify).
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  const stmt = store.database.prepare("SELECT is_class, is_embedded, parent_id FROM node WHERE id = ?");
  return {
    lookup: (id) => {
      const row = stmt.get(id) as { is_class: number; is_embedded: number; parent_id: string | null } | undefined;
      return row === undefined
        ? null
        : { isClass: row.is_class === 1, isEmbedded: row.is_embedded, parentId: row.parent_id };
    },
    // A create-only projection cannot see converged parents (moves ride the
    // tail) — fall back to the payload default.
    convergedParent: () => undefined,
    close: () => store.close(),
  };
}

// --- envelopes -----------------------------------------------------------------

/** Deterministic UUIDv5 (the migration envelope-id convention): re-runs of the
 *  same repair produce the same id, so RelayStorage.ingest's INSERT OR IGNORE
 *  makes the append idempotent. */
export function deterministicEnvelopeId(workspaceId: string, childId: string): string {
  const digest = createHash("sha1")
    .update(Buffer.from(ID_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(`repair-parent-order:${workspaceId}:${childId}`)
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildMoveEnvelopes(workspaceId: string, repairs: PlannedRepair[]): Envelope[] {
  const hlcBase = Date.now();
  let logical = 0;
  return repairs
    .filter((repair) => repair.moveTarget !== null)
    .map((repair) => {
      const envelope = newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical: hlcBase, logical: logical++ },
        affectedNodeIds: [repair.childId],
        opType: "object.move",
        payload: { objectId: repair.childId, parentId: repair.moveTarget },
      });
      // Deterministic id over the random uuidv7 — envelopeSchema accepts any UUID.
      return { ...envelope, id: deterministicEnvelopeId(workspaceId, repair.childId) };
    });
}

/** The protocol gate: every envelope must satisfy the envelope schema AND its
 *  per-op payload schema BEFORE anything is inserted. */
function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    const envResult = envelopeSchema.safeParse(envelope);
    if (!envResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid — ${envResult.error.message}`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined) {
      failures.push(`${envelope.opType} ${envelope.id}: no payload schema registered`);
      continue;
    }
    const payloadResult = schema.safeParse(envelope.payload);
    if (!payloadResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid — ${payloadResult.error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`);
  }
}

// --- scratch replay (the strict gate) -------------------------------------------

/**
 * Restore snapshot+tail into a scratch store, throwing on ANY StoreError —
 * the pre-ingest replay gate the migration tooling applies. This is the gate
 * the out-of-order creates fail today.
 */
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

// --- server-stopped gate ---------------------------------------------------------

/**
 * --apply refuses to run while the sync server may be serving the target
 * relay: a liveness probe on :8377 (skipped for --data-dir under the OS temp
 * dir — the scratch/test shape, where the lock probe still guards) plus a
 * write-transaction probe on the target relay.db itself.
 */
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

  // Write-lock probe on the target relay.db (catches any live holder the port
  // probe cannot see, e.g. a differently-mapped deployment).
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

// --- verification -----------------------------------------------------------------

function verify(relay: RelayStorage, workspaceId: string, repairs: PlannedRepair[]): void {
  // One expectation per child: duplicates (stripped-only re-creates) converge
  // to the FIRST repair's move target, not to null.
  const expectedByChild = new Map<string, string | null>();
  for (const repair of repairs) {
    if (!expectedByChild.has(repair.childId)) expectedByChild.set(repair.childId, repair.moveTarget);
  }
  const store = buildScratchStore(relay, workspaceId);
  try {
    const stmt = store.database.prepare("SELECT parent_id, is_embedded FROM node WHERE id = ?");
    for (const [childId, expected] of expectedByChild) {
      const row = stmt.get(childId) as { parent_id: string | null; is_embedded: number } | undefined;
      if (row === undefined) {
        throw new Error(`verification failed: child ${childId} absent from the strict replay`);
      }
      if (row.parent_id !== expected) {
        throw new Error(
          `verification failed: child ${childId} parent_id = ${row.parent_id}, expected ${expected}`,
        );
      }
    }
    console.log(
      `verify: strict replay clean — ${expectedByChild.size} repaired child(ren) read back under their expected parents ` +
        `(${[...expectedByChild.values()].filter((p) => p === null).length} converged parentless by design).`,
    );
  } finally {
    store.close();
  }

  // The re-scan arm: the rewritten log must classify zero offenders.
  const rows = relay.db
    .prepare(
      `SELECT seq, id, workspace_id, op_type, payload FROM envelope
       WHERE workspace_id = ? AND op_type IN ('object.create','class.create') ORDER BY seq ASC`,
    )
    .all(workspaceId) as StoredRow[];
  const recheck = planRepairs(rows, () => null, () => undefined);
  if (recheck.neverCreated.length > 0) {
    throw new Error(`verification failed: ${recheck.neverCreated.length} never-created parent(s) remain`);
  }
  if (recheck.repairs.length > 0) {
    throw new Error(`verification failed: ${recheck.repairs.length} out-of-order create(s) remain after the rewrite`);
  }
  console.log("verify: two-pass re-scan finds zero out-of-order creates.");
}

// --- main ---------------------------------------------------------------------------

function migrateWorkspace(relay: RelayStorage, dataDir: string, workspaceId: string, apply: boolean): void {
  const snapshot = relay.latestSnapshot(workspaceId);
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(`\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`);

  const rows = relay.db
    .prepare(
      `SELECT seq, id, workspace_id, op_type, payload FROM envelope
       WHERE workspace_id = ? AND op_type IN ('object.create','class.create','object.move')
       ORDER BY seq ASC`,
    )
    .all(workspaceId) as StoredRow[];

  const projection = openNodeLookup(relay, workspaceId, dataDir);
  let plan: RepairPlan;
  try {
    plan = planRepairs(rows, projection.lookup, projection.convergedParent);
  } finally {
    projection.close();
  }

  if (plan.neverCreated.length > 0) {
    console.log(`\n  ${plan.neverCreated.length} create(s) name a parent that is NEVER created — this script does not repair those:`);
    for (const entry of plan.neverCreated.slice(0, 10)) {
      console.log(`    seq ${entry.seq}  child ${entry.childId}  parent ${entry.parentId} (absent from the log)`);
    }
    throw new Error("never-created parents present — repair aborted (these need a different remedy)");
  }

  if (plan.repairs.length === 0) {
    // Resume path: a previous run may have died between the move ingest and
    // the epoch/verify tail stages (the duplicate-move incident) — the log
    // then carries this script's repair moves while the scan plans nothing.
    // Re-running must still execute the snapshot/epoch/verify stages for such
    // a workspace, not short-circuit with "nothing to repair".
    const priorMoves = relay
      .allEnvelopes(workspaceId)
      .filter((envelope) => envelope.deviceId === DEVICE && envelope.opType === "object.move");
    if (priorMoves.length === 0) {
      console.log("  nothing to repair — no out-of-order object.create in this workspace.");
      return;
    }
    const expectations = priorMoves.map((envelope) => {
      const payload = envelope.payload as { objectId: string; parentId: string | null };
      return { childId: payload.objectId, moveTarget: payload.parentId };
    });
    console.log(
      `\n  nothing to repair — but ${expectations.length} prior repair move(s) ride the log; ` +
        "running the snapshot/epoch/verify tail stages only (resuming a previous run).",
    );
    if (!apply) {
      console.log("  dry run — re-run with --apply to execute the tail stages.");
      return;
    }
    ensureSnapshotCompatible(
      relay,
      dataDir,
      workspaceId,
      expectations.flatMap((e) => [e.childId, ...(e.moveTarget !== null ? [e.moveTarget] : [])]),
    );
    if (relay.restoreEpoch(workspaceId) === 0) {
      const resumedEpoch = relay.bumpRestoreEpoch(workspaceId);
      console.log(`  restore_epoch was 0 with repair envelopes already in the log — bumped to ${resumedEpoch}.`);
    } else {
      console.log(`  restore_epoch already ${relay.restoreEpoch(workspaceId)} — left unchanged.`);
    }
    verify(relay, workspaceId, expectations);
    return;
  }

  console.log(`\n  planned parent-order repair (${plan.repairs.length} out-of-order create(s)):`);
  for (const repair of plan.repairs) {
    const target =
      repair.moveTarget === null
        ? "(no move — converged parentless)"
        : repair.moveTarget === repair.originalParentId
          ? `move → ${repair.moveTarget} (the original parent)`
          : `move → ${repair.moveTarget} (CONVERGED parent — differs from the create payload's ${repair.originalParentId})`;
    console.log(`    seq ${repair.seq}  child ${repair.childId}  parent ${repair.originalParentId} @${repair.parentSeq}  ${target}`);
    if (repair.guard !== "clean") {
      console.log(`      GUARD RISK: ${repair.guardNote}`);
    }
  }

  if (plan.blockers.length > 0) {
    console.log(`\n  ${plan.blockers.length} blocker(s) — the tail move would revert later log state:`);
    for (const blocker of plan.blockers) console.log(`    ${blocker}`);
    if (apply) throw new Error("plan blocked — refusing to write (nothing was modified)");
    console.log("  dry run: --apply would refuse until the blockers are resolved.");
    return;
  }
  if (plan.repairs.some((repair) => repair.guard !== "clean")) {
    console.log(
      "\n  at least one appended move fails the object.move write-time guard at replay " +
        "(see GUARD RISK lines) — a bare move cannot restore an edge under a class/embedded-block parent. " +
        "Refusing to write; the tree needs a different repair shape.",
    );
    if (apply) throw new Error("move-guard preflight failed — refusing to write (nothing was modified)");
    console.log("  dry run: --apply would refuse until the guard risks are resolved.");
    return;
  }

  const moves = buildMoveEnvelopes(workspaceId, plan.repairs);
  validateEnvelopes(moves);
  console.log(`\n  ${plan.repairs.length} envelope(s) to rewrite in place; ${moves.length} move envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("  dry run — re-run with --apply to perform the repair (server stopped: backup → rewrite → append → epoch → verify).");
    return;
  }

  // --- apply ---------------------------------------------------------------

  // 1. Rewrite in place, one transaction: strip parentId from each offending
  //    create payload. seq/id/HLC untouched; every other key untouched. Each
  //    rewritten payload re-validates through the strict payload schema — the
  //    assertion IS the point.
  const rewrite = relay.db.transaction(() => {
    for (const repair of plan.repairs) {
      const { parentId: _retired, ...surviving } = repair.payload;
      const schema = payloadSchemaFor("object.create")!;
      const check = schema.safeParse(surviving);
      if (!check.success) {
        throw new Error(`seq ${repair.seq}: rewritten object.create payload no longer validates: ${check.error.message}`);
      }
      const result = relay.db
        .prepare("UPDATE envelope SET payload = ? WHERE seq = ? AND id = ? AND workspace_id = ?")
        .run(JSON.stringify(surviving), repair.seq, repair.envelopeId, workspaceId);
      if (result.changes !== 1) {
        throw new Error(`seq ${repair.seq}: expected to rewrite exactly 1 envelope, changed ${result.changes}`);
      }
    }
  });
  rewrite();
  console.log(`  rewrote ${plan.repairs.length} create envelope(s) in place (parentId stripped; seq/id/HLC untouched).`);

  // 2. Append the tail moves through the ordinary storage mechanics.
  if (moves.length > 0) {
    const { savedIds } = relay.ingest(moves);
    if (savedIds.length !== moves.length) {
      throw new Error(`ingest saved ${savedIds.length}/${moves.length} move envelopes (duplicate ids?)`);
    }
    console.log(`  appended ${savedIds.length} object.move envelope(s) at the tail (deterministic ids — re-runs are insert-idempotent).`);
  }

  // 3. Snapshot compatibility (probe + drop when the moves cannot replay
  //    against the restored rows).
  const movedChildren = plan.repairs.filter((r) => r.moveTarget !== null);
  ensureSnapshotCompatible(
    relay,
    dataDir,
    workspaceId,
    movedChildren.flatMap((repair) => [repair.childId, repair.moveTarget as string]),
  );

  // 4. Epoch bump: every client wipes + resyncs from the repaired log.
  const epoch = relay.bumpRestoreEpoch(workspaceId);
  console.log(`  restore_epoch bumped to ${epoch}.`);

  // 5. Verify (the strict scratch-replay gate + parent readback + re-scan).
  verify(relay, workspaceId, plan.repairs);
}

/** fs-extra-free Buffer copy (copyFileSync needs a path; snapshot bytes may only exist in memory). */
function copyBuffer(bytes: Buffer, target: string): void {
  writeFileSync(target, bytes);
}

/**
 * Snapshot compatibility probe (shared by the apply and the resume paths): a
 * snapshot that lacks a node a repair move references cannot serve strict
 * snapshot+tail replay (the move would throw against the restored rows).
 * Back it up and drop it — full replay is the slow correct path; the server
 * re-saves a snapshot after hydrating.
 */
function ensureSnapshotCompatible(
  relay: RelayStorage,
  dataDir: string,
  workspaceId: string,
  referencedIds: string[],
): void {
  const fresh = relay.latestSnapshot(workspaceId);
  const freshBytes = fresh === null ? null : relay.readSnapshotData(fresh.id);
  if (fresh !== null && freshBytes === null) {
    console.log(`  snapshot ${fresh.id} has no bytes on disk — dropping the dangling row.`);
    relay.db.prepare("DELETE FROM snapshot WHERE id = ?").run(fresh.id);
    return;
  }
  if (fresh === null || freshBytes === null || referencedIds.length === 0) return;

  const referenced = new Map<string, string>();
  for (const id of referencedIds) referenced.set(id, id);
  const dir = mkdtempSync(join(tmpdir(), "notees-repair-parent-order-snap-probe-"));
  const probeFile = join(dir, "snapshot.db");
  let missing: string[] = [];
  try {
    writeFileSync(probeFile, freshBytes);
    const probe = new Database(probeFile, { readonly: true, fileMustExist: true }) as InstanceType<typeof Database>;
    try {
      const stmt = probe.prepare("SELECT 1 FROM node WHERE id = ?");
      missing = [...referenced.keys()].filter((id) => stmt.get(id) === undefined);
    } finally {
      probe.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (missing.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyBuffer(freshBytes, `/tmp/snapshot-${fresh.id}.bak-${stamp}`);
    relay.db.prepare("DELETE FROM snapshot WHERE id = ?").run(fresh.id);
    unlinkSync(join(dataDir, "snapshots", `${fresh.id}.db`));
    console.log(
      `  snapshot ${fresh.id} lacks ${missing.length} move-referenced node(s) — backed up to /tmp/snapshot-${fresh.id}.bak-${stamp} and DELETED ` +
        "(strict snapshot+tail replay would throw against it; full-log replay is the slow correct path).",
    );
  } else {
    console.log("  snapshot contains every move-referenced node — the moves replay as ordinary reparents; left in place.");
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
      `parent-order repair: ${workspaces.length} workspace(s) (${options.apply ? "--apply" : "dry run"})`,
    );

    if (options.apply) {
      await assertServerStopped(options.dataDir);
    }

    // One backup covers every rewritten workspace (the relay is one file).
    // Naming follows the existing relay.db.bak-YYYYMMDD-HHMMSS files.
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

    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, options.dataDir, workspaceId, options.apply);
    }

    if (options.apply) {
      console.log(
        "\ndone. START the sync server again (docker compose start notees-sync) — it rehydrates from the repaired log; " +
          "clients converge via the restore_epoch wipe + resync.",
      );
    }
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
