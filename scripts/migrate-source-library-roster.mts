/**
 * Source-library roster (owner 2026-10-23, slice 1 task 7): live workspaces
 * converge to the task-3/4/5/6 seed state by APPENDED envelopes (migrations.md
 * Path A — the immutable relay log is never edited). Four drifts heal in one
 * pass, per workspace, each step existence-checked against the CONVERGED log
 * state so a second run plans nothing:
 *
 *  (a) `paper` (…0025, WITHDRAWN — Zotero has no "paper" type) → every node
 *      classed paper gets `class.unassign {paper}` + the re-issued
 *      `object.create` OR-Set add carrier with classIds [journal_article]
 *      (there is no class.assign op; the add carrier is the wire path,
 *      packages/store appliers — the add's comparator is >= so the later add
 *      beats the remove in either delivery order);
 *  (b) the renamed classes' display titles: "Article" → "Journal article"
 *      (…0026), "Web link" → "Web page" (…0034), "Movie" → "Film" (…0035) —
 *      title-is-content, so the rename is a class.update contentAst rewrite
 *      (the migrate-system-names.mts precedent; object.update carries NO
 *      content field). The class UUIDs are unchanged — saved query ASTs keyed
 *      on them survive untouched (review focus #5, verified below);
 *  (c) the task-6 materialization for workspaces the new seeds never reached:
 *      every missing SEEDED_SYSTEM_CLASSES class node gets class.create
 *      (display-name contentAst + icon) + its SYSTEM_CLASS_EXTENDS parents,
 *      every missing pool property schema (…0006- block, task 4) gets
 *      propertySchema.create with the seed mapping (name/type/multi/
 *      scopeClassIds/defaultValue/options/targetClassFilter) + its spec's
 *      bindTo binding row, the manifest's binding rows land per missing
 *      (class, schema) pair — SYSTEM_PROPERTY_SPECS bindTo rows,
 *      SYSTEM_EXTRA_CLASS_BINDINGS (url→web_page among them),
 *      SYSTEM_SOURCE_CLASS_BINDINGS (task 5's 39-class table) — and each
 *      SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES class seeds archived
 *      (object.update {active: false} AFTER its rows exist, the seed.ts
 *      ordering). R5 pre-checked at plan time (a binding whose schema scope
 *      excludes the class fails loud at apply; the plan never emits one);
 *  (d) report + verify.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail —
 * the same restore+catch-up shape the sync server hydrates with), so the
 * compared rows are the converged log state. Every envelope is validated
 * through the protocol zod schemas BEFORE anything is inserted. Idempotent:
 * a second run plans nothing (every drifted row now exists).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (affected-node counts per step + the renamed classes' node counts) and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, paper
 * gone from node class sets, journal_article present on the migrated nodes,
 * the renamed titles read back, the new classes + binding rows + archived
 * flags present, and the pre-migration saved query AST — a class condition
 * on …0026 — still matching the migrated nodes: UUID-keyed conditions
 * survive display renames).
 *
 * NEVER point --data-dir at a real relay data dir during development: seed a
 * scratch dir (scripts/migrated-verify/seed-source-roster-scratch.mts points
 * at /tmp only) and pass it here.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-source-library-roster.mts \
 *     --data-dir /tmp/notees-roster-scratch [--workspace <uuid> | --all] [--apply]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  parseQueryAst,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  SEEDED_SYSTEM_CLASSES,
  SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
  type SystemPropertyName,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";
import { runQuery } from "../packages/query/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a7";
const DEVICE = "migrate-source-library-roster";
const CLIENT = "migrate-source-library-roster";
const DEFAULT_WORKSPACE = "c491595f-9f94-5ade-a620-e30ed063d8d2";

/** Withdrawn 2026-10-23 (the roster slice) — not in SYSTEM_CLASS_UUIDS anymore. */
const PAPER_ID = "00000000-0000-0000-0001-000000000025";
const JOURNAL_ARTICLE_ID = SYSTEM_CLASS_UUIDS.journal_article;

