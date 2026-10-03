/**
 * Object API (single-user M1 surface, /api): nodes, classes, properties,
 * search, backlinks. Every write IS an envelope through the same pipeline as
 * /batch (the server stamps id/HLC/timestamp/actor from the API key) — one
 * write path, per the milestone's hard invariant.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import {
  classCreatePayload,
  classUnassignPayload,
  colorValueSchema,
  objectCreatePayload,
  objectRestorePayload,
  objectUpdatePayload,
  propertySchemaCreatePayload,
  propertySetPayload,
  propertyUnsetPayload,
} from "@notees/protocol";
import { deriveDisplayName, rendersWithDocumentChrome } from "@notees/domain";
import { parseQueryAst, runAggregate, runQuery } from "@notees/query";
import type { NodeRow, Store } from "@notees/store";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";

/**
 * Query-string booleans: only the strings "true"/"false" coerce (a bare
 * z.coerce.boolean() would turn the string "false" into true).
 */
const booleanQueryParam = z
  .union([z.literal("true"), z.literal("false")])
  .transform((value) => value === "true");

const listQuerySchema = z
  .object({
    /** Class identity bit filter (Revision 11 render-state model). */
    isClass: booleanQueryParam.optional(),
    /**
     * Render-bit filter: true selects the document-chrome rows (non-class
     * roots plus main children), false the inline-body blocks (parented,
     * bit unset).
     */
    presentAsMain: booleanQueryParam.optional(),
    class: z.string().uuid().optional(),
    /** Direct-children filter: parent_id equality. */
    parent: z.string().uuid().optional(),
    /** Trash listing: true selects inactive rows (trashed), false/omitted the
     * default active rows. Position-order reads use GET /objects/:id/children;
     * this filter is for scans and bulk audits. */
    trashed: booleanQueryParam.optional(),
    q: z.string().max(512).optional(),
    /**
     * Property filter `?property=<schemaId>:<value>` — exact match on the
     * JSON-encoded scalar stored in property_value (a string value matches
     * its JSON form, e.g. kuhn1962 ↔ "kuhn1962"). The value part is
     * everything after the FIRST colon (URLs contain colons).
     */
    property: z
      .string()
      .regex(/^[^:]+:.*$/s)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().optional(),
  })
  .strict();

