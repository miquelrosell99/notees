/**
 * Developer self-description routes (§34.33 AG4/AG5), prefix /api:
 *
 *  - GET /api/meta         auth-free self-description: server version, wire
 *                          protocol versions, the default workspace id (a
 *                          fixed system uuid — identity.ts), setup state;
 *  - GET /api/openapi.json the OpenAPI 3.1 contract (AG4), built once;
 *  - GET /api/operations   paginated read of a workspace's relay operation
 *                          log (AG5 agent-safety feed) — cursor semantics
 *                          match relay catch-up, auth read + objects.read
 *                          scope for scoped keys.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PROTOCOL_VERSION } from "@notees/protocol";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { authorizeWorkspace } from "./routes-relay.js";
import { resolvePrincipal } from "./routes-auth.js";
import { scopeAllows } from "./scopes.js";

const WS_PROTOCOL_VERSION = 2;

const operationsQuerySchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    afterSeq: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  })
  .strict();

export function registerMetaRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  openApiDocument: Record<string, unknown>,
): void {
  app.get("/meta", async () => ({
    name: "notees-server",
    version: ctx.serverVersion,
    protocolVersion: PROTOCOL_VERSION,
    wsProtocolVersion: WS_PROTOCOL_VERSION,
    defaultWorkspaceId: ctx.defaultWorkspace,
    setupRequired: ctx.auth.userCount() === 0,
  }));

  app.get("/openapi.json", async (_request, reply) => {
    // The document is versioned by the server build, not request state.
    return reply.header("cache-control", "no-store").send(openApiDocument);
  });

  /**
   * The operation feed: the relay log is the authority, so agents audit
   * writes here instead of diffing derived state. Same cursor shape as relay
   * catch-up (afterSeq/limit/nextAfterSeq/hasMore/totalRemaining); the
   * entries are envelope-v3 objects.
   */
  app.get("/operations", async (request) => {
    const parsed = operationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid operations query");
    }
    const workspaceId = parsed.data.workspaceId ?? ctx.defaultWorkspace;
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    authorizeWorkspace(ctx, resolved.principal, workspaceId, "read");
    if (!scopeAllows(resolved.scopes, "objects.read")) {
      throw new AppError(403, "scope_denied", 'this route requires the "objects.read" API-key scope');
    }
    const page = ctx.relay.catchUp(workspaceId, parsed.data.afterSeq, parsed.data.limit);
    return {
      workspaceId,
      operations: page.envelopes,
      nextAfterSeq: page.nextAfterSeq,
      hasMore: page.hasMore,
      totalRemaining: page.totalRemaining,
    };
  });
}
