/**
 * Workspace feature toggles — the read half of the `workspace.feature.set`
 * op surface (research-tier2 slice 2b):
 *
 *  - GET /api/features   the workspace's `workspace_feature` projection rows
 *                        ({feature, enabled, settings}) — the CLI's
 *                        `feature list` consumes this. F2 semantics: an
 *                        ABSENT row means ENABLED (the empty table is the
 *                        pre-toggle state), so untoggled features simply do
 *                        not appear; callers default them to on. `settings`
 *                        is the winning payload's configuration record, NULL
 *                        when the winning payload carried none (the wire's
 *                        absent-vs-empty distinction, SCHEMA.md "Workspace
 *                        features").
 *
 * Read-only, over the derived store (like every object-API read); auth: any
 * authenticated principal (the object-API group preHandler), scoped API keys
 * need the objects.read scope.
 */

import type { FastifyInstance } from "fastify";

import type { ServerContext } from "./context.js";
import { workspaceFor } from "./routes-objects.js";

export function registerFeatureRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/features", async (request) => {
    const workspaceId = workspaceFor(ctx, request);
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    return {
      features: store.listFeatureRows(workspaceId).map((row) => ({
        feature: row.feature,
        enabled: row.enabled,
        settings: row.settings ?? null,
      })),
    };
  });
}
