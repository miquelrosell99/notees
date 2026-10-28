/**
 * Card-rename convergence migration: the `card` system class's manifest
 * display name moved from "Card" to "Memorization card" (packages/domain
 * seeds — the memorization-cards slice). Live workspaces whose stored
 * card-class title still says "Card" converge by an APPENDED envelope —
 * the immutable relay log is never edited:
 *
 *  - class.update { classId: SYSTEM_CLASS_UUIDS.card, contentAst: "Memorization
 *    card" } for the workspace whose stored card-class node title differs
 *    from the manifest (title-is-content: the title IS the class's text
 *    content).
 *
 * The plan is read from a SCRATCH derived store: the workspace's latest
 * snapshot restored into memory + the log tail applied on top (the same
 * restore+catch-up shape the sync server hydrates with), so the compared
 * title is the converged log state, not a possibly stale replica. The
 * envelope is validated through the protocol zod schemas (envelope +
 * per-op payload) BEFORE anything is inserted; an invalid payload aborts
 * the run with nothing written. Idempotent: a second run plans nothing
 * (the stored title already matches the manifest) and writes no envelope.
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest (the same
 * INSERT INTO envelope column layout the server uses, seq AUTOINCREMENT =
 * max(seq)+1, one transaction) and then verifies: the new envelope reads
 * back from the log and a FRESH scratch store applying the tail since the
 * snapshot (zero StoreError throws, card title matches the manifest).
 *
 * --selfcheck runs the whole plan against a scratch in-memory store seeded
 * with an old-title ("Card") card-class node — no relay, no live data:
 * asserts the plan holds exactly one class.update envelope, applies it to
 * the scratch store, and re-plans to prove idempotency (empty plan).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-card-rename.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 *   pnpm exec tsx scripts/migrate-card-rename.mts --selfcheck
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  PROTOCOL_VERSION,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const TARGET_ID = SYSTEM_CLASS_UUIDS.card;
const TARGET_TITLE = SYSTEM_CLASS_DISPLAY_NAMES.card;
const PREVIOUS_TITLE = "Card";

const ACTOR = "01920000-0000-7000-8000-0000000000c2";
const DEVICE = "system:migrate-card-rename";
const CLIENT = "migrate-card-rename";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  apply: boolean;
  selfcheck: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? DEFAULT_WORKSPACE,
    apply: argv.includes("--apply"),
    selfcheck: argv.includes("--selfcheck"),
  };
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

function firstTextOf(content: string): string {
  try {
    const ast = JSON.parse(content) as unknown;
    if (!Array.isArray(ast)) return "";
    for (const token of ast) {
      if (
        typeof token === "object" &&
        token !== null &&
        (token as { type?: unknown }).type === "text" &&
        typeof (token as { text?: unknown }).text === "string"
      ) {
        return (token as { text: string }).text;
      }
    }
  } catch {
    // Unparseable content reads as an empty title.
  }
  return "";
}

type CardRenamePlan = { kind: "rename"; from: string } | { kind: "skip"; reason: string } | null;

/** Compare the converged store's card-class title against the manifest. */
function planCardRename(store: Store): CardRenamePlan {
  const row = store.database
    .prepare("SELECT is_active AS active, content FROM node WHERE id = ? AND is_class = 1")
    .get(TARGET_ID) as { active: number; content: string } | undefined;
  if (row === undefined) return { kind: "skip", reason: "card class never authored in this workspace" };
  if (row.active !== 1) return { kind: "skip", reason: "card class node is inactive — left alone" };
  const title = firstTextOf(row.content);
  if (title === TARGET_TITLE) return null; // already converged
  return { kind: "rename", from: title };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelope(workspaceId: string): Envelope {
  return newEnvelope({
    workspaceId,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: CLIENT,
    hlc: { physical: Date.now(), logical: 0 },
    affectedNodeIds: [TARGET_ID],
    opType: "class.update",
    payload: { classId: TARGET_ID, contentAst: [{ type: "text", text: TARGET_TITLE }] },
  });
}

/**
 * The protocol gate: the envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
function validateEnvelope(envelope: Envelope): void {
  const failures: string[] = [];
  const envResult = envelopeSchema.safeParse(envelope);
  if (!envResult.success) {
    failures.push(`envelope invalid — ${envResult.error.message}`);
  }
  const schema = payloadSchemaFor(envelope.opType);
  if (schema === undefined) {
    failures.push("no payload schema registered");
  } else if (!schema.safeParse(envelope.payload).success) {
    failures.push(`payload invalid — ${schema.safeParse(envelope.payload).error?.message}`);
  }
  if (failures.length > 0) {
    throw new Error(`refusing to insert: invalid envelope:\n  ${failures.join("\n  ")}`);
  }
}

// --- selfcheck ----------------------------------------------------------------

/**
 * Dry-run the plan against a scratch in-memory store seeded with an
 * old-title card-class node — no relay, no live data. Asserts the plan
 * holds exactly one class.update envelope, applies it to the scratch
 * store, and re-plans to prove idempotency (empty plan).
 */
function selfcheck(): void {
  const workspaceId = DEFAULT_WORKSPACE;
  const store = Store.open(betterSqlite3Backend(":memory:"));
  try {
    store.apply(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical: Date.now(), logical: 0 },
        affectedNodeIds: [TARGET_ID],
        opType: "class.create",
        payload: { classId: TARGET_ID, contentAst: [{ type: "text", text: PREVIOUS_TITLE }] },
      }),
    );

    const plan = planCardRename(store);
    if (plan === null || plan.kind !== "rename" || plan.from !== PREVIOUS_TITLE) {
      throw new Error(`selfcheck failed: expected a rename from ${JSON.stringify(PREVIOUS_TITLE)}, got ${JSON.stringify(plan)}`);
    }
    const envelope = buildEnvelope(workspaceId);
    validateEnvelope(envelope);
    if (envelope.opType !== "class.update") {
      throw new Error(`selfcheck failed: expected a class.update envelope, got ${envelope.opType}`);
    }
    const payload = envelope.payload as { classId?: unknown; contentAst?: unknown };
    const text = Array.isArray(payload.contentAst)
      ? (payload.contentAst[0] as { text?: unknown } | undefined)?.text
      : undefined;
    if (payload.classId !== TARGET_ID || text !== TARGET_TITLE) {
      throw new Error(
        `selfcheck failed: envelope payload ${JSON.stringify(payload)} != classId ${TARGET_ID} + title ${JSON.stringify(TARGET_TITLE)}`,
      );
    }
    console.log(
      `selfcheck: scratch store seeded with old title ${JSON.stringify(PREVIOUS_TITLE)} — plan holds exactly one class.update envelope (${JSON.stringify(plan.from)} → ${JSON.stringify(TARGET_TITLE)}), protocol-validated.`,
    );

    store.apply(envelope);
    const after = planCardRename(store);
    if (after !== null) {
      throw new Error(`selfcheck failed: re-plan after apply is not empty: ${JSON.stringify(after)}`);
    }
    console.log("selfcheck: re-plan after applying the envelope is empty — idempotent.");
    console.log("SELFCHECK-PASS");
  } finally {
    store.close();
  }
}

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelope back (count + payload),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelope — zero StoreError throws,
 *  3. assert the converged card-class title matches the manifest.
 */
