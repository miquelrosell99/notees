/**
 * Object API (single-user M1 surface, /api/v1): nodes, classes, properties,
 * search, backlinks. Every write IS an envelope through the same pipeline as
 * /batch (the server stamps id/HLC/timestamp/actor from the API key) — one
 * write path, per the milestone's hard invariant.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import { objectCreatePayload, objectUpdatePayload } from "@notees/protocol";
import type { NodeRow, Store } from "@notees/store";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { requireApiKey } from "./routes-relay.js";

const listQuerySchema = z
  .object({
    nodeType: z.enum(["page", "block", "class"]).optional(),
    class: z.string().uuid().optional(),
    q: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().optional(),
  })
  .strict();

const createBodySchema = z
  .object({
    nodeType: z.enum(["page", "block", "class"]).optional(),
    name: z.string().max(1024).optional(),
    contentAst: z.array(z.unknown()).optional(),
    classIds: z.array(z.string().uuid()).default([]),
    parentId: z.string().uuid().nullable().optional(),
  })
  .strict();

const updateBodySchema = z
  .object({
    name: z.string().max(1024).optional(),
    nodeType: z.enum(["page", "block", "class"]).optional(),
    icon: z.string().max(64).optional(),
    color: z.string().max(32).optional(),
    contentAst: z.array(z.unknown()).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "at least one field to update" });

const searchQuerySchema = z
  .object({
    q: z.string().min(1).max(512),
    nodeType: z.enum(["page", "block", "class"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .strict();

const deleteQuerySchema = z
  .object({
    permanent: z.coerce.boolean().default(false),
    confirm: z.string().optional(),
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
  nodeType: string;
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
    nodeType: row.node_type,
    parentId: row.parent_id,
    classIds: JSON.parse(row.class_ids) as string[],
    name: row.name,
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

function fullObject(store: Store, row: NodeRow) {
  const base = nodeToApi(row);
  const classes = base.classIds
    .map((classId) => {
      const classRow = store.database
        .prepare("SELECT id, name, icon, color FROM class WHERE id = ? AND active = 1")
        .get(classId) as { id: string; name: string; icon: string | null; color: string | null } | undefined;
      return classRow ?? null;
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

  app.get("/objects", async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid list query");
    }
    const { nodeType, class: classId, q, limit, cursor } = parsed.data;
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);

    const clauses = ["n.is_active = 1", "n.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (nodeType !== undefined) {
      clauses.push("n.node_type = ?");
      params.push(nodeType);
    }
    if (classId !== undefined) {
      clauses.push(
        "EXISTS (SELECT 1 FROM class_member_set cm WHERE cm.node_id = n.id AND cm.class_id = ? AND cm.present = 1)",
      );
      params.push(classId);
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
    const objectId = uuidv7();
    const payload = {
      objectId,
      ...(parsed.data.nodeType !== undefined ? { nodeType: parsed.data.nodeType } : {}),
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
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

  app.get("/objects/:id/backlinks", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    return { nodeId: id, backlinks: store.backlinks(id) };
  });

  app.get("/search", async (request) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid search query");
    }
    const { q, nodeType, limit } = parsed.data;
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const hits = store.search(q, limit);
    const results = hits
      .map((hit) => store.getNode(hit.nodeId))
      .filter((row): row is NodeRow => row !== undefined && row.is_active === 1)
      .filter((row) => nodeType === undefined || row.node_type === nodeType)
      .map((row) => {
        const api = nodeToApi(row);
        return { id: api.id, nodeType: api.nodeType, name: api.name, parentId: api.parentId, updatedAt: api.updatedAt };
      });
    return { results };
  });

  app.get("/classes", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classes = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description,
                c.extends_class_id AS extendsClassId,
                (SELECT COUNT(*) FROM class_member_set m WHERE m.class_id = c.id AND m.present = 1) AS memberCount
         FROM class c WHERE c.active = 1 ORDER BY c.name, c.id`,
      )
      .all() as { id: string; name: string; icon: string | null; color: string | null; description: string | null; extendsClassId: string | null; memberCount: number }[];
    return { classes };
  });

  app.get("/classes/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const classRow = store.database
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color, c.description, c.extends_class_id AS extendsClassId
         FROM class c WHERE c.id = ? AND c.active = 1`,
      )
      .get(id) as { id: string; name: string; icon: string | null; color: string | null; description: string | null; extendsClassId: string | null } | undefined;
    if (classRow === undefined) {
      throw new AppError(404, "not_found", `class ${id} does not exist`);
    }
    const members = store.database
      .prepare(
        `SELECT n.id, n.name, n.node_type AS nodeType
         FROM class_member_set m JOIN node n ON n.id = m.node_id
         WHERE m.class_id = ? AND m.present = 1 AND n.is_active = 1 ORDER BY n.id`,
      )
      .all(id);
    return { class: classRow, members };
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
