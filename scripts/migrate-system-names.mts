/**
 * System-names migration (owner directive 2026-10-05): the system class and
 * property-schema ids stay camelCase/snake_case forever, but their DISPLAY
 * names move to normal wording ("TV series", not "tv_series"; "Publication
 * date", not "publicationDate" — the new-wording manifests are
 * SYSTEM_CLASS_DISPLAY_NAMES / SYSTEM_PROPERTY_DISPLAY_NAMES in
 * @notees/domain). Live workspaces seeded with the raw keys converge by
 * appended envelopes — the immutable relay log is never edited:
 *
 *  - class.update { classId, contentAst } for every SYSTEM class node whose
 *    stored title differs from the manifest's display name (title-is-content:
 *    the title IS the class's text content);
 *  - propertySchema.update { propertySchemaId, name } for every seeded
 *    property_schema row whose name differs from the manifest;
 *  - class.property.unset (source, cover) — the same-pass removal of the
 *    cover→source binding (owner ruling: a cover makes no sense on sources;
 *    the row left SYSTEM_EXTRA_CLASS_BINDINGS with the seeds).
 *
 * The plan is read from a SCRATCH derived store: the workspace's latest
 * snapshot restored into memory + the log tail applied on top (the same
 * restore+catch-up shape the sync server hydrates with), so the titles and
 * names compared are the converged log state, not a possibly stale replica.
 * Every envelope is validated through the protocol zod schemas (envelope +
 * per-op payload) BEFORE anything is inserted; an invalid payload aborts
 * the run with nothing written. Idempotent: a second run plans nothing
 * (stored names already match the manifest) and writes no envelopes.
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest (the same
 * INSERT INTO envelope column layout the server uses, seq AUTOINCREMENT =
 * max(seq)+1, one transaction) and then verifies: the new envelopes read
 * back from the log and a FRESH scratch store applying the tail since the
 * snapshot (zero StoreError throws, renamed state matches the manifest,
 * the cover binding row gone).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-system-names.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { uuidv7 } from "uuidv7";

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
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a1";
const DEVICE = "system-rename-migration";
const CLIENT = "migrate-system-names";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const SOURCE_CLASS_ID = SYSTEM_CLASS_UUIDS.source;
const COVER_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.cover;

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
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
    apply: argv.includes("--apply"),
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

interface PlannedRename {
  kind: "class" | "schema";
  id: string;
  from: string;
  to: string;
}

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

/** Plan the renames by comparing the converged store state to the manifests. */
function planRenames(store: Store): { renames: PlannedRename[]; skippedInactive: string[] } {
  const renames: PlannedRename[] = [];
  const skippedInactive: string[] = [];
  const db = store.database;

  const classRows = db
    .prepare("SELECT id, is_active AS active, content FROM node WHERE is_class = 1")
    .all() as Array<{ id: string; active: number; content: string }>;
  const classById = new Map(classRows.map((row) => [row.id, row]));
  for (const [key, id] of Object.entries(SYSTEM_CLASS_UUIDS)) {
    const target = SYSTEM_CLASS_DISPLAY_NAMES[key as keyof typeof SYSTEM_CLASS_DISPLAY_NAMES];
    const row = classById.get(id);
    if (row === undefined) continue; // never authored in this workspace
    if (row.active !== 1) {
      skippedInactive.push(`${key} (${id})`);
      continue;
    }
    const title = firstTextOf(row.content);
    if (title !== target) renames.push({ kind: "class", id, from: title, to: target });
  }

  const schemaIds = new Set(Object.values(SYSTEM_PROPERTY_UUIDS));
  const schemaRows = db
    .prepare("SELECT id, name FROM property_schema")
    .all() as Array<{ id: string; name: string }>;
  const displayById = new Map(
    Object.entries(SYSTEM_PROPERTY_UUIDS).map(([key, id]) => [
      id,
      SYSTEM_PROPERTY_DISPLAY_NAMES[key as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
    ]),
  );
  for (const row of schemaRows) {
    if (!schemaIds.has(row.id)) continue; // user schema — never touched
    const target = displayById.get(row.id)!;
    if (row.name !== target) renames.push({ kind: "schema", id: row.id, from: row.name, to: target });
  }

  return { renames, skippedInactive };
}

/** True when the (source, cover) binding row exists in the converged store. */
function coverBindingPresent(store: Store): boolean {
  return (
    store.database
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(SOURCE_CLASS_ID, COVER_SCHEMA_ID) !== undefined
  );
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(
  workspaceId: string,
  renames: PlannedRename[],
  unsetCoverBinding: boolean,
): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = renames.map((rename, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: rename.kind === "class" ? [rename.id] : [],
      opType: rename.kind === "class" ? "class.update" : "propertySchema.update",
      payload:
        rename.kind === "class"
          ? { classId: rename.id, contentAst: [{ type: "text", text: rename.to }] }
          : { propertySchemaId: rename.id, name: rename.to },
    }),
  );
  if (unsetCoverBinding) {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: [SOURCE_CLASS_ID],
        opType: "class.property.unset",
        payload: { classId: SOURCE_CLASS_ID, propertySchemaId: COVER_SCHEMA_ID },
      }),
    );
  }
  return envelopes;
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
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
    throw new Error(
      `refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`,
    );
  }
}

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + payloads),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelopes — zero StoreError throws,
 *  3. assert the converged class titles / schema names match the manifest
 *     and the cover binding row is gone.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== expectedCount) {
    throw new Error(`read-back mismatch: expected ${expectedCount} new envelopes, found ${rows.length}`);
  }
  for (const envelope of rows) {
    const stored = envelopeSchema.parse(envelope);
    const schema = payloadSchemaFor(stored.opType);
    if (schema === undefined || !schema.safeParse(stored.payload).success) {
      throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
    }
  }

  const store = buildScratchStore(relay, workspaceId);
  try {
    const db = store.database;
    const nodeRows = db
      .prepare("SELECT id, content FROM node WHERE is_class = 1 AND is_active = 1")
      .all() as Array<{ id: string; content: string }>;
    const titleById = new Map(nodeRows.map((row) => [row.id, firstTextOf(row.content)]));
    for (const [key, id] of Object.entries(SYSTEM_CLASS_UUIDS)) {
      const title = titleById.get(id);
      if (title === undefined) continue;
      const target = SYSTEM_CLASS_DISPLAY_NAMES[key as keyof typeof SYSTEM_CLASS_DISPLAY_NAMES];
      if (title !== target) {
        throw new Error(`verification failed: class ${key} title ${JSON.stringify(title)} != ${JSON.stringify(target)}`);
      }
    }
    const schemaRows = db
      .prepare("SELECT id, name FROM property_schema")
      .all() as Array<{ id: string; name: string }>;
    const displayById = new Map(
      Object.entries(SYSTEM_PROPERTY_UUIDS).map(([key, id]) => [
        id,
        SYSTEM_PROPERTY_DISPLAY_NAMES[key as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
      ]),
    );
    for (const row of schemaRows) {
      const target = displayById.get(row.id);
      if (target === undefined) continue;
      if (row.name !== target) {
        throw new Error(`verification failed: schema ${row.id} name ${JSON.stringify(row.name)} != ${JSON.stringify(target)}`);
      }
    }
    if (coverBindingPresent(store)) {
      throw new Error("verification failed: the (source, cover) binding row survived the unset");
    }
  } finally {
    store.close();
  }

  const byOp = new Map<string, number>();
  for (const envelope of rows) {
    byOp.set(envelope.opType, (byOp.get(envelope.opType) ?? 0) + 1);
  }
  const ops = [...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ");
  console.log(`verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean since seq ${snapshotSeq}; titles, schema names, and the cover unbind all converge.`);
}

// --- main ---------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
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
    const { renames, skippedInactive } = planRenames(store);
    const unsetCover = coverBindingPresent(store);
    store.close();

    console.log("\nplanned renames:");
    if (renames.length === 0) console.log("  (none — stored names already match the manifest)");
    for (const rename of renames) {
      console.log(`  ${rename.kind.padEnd(6)} ${rename.id}  ${JSON.stringify(rename.from)} → ${JSON.stringify(rename.to)}`);
    }
    if (skippedInactive.length > 0) {
      console.log(`  skipped (inactive nodes, left alone): ${skippedInactive.join(", ")}`);
    }
    console.log(`  cover→source binding row: ${unsetCover ? "present — unset planned" : "absent — nothing to do"}`);

    const envelopes = buildEnvelopes(options.workspace, renames, unsetCover);
    if (envelopes.length === 0) {
      console.log("\nnothing to migrate — the workspace already carries the normal-wording names.");
      return;
    }
    validateEnvelopes(envelopes);
    console.log(`\n${envelopes.length} envelope(s) built and protocol-validated.`);

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append these envelopes to the relay log.");
      return;
    }

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`\ningested ${savedIds.length} envelope(s) into the relay log.`);

    verify(relay, options.workspace, snapshotSeq, envelopes.length);
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
