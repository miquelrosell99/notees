/**
 * Human-facing op catalog — the discovery layer over `OP_PAYLOAD_SCHEMAS`.
 * Each entry carries a one-line description and an example payload, mirroring
 * the doc comments in op-types.ts (that file stays the normative wire spec;
 * this file is its ergonomic index). Maintained per the owner doc rule: a new
 * op type lands here in the same pass as op-types.ts.
 */

export interface OpCatalogEntry {
  opType: string;
  /** One line — what the op does, in migration-script vocabulary. */
  description: string;
  /** Copy-adaptable payload (ids are placeholders). */
  example: Record<string, unknown>;
  /** Default affectedNodeIds when the caller passes none. */
  affected: "objectId" | "classId" | "none";
}

export const OP_CATALOG: OpCatalogEntry[] = [
  {
    opType: "object.create",
    description:
      "Create a node — or, re-issued on an EXISTING id, seed class/tag OR-Set membership without touching the tree (the add-wins carrier).",
    example: { objectId: "<uuid>", presentAsMain: true, classIds: ["<class-uuid>"], contentAst: [{ type: "text", text: "Title" }] },
    affected: "objectId",
  },
  {
    opType: "object.update",
    description: "LWW field writes: render bit (promote/demote), icon, color, content (contentAst readable carrier or contentDeltaB64 wire carrier — exactly one per update).",
    example: { objectId: "<uuid>", contentAst: [{ type: "text", text: "New title" }] },
    affected: "objectId",
  },
  {
    opType: "object.delete",
    description: "Soft-delete (trash, subtree rides along); permanent: true hard-deletes.",
    example: { objectId: "<uuid>", permanent: false },
    affected: "objectId",
  },
  {
    opType: "object.move",
    description: "Reparent + fractional sibling order (afterId/beforeId anchors; null parent = workspace root).",
    example: { objectId: "<uuid>", parentId: "<parent-uuid>", afterId: "<sibling-uuid>" },
    affected: "objectId",
  },
  {
    opType: "class.create",
    description: "Declare a class node (always a root); title rides contentAst (title-is-content — there is no name field).",
    example: { classId: "<uuid>", contentAst: [{ type: "text", text: "Genre" }] },
    affected: "classId",
  },
  {
    opType: "class.update",
    description: "Class title/icon/color/description (partial patch semantics, null clears).",
    example: { classId: "<uuid>", contentAst: [{ type: "text", text: "Renamed" }] },
    affected: "classId",
  },
  {
    opType: "class.delete",
    description: "Deactivate a class and its node; membership pairs tombstone and nodes' class_ids recompute.",
    example: { classId: "<uuid>" },
    affected: "classId",
  },
  {
    opType: "class.unassign",
    description: "OR-Set remove for class membership (idempotent tombstone; authored property values survive).",
    example: { objectId: "<uuid>", classId: "<class-uuid>" },
    affected: "objectId",
  },
  {
    opType: "class.reorder",
    description: "Display order of an object's classes (LWW array; unlisted members sort by id after).",
    example: { objectId: "<uuid>", classIds: ["<class-uuid>", "<class-uuid>"] },
    affected: "objectId",
  },
  {
    opType: "tag.unassign",
    description: "OR-Set remove for tag membership (mirrors the class pair with the strictly-greater add tiebreak).",
    example: { objectId: "<uuid>", tagId: "<class-node-uuid>" },
    affected: "objectId",
  },
  {
    opType: "class.setExtends",
    description: "Replace a class's full parent set (m2m; cycles fail loud; the closure is applier-maintained).",
    example: { classId: "<uuid>", parentClassIds: ["<parent-class-uuid>"] },
    affected: "classId",
  },
  {
    opType: "class.property.set",
    description: "Upsert a class→property-schema binding (sequence, flags, defaultValue; omitted fields keep, null clears).",
    example: { classId: "<uuid>", propertySchemaId: "<schema-uuid>", sequence: 1 },
    affected: "classId",
  },
  {
    opType: "class.property.unset",
    description: "Delete a class→schema binding row (authored values on nodes survive).",
    example: { classId: "<uuid>", propertySchemaId: "<schema-uuid>" },
    affected: "classId",
  },
  {
    opType: "propertySchema.create",
    description: "Register a property schema (fixed id, type/multi/scope/options/targetClassFilter).",
    example: { propertySchemaId: "<uuid>", name: "rating", type: "number", scope: "class" },
    affected: "none",
  },
  {
    opType: "propertySchema.update",
    description: "Patch a schema's registry fields (name/type/flags — partial, null clears).",
    example: { propertySchemaId: "<uuid>", name: "score" },
    affected: "none",
  },
  {
    opType: "propertySchema.delete",
    description: "Deactivate a property schema.",
    example: { propertySchemaId: "<uuid>" },
    affected: "none",
  },
  {
    opType: "property.set",
    description: "Write an authored property value at an idx (object-typed values are {nodeId} refs).",
    example: { objectId: "<uuid>", propertySchemaId: "<schema-uuid>", value: "…", idx: 0 },
    affected: "objectId",
  },
  {
    opType: "property.unset",
    description: "Remove an authored property value at an idx.",
    example: { objectId: "<uuid>", propertySchemaId: "<schema-uuid>", idx: 0 },
    affected: "objectId",
  },
  {
    opType: "asset.attach",
    description: "Attach a CAS asset to a node (inline embed vs attachment rides metadata).",
    example: { objectId: "<uuid>", assetId: "<asset-uuid>" },
    affected: "objectId",
  },
  {
    opType: "asset.detach",
    description: "Detach an asset from a node (the CAS blob survives until GC).",
    example: { objectId: "<uuid>", assetId: "<asset-uuid>" },
    affected: "objectId",
  },
  {
    opType: "collection.member.add",
    description: "Add a member to a collection node.",
    example: { collectionId: "<uuid>", memberId: "<uuid>" },
    affected: "none",
  },
  {
    opType: "collection.member.remove",
    description: "Remove a collection member.",
    example: { collectionId: "<uuid>", memberId: "<uuid>" },
    affected: "none",
  },
];

const BY_TYPE = new Map(OP_CATALOG.map((entry) => [entry.opType, entry]));

/** One catalog entry, or null for an op type with no catalog row (fail soft for discovery UIs). */
export function describeOp(opType: string): OpCatalogEntry | null {
  return BY_TYPE.get(opType) ?? null;
}