/** The three renamed classes: stored title → manifest display name. */
const RENAMED_CLASSES: Array<{ classId: string; to: string }> = [
  { classId: JOURNAL_ARTICLE_ID, to: SYSTEM_CLASS_DISPLAY_NAMES.journal_article },
  { classId: SYSTEM_CLASS_UUIDS.web_page, to: SYSTEM_CLASS_DISPLAY_NAMES.web_page },
  { classId: SYSTEM_CLASS_UUIDS.film, to: SYSTEM_CLASS_DISPLAY_NAMES.film },
];

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

interface PlannedRename {
  classId: string;
  from: string;
  to: string;
  /** Nodes currently carrying the class (reported, never touched). */
  memberCount: number;
}

interface WorkspacePlan {
  paperNodes: string[];
  renames: PlannedRename[];
  skippedInactiveRenames: string[];
  missingSchemas: string[];
  missingClasses: string[];
  extendsForCreated: Array<{ classId: string; parents: string[] }>;
  missingSpecBindings: Array<{ classId: string; propertySchemaId: string }>;
  missingExtraBindings: Array<{ classId: string; propertySchemaId: string }>;
  missingSourceBindings: Array<{ classId: string; propertySchemaId: string }>;
  archivedFlips: string[];
}

function classNodeRow(store: Store, classId: string): { active: number; content: string } | undefined {
  return store.database
    .prepare("SELECT is_active AS active, content FROM node WHERE id = ? AND is_class = 1")
    .get(classId) as { active: number; content: string } | undefined;
}

function bindingPresent(store: Store, classId: string, propertySchemaId: string): boolean {
  return (
    store.database
      .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(classId, propertySchemaId) !== undefined
  );
}

function schemaRow(
  store: Store,
  propertySchemaId: string,
): { scope_class_ids: string | null } | undefined {
  return store.database
    .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
    .get(propertySchemaId) as { scope_class_ids: string | null } | undefined;
}

/**
 * R5 pre-check (owner ruling 2026-10-20): a binding whose schema scope
 * excludes the class is dead config and applyClassPropertySet fails loud —
 * the plan must never emit one. `createdParents` carries the manifest
 * parents of classes this run creates (their extends edges land in the same
 * ingest, before the bindings).
 */