const propertyWriteBodySchema = z
  .object({
    propertySchemaId: z.string().uuid(),
    value: z.unknown(),
    idx: z.number().int().nonnegative().default(0),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const propertyDeleteQuerySchema = z
  .object({
    idx: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();

const createBodySchema = z
  .object({
    /**
     * Revision 11 render state. `isClass: true` declares a class node — the
     * write becomes a class.create envelope (classes are always roots, so
     * parentId / classIds / presentAsMain must not accompany it). Otherwise
     * the write is object.create and `presentAsMain` sets the render bit
     * (applier default: true when parentless, false when parented).
     */
    isClass: z.boolean().optional(),
    presentAsMain: z.boolean().optional(),
    /** Title-is-content: becomes the node's initial text content. */
    name: z.string().max(1024).optional(),
    contentAst: z.array(z.unknown()).optional(),
    classIds: z.array(z.string().uuid()).default([]),
    parentId: z.string().uuid().nullable().optional(),
    /** Caller-chosen id (deterministic content-addressed ids — the date
     * chain roots; the op payload has always accepted one). Defaults to a
     * fresh UUIDv7. A taken id fails loud with 409. */
    id: z.string().uuid().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    /** Render-bit toggle: promotion/demotion between the parent's
     * main-children zone and the inline body. */
    presentAsMain: z.boolean().optional(),
    icon: z.string().max(64).optional(),
    /** Preset token or #RRGGBB hex; null clears (SCHEMA.md color grammar). */
    color: colorValueSchema.nullish(),
    contentAst: z.array(z.unknown()).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "at least one field to update" });

const searchQuerySchema = z
  .object({
    q: z.string().min(1).max(512),
    isClass: booleanQueryParam.optional(),
    presentAsMain: booleanQueryParam.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .strict();

const deleteQuerySchema = z
  .object({
    permanent: z.coerce.boolean().default(false),
    confirm: z.string().optional(),
  })
  .strict();

const queryBodySchema = z
  .object({
    /** The versioned QueryAST (validated fail-loud by parseQueryAst). */
    ast: z.unknown(),
  })
  .strict();

function workspaceFor(ctx: ServerContext, request: FastifyRequest): string {
  const header = request.headers["x-workspace-id"];
  if (typeof header === "string" && z.string().uuid().safeParse(header).success) {
    return header;
  }
  return ctx.defaultWorkspace;
}

interface ApiObject {
  id: string;
  workspaceId: string;
  /** Class identity bit (Revision 11): true = class node (always a root). */
  isClass: boolean;
  /** Render bit for parented non-class nodes: true = the parent's
   * main-children zone + document chrome when zoomed; false = inline body +
   * block chrome. Unread for parentless nodes and classes. */
  presentAsMain: boolean;
  parentId: string | null;
  classIds: string[];
  name: string | null;
  icon: string | null;
  color: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  hlc: { physical: number; logical: number };
}

function nodeToApi(row: NodeRow): ApiObject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isClass: row.is_class === 1,
    presentAsMain: row.present_as_main === 1,
    parentId: row.parent_id,
    classIds: JSON.parse(row.class_ids) as string[],
    // Title-is-content: the API name derives from the node's content (the
    // retired name column is always null).
    name:
      deriveDisplayName({
        id: row.id,
        isClass: row.is_class,
        presentAsMain: row.present_as_main,
        contentAst: JSON.parse(row.content) as NonNullable<Parameters<typeof deriveDisplayName>[0]["contentAst"]>,
        classIds: JSON.parse(row.class_ids) as string[],
      }) || null,
    icon: row.icon,
    color: row.color,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    hlc: { physical: row.hlc_physical, logical: row.hlc_logical },
  };
}

function requireNode(store: Store, id: string): NodeRow {
  const row = store.getNode(id);
  if (row === undefined) {
    throw new AppError(404, "not_found", `object ${id} does not exist`);
  }
  return row;
}

function requireClass(store: Store, id: string): void {
  const row = store.database.prepare("SELECT 1 FROM class WHERE id = ? AND active = 1").get(id);
  if (row === undefined) {
    throw new AppError(404, "not_found", `class ${id} does not exist`);
  }
}

/**
 * Class title read model (title-is-content): the display name derives from
 * the class NODE's content — the node is the authority. The registry `name`
 * is a write-side denormalized cache (applyClassCreate/applyClassUpdate
 * maintain it) that pre-title-is-content rows never backfilled, so reads
 * treat it as a fallback only, never the source of truth.
 */
function classNameFromNode(nodeContent: string | null, nodeClassIds: string | null, cachedName: string): string {
  if (nodeContent !== null) {
    const derived = deriveDisplayName({
      id: "",
      isClass: 1,
      presentAsMain: 0,
      contentAst: JSON.parse(nodeContent) as NonNullable<Parameters<typeof deriveDisplayName>[0]["contentAst"]>,
      classIds: JSON.parse(nodeClassIds ?? "[]") as string[],
    });
    if (derived) return derived;
  }
  return cachedName;
}

/**
 * The full object projection behind GET /objects/:id (and the children
 * read): base row + resolved classes + authored property rows. The
 * workspace-zip export (routes-auth) builds its ExportNodes from this so
 * exported frontmatter carries properties.
 */
export function fullObject(store: Store, row: NodeRow) {
  const base = nodeToApi(row);
  const classes = base.classIds
    .map((classId) => {
      const classRow = store.database
        .prepare(
          `SELECT c.id, c.name, c.icon, c.color, n.content AS nodeContent, n.class_ids AS nodeClassIds
           FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
           WHERE c.id = ? AND c.active = 1`,
        )
        .get(classId) as
        | { id: string; name: string; icon: string | null; color: string | null; nodeContent: string | null; nodeClassIds: string | null }
        | undefined;
      if (classRow === undefined) return null;
      return { id: classRow.id, name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name), icon: classRow.icon, color: classRow.color };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const properties = (
    store.database
      .prepare(
        `SELECT ps.id AS schemaId, ps.name AS schemaName, ps.type AS schemaType,
                pv.idx, pv.value, pv.metadata
         FROM property_value pv
         JOIN property_schema ps ON ps.id = pv.property_schema_id
         WHERE pv.node_id = ? ORDER BY ps.name, pv.idx`,
      )
      .all(row.id) as { schemaId: string; schemaName: string; schemaType: string; idx: number; value: string; metadata: string | null }[]
  ).map((property) => ({
    schemaId: property.schemaId,
    schemaName: property.schemaName,
    schemaType: property.schemaType,
    idx: property.idx,
    value: JSON.parse(property.value) as unknown,
    ...(property.metadata !== null ? { metadata: JSON.parse(property.metadata) as unknown } : {}),
  }));
  const contentAst = JSON.parse(row.content) as unknown;
  return { ...base, contentAst, classes, properties };
}

export function registerObjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/objects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = requireNode(store, id);
    return { object: fullObject(store, row) };
  });

  /**
   * Direct children in child-order position order, active rows only. The
   * full projection matches GET /objects/:id (contentAst included) — the
   * export nested-bullets read, replacing the paged-list scan.
   */
  app.get("/objects/:id/children", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    const children = store
      .children(id)
      .filter((row) => row.is_active === 1)
      .map((row) => fullObject(store, row));
    return { children };
  });

  app.get("/objects", async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid list query");
    }
    const { isClass, presentAsMain, class: classId, parent, trashed, q, limit, cursor } = parsed.data;
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);

    const clauses = [trashed === true ? "n.is_active = 0" : "n.is_active = 1", "n.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (parent !== undefined) {
      clauses.push("n.parent_id = ?");
      params.push(parent);
    }
    if (isClass !== undefined) {
      clauses.push("n.is_class = ?");
      params.push(isClass ? 1 : 0);
    }
    if (presentAsMain !== undefined) {
      // The pages-ish listing is the document-chrome predicate (non-class
      // roots render as documents regardless of the bit); its negation is
      // the inline body (parented rows with the bit unset).
      clauses.push(
        presentAsMain
          ? "n.is_class = 0 AND (n.parent_id IS NULL OR n.present_as_main = 1)"
          : "n.is_class = 0 AND n.parent_id IS NOT NULL AND n.present_as_main = 0",
      );
    }
    if (classId !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM class_member_set cm WHERE cm.node_id = n.id AND cm.class_id = ? AND cm.present = 1)",
      );
      params.push(classId);
    }
    if (parsed.data.property !== undefined) {
      const colon = parsed.data.property.indexOf(":");
      const schemaId = parsed.data.property.slice(0, colon);
      const rawValue = parsed.data.property.slice(colon + 1);
      if (!z.string().uuid().safeParse(schemaId).success) {
        throw new AppError(422, "validation_failed", "property filter schema id must be a UUID");
      }
      clauses.push(
        "EXISTS (SELECT 1 FROM property_value pv WHERE pv.node_id = n.id AND pv.property_schema_id = ? AND pv.value = ?)",
      );
      params.push(schemaId, JSON.stringify(rawValue));
    }
    if (q !== undefined) {
      const hits = store.search(q, 10_000);
      if (hits.length === 0) return { objects: [], nextCursor: null };
      clauses.push(`n.id IN (${hits.map(() => "?").join(",")})`);
      params.push(...hits.map((hit) => hit.nodeId));
    }
    if (cursor !== undefined && cursor.length > 0) {
      clauses.push("n.id > ?");
      params.push(cursor);
    }
    const rows = store.database
      .prepare(`SELECT n.* FROM node n WHERE ${clauses.join(" AND ")} ORDER BY n.id ASC LIMIT ?`)
      .all(...params, limit + 1) as unknown as NodeRow[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { objects: page.map((row) => nodeToApi(row)), nextCursor };
  });

  app.post("/objects", async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid create body");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const objectId = parsed.data.id ?? uuidv7();
    // Title-is-content: `name` becomes the node's initial text content (a
    // single text token) when no explicit contentAst is given.
    const initialText =
      parsed.data.name !== undefined && parsed.data.contentAst === undefined
        ? [{ type: "text", text: parsed.data.name }]
        : undefined;
    if (parsed.data.isClass === true) {
      // Class declaration stays the class.create op (Revision 11): classes
      // are always roots and take no classIds / parent / render bit.
      if (
        parsed.data.parentId !== undefined ||
        parsed.data.classIds.length > 0 ||
        parsed.data.presentAsMain !== undefined
      ) {
        throw new AppError(
          422,
          "validation_failed",
          "isClass cannot combine with parentId, classIds, or presentAsMain (classes are roots)",
        );
      }
      const payload = {
        classId: objectId,
        ...(initialText !== undefined ? { contentAst: initialText } : {}),
        ...(parsed.data.contentAst !== undefined ? { contentAst: parsed.data.contentAst } : {}),
      };
      const checked = classCreatePayload.safeParse(payload);
      if (!checked.success) {
        throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid class.create payload");
      }
      const { outcome } = await ctx.submit({
        workspaceId,
        opType: "class.create",
        payload: checked.data as Record<string, unknown>,
        affectedNodeIds: [objectId],
        client: "api",
      });
      if (outcome.savedIds.length === 0) {
        throw new AppError(409, "conflict", `object ${objectId} already exists`);
      }
      const store = ctx.workspaces.storeFor(workspaceId);
      const row = requireNode(store, objectId);
      reply.code(201);
      return { id: objectId, object: fullObject(store, row) };
    }
    const payload = {
      objectId,
      ...(parsed.data.presentAsMain !== undefined ? { presentAsMain: parsed.data.presentAsMain } : {}),
      ...(initialText !== undefined ? { contentAst: initialText } : {}),
      ...(parsed.data.contentAst !== undefined ? { contentAst: parsed.data.contentAst } : {}),
      classIds: parsed.data.classIds,
      ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
    };
    const checked = objectCreatePayload.safeParse(payload);
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid object.create payload");
    }
    const { outcome } = await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [objectId],
      client: "api",
    });
    if (outcome.savedIds.length === 0) {
      throw new AppError(409, "conflict", `object ${objectId} already exists`);
    }
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = requireNode(store, objectId);
    reply.code(201);
    return { id: objectId, object: fullObject(store, row) };
  });

  app.patch("/objects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid update body");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    const body = parsed.data as Record<string, unknown>;
    const payload = { objectId: id, ...body };
    const checked = objectUpdatePayload.safeParse(payload);
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid object.update payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "object.update",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    const row = requireNode(store, id);
    return { object: fullObject(store, row) };
  });

  /**
   * Class membership assign: the add rides the re-issued `object.create`
   * carrier (the OR-Set add-wins seed — applyObjectCreate's alreadyExists
   * branch upserts class_member_set without touching the tree). Idempotent
   * by construction; the effective-values read model derives the class's
   * bound defaults automatically. Class identity itself is never membership:
   * the is_class bit rejects class nodes here (fail loud).
   */
  app.put("/objects/:id/classes/:classId", async (request) => {
    const { id, classId } = request.params as { id: string; classId: string };
    const checked = objectCreatePayload.safeParse({ objectId: id, classIds: [classId] });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid assign payload");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = requireNode(store, id);
    if (row.is_class === 1) {
      throw new AppError(422, "validation_failed", "a class node is not a class member (identity is the is_class bit)");
    }
    requireClass(store, classId);
    await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    return { object: fullObject(store, requireNode(store, id)) };
  });

  /**
   * Class membership remove: the OR-Set tombstone (class.unassign). Removing
   * a membership the node does not have is a no-op tombstone — idempotent,
   * so scripts can "ensure absent". Authored property values survive; the
   * class's derived defaults drop from the effective read automatically.
   */
  app.delete("/objects/:id/classes/:classId", async (request) => {
    const { id, classId } = request.params as { id: string; classId: string };
    const checked = classUnassignPayload.safeParse({ objectId: id, classId });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid unassign payload");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    requireClass(store, classId);
    await ctx.submit({
      workspaceId,
      opType: "class.unassign",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    return { object: fullObject(store, requireNode(store, id)) };
  });

  app.post("/objects/:id/properties", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = propertyWriteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid property body");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    const payload = { objectId: id, ...parsed.data };
    const checked = propertySetPayload.safeParse(payload);
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid property.set payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "property.set",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    reply.code(200);
    return { object: fullObject(store, requireNode(store, id)) };
  });

  app.delete("/objects/:id/properties/:propertySchemaId", async (request) => {
    const { id, propertySchemaId } = request.params as { id: string; propertySchemaId: string };
    const parsed = propertyDeleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid property delete query");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    const payload = { objectId: id, propertySchemaId, idx: parsed.data.idx };
    const checked = propertyUnsetPayload.safeParse(payload);
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid property.unset payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "property.unset",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    return { object: fullObject(store, requireNode(store, id)) };
  });

  app.get("/property-schemas", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const rows = store.database
      .prepare(
        `SELECT id, name, type, multi, scope, options, target_class_filter AS targetClassFilter
         FROM property_schema WHERE active = 1 ORDER BY name, id`,
      )
      .all() as Array<{ id: string; name: string; type: string; multi: number; scope: string; options: string; targetClassFilter: string | null }>;
    return {
      propertySchemas: rows.map((row) => ({
        ...row,
        multi: row.multi === 1,
        options: JSON.parse(row.options) as unknown,
        targetClassFilter:
          row.targetClassFilter !== null ? (JSON.parse(row.targetClassFilter) as unknown) : null,
      })),
    };
  });

  app.get("/property-schemas/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = store.database
      .prepare(
        `SELECT id, name, type, multi, scope, options, target_class_filter AS targetClassFilter
         FROM property_schema WHERE id = ? AND active = 1`,
      )
      .get(id) as
      | { id: string; name: string; type: string; multi: number; scope: string; options: string; targetClassFilter: string | null }
      | undefined;
    if (row === undefined) {
      throw new AppError(404, "not_found", `property schema ${id} does not exist`);
    }
    return {
      propertySchema: {
        ...row,
        multi: row.multi === 1,
        options: JSON.parse(row.options) as unknown,
        targetClassFilter: row.targetClassFilter !== null ? (JSON.parse(row.targetClassFilter) as unknown) : null,
      },
    };
  });

  app.post("/property-schemas", async (request, reply) => {
    const parsed = propertySchemaCreatePayload.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid propertySchema.create payload");
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    await ctx.submit({
      workspaceId,
      opType: "propertySchema.create",
      payload: parsed.data as Record<string, unknown>,
      client: "api",
    });
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = store.database
      .prepare(
        `SELECT id, name, type, multi, scope, options, target_class_filter AS targetClassFilter
         FROM property_schema WHERE id = ? AND active = 1`,
      )
      .get(parsed.data.propertySchemaId) as
      | { id: string; name: string; type: string; multi: number; scope: string; options: string; targetClassFilter: string | null }
      | undefined;
    if (row === undefined) {
      throw new AppError(404, "not_found", `property schema ${parsed.data.propertySchemaId} does not exist`);
    }
    reply.code(201);
    return {
      propertySchema: {
        ...row,
        multi: row.multi === 1,
        options: JSON.parse(row.options) as unknown,
        targetClassFilter: row.targetClassFilter !== null ? (JSON.parse(row.targetClassFilter) as unknown) : null,
      },
    };
  });

  app.delete("/objects/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = deleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid delete query");
    }
    const { permanent, confirm } = parsed.data;
    if (permanent && confirm !== id) {
      throw new AppError(400, "validation_failed", `permanent delete requires ?confirm=${id}`);
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    await ctx.submit({
      workspaceId,
      opType: "object.delete",
      payload: { objectId: id, permanent },
      affectedNodeIds: [id],
      client: "api",
    });
    return { id, deleted: true, permanent };
  });

  /**
   * Restore from the trash (the object.restore op — whole-tree, convergent
   * LWW against delete by log order). Permanently deleted nodes are gone:
   * the applier's not_found surfaces as the route's 404.
   */
  app.post("/objects/:id/restore", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    requireNode(store, id);
    const checked = objectRestorePayload.safeParse({ objectId: id });
    if (!checked.success) {
      throw new AppError(422, "validation_failed", checked.error.issues[0]?.message ?? "invalid object.restore payload");
    }
    await ctx.submit({
      workspaceId,
      opType: "object.restore",
      payload: checked.data as Record<string, unknown>,
      affectedNodeIds: [id],
      client: "api",
    });
    return { object: fullObject(store, requireNode(store, id)) };
  });

  app.get("/objects/:id/backlinks", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    return { nodeId: id, backlinks: store.backlinks(id) };
  });

  // Effective properties: authored rows ∪ derived class-binding defaults
  // (source: "authored" | "default", boundBy). The authored-only view lives
  // on GET /objects/:id — this is the read model per SCHEMA.md.
  app.get("/objects/:id/effective-properties", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const properties = store.getEffectiveProperties(id).map((row) => ({
      schemaId: row.propertySchemaId,
      schemaName: row.schema?.name ?? null,
      schemaType: row.schema?.type ?? null,
      idx: row.idx,
      value: row.value,
      metadata: row.metadata,
      source: row.source,
      boundBy: row.boundBy,
      required: row.required,
      readonly: row.readonly,
      hideWhenEmpty: row.hideWhenEmpty,
      sequence: row.sequence,
    }));
    return { nodeId: id, properties };
  });

  app.get("/search", async (request) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid search query");
    }
    const { q, isClass, presentAsMain, limit } = parsed.data;
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const hits = store.search(q, limit);
    const results = hits
      .map((hit) => store.getNode(hit.nodeId))
      .filter((row): row is NodeRow => row !== undefined && row.is_active === 1)
      .filter((row) => isClass === undefined || (row.is_class === 1) === isClass)
      .filter(
        (row) =>
          presentAsMain === undefined ||
          rendersWithDocumentChrome({
            isClass: row.is_class,
            parentId: row.parent_id,
            presentAsMain: row.present_as_main,
          }) === presentAsMain,
      )
      .map((row) => {
        const api = nodeToApi(row);
        return {
          id: api.id,
          isClass: api.isClass,
          presentAsMain: api.presentAsMain,
          name: api.name,
          parentId: api.parentId,
          updatedAt: api.updatedAt,
        };
      });
    return { results };
  });

  /**
   * QueryAST execution endpoint: the caller compiles its text DSL (or builds
   * an AST directly) client-side and posts it; the server runs it against the
   * workspace's derived store with @notees/query. Plain ASTs return the
   * deterministic ids plus node summaries; ASTs carrying an `aggregation`
   * return the grouped grid (columns + rows). Unparseable ASTs and
   * unsupported compilations are 422s (fail loud, never half-executed).
   */
  app.post("/query", async (request) => {
    const parsed = queryBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid query body");
    }
    let ast;
    try {
      ast = parseQueryAst(parsed.data.ast);
    } catch (error) {
      throw new AppError(
        422,
        "validation_failed",
        `invalid query AST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    try {
      if (ast.aggregation !== undefined) {
        return runAggregate(store, ast);
      }
      const { ids, rows } = runQuery(store, ast);
      return {
        ids,
        rows: rows.map((row) => {
          // Title-is-content: the row name derives from the node's content.
          const derived =
            deriveDisplayName({
              id: String(row.id),
              isClass: row.is_class as number,
              presentAsMain: row.present_as_main as number,
              contentAst: JSON.parse((row.content as string | null) ?? "[]") as NonNullable<Parameters<typeof deriveDisplayName>[0]["contentAst"]>,
              classIds: JSON.parse((row.class_ids as string | null) ?? "[]") as string[],
            }) || null;
          const summary: Record<string, unknown> = {
            id: String(row.id),
            isClass: (row.is_class as number) === 1,
            presentAsMain: (row.present_as_main as number) === 1,
            name: derived,
            parentId: (row.parent_id as string | null) ?? null,
            createdAt: (row.created_at as string | null) ?? null,
            updatedAt: (row.updated_at as string | null) ?? null,
          };
          if (row.distance !== undefined) summary.distance = row.distance;
          return summary;
        }),
      };
    } catch (error) {
      throw new AppError(
        422,
        "validation_failed",
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  app.get("/classes", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classes = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds,
                (SELECT COUNT(*) FROM class_member_set m WHERE m.class_id = c.id AND m.present = 1) AS memberCount
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.active = 1`,
      )
      .all() as { id: string; name: string; icon: string | null; color: string | null; description: string | null; nodeContent: string | null; nodeClassIds: string | null; parentClassIds: string | null; memberCount: number }[];
    const listed = classes.map((row) => ({
      id: row.id,
      name: classNameFromNode(row.nodeContent, row.nodeClassIds, row.name),
      icon: row.icon,
      color: row.color,
      description: row.description,
      parentClassIds: JSON.parse(row.parentClassIds ?? "[]") as string[],
      memberCount: row.memberCount,
    }));
    // Title-is-content: ordering keys on the DERIVED title (the registry
    // cache is a fallback, not the authority).
    listed.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
    return { classes: listed };
  });

  app.get("/classes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classRow = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                n.content AS nodeContent, n.class_ids AS nodeClassIds,
                (SELECT json_group_array(parent_class_id) FROM (
                   SELECT parent_class_id FROM class_extends e
                   WHERE e.class_id = c.id ORDER BY parent_class_id)) AS parentClassIds
         FROM class c LEFT JOIN node n ON n.id = c.id AND n.is_active = 1
         WHERE c.id = ? AND c.active = 1`,
      )
      .get(id) as
      | { id: string; name: string; icon: string | null; color: string | null; description: string | null; nodeContent: string | null; nodeClassIds: string | null; parentClassIds: string | null }
      | undefined;
    if (classRow === undefined) {
      throw new AppError(404, "not_found", `class ${id} does not exist`);
    }
    const members = (
      store.database
        .prepare(
          `SELECT n.id, n.is_class AS isClass, n.present_as_main AS presentAsMain, n.content, n.class_ids
           FROM class_member_set m JOIN node n ON n.id = m.node_id
           WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1 ORDER BY n.id`,
        )
        .all(id) as Array<{ id: string; isClass: number; presentAsMain: number; content: string; class_ids: string }>
    ).map((row) => ({
      id: row.id,
      name: deriveDisplayName({
        id: row.id,
        isClass: row.isClass,
        presentAsMain: row.presentAsMain,
        contentAst: JSON.parse(row.content) as NonNullable<Parameters<typeof deriveDisplayName>[0]["contentAst"]>,
        classIds: JSON.parse(row.class_ids) as string[],
      }) || null,
      isClass: row.isClass === 1,
      presentAsMain: row.presentAsMain === 1,
    }));
    return {
      class: {
        id: classRow.id,
        name: classNameFromNode(classRow.nodeContent, classRow.nodeClassIds, classRow.name),
        icon: classRow.icon,
        color: classRow.color,
        description: classRow.description,
        parentClassIds: JSON.parse(classRow.parentClassIds ?? "[]") as string[],
      },
      members,
    };
  });

  app.get("/properties/:id/values", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const values = (
      store.database
        .prepare(
          `SELECT pv.node_id AS objectId, n.name AS objectName, pv.idx, pv.value
           FROM property_value pv JOIN node n ON n.id = pv.node_id
           WHERE pv.property_schema_id = ? ORDER BY pv.node_id, pv.idx`,
        )
        .all(id) as { objectId: string; objectName: string | null; idx: number; value: string }[]
    ).map((row) => ({
      objectId: row.objectId,
      objectName: row.objectName,
      idx: row.idx,
      value: JSON.parse(row.value) as unknown,
    }));
    return { propertySchemaId: id, values };
  });
}
