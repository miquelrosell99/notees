/**
 * Confidential-share routes — the SHIPPED half of the per-node-sharing
 * proposal's parked §3.3: READ-only sharing with someone who holds NO
 * membership on the source workspace (the password-sealed pattern —
 * Bitwarden Send / Proton link-password).
 *
 *  - POST   /api/confidential-shares {nodeId, recipientEmail, displayName,
 *           artifact, salt, kdf} → {share}  (owner/admin only);
 *  - GET    /api/confidential-shares/inbox → {shares}  (any authenticated
 *           USER — the rows addressed to her email, granter identity + the
 *           plaintext display name included: she is not a member and cannot
 *           resolve the node from her own projection);
 *  - GET    /api/confidential-shares/:id/artifact → {artifact, salt, kdf}
 *           (authenticated USER whose email matches the recipient — the
 *           CIPHERTEXT only; the password never reaches any route);
 *  - DELETE /api/confidential-shares/:id → {ok}  (owner/admin; immediate).
 *
 * Threat model: the artifact is a subtree render sealed CLIENT-side with a
 * key derived from a password the owner shares OUT OF BAND (scrypt →
 * AES-GCM, iv‖tag‖ct b64u — the plan-08 layout with a password-derived key
 * instead of a fragment key). The server stores ciphertext + the KDF
 * salt/params (non-secret) + the recipient email (the delivery hint).
 * Possession of the inbox row + the password is the capability; revocation
 * kills the row on every surface immediately. The grantee needs no account
 * on the source workspace and no membership — only an account on THIS
 * server matching the recipient email (so the inbox can address her) and
 * the password.
 *
 * EDIT over confidential shares stays parked (the shadow-workspace
 * bridge) — this is the read half of §3.3, documented as such.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal } from "./routes-auth.js";
import { requireShareAdmin } from "./routes-shares.js";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const kdfSchema = z.object({
  algorithm: z.literal("scrypt"),
  N: z.number().int().min(2 ** 14).max(2 ** 18),
  r: z.number().int().min(1).max(8),
  p: z.number().int().min(1).max(4),
});

const createBodySchema = z
  .object({
    nodeId: z.string().uuid(),
    recipientEmail: z.string().email(),
    displayName: z.string().trim().min(1).max(200),
    artifact: z.string().min(1).max(MAX_ARTIFACT_BYTES, `share artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte cap`),
    salt: z.string().min(1).max(64),
    kdf: kdfSchema,
  })
  .strict();

export function registerConfidentialShareRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/confidential-shares", async (request, reply) => {
    const resolved = requireShareAdmin(ctx, request);
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid confidential share request");
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
    const share = ctx.auth.createConfidentialShare({
      workspaceId,
      nodeId: parsed.data.nodeId,
      recipientEmail: parsed.data.recipientEmail,
      displayName: parsed.data.displayName,
      artifact: parsed.data.artifact,
      salt: parsed.data.salt,
      kdf: JSON.stringify(parsed.data.kdf),
      createdBy,
    });
    reply.code(201);
    return { share: { id: share.id, nodeId: parsed.data.nodeId, createdAt: share.createdAt } };
  });

  app.get("/confidential-shares/inbox", async (request) => {
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    if (resolved.principal.kind !== "user") return { shares: [] };
    return { shares: ctx.auth.confidentialShareInbox(resolved.principal.userId) };
  });

  app.get("/confidential-shares/:id/artifact", async (request) => {
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    if (resolved.principal.kind !== "user") {
      throw new AppError(403, "forbidden", "confidential shares are addressed to account sessions");
    }
    const { id } = request.params as { id: string };
    const row = ctx.auth.confidentialShareForReader(id, resolved.principal.userId);
    if (row === null) {
      throw new AppError(404, "not_found", "no such live confidential share for this account");
    }
    return { artifact: row.artifact, salt: row.salt, kdf: JSON.parse(row.kdf) as unknown };
  });

  app.delete("/confidential-shares/:id", async (request) => {
    requireShareAdmin(ctx, request);
    const { id } = request.params as { id: string };
    if (!ctx.auth.revokeConfidentialShare(id)) {
      throw new AppError(404, "not_found", "no such live confidential share");
    }
    return { ok: true };
  });
}
