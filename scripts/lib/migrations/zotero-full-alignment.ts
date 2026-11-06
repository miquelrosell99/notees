/**
 * The zotero-full-alignment migration's node-free planning core — the
 * client-side executor pattern (F3 fleet extraction, 2026-11-06), the
 * Stage-1 proving pattern repeated. NODE-DEP-FREE by contract: imports only
 * the browser-safe workspace packages (protocol/domain/store), no node
 * builtins, no better-sqlite3, no RelayStorage, no fs.
 *
 * The CLI (scripts/migrate-zotero-full-alignment.mts) delegates here
 * unchanged; its rehearsal suite
 * (apps/server/test/migrate-zotero-full-alignment.test.ts) is the pin (it
 * imports the planner/builder through the script's re-export).
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): the 31 pool schemas seed at their reserved ids (scoped
 * [source]) when missing, drifted class-local scopes converge to [source]
 * before the bindings they gate, and the per-class binding rows + the
 * pinned pmcid base row ride class.property.set. Attribute drift on
 * existing schemas is reported, never touched.
 */

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
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
} from "../../../packages/domain/src/index.ts";
import type { Store } from "../../../packages/store/src/index.ts";

/** The migration's actor/device/client constants — the CLI path's identity. */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a7",
  deviceId: "migrate-zotero-full-alignment",
  client: "migrate-zotero-full-alignment",
};

/** One migration write in its wire-neutral triple form (the client-side
 *  executor stamps these with its session constants through the normal
 *  write path — no new crypto, no wire change). */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

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

export const ALIGNMENT_BATCH: BatchEntry[] = deriveBatch();

// --- plan shape ---------------------------------------------------------------

export interface BindingRowPlan {
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
export interface PropertyAlignmentPlan {
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
export interface AlignmentPlan {
  /** The `source` class NODE is absent — the citation ensure self-heals. */
  sourceClassMissing: boolean;
  properties: PropertyAlignmentPlan[];
}
/**
 * The R5 dead-config gate, planned: does the class's extends closure
 * intersect the schema scope list? A null scope (global) admits everyone.
 */

export function scopeAdmits(
  ancestorsOf: (classId: string) => ReadonlySet<string>,
  scope: string[] | null,
  classId: string,
): boolean {
  if (scope === null || scope.length === 0) return true;
  const allowed = ancestorsOf(classId);
  return scope.some((id) => allowed.has(id));
}

export function planAlignment(store: Store): AlignmentPlan {
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

export function isConverged(plan: AlignmentPlan): boolean {
  return plan.properties.every(
    (property) =>
      !property.schemaMissing &&
      !property.scopeConverge &&
      (property.base === null || !property.base.planSet) &&
      property.classBindings.every((binding) => !binding.planSet),
  );
}

/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds work (a converged store plans
 * nothing — idempotent by construction). A missing source class node is the
 * citation ensure's job, not this migration's (the CLI's ruling).
 */
export function isPending(store: Store): boolean {
  const plan = planAlignment(store);
  return !plan.sourceClassMissing && !isConverged(plan);
}

// --- ops + envelopes --------------------------------------------------------------

export function buildOps(plan: AlignmentPlan): MigrationOp[] {
  const ops: MigrationOp[] = [];
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): void => {
    ops.push({ opType, payload, affected });
  };

  for (const property of plan.properties) {
    if (property.schemaMissing) {
      // The seed shape at the reserved id: text, scoped [source].
      stamp("propertySchema.create", {
        propertySchemaId: property.schemaId,
        name: property.displayName,
        type: property.type,
        scopeClassIds: [SOURCE_ID],
      }, []);
    } else if (property.scopeConverge) {
      // R5 dead-config guard: converge the drifted class-local scope to the
      // seed's [source] FIRST — same ingest, ordered before the bindings.
      stamp("propertySchema.update", { propertySchemaId: property.schemaId, scopeClassIds: [SOURCE_ID] }, []);
    }
    if (property.base !== null && property.base.planSet) {
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
      );
    }
    for (const binding of property.classBindings) {
      if (!binding.planSet) continue;
      stamp(
        "class.property.set",
        { classId: binding.classId, propertySchemaId: property.schemaId },
        [binding.classId],
      );
    }
  }
  return ops;
}

/**
 * The envelope builder: the plan's ops as fully-stamped protocol envelopes.
 * `stamp` is the HLC physical clock (the CLI passes `Date.now()`);
 * `identity` defaults to {@link MIGRATION_IDENTITY}.
 */
export function buildEnvelopes(
  workspaceId: string,
  plan: AlignmentPlan,
  stamp: number,
  identity: MigrationIdentity = MIGRATION_IDENTITY,
): Envelope[] {
  const ops = buildOps(plan);
  return ops.map((op, logical) =>
    newEnvelope({
      workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      ...(identity.client !== undefined ? { client: identity.client } : {}),
      hlc: { physical: stamp, logical },
      affectedNodeIds: op.affected,
      opType: op.opType,
      payload: op.payload,
    }),
  );
}

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