function scopeReachesClass(
  store: Store,
  classId: string,
  scopeClassIds: string[] | null,
  createdParents: Map<string, string[]>,
): boolean {
  if (scopeClassIds === null) return true;
  if (scopeClassIds.includes(classId)) return true;
  const inStore =
    store.database
      .prepare(
        `SELECT 1 FROM class_hierarchy
         WHERE class_id = ? AND ancestor_id IN (${scopeClassIds.map(() => "?").join(",")})`,
      )
      .get(classId, ...scopeClassIds) !== undefined;
  if (inStore) return true;
  // A class created by this run: walk the manifest extends transitively.
  const visiting = new Set<string>();
  const reach = (id: string): boolean => {
    if (scopeClassIds.includes(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const parents =
      createdParents.get(id) ??
      (store.database.prepare("SELECT 1 FROM node WHERE id = ? AND is_class = 1").get(id)
        ? (
            store.database
              .prepare(
                `SELECT parent_class_id FROM class_extends WHERE class_id = ?`,
              )
              .all(id)
              .map((row) => (row as { parent_class_id: string }).parent_class_id)
          )
        : []);
    for (const parent of parents) {
      if (reach(parent)) return true;
    }
    return false;
  };
  return reach(classId);
}

function planWorkspace(store: Store): WorkspacePlan {
  const db = store.database;
  const plan: WorkspacePlan = {
    paperNodes: [],
    renames: [],
    skippedInactiveRenames: [],
    missingSchemas: [],
    missingClasses: [],
    extendsForCreated: [],
    missingSpecBindings: [],
    missingExtraBindings: [],
    missingSourceBindings: [],
    archivedFlips: [],
  };

  // (a) nodes classed paper (OR-Set present rows; the effective membership).
  plan.paperNodes = (
    db
      .prepare("SELECT node_id FROM class_member_set WHERE class_id = ? AND present = 1 ORDER BY node_id")
      .all(PAPER_ID) as Array<{ node_id: string }>
  ).map((row) => row.node_id);
  if (plan.paperNodes.length > 0 && classNodeRow(store, JOURNAL_ARTICLE_ID) === undefined) {
    throw new Error(
      `plan: ${plan.paperNodes.length} node(s) carry paper but the journal_article (…0026) class node is absent — refusing to leave dangling membership`,
    );
  }

  // (b) the renamed classes' titles.
  for (const renamed of RENAMED_CLASSES) {
    const row = classNodeRow(store, renamed.classId);
    if (row === undefined) continue; // never authored in this workspace
    const memberCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM class_member_set WHERE class_id = ? AND present = 1")
        .get(renamed.classId) as { n: number }
    ).n;
    if (row.active !== 1) {
      plan.skippedInactiveRenames.push(`${renamed.classId} (${memberCount} node(s))`);
      continue;
    }
    const title = firstTextOf(row.content);
    if (title !== renamed.to) {
      plan.renames.push({ classId: renamed.classId, from: title, to: renamed.to, memberCount });
    }
  }

  // (c1) missing pool property schemas (existence-only; existing rows — even
  // drifted-typed ones, e.g. the pre-retype `authors` — are task-8 territory
  // and never rewritten here).
  const missingSchemaIds = new Set<string>();
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    const propertySchemaId = SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName];
    if (schemaRow(store, propertySchemaId) !== undefined) continue;
    plan.missingSchemas.push(propertySchemaId);
    missingSchemaIds.add(propertySchemaId);
  }

  // (c2/c3) missing seeded class nodes + their extends edges.
  const createdParents = new Map<string, string[]>();
  for (const name of SEEDED_SYSTEM_CLASSES) {
    const classId = SYSTEM_CLASS_UUIDS[name];
    if (classNodeRow(store, classId) !== undefined) continue;
    plan.missingClasses.push(name);
    const parents = (SYSTEM_CLASS_EXTENDS[name] ?? []).map(
      (parent) => SYSTEM_CLASS_UUIDS[parent],
    );
    plan.extendsForCreated.push({ classId, parents });
    createdParents.set(classId, parents);
  }
  // Every extends parent must exist after the create pass (live or created).
  for (const { classId, parents } of plan.extendsForCreated) {
    for (const parent of parents) {
      const parentName = SEEDED_SYSTEM_CLASSES.find((n) => SYSTEM_CLASS_UUIDS[n] === parent);
      const parentCreated =
        parentName !== undefined && plan.missingClasses.includes(parentName);
      if (!parentCreated && classNodeRow(store, parent) === undefined) {
        throw new Error(
          `plan: class ${classId} extends ${parent}, which has no node row and is not seeded — refusing to emit a dangling extends edge`,
        );
      }
    }
  }

  // (c4) binding rows: spec bindTo rows, extra rows, source rows. Each
  // existence-checked; R5 pre-checked against the converged closure plus
  // this run's creates.
  const classExistsOrCreated = (classId: string): boolean =>
    classNodeRow(store, classId) !== undefined || createdParents.has(classId);
  const pushBinding = (
    bucket: Array<{ classId: string; propertySchemaId: string }>,
    classId: string,
    propertySchemaId: string,
  ): void => {
    if (!classExistsOrCreated(classId)) {
      console.log(
        `  warning: binding ${classId}↔${propertySchemaId} skipped — the class has no node row (not seeded either)`,
      );
      return;
    }
    if (bindingPresent(store, classId, propertySchemaId)) return;
    const schema = schemaRow(store, propertySchemaId);
    const scope =
      schema === undefined
        ? missingSchemaIds.has(propertySchemaId)
          ? scopeForSpec(propertySchemaId)
          : null // schema-less writes stay unchecked (the applier precedent)
        : schema.scope_class_ids === null
          ? null
          : (JSON.parse(schema.scope_class_ids) as string[]);
    if (!scopeReachesClass(store, classId, scope, createdParents)) {
      throw new Error(
        `plan: binding ${classId}↔${propertySchemaId} would violate R5 (scope excludes the class) — refusing to emit dead config`,
      );
    }
    bucket.push({ classId, propertySchemaId });
  };
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined || spec.bindTo === undefined) continue;
    pushBinding(
      plan.missingSpecBindings,
      SYSTEM_CLASS_UUIDS[spec.bindTo],
      SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName],
    );
  }
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    pushBinding(
      plan.missingExtraBindings,
      SYSTEM_CLASS_UUIDS[extra.bindTo],
      SYSTEM_PROPERTY_UUIDS[extra.property],
    );
  }
  for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
    const classId = SYSTEM_CLASS_UUIDS[name as SystemClassName];
    for (const property of properties) {
      pushBinding(plan.missingSourceBindings, classId, SYSTEM_PROPERTY_UUIDS[property]);
    }
  }

  // (c5) archived-by-default flips: existing-but-active or created-this-run.
  for (const name of SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES) {
    const classId = SYSTEM_CLASS_UUIDS[name];
    const row = classNodeRow(store, classId);
    if (row === undefined && !createdParents.has(classId)) continue;
    if (row === undefined || row.active === 1) plan.archivedFlips.push(classId);
  }

  return plan;
}

