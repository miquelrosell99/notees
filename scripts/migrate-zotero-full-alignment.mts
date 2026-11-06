/**
 * The Zotero full-alignment seed batch (2026-11-02): the 31 source pool
 * properties (packages/domain SYSTEM_PROPERTY_UUIDS tails …057–…075 —
 * `pmcid` pinned onto the source base family alongside `pmid`, the other 30
 * bind:false pool fields scoped [source]) and the full per-class binding
 * table (SYSTEM_SOURCE_CLASS_BINDINGS — 39 source type-classes, the skip
 * list emptied). Seeds only shape NEW workspaces; live workspaces converge
 * by APPENDED envelopes (migrations.md Path A — the immutable relay log is
 * never edited):
 *
 *  - a pool SCHEMA is missing → one `propertySchema.create` (the seed shape
 *    at the reserved id — the display name, type text, scope [source])
 *    followed by one `class.property.set` per bound class whose binding row
 *    is missing, all in the SAME ingest and ordered schema-first per
 *    property;
 *  - `pmcid` mirrors the pmid migration: the schema + a PINNED
 *    `class.property.set { classId: <source>, pinned: true }`; an existing
 *    UNPINNED source binding converges with the pin patch (same op);
 *  - a stored class-local scope that EXCLUDES source (the R5 dead-config
 *    check would reject every bound row) → `propertySchema.update
 *    { scopeClassIds: [source] }` FIRST, the bindings in the same ingest,
 *    ordered after it (the migrate-pmid-property precedent). A stored GLOBAL
 *    scope (null) is wider than the seed but legal — reported, never touched;
 *  - attribute drift on an EXISTING schema (type/name mismatching the seed)
 *    is REPORTED, never touched — client-authored data is never clobbered;
 *  - the `source` CLASS NODE absent → the base rows are skipped (a
 *    fresh/offline workspace self-heals the whole citation family via
 *    ensureCitationFamily on the next source create); pool schemas and
 *    per-class bindings still converge;
 *  - a binding row is NEVER authored for a class whose extends closure
 *    cannot reach the schema's scope — the R5 dead-config check would throw
 *    on every replica's hydration. A class node the workspace never deployed
 *    (no node, no extends edges) is reported and skipped, not written.
 *
 * The batch table is DERIVED from the domain manifests at module load
 * (SYSTEM_PROPERTY_UUIDS / SYSTEM_PROPERTY_SPECS / SYSTEM_PROPERTY_DISPLAY_NAMES
 * / SYSTEM_SOURCE_CLASS_BINDINGS), never hand-copied — drift in the
 * manifests fails loudly before anything is planned. The plan is read from
 * a SCRATCH derived store (latest snapshot + log tail — the same
 * restore+catch-up shape the sync server hydrates with), so the compared
 * rows are the converged log state. Every envelope is validated through the
 * protocol zod schemas BEFORE anything is inserted. Idempotent: a second
 * run plans nothing (the schemas + binding rows exist).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan and
 * writes nothing. --apply inserts through RelayStorage.ingest and then
 * verifies: the new envelopes read back from the log and a FRESH scratch
 * store applying the tail since the snapshot (zero StoreError throws, the
 * schema + binding rows present).
 *
 * THE LIVE-STACK PATH (recommended): `--apply --server http://localhost:8377`
 * posts the batch to the sync server's `POST /api/admin/append` (operator
 * key from `<data-dir>/api_key.txt`, or `--api-key`) — the ONE write path
 * (relay ingest + derived apply), so the server's own stores converge
 * before the response: no restart, no derived-cache wipe, no side-channel
 * relay.db writes under a running server. Idempotent either way.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-zotero-full-alignment.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync [--workspace <uuid> | --all] [--apply] \
 *     [--server http://localhost:8377] [--api-key <operator key>]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  sourceBindingPropertyOf,
  type SystemClassName,
  type SystemPropertyName,
  type SystemSourceBindingRef,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  buildScratchStore as scratchStoreBuild,
  refuseIfContentOnKeyed,
  type MigrationContentClass,
} from "./lib/scratch-store.ts";

/**
 * This migration's content class (the dev-ops contract, scripts/lib/scratch-store.ts):
 * "content" plans against the object graph — refused server-side on a keyed workspace (run it through a keyed client).
 */
export const CONTENT_CLASS: MigrationContentClass = "content";

