/**
 * The `class` meta-class retirement (owner ruling 2026-10-07): the seeded
 * `class` class (…0001) is withdrawn — nodes bound to it BECOME real
 * classes, and nothing seeds or hosts on it anymore. Live workspaces
 * converge by APPENDED envelopes — the immutable relay log is never edited:
 *
 *  - class.create { classId: <member> } for every node bound to the
 *    class-class — the conversion capability (class.create on an EXISTING
 *    node declares it a class: is_class flips, classes-are-roots cuts any
 *    parent edge, the registry row adopts the node's title). A bare-id
 *    payload carries no content — title-is-content, the node row is the
 *    authority.
 *  - class.unassign { objectId: <member>, classId: <class-class> } drops the
 *    retired binding (OR-Set remove; authored values on the member survive
 *    untouched).
 *  - The has-template family relocation: the (class-class, has-template)
 *    binding row retires (class.property.unset), and the schema re-emits
 *    through propertySchema.create (an upsert — the only wire path that can
 *    change scope) carrying the stored row's values verbatim with
 *    scope "global" (the seed no longer binds it anywhere; values are
 *    authored on class nodes directly, the aliasOf precedent).
 *  - When every member converted, the empty class-class node rides to the
 *    trash (object.delete — recoverable via object restore, the
 *    migrate-cover-to-asset precedent). A partial pass leaves it live so the
 *    remainder is visible; re-running is idempotent.
 *
 * The plan is read from a SCRATCH derived store: the workspace's latest
 * snapshot restored into memory + the log tail applied on top (the sync
 * server's hydration shape), so the members listed are the converged log
 * state, not a possibly stale replica. Every envelope is validated through
 * the protocol zod schemas (envelope + per-op payload) BEFORE anything is
 * inserted.
 *
 * LOCKSTEP LAW (migrations.md): the conversion capability changes
 * class.create's semantics for an existing-id payload — a pre-batch client
 * applies the registry upsert but never flips is_class, leaving the
 * inconsistent half-state this ruling exists to fix. Run this ONLY after
 * the GTK/Flutter ports implement the conversion (and the seed cleanup
 * ships in their package pin).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (members, the relocation, the trash step) and writes nothing. --apply
 * inserts through RelayStorage.ingest (one transaction) and then verifies:
 * the new envelopes read back from the log, a FRESH scratch store applies
 * the tail since the snapshot with zero StoreError throws, every member
 * carries is_class, no live binding to the class-class remains anywhere,
 * the has-template schema is global-scope with no binding row, and the
 * class-class node is inactive.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-retire-class-class.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS } from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a4";
const DEVICE = "system-class-class-retirement";
const CLIENT = "migrate-retire-class-class";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

/** The retired class-class id — hardcoded on purpose: the constant was
 *  removed from the seed manifest (…0001 never reused), but live workspaces
 *  still carry the node + membership rows this id names. */
export const CLASS_CLASS_ID = "00000000-0000-0000-0001-000000000001";

const HAS_TEMPLATE_ID = SYSTEM_PROPERTY_UUIDS.hasTemplate;
const TEMPLATE_CLASS_ID = SYSTEM_CLASS_UUIDS.template;

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

// --- planning -------------------------------------------------------------------

export interface PlannedConversion {
  nodeId: string;
  /** "Genre collection" — the title the registry adopts (dry-run print). */
  title: string;
  /** False when the node row vanished (dangling membership) — skipped. */
  nodePresent: boolean;
}

export interface ClassClassPlan {
  conversions: PlannedConversion[];
  /** The (class-class, has-template) binding row lives. */
  templateBindingPresent: boolean;
  /** The has-template schema exists but is not yet global-scope. */
  templateRescopeNeeded: boolean;
  /** The has-template schema row is absent (nothing to re-scope). */
  templateSchemaAbsent: boolean;
  /** The class-class node is live — the trash step rides a full pass. */
  classClassLive: boolean;
}

function firstTextOf(content: string): string {
  try {
    const ast = JSON.parse(content) as unknown;
    if (Array.isArray(ast)) {
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
    }
  } catch {
    // Unparseable content reads as an empty title.
  }
  return "";
}

/**
 * Plan the retirement from a converged derived store. Structural over the
 * Store class (the src/dist split under the dev-condition exports makes
 * the class itself import-fragile; only `database` is read).
 */