/** The scope a missing schema WILL carry once created (the seed mapping). */
function scopeForSpec(propertySchemaId: string): string[] | null {
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    if (SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName] !== propertySchemaId) continue;
    if (spec.bindTo === undefined || spec.global === true) return null;
    return [SYSTEM_CLASS_UUIDS[spec.bindTo]];
  }
  return null;
}

function planIsEmpty(plan: WorkspacePlan): boolean {
  return (
    plan.paperNodes.length === 0 &&
    plan.renames.length === 0 &&
    plan.missingSchemas.length === 0 &&
    plan.missingClasses.length === 0 &&
    plan.missingSpecBindings.length === 0 &&
    plan.missingExtraBindings.length === 0 &&
    plan.missingSourceBindings.length === 0 &&
    plan.archivedFlips.length === 0
  );
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: WorkspacePlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
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

  // (a) paper → journal_article: the remove + the re-issued add carrier.
  for (const nodeId of plan.paperNodes) {
    push("class.unassign", { objectId: nodeId, classId: PAPER_ID }, [nodeId]);
    push("object.create", { objectId: nodeId, classIds: [JOURNAL_ARTICLE_ID] }, [nodeId]);
  }

  // (b) the renamed classes' titles (title-is-content rewrite).
  for (const rename of plan.renames) {
    push(
      "class.update",
      { classId: rename.classId, contentAst: [{ type: "text", text: rename.to }] },
      [rename.classId],
    );
  }

  // (c1) missing pool schemas (name/type/multi/scope/defaults per the seed).
  for (const propertySchemaId of plan.missingSchemas) {
    const specEntry = Object.entries(SYSTEM_PROPERTY_SPECS).find(
      ([name, spec]) =>
        spec !== undefined && SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName] === propertySchemaId,
    );
    if (specEntry === undefined || specEntry[1] === undefined) continue;
    const [name, spec] = specEntry as [SystemPropertyName, NonNullable<(typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]>];
    const scopeClassIds = scopeForSpec(propertySchemaId);
    push(
      "propertySchema.create",
      {
        propertySchemaId,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
        type: spec.type,
        multi: spec.multi ?? false,
        ...(scopeClassIds !== null ? { scopeClassIds } : {}),
        ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
        ...(spec.options !== undefined ? { options: spec.options } : {}),
        ...(spec.targetClassFilter !== undefined
          ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
          : {}),
      },
      [],
    );
  }

  // (c2/c3) class creates, then extends (parents exist after the create pass).
  for (const className of plan.missingClasses) {
    const classId = SYSTEM_CLASS_UUIDS[className as SystemClassName];
    push(
      "class.create",
      {
        classId,
        contentAst: [{ type: "text", text: SYSTEM_CLASS_DISPLAY_NAMES[className as SystemClassName] }],
        icon: SYSTEM_CLASS_ICONS[className as SystemClassName],
      },
      [classId],
    );
  }
  for (const { classId, parents } of plan.extendsForCreated) {
    push("class.setExtends", { classId, parentClassIds: parents }, [classId]);
  }

  // (c4) binding rows (schemas and extends already emitted above).
  for (const binding of plan.missingSpecBindings) {
    push("class.property.set", binding, [binding.classId]);
  }
  for (const binding of plan.missingExtraBindings) {
    push("class.property.set", binding, [binding.classId]);
  }
  for (const binding of plan.missingSourceBindings) {
    push("class.property.set", binding, [binding.classId]);
  }

  // (c5) archived-by-default flips — after the rows exist (the seed ordering).
  for (const classId of plan.archivedFlips) {
    push("object.update", { objectId: classId, active: false }, [classId]);
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
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the same snapshot and apply the tail
 *     INCLUDING the new envelopes — zero StoreError throws,
 *  3. assert the converged state: paper gone from node class sets, the
 *     migrated nodes carry journal_article, the renamed titles read back,
 *     every seeded class node + manifest binding row + archived flag
 *     present,
 *  4. review focus #5: the query view saved BEFORE the migration (a class
 *     condition on …0026, unchanged by the rename) still matches the
 *     migrated nodes — UUID-keyed conditions survive display renames.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: WorkspacePlan,
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

    // paper gone, journal_article present on the migrated nodes.
    const paperLeft = (
      db
        .prepare("SELECT COUNT(*) AS n FROM class_member_set WHERE class_id = ? AND present = 1")
        .get(PAPER_ID) as { n: number }
    ).n;
    if (paperLeft !== 0) {
      throw new Error(`verification failed: ${paperLeft} node(s) still carry paper after the migration`);
    }
    for (const nodeId of plan.paperNodes) {
      const node = db.prepare("SELECT class_ids FROM node WHERE id = ?").get(nodeId) as
        | { class_ids: string }
        | undefined;
      if (node === undefined) continue;
      const classIds = JSON.parse(node.class_ids) as string[];
      if (!classIds.includes(JOURNAL_ARTICLE_ID)) {
        throw new Error(`verification failed: migrated node ${nodeId} does not carry journal_article`);
      }
      if (classIds.includes(PAPER_ID)) {
        throw new Error(`verification failed: migrated node ${nodeId} still lists paper in class_ids`);
      }
    }

    // The renamed titles read back (title-is-content).
    for (const renamed of RENAMED_CLASSES) {
      const row = classNodeRow(store, renamed.classId);
      if (row === undefined) {
        throw new Error(`verification failed: class node ${renamed.classId} is absent after the migration`);
      }
      const title = firstTextOf(row.content);
      if (title !== renamed.to) {
        throw new Error(
          `verification failed: class ${renamed.classId} title ${JSON.stringify(title)} != ${JSON.stringify(renamed.to)}`,
        );
      }
    }

    // Every seeded class node + manifest binding row + archived flag present.
    for (const name of SEEDED_SYSTEM_CLASSES) {
      if (classNodeRow(store, SYSTEM_CLASS_UUIDS[name]) === undefined) {
        throw new Error(`verification failed: seeded class ${name} has no node row after the migration`);
      }
    }
    const assertBinding = (classId: string, propertySchemaId: string): void => {
      if (!bindingPresent(store, classId, propertySchemaId)) {
        throw new Error(
          `verification failed: binding row ${classId}↔${propertySchemaId} is missing after the migration`,
        );
      }
    };
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      if (spec === undefined || spec.bindTo === undefined) continue;
      assertBinding(SYSTEM_CLASS_UUIDS[spec.bindTo], SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName]);
    }
    for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
      assertBinding(SYSTEM_CLASS_UUIDS[extra.bindTo], SYSTEM_PROPERTY_UUIDS[extra.property]);
    }
    for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
      const classId = SYSTEM_CLASS_UUIDS[name as SystemClassName];
      for (const property of properties) {
        assertBinding(classId, SYSTEM_PROPERTY_UUIDS[property]);
      }
    }
    for (const name of SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES) {
      const classId = SYSTEM_CLASS_UUIDS[name];
      const classRow = db.prepare("SELECT active FROM class WHERE id = ?").get(classId) as
        | { active: number }
        | undefined;
      const nodeRow = db.prepare("SELECT is_active AS active FROM node WHERE id = ?").get(classId) as
        | { active: number }
        | undefined;
      if (classRow === undefined || classRow.active !== 0 || nodeRow === undefined || nodeRow.active !== 0) {
        throw new Error(`verification failed: archived-by-default class ${name} is not archived after the migration`);
      }
    }

    // Review focus #5: the pre-migration saved query view (a class condition
    // on …0026) still matches the migrated nodes.
    const hosts = db
      .prepare("SELECT id, content FROM node WHERE content LIKE '%\"type\":\"query\"%'")
      .all() as Array<{ id: string; content: string }>;
    let checkedAst = false;
    for (const host of hosts) {
      let tokens: unknown[] = [];
      try {
        tokens = JSON.parse(host.content) as unknown[];
      } catch {
        continue;
      }
      for (const token of tokens) {
        if (
          typeof token !== "object" ||
          token === null ||
          (token as { type?: unknown }).type !== "query"
        ) {
          continue;
        }
        const ast = parseQueryAst((token as { queryAst: unknown }).queryAst);
        const conditions = ast.root.children.filter(
          (child): child is { type: "class"; classId: string } =>
            (child as { type?: unknown }).type === "class",
        );
        for (const condition of conditions) {
          if (condition.classId !== JOURNAL_ARTICLE_ID) continue;
          checkedAst = true;
          const result = runQuery(store, ast);
          for (const nodeId of plan.paperNodes) {
            if (!result.ids.includes(nodeId)) {
              throw new Error(
                `verification failed: the pre-migration query view (class …0026) no longer matches migrated node ${nodeId}`,
              );
            }
          }
        }
      }
    }
    if (!checkedAst) {
      console.log(
        "  note: no saved query view with a class condition on journal_article (…0026) found — the rename-survival check is a no-op in this workspace.",
      );
    } else {
      console.log(
        "  review focus #5: the pre-migration query view (class condition on …0026) still matches the migrated nodes — UUID-keyed conditions survive display renames.",
      );
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
    `verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean since seq ${snapshotSeq}; ` +
      "paper is gone, journal_article converges, titles/bindings/archival all read back clean.",
  );
}

