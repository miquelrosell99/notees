/**
 * Share routes (§34.62) — READ-ONLY public page shares.
 *
 * Management surface (registered under /api, per-route auth):
 *
 *  - POST   /api/shares {nodeId, expiresAt?} → {share} (owner/admin only);
 *  - GET    /api/shares?nodeId=              → {shares} (owner/admin only);
 *  - DELETE /api/shares/:token               → {ok}     (owner/admin only).
 *
 * Public surface (registered at the app root, UNAUTHENTICATED BY DESIGN):
 *
 *  - GET /s/:token — the share view: one static, read-only HTML document
 *    (the export package's projection of the page + its block tree). GET-only;
 *    missing / revoked / expired tokens and trashed pages all answer the same
 *    404 so the route never distinguishes them.
 *
 * Threat note (owner ruling 2026-10-04, documented in the OpenAPI entries and
 * docs/usage.md): possession of the URL is the capability — the token is 24
 * random bytes (base64url), there is NO directory listing (unguessable
 * tokens; every failure is the same 404), revocation takes effect on the next
 * request, and minting accepts an optional expiresAt after which the link
 * dies on its own. The view is read-only by construction: the route only
 * ever renders derived content, there is no write path and no app script.
 *
 * AuthZ: the operator API key (the machine/owner path) plus admin users and
 * owner-role members of the default workspace — the object API v1 is
 * default-workspace scoped, so shares are too.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal, type ResolvedRequest } from "./routes-auth.js";
import { renderSharedNode } from "./share-render.js";
import type { ShareRow } from "./shares.js";
import { shareIsLive } from "./shares.js";

const createBodySchema = z
  .object({
    nodeId: z.string().uuid(),
    /** Epoch millis after which the link stops resolving; omit = no expiry. */
    expiresAt: z.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => body.expiresAt === undefined || body.expiresAt > Date.now(), {
    message: "expiresAt must be in the future",
  });

const listQuerySchema = z
  .object({
    nodeId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Owner/admin gate. The operator key passes (it is the machine owner path);
 * user principals need the admin flag or the owner membership role on the
 * default workspace (the same role gate as workspace rename/delete).
 */
function requireShareAdmin(ctx: ServerContext, request: FastifyRequest): ResolvedRequest {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
  if (resolved.principal.kind === "apikey") return resolved;
  if (resolved.principal.isAdmin) return resolved;
  if (ctx.auth.membership(ctx.defaultWorkspace, resolved.principal.userId) === "owner") return resolved;
  throw new AppError(403, "forbidden", "managing shares is owner/admin only");
}

function shareView(row: ShareRow): Record<string, unknown> {
  return {
    token: row.token,
    /** The public route's path — clients prefix their own server origin. */
    urlPath: `/s/${row.token}`,
    nodeId: row.nodeId,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

export function registerShareRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/shares", async (request, reply) => {
    const resolved = requireShareAdmin(ctx, request);
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid share request");
    }
    const workspaceId = ctx.defaultWorkspace;
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = store.getNode(parsed.data.nodeId);
    if (row === undefined || row.is_active !== 1) {
      throw new AppError(404, "not_found", `object ${parsed.data.nodeId} does not exist`);
    }
    if (row.is_class === 1) {
      throw new AppError(422, "validation_failed", "classes are not shareable — share a page or a block");
    }
    const createdBy = resolved.principal.kind === "user" ? resolved.principal.userId : ctx.actorId;
    const share = ctx.shares.create({
      workspaceId,
      nodeId: parsed.data.nodeId,
      createdBy,
      expiresAt: parsed.data.expiresAt ?? null,
    });
    reply.code(201);
    return { share: shareView(share) };
  });

  app.get("/shares", async (request) => {
    requireShareAdmin(ctx, request);
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid shares query");
    }
    const shares = ctx.shares.list(ctx.defaultWorkspace, parsed.data.nodeId);
    return { shares: shares.map(shareView) };
  });

  app.delete("/shares/:token", async (request) => {
    requireShareAdmin(ctx, request);
    const { token } = request.params as { token: string };
    if (!ctx.shares.revoke(token)) {
      throw new AppError(404, "not_found", "no such live share token");
    }
    return { ok: true };
  });
}

/**
 * The public share view. Unauthenticated GET-only by design (see module
 * header); the answer carries privacy-sane cache + content headers.
 */
export function registerPublicShareRoute(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/s/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = ctx.shares.get(token);
    if (share === null || !shareIsLive(share)) {
      throw new AppError(404, "not_found", "share link not found");
    }
    await ctx.ensureSeeded(share.workspaceId);
    const store = ctx.workspaces.storeFor(share.workspaceId);
    const row = store.getNode(share.nodeId);
    if (row === undefined || row.is_active !== 1) {
      // The page was trashed/permanently deleted — the share dies with it.
      throw new AppError(404, "not_found", "share link not found");
    }
    const html = renderSharedNode(store, row);
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      )
      .send(html);
  });
}