export function planRetirement(store: Pick<Store, "database">): ClassClassPlan {
  const db = store.database;
  const members = db
    .prepare(
      `SELECT m.node_id, n.id AS present_id, n.content
       FROM class_member_set m
       LEFT JOIN node n ON n.id = m.node_id
       WHERE m.class_id = ? AND m.present = 1
       ORDER BY m.node_id`,
    )
    .all(CLASS_CLASS_ID) as Array<{ node_id: string; present_id: string | null; content: string | null }>;
  const conversions: PlannedConversion[] = members.map((row) => ({
    nodeId: row.node_id,
    title: row.present_id !== null ? firstTextOf(row.content ?? "[]") : "",
    nodePresent: row.present_id !== null,
  }));

  const templateBindingPresent =
    db
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(CLASS_CLASS_ID, HAS_TEMPLATE_ID) !== undefined;
  const schemaRow = db
    .prepare("SELECT scope FROM property_schema WHERE id = ?")
    .get(HAS_TEMPLATE_ID) as { scope: string } | undefined;
  const classClassLive =
    db
      .prepare("SELECT is_active FROM node WHERE id = ?")
      .get(CLASS_CLASS_ID) !== undefined &&
    (
      db.prepare("SELECT is_active FROM node WHERE id = ?").get(CLASS_CLASS_ID) as {
        is_active: number;
      }
    ).is_active === 1;

  return {
    conversions,
    templateBindingPresent,
    templateRescopeNeeded: schemaRow !== undefined && schemaRow.scope !== "global",
    templateSchemaAbsent: schemaRow === undefined,
    classClassLive,
  };
}

// --- envelopes ----------------------------------------------------------------

export interface TemplateSchemaRow {
  name: string;
  multi: number;
  targetClassFilter: string | null;
  display: string | null;
  readonly: number | null;
  hideWhenEmpty: number | null;
}

export function buildEnvelopes(
  workspaceId: string,
  plan: ClassClassPlan,
  templateRow: TemplateSchemaRow | null,
): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[]): void => {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );
  };

  for (const conversion of plan.conversions) {
    if (!conversion.nodePresent) continue;
    // The conversion capability: a bare classId declares the existing node
    // a class (the applier flips is_class, cuts any parent edge, and the
    // registry adopts the node's title).
    push("class.create", { classId: conversion.nodeId }, [conversion.nodeId]);
    push(
      "class.unassign",
      { objectId: conversion.nodeId, classId: CLASS_CLASS_ID },
      [conversion.nodeId],
    );
  }
  if (plan.templateBindingPresent) {
    push(
      "class.property.unset",
      { classId: CLASS_CLASS_ID, propertySchemaId: HAS_TEMPLATE_ID },
      [CLASS_CLASS_ID],
    );
  }
  if (plan.templateRescopeNeeded) {
    if (templateRow === null) {
      throw new Error("the plan calls for a has-template re-scope but no schema row was provided");
    }
    // propertySchema.create is an upsert — the only wire path that can move
    // scope. The current row's values ride verbatim (name preserved across
    // user renames); only scope becomes "global".
    push(
      "propertySchema.create",
      {
        propertySchemaId: HAS_TEMPLATE_ID,
        name: templateRow.name,
        type: "object",
        multi: templateRow.multi === 1,
        scope: "global",
        ...(templateRow.targetClassFilter !== null
          ? { targetClassFilter: JSON.parse(templateRow.targetClassFilter) as string[] }
          : {}),
        ...(templateRow.display !== null ? { display: templateRow.display } : {}),
        ...(templateRow.readonly !== null ? { readonly: templateRow.readonly === 1 } : {}),
        ...(templateRow.hideWhenEmpty !== null ? { hideWhenEmpty: templateRow.hideWhenEmpty === 1 } : {}),
      },
      [],
    );
  }
  const convertedAll = plan.conversions.every((c) => c.nodePresent);
  if (plan.classClassLive && plan.conversions.length > 0 && convertedAll) {
    // The empty class-class node rides to the trash — recoverable via
    // object restore. (No members at all: nothing to trash either — the
    // node may stay live; the owner can trash it by hand.)
    push("object.delete", { objectId: CLASS_CLASS_ID, permanent: false }, [CLASS_CLASS_ID]);
  }
  return envelopes;
}

