/**
 * Operation type registry v2 (M1 subset).
 *
 * Model per .plans/design/01-knowledge-model.md (the model is normative there;
 * this registry is its op-level expression). Associations are node-typed
 * property values or typed-link word marks in contentAst — there are no
 * relation.* ops. contentAst rides object.create/update as the readable carrier
 * (fixtures, tests, plain-text editor path); contentDeltaB64 is the canonical
 * wire carrier once the Yjs port lands (store/sync work).
 */

import { z } from "zod";

const uuid = z.string().uuid();

// --- objects -----------------------------------------------------------------

export const objectCreatePayload = z
  .object({
    objectId: uuid,
    /** Structural role (Revision 10, bullet-proof schema): exactly one of
     * page | block | class — the database enforces placement invariants with
     * CHECK (a block can never be parentless; a class is always tree-external).
     * Optional in the payload — the applier defaults it by context
     * (workspace root → page, child → block). Placement itself lives only in
     * the tree (parent_id). Domain typing (whiteboard, meeting, …) is class_ids. */
    nodeType: z.enum(["page", "block", "class"]).optional(),
    classIds: z.array(uuid).default([]),
    tagIds: z.array(uuid).default([]),
    /**
     * The node's initial text content — a node's title IS its content
     * (SCHEMA.md "title-is-content"): there is no name field for objects or
     * classes. (Class labels ride class.create's contentAst; property schema
     * names are registry metadata, not node names.)
     */
    contentAst: z.array(z.unknown()).optional(),
    parentId: uuid.nullable().optional(),
    /**
     * Initial sibling placement (fractional child order — see object.move):
     * `afterId`/`beforeId` anchor the node next to that current sibling;
     * omit both to append at the end. At most one is meaningful; when both
     * are present `afterId` wins (the TS reference never sends both).
     */
    afterId: uuid.optional(),
    beforeId: uuid.optional(),
  })
  .strict();

