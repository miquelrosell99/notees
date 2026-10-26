/**
 * query-class marker migration: a query block is
 * MARKED by the query system class (the whiteboard precedent — class =
 * identity/membership, so every query in the workspace lists through the
 * class machinery); its `query` content token only carries the default
 * tab's AST as payload. Before this ruling the token alone marked the
 * block, and the web's read was token-based — this migration appends the
 * class assignment for every node that carries a query token WITHOUT the
 * query class, so the strict class-based read (owner choice) renders them.
 *
 * Path A (migrations.md — the immutable relay log is never edited): one
 * `object.create` carrier envelope per unmarked node (class.assign rides
 * object.create, the OR-Set add carrier — the same idempotent re-create the
 * web client's assignClass issues, with the node's current parentId +
 * contentAst verbatim so the re-create is lossless). Date-chain nodes are
 * class-locked (their class set is fixed to the precision's system class)
 * and are reported + skipped, never touched.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (every token-bearing node carries the class).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot sees every planned node
 * carrying the query class (zero StoreError throws).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-query-class.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, dateChainClassId } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a3";
const DEVICE = "migrate-query-class";
const CLIENT = "migrate-query-class";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const QUERY_ID = SYSTEM_CLASS_UUIDS.query;

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

// --- scratch derived store ----------------------------------------------------

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). Throws on any StoreError — a tail that cannot apply must block the
 * migration, not be planned against.
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
        throw new Error(`tail apply failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- planning -----------------------------------------------------------------

interface PlannedNode {
  id: string;
  parentId: string | null;
  contentAst: unknown[];
}

interface SkippedNode {
  id: string;
  reason: string;
}

/** Nodes carrying a query token without the query class (the migration set). */
function planAssignments(store: Store): { planned: PlannedNode[]; skipped: SkippedNode[] } {
  const rows = store.database
    .prepare(
      `SELECT n.id, n.parent_id, n.content, n.class_ids
       FROM node n
       WHERE n.id NOT IN (SELECT node_id FROM trash)`,
    )
    .all() as Array<{ id: string; parent_id: string | null; content: string; class_ids: string }>;
  const planned: PlannedNode[] = [];
  const skipped: SkippedNode[] = [];
  for (const row of rows) {
    let content: unknown[] = [];
    try {
      content = JSON.parse(row.content) as unknown[];
    } catch {
      continue; // a corrupt row fails loud at the client's parse, never here
    }
    const hasToken = content.some(
      (token) => typeof token === "object" && token !== null && (token as { type?: unknown }).type === "query",
    );
    if (!hasToken) continue;
    let classIds: string[] = [];
    try {
      classIds = JSON.parse(row.class_ids) as string[];
    } catch {
      classIds = [];
    }
    if (classIds.includes(QUERY_ID)) continue; // already marked — idempotent
    if (dateChainClassId(row.id) !== null) {
      skipped.push({ id: row.id, reason: "date-chain node is class-locked" });
      continue;
    }
    planned.push({ id: row.id, parentId: row.parent_id, contentAst: content });
  }
  return { planned, skipped };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, planned: PlannedNode[]): Envelope[] {
  const physical = Date.now();
  return planned.map((node, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: [node.id],
      opType: "object.create",
      payload: {
        objectId: node.id,
        parentId: node.parentId,
        classIds: [QUERY_ID],
        contentAst: node.contentAst,
      },
    }),
  );
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
  for (const envelope of envelopes) {
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new Error(`envelope failed the schema gate: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const payload = payloadSchemaFor(envelope.opType).safeParse(envelope.payload);
    if (!payload.success) {
      throw new Error(
        `payload for ${envelope.opType} failed the schema gate: ${payload.error.issues[0]?.message ?? "invalid"}`,
      );
    }
  }
}

// --- main ---------------------------------------------------------------------

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );
  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(`query-class migration — ${workspaces.length} workspace(s), ${options.apply ? "APPLY" : "DRY RUN"}`);

    for (const workspaceId of workspaces) {
      const store = buildScratchStore(relay, workspaceId);
      let verify: Store | null = null;
      try {
        const { planned, skipped } = planAssignments(store);
        console.log(`\n[${workspaceId}] ${planned.length} node(s) carry a query token without the class`);
        for (const node of planned) {
          console.log(`  assign ${QUERY_ID} → ${node.id} (parent ${node.parentId ?? "∅"})`);
        }
        for (const node of skipped) {
          console.log(`  SKIP ${node.id}: ${node.reason}`);
        }
        if (planned.length === 0) continue;

        const envelopes = buildEnvelopes(workspaceId, planned);
        validateEnvelopes(envelopes);
        if (!options.apply) {
          console.log(`  dry run — ${envelopes.length} envelope(s) validated, nothing written`);
          continue;
        }

        relay.ingest(envelopes);

        // Verify: a FRESH scratch store over the new tail sees every planned
        // node carrying the query class, with zero StoreError throws.
        verify = buildScratchStore(relay, workspaceId);
        const missing = planned.filter(
          (node) =>
            !(JSON.parse(
              (
                verify!.database
                  .prepare("SELECT class_ids FROM node WHERE id = ?")
                  .get(node.id) as { class_ids: string } | undefined
              )?.class_ids ?? "[]",
            ) as string[]).includes(QUERY_ID),
        );
        if (missing.length > 0) {
          throw new Error(`verify failed: ${missing.length} node(s) still unmarked: ${missing.map((n) => n.id).join(", ")}`);
        }
        console.log(`  applied + verified: ${envelopes.length} envelope(s), every planned node marked`);
      } finally {
        store.close();
        verify?.close();
      }
    }
  } finally {
    relay.close();
  }
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
