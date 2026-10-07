/**
 * Operation type registry v2.
 *
 * Model per SCHEMA.md — this registry is the op-level expression of the
 * model. Associations are node-typed
 * property values or typed-link word marks in contentAst — there are no
 * relation.* ops. contentAst rides object.create/update as the readable carrier
 * (fixtures, tests, plain-text editor path); contentDeltaB64 is the canonical
 * wire carrier once the Yjs port lands (store/sync work).
 */

import { z } from "zod";

import { colorValueSchema } from "./colors.js";

const uuid = z.string().uuid();

// --- objects -----------------------------------------------------------------

export const objectCreatePayload = z
  .object({
    objectId: uuid,
    /**
     * Render bit (Revision 11): read only when the node has a parent —
     * true = render in the parent's main-children zone with document
     * chrome; false = inline body with block chrome. Unread/unused for
     * parentless nodes (those render with document chrome by the second
     * cascade branch). Optional in the payload — the applier defaults it
     * by context: true when parentless, false otherwise. Content is
     * flattened to text-only when is_class or present_as_main. Class
     * declaration remains the class.create op. Placement itself lives
     * only in the tree (parentId). Domain typing (whiteboard, meeting,
     * …) is classIds. The retired nodeType key (Revision 10 and earlier)
     * is rejected outright by this strict schema; old stored logs are
     * rewritten to the new model by the one-time migration script
     * (scripts/migrate-node-type.mts, planned). */
    presentAsMain: z.boolean().optional(),
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
    /** Render-bit toggle (Revision 11): promotion/demotion flips are
     * presentAsMain true/false (identity preserved; promotion stringifies
     * the content when the bit flips false → true). Class declaration
     * remains the class.create op. The retired nodeType key (Revision 10
     * and earlier) is rejected outright by this strict schema; old stored
     * logs are rewritten to the new model by the one-time migration
     * script (scripts/migrate-node-type.mts, planned). */
    presentAsMain: z.boolean().optional(),
    icon: z.string().max(64).optional(),
    /** Preset token (`sky`) or custom `#RRGGBB` hex (colors.ts grammar);
     * null CLEARS the node's color. */
    color: colorValueSchema.nullish(),
    /**
     * Wire node fields (the icon/color precedent): platform-fixed node
     * fundamentals that core chrome or navigation reads/writes — an asset
     * node for the page cover, an asset node for the page banner, and the
     * main page a node alias points at (many-to-one FROM the alias: a node
     * aliases at most one node). Set via object.update only (object.create
     * carries no appearance/fundamental fields); `null` CLEARS. Presence
     * writes, null clears — the applier distinguishes absence (no write)
     * from present-null (SQL NULL), exactly like `color`. Reference
     * integrity (asset existence, alias-chain cycle validation, the
     * universal redirect) is a client/read-layer concern — the applier
     * maps the fields, it does not validate them. See SCHEMA.md
     * "Node structure" and "Node aliases". */
    coverAssetId: uuid.nullish(),
    bannerAssetId: uuid.nullish(),
    aliasedNodeId: uuid.nullish(),
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
 * Restore from the trash (SCHEMA.md deletion/restore semantics). Whole-tree:
 * the subtree trashed WITH the node reactivates; a descendant carrying its
 * OWN trash row was trashed independently and stays trashed (its subtree
 * rides along with it, not with this restore). LWW against object.delete by
 * log order — the single global relay log makes the pair convergent.
 * Corner: parent row missing (permanently deleted, legacy dangling row) →
 * reparent to the workspace root; a present-but-inactive parent is left
 * alone (restoring the parent later heals the tree; an active child under
 * a trashed parent is transient, never data loss).
 */
export const objectRestorePayload = z
  .object({
    objectId: uuid,
  })
  .strict();

/**
 * Reparenting + sibling ordering (the outliner's indent/outdent/Enter
 * placement). `parentId` null means workspace root and is legal ONLY for
 * pages — the store's placement CHECKs reject a parentless block, and the
 * applier's cross-row move guard rejects any class parenting (fail loud).
 * `afterId` places the node immediately after that sibling in the parent's
 * child order (Enter placement); `beforeId` places it immediately before
 * (the Enter-at-start / first-child placement that afterId-only
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
    /** Preset token or `#RRGGBB` hex (colors.ts grammar); null = no color. */
    color: colorValueSchema.nullish(),
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
    /** Preset token or `#RRGGBB` hex (colors.ts grammar); null clears —
     * the schema now accepts what the catalog always documented. */
    color: colorValueSchema.nullish(),
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
    /** Designed m2m model: a class may have
     * MULTIPLE parents — diamonds are natural. Replace semantics: the array
     * IS the class's full parent set (an empty array detaches all parents).
     * The store applier keeps the transitive closure in sync and fails loud
     * on cycles, including self-parent and multi-hop cycles. Closure rows
     * carry no order: diamond resolution (own binding → shortest extends-path
     * → earliest-authored HLC) happens at read time in the bindings read
     * model, so the payload needs nothing extra. */
    parentClassIds: z.array(uuid),
  })
  .strict();