export const objectUpdatePayload = z
  .object({
    objectId: uuid,
    /** Flipping nodeType block↔page = promotion/demotion (identity preserved);
     * setting 'class' = declare the node a class (declaration-first). */
    nodeType: z.enum(["page", "block", "class"]).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    /** Canonical wire carrier: base64 incremental CRDT delta. */
    contentDeltaB64: z.string().optional(),
    /** Readable carrier (fixtures, tests, plain-text editor path before the Yjs port). */
    contentAst: z.array(z.unknown()).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 1, { message: "object.update requires at least one field" })
  .refine((p) => !(p.contentDeltaB64 !== undefined && p.contentAst !== undefined), {
    message: "exactly one content carrier per update",
  });

export const objectDeletePayload = z
  .object({
    objectId: uuid,
    permanent: z.boolean().default(false),
  })
  .strict();

/**
 * Reparenting + sibling ordering (the outliner's indent/outdent/Enter
 * placement). `parentId` null means workspace root and is legal ONLY for
 * pages — the store's placement CHECKs reject a parentless block, and the
 * applier's cross-row move guard rejects any class parenting (fail loud).
 * `afterId` places the node immediately after that sibling in the parent's
 * child order (Enter placement); `beforeId` places it immediately before
 * (the v1-level Enter-at-start / first-child placement that afterId-only
 * fractional ordering cannot express — midpoints never drop below the
 * current minimum). Omit both to append at the end. At most one anchor is
 * meaningful; when both are present `afterId` wins. An anchor that is not a
 * current sibling falls back to append (defensive, mirrors afterId). Parent
 * and position are LWW by envelope HLC, like the other node fields. Ordering
 * is a minimal deterministic fractional allocator (sibling midpoint /
 * midpoint-below-first / append) — TreeCrdt remains designed (docs/ux.md
 * "The outliner").
 */
export const objectMovePayload = z
  .object({
    objectId: uuid,
    parentId: uuid.nullable(),
    afterId: uuid.optional(),
    beforeId: uuid.optional(),
  })
  .strict();

// --- classes & properties ----------------------------------------------------

export const classCreatePayload = z
  .object({
    classId: uuid,
    /** The class's title text — classes are nodes; their name IS their
     * content (text-only, like pages). Client helpers may still accept a
     * plain `name` string and wrap it into a single text token. */
    contentAst: z.array(z.unknown()).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    description: z.string().max(4096).optional(),
  })
  .strict();

export const classUpdatePayload = z
  .object({
    classId: uuid,
    /** Title-text replacement (text-only content), same contract as
     * class.create. */
    contentAst: z.array(z.unknown()).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    description: z.string().max(4096).optional(),
  })
  .strict();

export const classDeletePayload = z.object({ classId: uuid }).strict();

/**
 * Class membership removal (SCHEMA.md "Class properties"): the OR-Set remove
 * complement of the re-issued object.create add carrier. The applier
 * tombstones the `class_member_set` pair (present = 0, HLC-gated add-wins)
 * and recomputes `node.class_ids`; the effective-values read model drops the
 * class's derived defaults automatically and authored values survive.
 */
export const classUnassignPayload = z
  .object({ objectId: uuid, classId: uuid })
  .strict();

/**
 * Class ORDER (display-only, 2026-10-01): the membership OR-Set projects
 * class_ids sorted by id; user-defined order rides this dedicated op as an
 * LWW-by-arrival array. The effective class_ids = ordered members first,
 * then any unlisted members sorted by id (see recomputeClassIds).
 */
export const classReorderPayload = z
  .object({
    objectId: uuid,
    classIds: z.array(uuid),
  })
  .strict();

export const tagUnassignPayload = z
  .object({ objectId: uuid, tagId: uuid })
  .strict();

export const classSetExtendsPayload = z
  .object({
    classId: uuid,
    /** Designed m2m model (01-knowledge-model.md §6): a class may have
     * MULTIPLE parents — diamonds are natural. Replace semantics: the array
     * IS the class's full parent set (an empty array detaches all parents).
     * The store applier keeps the transitive closure in sync and fails loud
     * on cycles, including self-parent and multi-hop cycles. Closure rows
     * carry no order: diamond resolution (own binding → shortest extends-path
     * → earliest-authored HLC) happens at read time in the bindings read
     * model, so the payload needs nothing extra for M1. */
    parentClassIds: z.array(uuid),
  })
  .strict();

/**
 * Class → property-schema binding upsert (SCHEMA.md "Class properties"):
 * a configuration row on `class_property` (sequence, flags, defaultValue).
 * Row-level LWW by envelope HLC; on update, omitted fields KEEP their existing
 * values (a partial patch, not a replace) — pass `null` explicitly to clear
 * required/readonly/hideWhenEmpty, or `undefined`-absent to leave untouched.
 * `defaultValue` is any JSON value (JSON-null is a real default; absent = keep).
 */
export const classPropertySetPayload = z
  .object({
    classId: uuid,
    propertySchemaId: uuid,
    sequence: z.number().int().optional(),
    required: z.boolean().nullable().optional(),
    readonly: z.boolean().nullable().optional(),
    hideWhenEmpty: z.boolean().nullable().optional(),
    defaultValue: z.unknown().optional(),
  })
  .strict();

/**
 * Binding removal: deletes the `class_property` row. No tombstone — a config
 * row, last write wins; the derived defaults read model simply stops deriving
 * the schema's default for the class's nodes (authored property values are
 * unaffected and survive, per SCHEMA.md).
 */
export const classPropertyUnsetPayload = z
  .object({
    classId: uuid,
    propertySchemaId: uuid,
  })
  .strict();

export const propertySchemaCreatePayload = z
  .object({
    propertySchemaId: uuid,
    name: z.string().min(1).max(256),
    type: z.enum([
      "text",
      "number",
      "boolean",
      "date",
      "date_range",
      "url",
      "email",
      "select",
      "multi_select",
      "object",
      "image",
    ]),
    multi: z.boolean().default(false),
    scope: z.enum(["global", "class", "object"]).default("global"),
    options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    /** Node-typed (m2o/m2m) schemas constrain their targets to these classes. */
    targetClassFilter: z.array(uuid).optional(),
    /** Date schemas: the finest granularity a value may claim (SCHEMA.md "Dates";
     * default "day" at the read model when absent). */
    datePrecision: z.enum(["year", "month", "day"]).optional(),
    /** Node-typed schemas: values may carry date qualifiers (metadata
     * startDate/endDate — the panel renders a small range control per chip). */
    dateQualified: z.boolean().optional(),
  })
  .strict();

export const propertySchemaUpdatePayload = z
  .object({
    propertySchemaId: uuid,
    name: z.string().min(1).max(256).optional(),
    options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    /** Patchable so the Class View bindings editor can retune date behavior
     * after creation (same optional-fields contract as name/options). */
    datePrecision: z.enum(["year", "month", "day"]).optional(),
    dateQualified: z.boolean().optional(),
  })
  .strict();

export const propertySchemaDeletePayload = z
  .object({ propertySchemaId: uuid })
  .strict();

export const propertySetPayload = z
  .object({
    objectId: uuid,
    propertySchemaId: uuid,
    value: z.unknown(),
    idx: z.number().int().nonnegative().default(0),
    /** Per-value qualifiers (`since`, `locator`, …) — SCHEMA.md owed work, column reserved. */
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const propertyUnsetPayload = z
  .object({
    objectId: uuid,
    propertySchemaId: uuid,
    idx: z.number().int().nonnegative().default(0),
  })
  .strict();

// --- associations ------------------------------------------------------------
// First-class relation entities were deleted 2026-09-25 (02-model-assessment.md
// §6): associations are node-typed property values (m2o/m2m) or typed-link word
// marks riding in contentAst — both project into the derived edge index. There
// is deliberately NO relation.* op type, and no seeded relation vocabulary
// (design law: predictions become defaults/conventions, never protocol).

export const assetAttachPayload = z
  .object({
    objectId: uuid,
    assetId: uuid,
    hash: z.string().length(64),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    originalName: z.string().min(1).max(1024),
  })
  .strict();

export const assetDetachPayload = z
  .object({ objectId: uuid, assetId: uuid })
  .strict();

// --- collections -------------------------------------------------------------
// Reconciliation (SCHEMA.md owed work, decided 2026-09-26): collections ARE
// nodes per 01 — created via object.create with the `collection` class. There
// are deliberately NO collection.create/update/delete ops (that would be a
// parallel write path to the node model). Only membership carries dedicated
// ops; everything else is object.* + class assignments.

export const collectionMemberAddPayload = z
  .object({ collectionId: uuid, objectId: uuid })
  .strict();

export const collectionMemberRemovePayload = z
  .object({ collectionId: uuid, objectId: uuid })
  .strict();

// --- registry ----------------------------------------------------------------

export const OP_PAYLOAD_SCHEMAS = {
  "object.create": objectCreatePayload,
  "object.update": objectUpdatePayload,
  "object.delete": objectDeletePayload,
  "object.move": objectMovePayload,
  "class.create": classCreatePayload,
  "class.update": classUpdatePayload,
  "class.delete": classDeletePayload,
  "class.unassign": classUnassignPayload,
  "class.reorder": classReorderPayload,
  "tag.unassign": tagUnassignPayload,
  "class.setExtends": classSetExtendsPayload,
  "class.property.set": classPropertySetPayload,
  "class.property.unset": classPropertyUnsetPayload,
  "propertySchema.create": propertySchemaCreatePayload,
  "propertySchema.update": propertySchemaUpdatePayload,
  "propertySchema.delete": propertySchemaDeletePayload,
  "property.set": propertySetPayload,
  "property.unset": propertyUnsetPayload,
  "asset.attach": assetAttachPayload,
  "asset.detach": assetDetachPayload,
  "collection.member.add": collectionMemberAddPayload,
  "collection.member.remove": collectionMemberRemovePayload,
} as const;

export type OpType = keyof typeof OP_PAYLOAD_SCHEMAS;
export const KNOWN_OP_TYPES = Object.keys(OP_PAYLOAD_SCHEMAS) as OpType[];

export type OpPayload<T extends OpType> = z.infer<(typeof OP_PAYLOAD_SCHEMAS)[T]>;

export function payloadSchemaFor(opType: string): z.ZodTypeAny | undefined {
  return (OP_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[opType];
}