// --- verification -------------------------------------------------------------
/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
export function validateEnvelopes(envelopes: Envelope[]): void {
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

function verify(relay: RelayStorage, workspaceId: string, plan: ClassClassPlan, expectedCount: number): void {
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
    for (const conversion of plan.conversions) {
      if (!conversion.nodePresent) continue;
      const row = db.prepare("SELECT is_class FROM node WHERE id = ?").get(conversion.nodeId) as
        | { is_class: number }
        | undefined;
      if (row?.is_class !== 1) {
        throw new Error(`verification failed: node ${conversion.nodeId} is_class = ${row?.is_class}, expected 1`);
      }
      const member = db
        .prepare("SELECT present FROM class_member_set WHERE node_id = ? AND class_id = ?")
        .get(conversion.nodeId, CLASS_CLASS_ID) as { present: number } | undefined;
      if (member?.present === 1) {
        throw new Error(`verification failed: node ${conversion.nodeId} still binds the retired class-class`);
      }
    }
    if (plan.templateBindingPresent) {
      const binding = db
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(CLASS_CLASS_ID, HAS_TEMPLATE_ID);
      if (binding !== undefined) {
        throw new Error("verification failed: the (class-class, has-template) binding row survived the unset");
      }
    }
    if (plan.templateRescopeNeeded) {
      const row = db.prepare("SELECT scope FROM property_schema WHERE id = ?").get(HAS_TEMPLATE_ID) as
        | { scope: string }
        | undefined;
      if (row?.scope !== "global") {
        throw new Error(`verification failed: has-template scope = ${row?.scope}, expected global`);
      }
    }
    if (
      plan.classClassLive &&
      plan.conversions.length > 0 &&
      plan.conversions.every((c) => c.nodePresent)
    ) {
      const row = db.prepare("SELECT is_active FROM node WHERE id = ?").get(CLASS_CLASS_ID) as
        | { is_active: number }
        | undefined;
      if (row?.is_active !== 0) {
        throw new Error("verification failed: the class-class node is still live after the full pass");
      }
    }
  } finally {
    store.close();
  }

  const byOp = new Map<string, number>();
  for (const envelope of rows) {
    byOp.set(envelope.opType, (byOp.get(envelope.opType) ?? 0) + 1);
  }
  const ops = [...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ");
  console.log(
    `verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean; ` +
      "members are classes, the retired binding is gone, has-template is global.",
  );
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
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planRetirement(store);
    const templateRow: TemplateSchemaRow | null = plan.templateRescopeNeeded
      ? (store.database
          .prepare(
            `SELECT name, multi,
                    target_class_filter AS targetClassFilter, display,
                    readonly, hide_when_empty AS hideWhenEmpty
             FROM property_schema WHERE id = ?`,
          )
          .get(HAS_TEMPLATE_ID) as TemplateSchemaRow)
      : null;
    store.close();

    console.log("\nplanned conversions:");
    if (plan.conversions.length === 0) console.log("  (none — no live class-class members)");
    for (const conversion of plan.conversions) {
      console.log(
        `  ${conversion.nodeId}  "${conversion.title}"` +
          (conversion.nodePresent ? "" : "  SKIPPED — the node row is gone (dangling membership)"),
      );
    }
    console.log(`  has-template binding on the class-class: ${plan.templateBindingPresent ? "present — unset planned" : "absent"}`);
    console.log(
      `  has-template scope: ${plan.templateSchemaAbsent ? "schema absent (the web ensure self-heals it)" : plan.templateRescopeNeeded ? `"stored" — re-scope to global planned` : "global — converged"}`,
    );
    console.log(
      `  class-class node: ${plan.classClassLive ? "live" : "absent/inactive"} — trash ${plan.classClassLive && plan.conversions.length > 0 && plan.conversions.every((c) => c.nodePresent) ? "planned after the conversions" : "not planned"}`,
    );

    const envelopes = buildEnvelopes(options.workspace, plan, templateRow);
    if (envelopes.length === 0) {
      console.log("\nnothing to migrate — the workspace already carries the retired shape.");
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

    verify(relay, options.workspace, plan, envelopes.length);
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