/**
 * Class → property-schema binding upsert (SCHEMA.md "Class properties"):
 * a configuration row on `class_property` (sequence, defaultValue, active —
 * the genuinely PER-CLASS mechanics: panel order, the class's own default,
 * the class's soft-unbind). Row-level LWW by envelope HLC; on update, omitted
 * fields KEEP their existing values. `defaultValue` is any JSON value
 * (JSON-null is a real default; absent = keep).
 *
 * (owner review 2026-10-05): the render contracts readonly,
 * hideWhenEmpty, display are PROPERTY-level characteristics and live on the
 * property schema (`propertySchema.create/update`) — the strict schema
 * rejects them here like any retired key. `required` is the exception the
 * owner kept at the binding: a property may be mandatory for one class and
 * optional for another. A binding answers "does THIS class use the property,
 * in what order, required or not, with what default"; a schema answers "what
 * the property is and how it behaves everywhere" (class-bound or not).
 *
 * `active` (PC4, LOCKSTEP-PENDING): the soft-unbind flag — an
 * inactive binding row stops contributing to the effective-properties read
 * (no derived default, no sequence metadata) while AUTHORED property values
 * always survive (the row is kept, never deleted). Omitted = keep the stored
 * flag.
 */
export const classPropertySetPayload = z
  .object({
    classId: uuid,
    propertySchemaId: uuid,
    sequence: z.number().int().optional(),
    required: z.boolean().nullable().optional(),
    defaultValue: z.unknown().optional(),
    active: z.boolean().optional(),
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

/**
 * A select/multi_select option record (PG16, additive 2026-10-04):
 * `{ id, label }` plus an OPTIONAL color — a preset
 * token or a custom `#RRGGBB` hex; absent/null = no color (the token
 * palette renders the pill like any uncolored one). Additive JSON inside
 * the existing options array — no op-shape change.
 *
 * `icon` (additive): an OPTIONAL MDI icon name (camelCase @mdi/js
 * convention, max 64 chars — the same string shape as node/class icons);
 * absent/null = no icon. The option record itself intentionally stays
 * NON-strict: older parsers strip unknown keys instead of rejecting
 * the envelope, so icon-carrying options sync through old clients (their
 * stores drop the icon; wipe → replay restores it).
 */
export const propertySchemaOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  color: colorValueSchema.nullish(),
  icon: z.string().max(64).nullish(),
});

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
      /**
       * M38: an asset reference — a node-typed value ({ nodeId }) whose
       * target MUST carry the asset class; the filter is IMPLICIT in the
       * type (an explicit targetClassFilter is redundant and dropped on
       * retype migrations). The attachments property (…0011) is the first
       * asset-typed schema (retyped from object). See SCHEMA.md
       * "Node-backed text properties".
       */
      "asset",
    ]),
    multi: z.boolean().default(false),
    scope: z.enum(["global", "class", "object"]).default("global"),
    options: z.array(propertySchemaOptionSchema).optional(),
    /** Node-typed (m2o/m2m) schemas constrain their targets to these classes. */
    targetClassFilter: z.array(uuid).optional(),
    /** Date schemas: the finest granularity a value may claim (SCHEMA.md "Dates";
     * default "day" at the read model when absent). */
    datePrecision: z.enum(["year", "month", "day"]).optional(),
    /** Node-typed schemas: values may carry date qualifiers (metadata
     * startDate/endDate — the panel renders a small range control per chip). */
    dateQualified: z.boolean().optional(),
    /**
     * Number schemas: DISPLAY formatting only (SCHEMA.md "Number formats") —
     * values stay exact in the log; these shape how a client renders them.
     * `numberPad`: zero-pad the integer part to N digits ("0001"); absent/null
     * = off. `numberDecimals`: digits after the point (0–10); absent/null =
     * as stored. `numberRounding`: how a decimals cut rounds — "round" (half
     * away from zero, the default when only decimals is set), "floor", "ceil",
     * "truncate"; meaningless without numberDecimals.
     */
    numberPad: z.number().int().min(1).max(20).nullable().optional(),
    numberDecimals: z.number().int().min(0).max(10).nullable().optional(),
    numberRounding: z.enum(["round", "floor", "ceil", "truncate"]).nullable().optional(),
    /**
     * (supersedes the binding-level field — owner correction
     * 2026-10-05: the position is a PROPERTY-level characteristic, like name
     * and options; bindings come and go, schemas are the surface): where a
     * select/multi_select (or boolean) value renders on a block row —
     * "panel" (absent/null) keeps the value in the properties section only;
     * "bullet" renders it as an icon button next to the block bullet;
     * "inline" renders it before the block content (the icon_visibility /
     * Logseq-DB "UI position" port). A render contract only — never read by
     * queries or appliers beyond persistence.
     */
    display: z.enum(["panel", "bullet", "inline"]).nullable().optional(),
    /**
     * (owner review 2026-10-05): the render contracts are PROPERTY-level
     * — a property is readonly/hidden-when-empty everywhere it appears,
     * whatever class binds it (or none). (`required` is the deliberate
     * exception: it stays on the class binding — a property may be mandatory
     * for one class, optional for another.) Keep/clear contract like the
     * number formats: absent keeps, null clears. Clients: readonly
     * dims/disables the editors (never blocks a write — PC1); hideWhenEmpty
     * hides the row unless a value or derived default exists.
     */
    readonly: z.boolean().nullable().optional(),
    hideWhenEmpty: z.boolean().nullable().optional(),
  })
  .strict();

