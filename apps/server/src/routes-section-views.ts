/**
 * Per-user hosted section views — the custom-tabs store (the prefs channel,
 * the favorites/recents precedent extended 2026-10-07).
 *
 * Every collection-backed section (linked-references, unlinked-mentions,
 * classed-nodes) may host custom views: named tabs whose query_ast refines
 * the section's default row set. This is cross-device UI state, NOT op-log
 * state — the "device state is never an op" law stands — so the rows live in
 * relay.db beside the account, scoped to the user, riding the same auth
 * posture as /api/me/prefs (any user principal: account session or per-user
 * API key; the operator key is not a user and gets 401).
 *
 * Endpoints (all under /api, all per-user scoped):
 *  - GET    /me/nodes/:nodeId/sections/:sectionKey/views          list, tab order
 *  - POST   /me/nodes/:nodeId/sections/:sectionKey/views          create (appends)
 *  - PATCH  /me/nodes/:nodeId/sections/:sectionKey/views/:viewId  rename
 *  - PUT    /me/nodes/:nodeId/sections/:sectionKey/views/order    reorder (full list)
 *  - DELETE /me/nodes/:nodeId/sections/:sectionKey/views/:viewId  delete
 *
 * The default view is derived-not-stored: there is no is_default column and
 * no default row — the schema cannot express a default, so emptying the
 * table restores factory behavior (the reset-to-default UI deletes every
 * row for the section).
 *
 * Validation is fail-loud (422 validation_failed): uuid-shaped ids, the
 * pinned section-key vocabulary, a trimmed 1..120 name, and a query_ast that
 * parses against the QueryAST v1 zod schema (@notees/protocol — the same
 * grammar the web's FilterBuilderModal produces, so a transient filter
 * persists verbatim). A name collision on the (user, node, section) unique
 * key is 409 conflict; a missing or foreign row is 404 not_found (per-user
 * scoping never leaks another account's tabs).
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

const MAX_VIEW_NAME = 120;
const MAX_VIEW_MODE = 32;

const sectionParamsSchema = z
  .object({
    nodeId: z.string().uuid(),
    sectionKey: z.enum(SECTION_KEYS),
  })
  .strict();

const viewParamsSchema = sectionParamsSchema.extend({ viewId: z.string().uuid() }).strict();

const createBodySchema = z
  .object({
    name: z.string().trim().min(1, "view name is required").max(MAX_VIEW_NAME),
    queryAst: z.unknown(),
    viewMode: z.string().max(MAX_VIEW_MODE).nullish(),
  })
  .strict();

const renameBodySchema = z
  .object({
    name: z.string().trim().min(1, "view name is required").max(MAX_VIEW_NAME),
  })
  .strict();

const reorderBodySchema = z
  .object({
    orderedIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

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

/** Map the (user, node, section, name) unique key to 409. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function registerSectionViewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/me/nodes/:nodeId/sections/:sectionKey/views", async (request) => {
    const principal = requireUser(ctx, request);
    const params = sectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    return {
      views: ctx.auth.listSectionViews(principal.userId, params.data.nodeId, params.data.sectionKey),
    };
  });

  app.post("/me/nodes/:nodeId/sections/:sectionKey/views", async (request, reply) => {
    const principal = requireUser(ctx, request);
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
      const view = ctx.auth.createSectionView({
        userId: principal.userId,
        nodeId: params.data.nodeId,
        sectionKey: params.data.sectionKey,
        name: body.data.name,
        queryAst,
        viewMode: body.data.viewMode ?? null,
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

  app.patch("/me/nodes/:nodeId/sections/:sectionKey/views/:viewId", async (request) => {
    const principal = requireUser(ctx, request);
    const params = viewParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const body = renameBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(422, "validation_failed", body.error.issues[0]?.message ?? "invalid view body");
    }
    // The row must exist, belong to the user, AND live on this section —
    // a foreign view id is 404, never a cross-section rename.
    const existing = ctx.auth.getSectionView(principal.userId, params.data.viewId);
    if (
      existing === null ||
      existing.nodeId !== params.data.nodeId ||
      existing.sectionKey !== params.data.sectionKey
    ) {
      throw new AppError(404, "not_found", "section view not found");
    }
    try {
      const view = ctx.auth.renameSectionView(principal.userId, params.data.viewId, body.data.name);
      return { view };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, "conflict", "a view with this name already exists on this section");
      }
      throw error;
    }
  });

  app.put("/me/nodes/:nodeId/sections/:sectionKey/views/order", async (request) => {
    const principal = requireUser(ctx, request);
    const params = sectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const body = reorderBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError(422, "validation_failed", body.error.issues[0]?.message ?? "invalid order body");
    }
    try {
      const views = ctx.auth.reorderSectionViews(
        principal.userId,
        params.data.nodeId,
        params.data.sectionKey,
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

  app.delete("/me/nodes/:nodeId/sections/:sectionKey/views/:viewId", async (request, reply) => {
    const principal = requireUser(ctx, request);
    const params = viewParamsSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError(422, "validation_failed", params.error.issues[0]?.message ?? "invalid view path");
    }
    const deleted = ctx.auth.deleteSectionView(principal.userId, params.data.viewId);
    if (!deleted) {
      throw new AppError(404, "not_found", "section view not found");
    }
    reply.code(204);
  });
}