const ACTOR = "01920000-0000-7000-8000-0000000000a7";
const DEVICE = "migrate-zotero-full-alignment";
const CLIENT = "migrate-zotero-full-alignment";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;

// --- the batch table (derived from the domain manifests) ----------------------

interface BatchEntry {
  name: SystemPropertyName;
  schemaId: string;
  displayName: string;
  type: string;
  /** The base-family arm: the spec's bindTo class + pin (pmcid only today). */
  baseClassName: SystemClassName | null;
  pinnedBase: boolean;
  /** Per-class pool bindings, inverted from SYSTEM_SOURCE_CLASS_BINDINGS. */
  classNames: SystemClassName[];
}

/**
 * The 31-property alignment batch: every SYSTEM_PROPERTY_UUIDS entry whose
 * pool tail lands in the reserved …057–…075 block (2026-11-02). Deriving
 * (instead of hand-listing) means manifest drift changes the plan — and the
 * e2e count pins fail loudly. Load-time assertions guard the seed invariants
 * the envelopes depend on.
 */
function deriveBatch(): BatchEntry[] {
  const problems: string[] = [];
  const byProperty = new Map<SystemPropertyName, SystemClassName[]>();
  for (const [className, refs] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS) as Array<
    [SystemClassName, readonly SystemSourceBindingRef[] | undefined]
  >) {
    for (const ref of refs ?? []) {
      const property = sourceBindingPropertyOf(ref);
      const list = byProperty.get(property) ?? [];
      list.push(className);
      byProperty.set(property, list);
    }
  }

  const entries: BatchEntry[] = [];
  for (const [name, schemaId] of Object.entries(SYSTEM_PROPERTY_UUIDS) as Array<
    [SystemPropertyName, string]
  >) {
    const tail = parseInt(schemaId.slice(-2), 16);
    if (Number.isNaN(tail) || tail < 0x57 || tail > 0x75) continue;

    const spec = SYSTEM_PROPERTY_SPECS[name];
    if (spec === undefined) {
      problems.push(`${name}: no SYSTEM_PROPERTY_SPECS entry`);
      continue;
    }
    if (spec.bindTo !== "source") {
      problems.push(`${name}: spec bindTo is ${spec.bindTo} (seed: source)`);
      continue;
    }
    const classNames = (byProperty.get(name) ?? []).slice().sort();
    const baseClassName = spec.bind === false ? null : "source";
    if (name === "pmcid") {
      if (spec.pinned !== true) problems.push("pmcid: spec is not pinned (seed: pinned base family)");
      if (classNames.length > 0) problems.push("pmcid: must never repeat per class (base family only)");
    } else {
      if (spec.bind !== false) problems.push(`${name}: spec bind is not false (seed: bind:false pool field)`);
      if (spec.pinned === true) problems.push(`${name}: pool field must not seed pinned`);
      if (classNames.length === 0) problems.push(`${name}: no per-class bindings in SYSTEM_SOURCE_CLASS_BINDINGS`);
    }
    entries.push({
      name,
      schemaId,
      displayName: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
      type: spec.type,
      baseClassName,
      pinnedBase: spec.pinned === true,
      classNames,
    });
  }

  entries.sort((a, b) => a.schemaId.localeCompare(b.schemaId));
  if (entries.length !== 31) {
    problems.push(`expected a 31-property batch (…057–…075), derived ${entries.length}`);
  }
  if (problems.length > 0) {
    throw new Error(
      "migrate-zotero-full-alignment: the domain manifests drifted from the seed invariants:\n  " +
        problems.join("\n  "),
    );
  }
  return entries;
}

const ALIGNMENT_BATCH: BatchEntry[] = deriveBatch();

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
  apply: boolean;
  /** The live-stack path: apply through POST /api/admin/append. */
  server: string | null;
  apiKey: string | null;
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
    server: value("--server") ?? null,
    apiKey: value("--api-key") ?? null,
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  return relay.listWorkspaceIds();
}

/**
 * The operator credential for the --server path: --api-key wins, else the
 * stack's api_key.txt beside the data dir (the deploy layout).
 */
function operatorKeyOf(options: CliOptions): string {
  if (options.apiKey !== null) return options.apiKey;
  try {
    return readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();
  } catch {
    throw new Error(
      "--server needs the operator key: pass --api-key or keep api_key.txt beside --data-dir",
    );
  }
}

