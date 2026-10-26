/**
 * colección extends Source — the 2026-10-26 ruling at the SEED
 * (a system class's extends mapping is frozen
 * platform structure, so `regulación`'s user-class data op has no system
 * counterpart — the edge lives in `SYSTEM_CLASS_EXTENDS` instead).
 *
 * New workspaces receive the edge from the server seed (apps/server
 * src/seed.ts emits every SYSTEM_CLASS_EXTENDS edge; the web
 * `deploySystemClass` ensure shape re-issues it on the user-triggered
 * gallery deploy). Neither path runs for EXISTING live workspaces on its
 * own — the web self-heal is declaration-first (the `ensureWeblinkExtendsSource`
 * precedent: nothing calls it automatically), and the sync server does not
 * back-fill (law 10). So the one-off Path A migration (migrations.md) owns
 * the convergence: for every workspace whose `collection` class (…0001-…0032)
 * does not carry the seeded parent set [source (…0001-…0023)], append ONE
 * `class.setExtends` envelope with exactly the seeded parent set — the
 * SystemExtendsLockError's seed/ensure re-issue path applies it (the payload
 * EQUALS the seeded set), and the deploySystemClass ensure shape (replace
 * with the seeded set when a seeded parent edge is missing). A converged
 * workspace plans nothing (idempotent; a second run is a complete no-op).
 *
 * (The roster script's source-family extends heal derives its class list
 * from SYSTEM_CLASS_EXTENDS too, so a re-run of
 * migrate-source-library-roster.mts would converge this drift as well —
 * this focused script exists so the fleet host can apply JUST this ruling
 * without the roster's four drift passes.)
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), the
 * envelope is protocol-validated, TEST-APPLIED against the scratch store
 * (the replay gate — a poison envelope aborts with ZERO envelopes written),
 * and only then ingested through RelayStorage.ingest. Post-ingest
 * verification rebuilds a FRESH scratch store from the persisted log and
 * asserts the edge reads back.
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the plan per
 * workspace and writes nothing.
 *
 * NEVER point --data-dir at a real relay data dir during development: seed a
 * scratch dir under /tmp and pass it here. On the fleet host the live relay
 * lives under the stack's NOTEES_DATA_DIR (never the dev repo's config/).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-collection-extends-source.mts \
 *     --data-dir /tmp/<scratch> [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_EXTENDS, SYSTEM_CLASS_UUIDS } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a7";
const DEVICE = "migrate-collection-extends-source";
const CLIENT = "migrate-collection-extends-source";
const DEFAULT_WORKSPACE = "c491595f-9f94-5ade-a620-e30ed063d8d2";

const COLLECTION_ID = SYSTEM_CLASS_UUIDS.collection;
const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
/** The seeded parent set this run converges to (the SYSTEM_CLASS_EXTENDS row). */
const SEEDED_PARENTS: readonly string[] = (SYSTEM_CLASS_EXTENDS.collection ?? []).map(
  (parent) => SYSTEM_CLASS_UUIDS[parent],
);

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

function classNodeRow(store: Store, classId: string): { active: number } | undefined {
  return store.database
    .prepare("SELECT is_active AS active FROM node WHERE id = ? AND is_class = 1")
    .get(classId) as { active: number } | undefined;
}

/**
 * The deploySystemClass ensure shape: converge when the stored parent set
 * does not carry every seeded parent — the re-issue replaces with EXACTLY
 * the seeded set (a system class's extends is frozen to the seeded set
 * anyway, so replace-with-seeded is the convergence, not a clobber). A
 * workspace whose collection class predates the seed entirely is reported,
 * not created — the roster script's create flow owns missing classes.
 */