function verify(relay: RelayStorage, workspaceId: string, snapshotSeq: number): void {
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
    const plan = planCardRename(store);
    if (plan !== null) {
      throw new Error(`verification failed: card title still diverges from the manifest: ${JSON.stringify(plan)}`);
    }
  } finally {
    store.close();
  }

  console.log(`verify: 1 new envelope read back (${rows[0].opType}); tail applied clean since seq ${snapshotSeq}; card title converges to the manifest.`);
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfcheck) {
    selfcheck();
    return;
  }

  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const snapshot = relay.latestSnapshot(options.workspace);
    const snapshotSeq = snapshot?.up_to_seq ?? 0;
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planCardRename(store);
    store.close();

    console.log("\nplanned card rename:");
    if (plan === null) {
      console.log("  (none — stored title already matches the manifest)");
    } else if (plan.kind === "skip") {
      console.log(`  skipped (${plan.reason})`);
    } else {
      console.log(`  class  ${TARGET_ID}  ${JSON.stringify(plan.from)} → ${JSON.stringify(TARGET_TITLE)}`);
    }

    if (plan === null || plan.kind === "skip") {
      console.log("\nnothing to migrate.");
      return;
    }
    const envelope = buildEnvelope(options.workspace);
    validateEnvelope(envelope);
    console.log("\n1 envelope built and protocol-validated.");

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append this envelope to the relay log.");
      return;
    }

    const { savedIds } = relay.ingest([envelope]);
    if (savedIds.length !== 1) {
      throw new Error(`ingest saved ${savedIds.length}/1 envelopes (duplicate id?)`);
    }
    console.log(`\ningested 1 envelope into the relay log.`);

    verify(relay, options.workspace, snapshotSeq);
    console.log("done.");
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