// --- main ---------------------------------------------------------------------

function migrateWorkspace(relay: RelayStorage, workspaceId: string, apply: boolean): void {
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plan = planWorkspace(store);
  store.close();

  console.log("planned source-library roster convergence:");
  console.log(
    `  (a) paper→journal_article: ${plan.paperNodes.length} node(s)` +
      (plan.paperNodes.length > 0 ? ` — ${plan.paperNodes.join(", ")}` : ""),
  );
  if (plan.renames.length === 0) {
    console.log("  (b) class title renames: (none — stored titles already match the manifest)");
  }
  for (const rename of plan.renames) {
    console.log(
      `  (b) class title rename: ${rename.classId}  ${JSON.stringify(rename.from)} → ${JSON.stringify(rename.to)}` +
        `  (${rename.memberCount} node(s) carry the class)`,
    );
  }
  for (const skipped of plan.skippedInactiveRenames) {
    console.log(`  (b) skipped (inactive class node, left alone): ${skipped}`);
  }
  console.log(
    `  (c) missing pool schemas: ${plan.missingSchemas.length}; missing class nodes: ` +
      `${plan.missingClasses.length}${plan.missingClasses.length > 0 ? ` (${plan.missingClasses.join(", ")})` : ""}; ` +
      `extends edges: ${plan.extendsForCreated.length}`,
  );
  console.log(
    `  (c) missing binding rows: spec ${plan.missingSpecBindings.length}, extra ` +
      `${plan.missingExtraBindings.length}, source-class ${plan.missingSourceBindings.length}; ` +
      `archived flips: ${plan.archivedFlips.length}`,
  );

  if (planIsEmpty(plan)) {
    console.log("\nnothing to migrate — this workspace already carries the roster seed state.");
    return;
  }

  const envelopes = buildEnvelopes(workspaceId, plan);
  validateEnvelopes(envelopes);
  console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, snapshotSeq, envelopes.length, plan);
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
      `source-library roster migration: ${workspaces.length} workspace(s) ` +
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