function planWorkspace(store: Store): { needsHeal: boolean; currentParents: string[] } {
  const row = classNodeRow(store, COLLECTION_ID);
  if (row === undefined) {
    throw new Error(
      "plan: the collection class node is absent from this workspace — refusing to emit " +
        "an extends edge onto nothing (a missing seeded class is the roster migration's create flow, not this script)",
    );
  }
  const currentParents = (
    store.database
      .prepare("SELECT parent_class_id FROM class_extends WHERE class_id = ?")
      .all(COLLECTION_ID) as Array<{ parent_class_id: string }>
  ).map((r) => r.parent_class_id);
  const needsHeal = !SEEDED_PARENTS.every((parent) => currentParents.includes(parent));
  return { needsHeal, currentParents };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelope(workspaceId: string): Envelope {
  return newEnvelope({
    workspaceId,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: CLIENT,
    hlc: { physical: Date.now(), logical: 0 },
    affectedNodeIds: [COLLECTION_ID],
    opType: "class.setExtends",
    payload: { classId: COLLECTION_ID, parentClassIds: [...SEEDED_PARENTS] },
  });
}

/** The protocol gate: the envelope must satisfy the envelope schema AND the op payload schema. */
function validateEnvelope(envelope: Envelope): void {
  const envResult = envelopeSchema.safeParse(envelope);
  if (!envResult.success) {
    throw new Error(`refusing to insert: envelope invalid — ${envResult.error.message}`);
  }
  const schema = payloadSchemaFor(envelope.opType);
  if (schema === undefined) {
    throw new Error(`refusing to insert: no payload schema registered for ${envelope.opType}`);
  }
  const payloadResult = schema.safeParse(envelope.payload);
  if (!payloadResult.success) {
    throw new Error(`refusing to insert: payload invalid — ${payloadResult.error.message}`);
  }
}

/**
 * The replay gate (pre-ingest): test-apply the envelope against the scratch
 * store the plan was read from. A poison envelope throws here, BEFORE
 * RelayStorage.ingest, so the abort lands with ZERO envelopes written.
 */
function testApplyEnvelope(store: Store, envelope: Envelope): void {
  try {
    store.apply(envelope);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `pre-ingest test-apply failed (${envelope.opType} ${JSON.stringify(envelope.payload)}): ${detail}\n` +
        "aborting with ZERO envelopes ingested — fix the workspace state and re-run.",
    );
  }
}

// --- verification -------------------------------------------------------------

/** Post-insert verification, straight from the persisted log: a FRESH scratch store must read the edge back. */
function verify(relay: RelayStorage, workspaceId: string): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== 1) {
    throw new Error(`read-back mismatch: expected 1 new envelope, found ${rows.length}`);
  }
  const stored = envelopeSchema.parse(rows[0]);
  const schema = payloadSchemaFor(stored.opType);
  if (schema === undefined || !schema.safeParse(stored.payload).success) {
    throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
  }

  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const parent of SEEDED_PARENTS) {
      const edge =
        store.database
          .prepare("SELECT 1 FROM class_extends WHERE class_id = ? AND parent_class_id = ?")
          .get(COLLECTION_ID, parent) !== undefined;
      if (!edge) {
        throw new Error(
          `verification failed: collection (…0032) is still missing its seeded extends edge to ${parent}`,
        );
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: 1 new envelope read back (class.setExtends×1); tail applied clean; collection → source reads back.`,
  );
}

// --- main ---------------------------------------------------------------------

function migrateWorkspace(relay: RelayStorage, workspaceId: string, apply: boolean): void {
  const snapshot = relay.latestSnapshot(workspaceId);
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  try {
    const plan = planWorkspace(store);
    if (!plan.needsHeal) {
      console.log(
        "  collection already carries its seeded parent set " +
          `[${SEEDED_PARENTS.join(", ")}] (stored: [${plan.currentParents.sort().join(", ")}]) — nothing to migrate.`,
      );
      return;
    }
    console.log(
      `  planned: class.setExtends collection (…0032) parents [${plan.currentParents.sort().join(", ")}] → ` +
        `[${SEEDED_PARENTS.join(", ")}]`,
    );

    const envelope = buildEnvelope(workspaceId);
    validateEnvelope(envelope);

    // The replay gate BEFORE anything is written.
    testApplyEnvelope(store, envelope);
    console.log("  pre-ingest test-apply: the envelope applied clean against the scratch store.");

    if (!apply) {
      console.log("  dry run — re-run with --apply to append this envelope to the relay log.");
      return;
    }

    const { savedIds } = relay.ingest([envelope]);
    if (savedIds.length !== 1) {
      throw new Error(`ingest saved ${savedIds.length}/1 envelopes (duplicate id?)`);
    }
    console.log("  ingested 1 envelope into the relay log.");
    verify(relay, workspaceId);
  } finally {
    store.close();
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `collection→source extends migration: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, workspaceId, options.apply);
    }
    if (options.apply) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite).",
      );
    }
  } finally {
    relay.close();
  }
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
