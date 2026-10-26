/**
 * Node-scoped hosted views — the custom-tabs store (the prefs channel,
 * the favorites/recents precedent extended 2026-10-07, de-scoped from the
 * user 2026-10-26).
 *
 * Every collection-backed surface may host custom views: named tabs whose
 * query_ast refines the surface's default row set. System sections key by
 * their section key (linked-references, unlinked-mentions, classed-nodes);
 * a query node's main query is keyed by the empty section key (the literal
 * "-" sentinel in the URL path). This is cross-device UI state, NOT op-log
 * state — the "device state is never an op" law stands — so the rows live
 * in relay.db beside the account, but they belong to the NODE, not to a
 * user: every user of the deployment shares a node's tabs (applied to system sections too).
 *
 * Endpoints (all under /api, authenticated but not user-scoped):
 *  - GET    /nodes/:nodeId/sections/:sectionKey/views          list, tab order
 *  - POST   /nodes/:nodeId/sections/:sectionKey/views          create (appends)
 *  - PATCH  /nodes/:nodeId/sections/:sectionKey/views/:viewId  rename / rewrite the query (or both)
 *  - PUT    /nodes/:nodeId/sections/:sectionKey/views/order    reorder (full list)
 *  - DELETE /nodes/:nodeId/sections/:sectionKey/views/:viewId  delete
 *
 * The default view is derived-not-stored: there is no is_default column and
 * no default row — the schema cannot express a default, so emptying the
 * table restores factory behavior (the reset-to-default UI deletes every
 * row for the surface).
 *
 * Validation is fail-loud (422 validation_failed): uuid-shaped ids, the
 * pinned section-key vocabulary (plus the "-" sentinel for the empty key),
 * a trimmed 1..120 name, and a query_ast that parses against the QueryAST
 * v1 zod schema (@notees/protocol — the same grammar the web's
 * FilterBuilderModal produces, so a transient filter persists verbatim).
 * A name collision on the (node, section) unique key is 409 conflict; a
 * missing or foreign row is 404 not_found. There is deliberately no
 * view_mode on this channel (view modes are transient surface state).
 */

import type { FastifyInstance } from "fastify";
import { queryAstSchema } from "@notees/protocol";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { requireUser } from "./routes-auth.js";

/** The collection-backed sections that may host custom views. */
export const SECTION_KEYS = ["linked-references", "unlinked-mentions", "classed-nodes"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** URL sentinel for the empty section key (a query node's main query). */
export const EMPTY_SECTION_SENTINEL = "-";

const MAX_VIEW_NAME = 120;

const sectionParamsSchema = z
  .object({
    nodeId: z.string().uuid(),
    sectionKey: z.enum([...SECTION_KEYS, EMPTY_SECTION_SENTINEL]),
  })
  .strict();

const viewParamsSchema = sectionParamsSchema.extend({ viewId: z.string().uuid() }).strict();

const createBodySchema = z
  .object({
    name: z.string().trim().min(1, "view name is required").max(MAX_VIEW_NAME),
    queryAst: z.unknown(),
  })
  .strict();

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1, "view name is required").max(MAX_VIEW_NAME).optional(),
    queryAst: z.unknown().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.queryAst !== undefined, {
    message: "a rename (name), a query rewrite (queryAst), or both is required",
  });

const reorderBodySchema = z
  .object({
    orderedIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

/** The URL sentinel normalizes to the empty section key at the storage seam. */
function normalizeSectionKey(sectionKey: string): string {
  return sectionKey === EMPTY_SECTION_SENTINEL ? "" : sectionKey;
}

/** query_ast must be a valid QueryAST v1 — the same parse the client's resolution runs. */
function parseStoredAst(raw: unknown): unknown {
  const parsed = queryAstSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      422,
      "validation_failed",
      `queryAst is not a valid QueryAST v1: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Map the (node, section, name) unique key to 409. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function registerSectionViewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/nodes/:nodeId/sections/:sectionKey/views", async (request) => {
    requireUser(ctx, request);
    const params = sectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    return {
      views: ctx.auth.listNodeViews(params.data.nodeId, normalizeSectionKey(params.data.sectionKey)),
    };
  });

  app.post("/nodes/:nodeId/sections/:sectionKey/views", async (request, reply) => {
    requireUser(ctx, request);
    const params = sectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(422, "validation_failed", body.error.issues[0]?.message ?? "invalid view body");
    }
    const queryAst = parseStoredAst(body.data.queryAst);
    try {
      const view = ctx.auth.createNodeView({
        nodeId: params.data.nodeId,
        sectionKey: normalizeSectionKey(params.data.sectionKey),
        name: body.data.name,
        queryAst,
      });
      reply.code(201);
      return { view };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, "conflict", "a view with this name already exists on this section");
      }
      throw error;
    }
  });

  app.patch("/nodes/:nodeId/sections/:sectionKey/views/:viewId", async (request) => {
    requireUser(ctx, request);
    const params = viewParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const body = patchBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(422, "validation_failed", body.error.issues[0]?.message ?? "invalid view body");
    }
    // The row must exist AND live on this surface — a foreign view id is 404,
    // never a cross-section patch.
    const existing = ctx.auth.getNodeView(params.data.viewId);
    if (
      existing === null ||
      existing.nodeId !== params.data.nodeId ||
      existing.sectionKey !== normalizeSectionKey(params.data.sectionKey)
    ) {
      throw new AppError(404, "not_found", "node view not found");
    }
    const patch: { name?: string; queryAst?: unknown } = {};
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.queryAst !== undefined) patch.queryAst = parseStoredAst(body.data.queryAst);
    try {
      const view = ctx.auth.patchNodeView(params.data.viewId, patch);
      return { view };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, "conflict", "a view with this name already exists on this section");
      }
      throw error;
    }
  });

  app.put("/nodes/:nodeId/sections/:sectionKey/views/order", async (request) => {
    requireUser(ctx, request);
    const params = sectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const body = reorderBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(422, "validation_failed", body.error.issues[0]?.message ?? "invalid order body");
    }
    try {
      const views = ctx.auth.reorderNodeViews(
        params.data.nodeId,
        normalizeSectionKey(params.data.sectionKey),
        body.data.orderedIds,
      );
      return { views };
    } catch {
      throw new AppError(
        422,
        "validation_failed",
        "orderedIds must name every view of this section exactly once",
      );
    }
  });

  app.delete("/nodes/:nodeId/sections/:sectionKey/views/:viewId", async (request, reply) => {
    requireUser(ctx, request);
    const params = viewParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const deleted = ctx.auth.deleteNodeView(params.data.viewId);
    if (!deleted) {
      throw new AppError(404, "not_found", "node view not found");
    }
    reply.code(204);
  });
}