export const propertySchemaUpdatePayload = z
  .object({
    propertySchemaId: uuid,
    name: z.string().min(1).max(256).optional(),
    options: z.array(propertySchemaOptionSchema).optional(),
    /** Patchable so the Class View bindings editor can retune date behavior
     * after creation (same optional-fields contract as name/options). */
    datePrecision: z.enum(["year", "month", "day"]).optional(),
    dateQualified: z.boolean().optional(),
    /** Number display formatting; absent keeps the stored value, null clears
     * it (the same keep-vs-clear contract as class.property.set flags). */
    numberPad: z.number().int().min(1).max(20).nullable().optional(),
    numberDecimals: z.number().int().min(0).max(10).nullable().optional(),
    numberRounding: z.enum(["round", "floor", "ceil", "truncate"]).nullable().optional(),
    /**
     * The value-display position (create-side doc above). Update-side
     * keep/clear contract like the number formats: absent keeps the stored
     * value, null clears back to the "panel" default.
     */
    display: z.enum(["panel", "bullet", "inline"]).nullable().optional(),
    /** The render contracts (create-side doc above) — same
     *  absent-keeps / null-clears contract. */
    readonly: z.boolean().nullable().optional(),
    hideWhenEmpty: z.boolean().nullable().optional(),
  })
  .strict();

export const propertySchemaDeletePayload = z
  .object({ propertySchemaId: uuid })
  .strict();

/**
 * Authored property write (SCHEMA.md "Node-backed text properties" / PG5
 * element identity):
 *
 *  - SINGLE-VALUE slots stay LWW at the element: the slot has exactly one
 *    element whose id is derived deterministically (`node:schema:idx` — the
 *    pre-PG5 id generation, unchanged), so payloads omit `elementId`.
 *  - MULTI-VALUE slots are an OR-Set of elements (PG5, LOCKSTEP-PENDING):
 *    each ADD carries a writer-minted `elementId` (UUIDv7 — identity law), the
 *    property_value row id IS the element id, and removal addresses the
 *    element (property.unset {elementId}). Adds never conflict: concurrent
 *    adds at the same `idx` coexist, ordered by (idx, element id). A remove
 *    tombstones the element (add-wins: a re-issued add whose HLC is not
 *    strictly older than the tombstone revives it). `idx` is a per-element
 *    order hint (writers allocate; gaps never heal — PB4 tolerance stands).
 *  - A payload WITHOUT `elementId` is the legacy positional carrier
 *    (pre-PG5 clients): it addresses the deterministic positional element of
 *    its idx — replayed stored logs and old clients keep applying unchanged.
 *
 * `metadata` carries per-value qualifiers: for dateQualified schemas the
 * reserved keys `startDate`/`endDate` are date-node refs
 * `{ "nodeId": <chain node> }` (PC6 — legacy ISO strings read lenient
 * and normalize to day-node refs on write); any other keys ride as authored.
 */
