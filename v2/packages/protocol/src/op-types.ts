/**
 * Operation type registry v2 (M1 subset).
 *
 * Relation-first by design (assessment §34.4). Per RELATIONS.md, M1 implements
 * relation identity/create/delete/tombstone/LWW-properties only — payloads
 * MUST NOT carry `position` (dimension 6 is M2; appliers ignore it if present).
 *
 * `relationSchema.create/update/delete` ops are deliberately absent: schema
 * CRUD is M2 (RELATIONS.md §7). User-defined schemas never collide with the
 * fixed seed UUID block (seeds.ts).
 */

import { z } from "zod";

const uuid = z.string().uuid();

// --- objects -----------------------------------------------------------------

export const objectCreatePayload = z
  .object({
    objectId: uuid,
    kind: z.enum(["page", "block"]),
    classIds: z.array(uuid).default([]),
    name: z.string().max(1024).optional(),
    content: z.string().optional(),
    parentId: uuid.nullable().optional(),
  })
  .strict();

export const objectUpdatePayload = z
  .object({
    objectId: uuid,
    name: z.string().max(1024).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    /** Canonical content carrier: base64 incremental CRDT delta. */
    contentDeltaB64: z.string().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 1, { message: "object.update requires at least one field" });

export const objectDeletePayload = z
  .object({
    objectId: uuid,
    permanent: z.boolean().default(false),
  })
  .strict();

// --- classes & properties ----------------------------------------------------

export const classCreatePayload = z
  .object({
    classId: uuid,
    name: z.string().min(1).max(256),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    description: z.string().max(4096).optional(),
  })
  .strict();

export const classUpdatePayload = z
  .object({
    classId: uuid,
    name: z.string().min(1).max(256).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    description: z.string().max(4096).optional(),
  })
  .strict();

export const classDeletePayload = z.object({ classId: uuid }).strict();

export const classSetExtendsPayload = z
  .object({
    classId: uuid,
    parentClassId: uuid.nullable(),
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
  })
  .strict();

export const propertySchemaUpdatePayload = z
  .object({
    propertySchemaId: uuid,
    name: z.string().min(1).max(256).optional(),
    options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
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
  })
  .strict();

export const propertyUnsetPayload = z
  .object({
    objectId: uuid,
    propertySchemaId: uuid,
    idx: z.number().int().nonnegative().default(0),
  })
  .strict();

// --- relations (RELATIONS.md dimensions 1–5; M1 subset) ----------------------

export const relationCreatePayload = z
  .object({
    relationId: uuid,
    sourceId: uuid,
    relationSchemaId: uuid,
    targetId: uuid,
    /** Opaque JSON; per-key LWW by HLC (dimension 5). */
    properties: z.record(z.unknown()).default({}),
  })
  .strict();

export const relationUpdatePayload = z
  .object({
    relationId: uuid,
    /** Partial update, per-key LWW (dimension 5). */
    properties: z.record(z.unknown()),
  })
  .strict();

export const relationDeletePayload = z
  .object({ relationId: uuid })
  .strict();

// --- assets ------------------------------------------------------------------

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

export const collectionCreatePayload = z
  .object({
    collectionId: uuid,
    name: z.string().min(1).max(256),
    queryAst: z.unknown().optional(),
  })
  .strict();

export const collectionUpdatePayload = z
  .object({
    collectionId: uuid,
    name: z.string().min(1).max(256).optional(),
    queryAst: z.unknown().optional(),
  })
  .strict();

export const collectionDeletePayload = z.object({ collectionId: uuid }).strict();

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
  "class.create": classCreatePayload,
  "class.update": classUpdatePayload,
  "class.delete": classDeletePayload,
  "class.setExtends": classSetExtendsPayload,
  "propertySchema.create": propertySchemaCreatePayload,
  "propertySchema.update": propertySchemaUpdatePayload,
  "propertySchema.delete": propertySchemaDeletePayload,
  "property.set": propertySetPayload,
  "property.unset": propertyUnsetPayload,
  "relation.create": relationCreatePayload,
  "relation.update": relationUpdatePayload,
  "relation.delete": relationDeletePayload,
  "asset.attach": assetAttachPayload,
  "asset.detach": assetDetachPayload,
  "collection.create": collectionCreatePayload,
  "collection.update": collectionUpdatePayload,
  "collection.delete": collectionDeletePayload,
  "collection.member.add": collectionMemberAddPayload,
  "collection.member.remove": collectionMemberRemovePayload,
} as const;

export type OpType = keyof typeof OP_PAYLOAD_SCHEMAS;
export const KNOWN_OP_TYPES = Object.keys(OP_PAYLOAD_SCHEMAS) as OpType[];

export type OpPayload<T extends OpType> = z.infer<(typeof OP_PAYLOAD_SCHEMAS)[T]>;

export function payloadSchemaFor(opType: string): z.ZodTypeAny | undefined {
  return (OP_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[opType];
}