/**
 * Apply one workspace's batch through the running server (the one write
 * path). Answers the saved ids — an empty list means the batch was already
 * applied (idempotent re-run); the server's derived stores converge before
 * the response, so no restart or cache wipe follows.
 */
async function appendViaServer(
  options: CliOptions,
  workspaceId: string,
  envelopes: Envelope[],
): Promise<{ savedIds: string[]; pending: number }> {
  const base = options.server!.replace(/\/$/, "");
  const response = await fetch(`${base}/api/admin/append`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": operatorKeyOf(options) },
    body: JSON.stringify({ workspaceId, envelopes }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/admin/append answered ${response.status}: ${body}`);
  }
  const result = (await response.json()) as { savedIds: string[]; pending: number };
  return { savedIds: result.savedIds, pending: result.pending };
}

// --- scratch derived store ----------------------------------------------------

/**
 * The shared scratch build (scripts/lib/scratch-store.ts — the sealed gate +
 * the skip accounting) plus this migration's house skip line.
 */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  return scratchStoreBuild(relay, workspaceId, ({ encrypted, pending }) => {
    console.log(
      `  (scratch: ${encrypted} encrypted + ${pending} pending envelope(s) skipped — ` +
        "a keyed workspace's sealed content is invisible to a server-side plan)",
    );
  });
}

// --- planning -----------------------------------------------------------------

interface BindingRowPlan {
  className: SystemClassName;
  classId: string;
  /** The class NODE is absent from this workspace. */
  classNodeMissing: boolean;
  /** A binding row already exists (any tier). */
  bound: boolean;
  /** The existing row's pinned tier flag (meaningful when bound). */
  boundPinned: boolean;
  /**
   * True when the class's extends closure reaches the schema's scope — the
   * R5 dead-config gate every replica enforces at hydration. A planned row
   * must never fail it.
   */
  scopeReachable: boolean;
  /** Emit `class.property.set` (create or — for the pinned base — pin patch). */
  planSet: boolean;
  /** The pin-convergence arm: the row exists, unpinned; the seed pins it. */
  pinPatch: boolean;
}

interface PropertyAlignmentPlan {
  name: SystemPropertyName;
  schemaId: string;
  displayName: string;
  type: string;
  schemaMissing: boolean;
  /**
   * The stored scope is a class-local list excluding source while binding
   * rows need planning → converge to the seed's [source] FIRST (the update
   * is ordered before every binding op of this property, same ingest).
   */
  scopeConverge: boolean;
  /** The converged stored scope; null = global (wider than the seed, legal). */
  storedScope: string[] | null;
  /** Attribute drift on an existing schema — reported, never touched. */
  attributeDrift: string[];
  /** The seed pins the base binding row (pmcid); false for pool fields. */
  pinnedBase: boolean;
  /** The base-family binding (pmcid on `source`); null for bind:false pool fields. */
  base: BindingRowPlan | null;
  /** Per-class pool bindings from SYSTEM_SOURCE_CLASS_BINDINGS. */
  classBindings: BindingRowPlan[];
}

interface AlignmentPlan {
  /** The `source` class NODE is absent — the citation ensure self-heals. */
  sourceClassMissing: boolean;
  properties: PropertyAlignmentPlan[];
}

/**
 * The R5 dead-config gate, planned: does the class's extends closure
 * intersect the schema scope list? A null scope (global) admits everyone.
 */
function scopeAdmits(
  ancestorsOf: (classId: string) => ReadonlySet<string>,
  scope: string[] | null,
  classId: string,
): boolean {
  if (scope === null || scope.length === 0) return true;
  const allowed = ancestorsOf(classId);
  return scope.some((id) => allowed.has(id));
}

function planAlignment(store: Store): AlignmentPlan {
  const db = store.database;
  const classNodeStmt = db.prepare("SELECT id FROM node WHERE id = ? AND is_class = 1");
  const schemaStmt = db.prepare(
    "SELECT name, type, scope_class_ids FROM property_schema WHERE id = ?",
  );
  const bindingStmt = db.prepare(
    "SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?",
  );
  const ancestorsStmt = db.prepare(
    "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?",
  );
  const ancestorsCache = new Map<string, ReadonlySet<string>>();
  const ancestorsOf = (classId: string): ReadonlySet<string> => {
    const cached = ancestorsCache.get(classId);
    if (cached !== undefined) return cached;
    const allowed = new Set<string>([classId]);
    for (const row of ancestorsStmt.all(classId) as Array<{ ancestor_id: string }>) {
      allowed.add(row.ancestor_id);
    }
    ancestorsCache.set(classId, allowed);
    return allowed;
  };
  const bindingState = (classId: string, schemaId: string): { bound: boolean; pinned: boolean } => {
    const row = bindingStmt.get(classId, schemaId) as { pinned: number } | undefined;
    return { bound: row !== undefined, pinned: row?.pinned === 1 };
  };

  const sourceClassMissing = classNodeStmt.get(SOURCE_ID) === undefined;

  const properties: PropertyAlignmentPlan[] = ALIGNMENT_BATCH.map((entry) => {
    const schema = schemaStmt.get(entry.schemaId) as
      | { name: string; type: string; scope_class_ids: string | null }
      | undefined;

    const attributeDrift: string[] = [];
    if (schema !== undefined) {
      if (schema.type !== entry.type) attributeDrift.push(`type=${schema.type} (seed: ${entry.type})`);
      if (schema.name !== entry.displayName) {
        attributeDrift.push(`name=${schema.name} (seed: ${entry.displayName})`);
      }
    }
    const storedScope =
      schema === undefined || schema.scope_class_ids === null
        ? null
        : (JSON.parse(schema.scope_class_ids) as string[]);

    // Row need, independent of scope (the scope arms converge first).
    const baseState =
      entry.baseClassName === null
        ? null
        : {
            classId: SYSTEM_CLASS_UUIDS[entry.baseClassName],
            ...bindingState(SYSTEM_CLASS_UUIDS[entry.baseClassName], entry.schemaId),
          };
    const classStates = entry.classNames.map((className) => {
      const classId = SYSTEM_CLASS_UUIDS[className];
      return { className, classId, ...bindingState(classId, entry.schemaId) };
    });
    const baseNeedsRow =
      baseState !== null && (!baseState.bound || (entry.pinnedBase && !baseState.pinned));
    const classesNeedingRows = classStates.filter((s) => !s.bound);

    // Scope arms — the scope the bindings are gated against is exactly what
    // will be STORED after this ingest: a missing schema creates at the
    // seed's [source]; a stored global scope admits everyone; the converge
    // arm rewrites a blocking class-local list to [source] FIRST when rows
    // need it.
    const storedBlocksClass = (classId: string): boolean =>
      storedScope !== null && !scopeAdmits(ancestorsOf, storedScope, classId);
    const closureReachesSeed = (classId: string): boolean =>
      scopeAdmits(ancestorsOf, [SOURCE_ID], classId);
    const scopeConverge =
      schema !== undefined &&
      storedScope !== null &&
      storedBlocksClass(SOURCE_ID) &&
      ((baseNeedsRow ?? false) ||
        classesNeedingRows.some(
          (s) => storedBlocksClass(s.classId) && closureReachesSeed(s.classId),
        ));
    const effectiveScope = scopeConverge
      ? [SOURCE_ID]
      : schema === undefined
        ? [SOURCE_ID]
        : storedScope;

    const base: BindingRowPlan | null =
      baseState === null
        ? null
        : {
            className: entry.baseClassName!,
            classId: baseState.classId,
            classNodeMissing: classNodeStmt.get(baseState.classId) === undefined,
            bound: baseState.bound,
            boundPinned: baseState.pinned,
            scopeReachable: scopeAdmits(ancestorsOf, effectiveScope, baseState.classId),
            // The base row is suppressed when the family base node is absent
            // (the citation ensure self-heals the family) — never against a
            // reachable scope, which for `source` itself is tautological.
            planSet:
              !sourceClassMissing &&
              (!baseState.bound || (entry.pinnedBase && !baseState.pinned)) &&
              scopeAdmits(ancestorsOf, effectiveScope, baseState.classId),
            pinPatch: baseState.bound && entry.pinnedBase && !baseState.pinned,
          };

    const classBindings: BindingRowPlan[] = classStates.map((state) => ({
      className: state.className,
      classId: state.classId,
      classNodeMissing: classNodeStmt.get(state.classId) === undefined,
      bound: state.bound,
      boundPinned: state.pinned,
      scopeReachable: scopeAdmits(ancestorsOf, effectiveScope, state.classId),
      planSet:
        !state.bound && scopeAdmits(ancestorsOf, effectiveScope, state.classId),
      pinPatch: false,
    }));

    return {
      name: entry.name,
      schemaId: entry.schemaId,
      displayName: entry.displayName,
      type: entry.type,
      schemaMissing: schema === undefined,
      scopeConverge,
      storedScope,
      attributeDrift,
      pinnedBase: entry.pinnedBase,
      base,
      classBindings,
    };
  });

  return { sourceClassMissing, properties };
}

// --- envelopes ----------------------------------------------------------------

function buildEnvelopes(workspaceId: string, plan: AlignmentPlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  let logical = 0;
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): Envelope =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: affected,
      opType,
      payload,
    });

  for (const property of plan.properties) {
    if (property.schemaMissing) {
      // The seed shape at the reserved id: text, scoped [source].
      envelopes.push(
        stamp("propertySchema.create", {
          propertySchemaId: property.schemaId,
          name: property.displayName,
          type: property.type,
          scopeClassIds: [SOURCE_ID],
        }, []),
      );
    } else if (property.scopeConverge) {
      // R5 dead-config guard: converge the drifted class-local scope to the
      // seed's [source] FIRST — same ingest, ordered before the bindings.
      envelopes.push(
        stamp("propertySchema.update", { propertySchemaId: property.schemaId, scopeClassIds: [SOURCE_ID] }, []),
      );
    }
    if (property.base !== null && property.base.planSet) {
      envelopes.push(
        stamp(
          "class.property.set",
          {
            classId: property.base.classId,
            propertySchemaId: property.schemaId,
            // The pin patch converges the tier; a fresh base row carries the
            // seed's tier (pinned for the base family).
            ...(property.pinnedBase ? { pinned: true } : {}),
          },
          [property.base.classId],
        ),
      );
    }
    for (const binding of property.classBindings) {
      if (!binding.planSet) continue;
      envelopes.push(
        stamp(
          "class.property.set",
          { classId: binding.classId, propertySchemaId: property.schemaId },
          [binding.classId],
        ),
      );
    }
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
 *  3. assert every batch schema row converged (scope [source]) and every
 *     planned binding row exists (the pmcid base row pinned).
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  plan: AlignmentPlan,
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
    for (const property of plan.properties) {
      const schema = store.database
        .prepare("SELECT scope_class_ids FROM property_schema WHERE id = ?")
        .get(property.schemaId) as { scope_class_ids: string | null } | undefined;
      if (schema === undefined) {
        throw new Error(`verification failed: the ${property.name} schema row is missing after the migration`);
      }
      if (property.base !== null && property.base.planSet) {
        const binding = store.database
          .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(property.base.classId, property.schemaId) as { pinned: number } | undefined;
        if (binding === undefined) {
          throw new Error(
            `verification failed: the ${property.base.className}↔${property.name} binding row is missing after the migration`,
          );
        }
        if (binding.pinned !== 1) {
          throw new Error(
            `verification failed: the ${property.base.className}↔${property.name} binding row is not pinned after the migration`,
          );
        }
      }
      for (const binding of property.classBindings) {
        if (!binding.planSet) continue;
        const row = store.database
          .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
          .get(binding.classId, property.schemaId) as { pinned: number } | undefined;
        if (row === undefined) {
          throw new Error(
            `verification failed: the ${binding.className}↔${property.name} binding row is missing after the migration`,
          );
        }
      }
    }
  } finally {
    store.close();
  }

  console.log(
    `verify: ${rows.length} new envelope(s) read back; tail applied clean; ` +
      "the 31 schemas + every planned binding row converge.",
  );
}

// --- main ---------------------------------------------------------------------

function isConverged(plan: AlignmentPlan): boolean {
  return plan.properties.every(
    (property) =>
      !property.schemaMissing &&
      !property.scopeConverge &&
      (property.base === null || !property.base.planSet) &&
      property.classBindings.every((binding) => !binding.planSet),
  );
}

async function migrateWorkspace(relay: RelayStorage, options: CliOptions, workspaceId: string): Promise<void> {
  const apply = options.apply;
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  const plan = planAlignment(store);
  store.close();

  if (isConverged(plan)) {
    console.log("  already converged — the 31 schemas + every binding row exist. Nothing to do.");
    return;
  }

  console.log("planned Zotero full alignment:");
  if (plan.sourceClassMissing) {
    console.log(
      "  source class node not present — the base-family rows are skipped " +
        "(the citation ensure self-heals the family on the next source create).",
    );
  }
  let creates = 0;
  let bindingOps = 0;
  let pinPatches = 0;
  let scopeConverges = 0;
  const skipped: string[] = [];
  for (const property of plan.properties) {
    const lines: string[] = [];
    if (property.schemaMissing) {
      creates += 1;
      lines.push(
        `propertySchema.create { propertySchemaId: <${property.name} ${property.schemaId.slice(-9)}>, name: ${JSON.stringify(property.displayName)}, type: ${property.type}, scopeClassIds: [<source>] }`,
      );
    } else if (property.scopeConverge) {
      scopeConverges += 1;
      lines.push(
        `propertySchema.update { propertySchemaId: <${property.name}>, scopeClassIds: [<source>] } FIRST — stored scope drifted: ` +
          JSON.stringify(property.storedScope),
      );
    } else if (property.storedScope === null) {
      lines.push(`stored scope is GLOBAL — wider than the seed, legal, NOT touched.`);
    }
    if (property.base !== null && property.base.planSet) {
      bindingOps += 1;
      if (property.base.pinPatch) pinPatches += 1;
      lines.push(
        `class.property.set { classId: <${property.base.className}>, propertySchemaId: <${property.name}>, pinned: true }` +
          (property.base.pinPatch ? " — pin patch" : ""),
      );
    }
    for (const binding of property.classBindings) {
      if (binding.planSet) {
        bindingOps += 1;
        lines.push(
          `class.property.set { classId: <${binding.className}>, propertySchemaId: <${property.name}> }`,
        );
      } else if (!binding.bound && !binding.scopeReachable) {
        skipped.push(`${property.name} → ${binding.className}`);
      }
    }
    for (const drift of property.attributeDrift) {
      lines.push(`reported drift (NOT touched): ${drift}`);
    }
    for (const line of lines) console.log(`  ${line}`);
  }
  if (skipped.length > 0) {
    console.log(
      "  skipped (the class's extends closure cannot reach the scope — authoring the row would " +
        `fail the R5 dead-config check on every replica): ${skipped.join(", ")}`,
    );
  }
  console.log(
    `  ${creates} schema create(s), ${scopeConverges} scope converge(s), ` +
      `${bindingOps} binding op(s) (${pinPatches} pin patch(es)).`,
  );

  const envelopes = buildEnvelopes(workspaceId, plan);
  validateEnvelopes(envelopes);
  console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

  if (!apply) {
    console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
    return;
  }

  if (options.server !== null) {
    // The live-stack path: the server is the writer (relay ingest + derived
    // apply in one step). An empty savedIds is the idempotent re-run case —
    // the batch is already applied, not an error.
    const { savedIds, pending } = await appendViaServer(options, workspaceId, envelopes);
    console.log(
      savedIds.length === 0
        ? "  already applied on the server (idempotent re-run) — nothing to append."
        : `  applied ${savedIds.length} envelope(s) through the server (pending skips: ${pending}). ` +
            "The server's derived stores converged before the response — no restart needed.",
    );
    return;
  }

  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
  }
  console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

  verify(relay, workspaceId, plan, envelopes.length);
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
      `Zotero full alignment (31 pool properties, ${ALIGNMENT_BATCH.reduce((n, e) => n + e.classNames.length, 0)} per-class binding rows + the pinned pmcid base row): ` +
        `${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"}${options.server !== null ? ` via ${options.server}` : ""})`,
    );
    for (const workspaceId of workspaces) {
      await migrateWorkspace(relay, options, workspaceId);
      refuseIfContentOnKeyed(options.dataDir, workspaceId, CONTENT_CLASS, "migrate-zotero-full-alignment.mts");
    }
    if (options.apply && options.server === null) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite). " +
          "The server's own derived caches converge on its next open (a restart nudge) or " +
          "via the self-heal sweep; --server applies through the server and skips even that.",
      );
    }
  } finally {
    relay.close();
  }
}

export { buildEnvelopes, planAlignment, type AlignmentPlan, type PropertyAlignmentPlan, type BindingRowPlan };

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