export const propertySetPayload = z
  .object({
    objectId: uuid,
    propertySchemaId: uuid,
    value: z.unknown(),
    /** PG5 element id — the OR-Set add carrier for multi-value slots. */
    elementId: uuid.optional(),
    idx: z.number().int().nonnegative().default(0),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const propertyUnsetPayload = z
  .object({
    objectId: uuid,
    propertySchemaId: uuid,
    /** PG5 element id — OR-Set remove of that element (add-wins tombstone).
     *  Absent = legacy positional remove of the slot's deterministic
     *  positional element at `idx`. */
    elementId: uuid.optional(),
    idx: z.number().int().nonnegative().default(0),
  })
  .strict();

// --- associations ------------------------------------------------------------
// First-class relation entities were deleted 2026-09-25:
// associations are node-typed property values (m2o/m2m) or typed-link word
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
// nodes — created via object.create with the `collection` class. There
// are deliberately NO collection.create/update/delete ops (that would be a
// parallel write path to the node model). Only membership carries dedicated
// ops; everything else is object.* + class assignments.

export const collectionMemberAddPayload = z
  .object({ collectionId: uuid, objectId: uuid })
  .strict();

export const collectionMemberRemovePayload = z
  .object({ collectionId: uuid, objectId: uuid })
  .strict();

// --- workspace ----------------------------------------------------------------

/**
 * Per-workspace feature toggles (the Features settings tab): the
 * synced semantic state behind each toggle. `feature` is fixed protocol
 * vocabulary (the WORKSPACE_FEATURES set below — feature ids, not UUIDs;
 * these name protocol-level switches, not nodes). The enum IS the core
 * class families (owner directive 2026-10-04): tasks=task,
 * events=event, meetings=meeting, sources=source, persons=person — each a
 * seeded system-class family with built-in product logic; the
 * extends-children ride the base class (disabling events archives meetings
 * and birthdays with it — see @notees/domain features.ts). LWW by envelope
 * HLC on (workspaceId, feature): a later toggle always wins whatever the
 * arrival order. The derived `workspace_feature` table stores the winning
 * row; an ABSENT row means enabled (all features default ON — the
 * empty-table default, F2), so pre-toggle workspaces need no migration.
 * Applying the toggle derives the membership-preserving archival of the
 * family's classes (class registry `active` + the class node's `is_active`
 * flip; `class_member_set` rows are NEVER touched — instances keep their
 * class_ids and stay in the graph; toggle-off is hide-surfaces-keep-data,
 * F3). A `class.delete` addressed at a family's BASE class is ROUTED to
 * the toggle (F4): the delete is applied as a feature-disable instead, so
 * the Features setting is the single archive path for managed classes and
 * the lossy plain delete (membership tombstoning) never runs on them.
 */
export const WORKSPACE_FEATURES = [
  "tasks",
  "events",
  "meetings",
  "sources",
  "persons",
] as const;
export type WorkspaceFeature = (typeof WORKSPACE_FEATURES)[number];
export const workspaceFeatureSchema = z.enum(WORKSPACE_FEATURES);

export const workspaceFeatureSetPayload = z
  .object({
    feature: workspaceFeatureSchema,
    enabled: z.boolean(),
  })
  .strict();

// --- registry ----------------------------------------------------------------

export const OP_PAYLOAD_SCHEMAS = {
  "object.create": objectCreatePayload,
  "object.update": objectUpdatePayload,
  "object.delete": objectDeletePayload,
  "object.restore": objectRestorePayload,
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
  "workspace.feature.set": workspaceFeatureSetPayload,
} as const;

export type OpType = keyof typeof OP_PAYLOAD_SCHEMAS;
export const KNOWN_OP_TYPES = Object.keys(OP_PAYLOAD_SCHEMAS) as OpType[];

export type OpPayload<T extends OpType> = z.infer<(typeof OP_PAYLOAD_SCHEMAS)[T]>;

export function payloadSchemaFor(opType: string): z.ZodTypeAny | undefined {
  return (OP_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[opType];
}
