/**
 * ADMIN ROUTES — the operator-key maintenance surface: applying pre-built
 * migration envelopes through the server (the apply-through-server path)
 * and reading per-workspace convergence state.
 *
 *  - POST /api/admin/append   the MIGRATION path: body {workspaceId,
 *                             envelopes[]} — envelopes built and validated
 *                             by a scripts/migrate-*.mts planner (Path A,
 *                             additive, idempotent). Runs through the ONE
 *                             write path (WorkspaceManager.apply: relay
 *                             ingest, then derived apply), so the server's
 *                             own stores converge INSTANTLY — no restart,
 *                             no derived-cache wipe, no side-channel
 *                             relay.db writes while the server runs
 *                             (the 2026-11-02 lesson: an external script
 *                             appending to relay.db bypassed the live
 *                             process, and only a restart — or now the
 *                             self-heal sweep — let the server see the
 *                             tail). The whole batch is protocol-validated
 *                             before anything is ingested; an invalid
 *                             envelope fails the request with nothing
 *                             written. Duplicate ids are ignored by the
 *                             relay (idempotent re-runs answer savedIds
 *                             empty).
 *  - GET  /api/admin/convergence?workspaceId=&envelopeIds=a,b
 *                             how far the open derived handle has applied
 *                             the log ({hydrated, lastSeq, latestSeq,
 *                             pending, appliedCount}) and whether specific
 *                             envelope ids (a migration's batch) are
 *                             applied — the honest post-migration check
 *                             THROUGH THE SERVER's own read path (the
 *                             2026-11-02 lesson the other way: raw sqlite
 *                             probes of derived/*.db lie — snapshot-restore
 *                             temp files, WAL raciness, and fat-fingered
 *                             UUIDs all masquerade as "not converged").
 *
 * Auth: OPERATOR KEY ONLY (principal.kind === "apikey") — the machine
 * owner path. User sessions and per-user API keys get 403 even when
 * admin: appending arbitrary envelopes is a log-write capability beyond
 * account administration (requireAdmin's looser gate does NOT apply).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { envelopeSchema, payloadSchemaFor, type Envelope } from "@notees/protocol";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal } from "./routes-auth.js";

/** The operator-key gate: the deployment owner's machine credential only. */
function requireOperator(ctx: ServerContext, request: FastifyRequest): void {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
  if (resolved.principal.kind !== "apikey") {
    throw new AppError(403, "forbidden", "admin routes require the operator API key");
  }
}

const appendBodySchema = z
  .object({
    workspaceId: z.string().uuid(),
    envelopes: z.array(z.unknown()).min(1).max(10_000),
  })
  .strict();

const convergenceQuerySchema = z
  .object({
    workspaceId: z.string().uuid(),
    envelopeIds: z.string().optional(),
  })
  .strict();

/**
 * The protocol gate, identical to the migration scripts': every envelope
 * must satisfy the envelope schema AND its per-op payload schema. Anything
 * invalid aborts the request BEFORE anything is ingested.
 */
function validateBatch(envelopes: unknown[]): void {
  const failures: string[] = [];
  envelopes.forEach((raw, index) => {
    const envResult = envelopeSchema.safeParse(raw);
    if (!envResult.success) {
      failures.push(`#${index}: envelope invalid — ${envResult.error.message}`);
      return;
    }
    const schema = payloadSchemaFor(envResult.data.opType);
    if (schema === undefined) {
      failures.push(`#${index}: no payload schema registered for ${envResult.data.opType}`);
      return;
    }
    if (!schema.safeParse(envResult.data.payload).success) {
      failures.push(`#${index}: payload invalid for ${envResult.data.opType}`);
    }
  });
  if (failures.length > 0) {
    throw new AppError(
      422,
      "validation_failed",
      `refusing to append: ${failures.length} invalid envelope(s): ${failures.join("; ")}`,
    );
  }
}

export function registerAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/admin/append", async (request) => {
    requireOperator(ctx, request);
    const parsed = appendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid append request");
    }
    const { workspaceId, envelopes } = parsed.data;
    validateBatch(envelopes);
    // The one write path: relay ingest (idempotent on envelope id), then
    // the derived apply — the server's stores converge before the response.
    const outcome = await ctx.workspaces.apply(workspaceId, envelopes as Envelope[]);
    const convergence = ctx.workspaces.convergence(workspaceId);
    return { ...outcome, pending: convergence.pending };
  });

  app.get("/admin/convergence", async (request) => {
    requireOperator(ctx, request);
    const parsed = convergenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid convergence query");
    }
    const { workspaceId, envelopeIds } = parsed.data;
    const convergence = ctx.workspaces.convergence(workspaceId);
    const ids = (envelopeIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    const store = ctx.workspaces.storeFor(workspaceId);
    const envelopes: Record<string, boolean> = {};
    for (const id of ids.slice(0, 100)) {
      envelopes[id] = store.hasApplied(id);
    }
    return { workspaceId, ...convergence, envelopes };
  });
}
