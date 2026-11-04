/**
 * Shared class-family "ensure" authoring loop — the spec-driven core the
 * family ensures compose (taskFamily / meetingFamily / cardFamily). Every
 * family re-rolled the same two-phase write: author the family's missing
 * property schemas, then author the missing class bindings. This module is
 * that loop, parameterized by a per-property spec so each family keeps its
 * exact current write semantics:
 *
 * - Scope: the meeting family scopes its schemas to the family class
 *   (`scopeClassIds: [classId]` — the sole-locality-authority pattern) via
 *   `EnsureFamilyOptions.scopeToClass`; the task and card families author
 *   global-scope schemas (absent scopeClassIds — any node may carry the
 *   schema, only the binding row is class-local).
 * - Schema options: multi / options / targetClassFilter / hideWhenEmpty /
 *   defaultValue ride the spec and are carried into the
 *   propertySchema.create payload only when defined — the authored wire
 *   payload is exactly what a hand-rolled loop would send.
 * - Bindings: existence-only. The `pinned` tier flag rides a NEW binding
 *   row only — an existing row (user-unpinned included) is never re-patched.
 *
 * Idempotence: a fully-present family is a complete no-op (both phases skip
 * every spec), so the ensures are safe to call on every open.
 *
 * The surface is MaybePromise so the same loop runs over the sync web
 * clients (a sync return value is a valid MaybePromise) and over async
 * surfaces (the meeting family's HTTP-capable adapter in the remap script),
 * no casts. Type-only client imports keep the module runtime-import-free
 * beyond types, so node-side consumers (tsx scripts) can import it.
 */

import type {
  ClientPropertyOption,
  CreatePropertySchemaInput,
  SetClassPropertyInput,
} from "@/core/workspace-client/index.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * The minimal write/read surface the ensure loop composes — satisfied
 * structurally by the sync web clients and by the async family surfaces.
 */
export interface FamilyEnsureSurface {
  listPropertySchemas(): MaybePromise<readonly { id: string }[]>;
  getClassBindings(classId: string): MaybePromise<readonly { propertySchemaId: string }[]>;
  createPropertySchema(input: CreatePropertySchemaInput): MaybePromise<unknown>;
  setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): MaybePromise<void>;
}

/**
 * One family property spec — the authoring manifest entry (in authoring
 * order; binding rows carry no order — the pin tiers derive at read time).
 */
export interface FamilyPropertySpec {
  /** The reserved system schema id (fixed-UUID seeds converge by id). */
  id: string;
  name: string;
  /** The schema type (text / datetime / object / select / number / …). */
  type: string;
  /** Multi cardinality (absent = single-value). */
  multi?: boolean;
  /**
   * Select options, resolved lazily at author time — only invoked when the
   * schema is missing, so a converged run never calls it.
   */
  options?: () => ClientPropertyOption[];
  /** Node-typed target filter (already-resolved class ids). */
  targetClassFilter?: string[];
  /** The schema-level hide-when-empty render contract. */
  hideWhenEmpty?: boolean;
  /** The schema-level default (carried on the schema, never materialized). */
  defaultValue?: unknown;
  /** The binding row's pin-tier flag — rides a NEW binding row only. */
  pinned?: boolean;
}

export interface EnsureFamilyOptions {
  /**
   * Scope the authored schemas to the target class (`scopeClassIds:
   * [classId]`); absent = global scope. The family's choice is part of its
   * contract (meeting: class-scoped; task/card: global) — not per-spec.
   */
  scopeToClass?: boolean;
}

/** True when every family spec's schema exists AND binds the class. */
export async function familySchemasPresent(
  surface: FamilyEnsureSurface,
  classId: string,
  family: ReadonlyArray<{ id: string }>,
): Promise<boolean> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  const bound = new Set(
    (await surface.getClassBindings(classId)).map((binding) => binding.propertySchemaId),
  );
  return family.every((spec) => have.has(spec.id) && bound.has(spec.id));
}

/**
 * Phase 1 — author the family's missing property schemas (existence-only:
 * an existing schema row is never re-patched, whatever its stored shape).
 * Pass `scopeClassIds` to scope the authored schemas to those classes;
 * absent = global scope.
 */
export async function ensureFamilyPropertySchemas(
  surface: FamilyEnsureSurface,
  family: ReadonlyArray<FamilyPropertySpec>,
  opts?: { scopeClassIds?: string[] },
): Promise<void> {
  const have = new Set((await surface.listPropertySchemas()).map((schema) => schema.id));
  for (const spec of family) {
    if (have.has(spec.id)) continue;
    await surface.createPropertySchema({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      ...(opts?.scopeClassIds !== undefined ? { scopeClassIds: opts.scopeClassIds } : {}),
      ...(spec.multi !== undefined ? { multi: spec.multi } : {}),
      ...(spec.options !== undefined ? { options: spec.options() } : {}),
      ...(spec.targetClassFilter !== undefined ? { targetClassFilter: spec.targetClassFilter } : {}),
      ...(spec.hideWhenEmpty !== undefined ? { hideWhenEmpty: spec.hideWhenEmpty } : {}),
      ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
    });
  }
}

/**
 * Phase 2 — author the family's missing class bindings (existence-only:
 * `pinned` rides a NEW binding row only — an existing row, user-unpinned
 * included, is never re-patched; a spec without `pinned` binds with an
 * empty fields object).
 */
export async function ensureFamilyBindings(
  surface: FamilyEnsureSurface,
  classId: string,
  family: ReadonlyArray<FamilyPropertySpec>,
): Promise<void> {
  const bound = new Set(
    (await surface.getClassBindings(classId)).map((binding) => binding.propertySchemaId),
  );
  for (const spec of family) {
    if (bound.has(spec.id)) continue;
    await surface.setClassProperty(classId, spec.id, {
      ...(spec.pinned !== undefined ? { pinned: spec.pinned } : {}),
    });
  }
}

/** Both phases in order: author missing schemas, then missing bindings. */
export async function ensureFamilySchemas(
  surface: FamilyEnsureSurface,
  classId: string,
  family: ReadonlyArray<FamilyPropertySpec>,
  opts?: EnsureFamilyOptions,
): Promise<void> {
  await ensureFamilyPropertySchemas(
    surface,
    family,
    opts?.scopeToClass ? { scopeClassIds: [classId] } : undefined,
  );
  await ensureFamilyBindings(surface, classId, family);
}
