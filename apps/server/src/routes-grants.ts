/**
 * Grant routes — per-node sharing between users (the per-node-sharing
 * proposal's slices 2–3, trusted-circle v1):
 *
 *  - POST   /api/grants {nodeId, granteeUserId? | granteeEmail?, role?}
 *           → {grant}        (owner/admin only; role read|edit, default read);
 *  - GET    /api/grants?nodeId= → {grants}  (owner/admin only);
 *  - DELETE /api/grants/:id     → {ok}      (owner/admin only; immediate);
 *  - GET    /api/grants/inbox   → {grants}  (any authenticated USER — the
 *           parked "Shares Inbox": the live grants matching the caller, with
 *           the granter's identity; the grantee email rides along so the UI
 *           can render a pending state).
 *
 * Threat & trust model (documented in docs/features/sharing.md): a grant
 * covers its root's WHOLE descendant closure — coverage is a read-time
 * derivation over the derived store's parentage, never a stored list, so
 * children created later are covered automatically. Grants target
 * workspace MEMBERS (role "member" = restricted, "owner" = full peer): the
 * op log is the sync boundary, so a grantee must hold the workspace key —
 * this is the proposal's trusted-circle v1. Confidential sharing for
 * non-members stays parked (user keypairs / shadow workspaces). Two
 * enforcement levels follow from that:
 *
 *  - VIEW: the app shows a restricted member only her grant roots and
 *    closures (inbox + client-side filtering — a UX boundary, not
 *    confidentiality: she holds the key).
 *  - WRITE: `guardRestrictedWrite` (below, wired into the relay's two ingest
 *    paths) rejects envelopes whose affectedNodeIds step outside the
 *    writer's edit-grant closure — this holds even for SEALED payloads (the
 *    affected ids travel outside the seal), but it leans on clients
 *    declaring affectedNodeIds faithfully; a sealed create's brand-new id
 *    has no row yet and its placement is client-trusted (documented).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import type { Principal } from "./identity.js";
import { resolvePrincipal } from "./routes-auth.js";
import { requireShareAdmin } from "./routes-shares.js";

const createBodySchema = z
  .object({
    nodeId: z.string().uuid(),
    granteeUserId: z.string().uuid().optional(),
    granteeEmail: z.string().email().optional(),
    role: z.enum(["read", "edit"]).default("read"),
  })
  .strict()
  .refine((body) => (body.granteeUserId !== undefined) !== (body.granteeEmail !== undefined), {
    message: "pass exactly one of granteeUserId or granteeEmail",
  });

const listQuerySchema = z.object({ nodeId: z.string().uuid() }).strict();

function grantView(row: {
  id: string;
  nodeId: string;
  granteeUserId: string | null;
  granteeEmail: string | null;
  role: string;
  createdBy: string;
  createdAt: number;
}) {
  return {
    id: row.id,
    nodeId: row.nodeId,
    granteeUserId: row.granteeUserId,
    granteeEmail: row.granteeEmail,
    role: row.role,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Whether `nodeId` sits inside ANY of the grant roots' descendant closures
 * — an ancestor walk over the derived store's parentage. Ids with NO row
 * yet (a create's brand-new id) read as inside: placement of a not-yet-
 * materialized node is client-trusted under the trusted-circle ruling.
 */
export function withinGrantClosure(
  store: { getNode(id: string): { parent_id: string | null } | undefined },
  grantRoots: ReadonlySet<string>,
  nodeId: string,
): boolean {
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (grantRoots.has(cursor)) return true;
    seen.add(cursor);
    const row = store.getNode(cursor);
    if (row === undefined) return true;
    cursor = row.parent_id;
  }
  return false;
}

/**
 * The write-guard's decision for one restricted writer and one batch:
 * every affected node id across every envelope must sit inside the union
 * of her EDIT-grant closures. True when nothing is restricted (callers
 * short-circuit before this).
 */
export function restrictedWriteAllowed(
  ctx: ServerContext,
  userId: string,
  workspaceId: string,
  affectedNodeIds: readonly string[],
): boolean {
  const roots = new Set(
    ctx.auth
      .liveGrantsForUser(workspaceId, userId)
      .filter((grant) => grant.role === "edit")
      .map((grant) => grant.nodeId),
  );
  if (roots.size === 0) return false;
  const store = ctx.workspaces.storeFor(workspaceId);
  return affectedNodeIds.every((id) => withinGrantClosure(store, roots, id));
}

/**
 * Throws 403 when a USER principal is a RESTRICTED member of the workspace
 * (role "member") and the batch's affected ids step outside her edit
 * closures. Owners/admins/operator pass untouched. Wired into both relay
 * ingest paths (HTTP batch + WS ops frame).
 */
export function guardRestrictedWrite(
  ctx: ServerContext,
  principal: Principal,
  workspaceId: string,
  affectedNodeIds: readonly string[],
): void {
  if (principal.kind !== "user") return;
  if (!ctx.auth.isRestrictedMember(workspaceId, principal.userId)) return;
  if (affectedNodeIds.length === 0) {
    throw new AppError(
      403,
      "forbidden",
      "restricted members must declare affectedNodeIds on every envelope",
    );
  }
  if (!restrictedWriteAllowed(ctx, principal.userId, workspaceId, affectedNodeIds)) {
    throw new AppError(
      403,
      "forbidden",
      "this write steps outside your edit grants — ask the workspace owner for access",
    );
  }
}

export function registerGrantRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/grants", async (request, reply) => {
    const resolved = requireShareAdmin(ctx, request);
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid grant request");
    }
    const workspaceId = ctx.defaultWorkspace;
    await ctx.ensureSeeded(workspaceId);
    const store = ctx.workspaces.storeFor(workspaceId);
    const row = store.getNode(parsed.data.nodeId);
    if (row === undefined || row.is_active !== 1) {
      throw new AppError(404, "not_found", `object ${parsed.data.nodeId} does not exist`);
    }
    if (row.is_class === 1) {
      throw new AppError(422, "validation_failed", "classes are not grantable — grant a page or a block");
    }
    // Resolve the grantee: an explicit user id must name an account; an
    // email may stay pending until someone registers with it.
    let granteeUserId: string | undefined;
    let granteeEmail: string | undefined;
    if (parsed.data.granteeUserId !== undefined) {
      if (ctx.auth.findUserById(parsed.data.granteeUserId) === null) {
        throw new AppError(404, "not_found", `no account ${parsed.data.granteeUserId}`);
      }
      granteeUserId = parsed.data.granteeUserId;
    } else {
      granteeEmail = parsed.data.granteeEmail as string;
      const existing = ctx.auth.findUserByEmail(granteeEmail);
      if (existing !== null) granteeUserId = existing.id;
    }
    const createdBy = resolved.principal.kind === "user" ? resolved.principal.userId : ctx.actorId;
    const grant = ctx.auth.createGrant({
      workspaceId,
      nodeId: parsed.data.nodeId,
      granteeUserId,
      granteeEmail: granteeUserId !== undefined ? undefined : granteeEmail,
      role: parsed.data.role,
      createdBy,
    });
    reply.code(201);
    return { grant: grantView(grant) };
  });

  app.get("/grants", async (request) => {
    requireShareAdmin(ctx, request);
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid grants query");
    }
    return { grants: ctx.auth.listGrantsForNode(ctx.defaultWorkspace, parsed.data.nodeId).map(grantView) };
  });

  app.delete("/grants/:id", async (request) => {
    requireShareAdmin(ctx, request);
    const { id } = request.params as { id: string };
    if (!ctx.auth.revokeGrant(id)) {
      throw new AppError(404, "not_found", "no such live grant");
    }
    return { ok: true };
  });

  // The Shares Inbox — any authenticated USER (the operator key is not a
  // grantee: it owns everything and answers an empty inbox).
  app.get("/grants/inbox", async (request) => {
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    if (resolved.principal.kind !== "user") return { grants: [] };
    const userId = resolved.principal.userId;
    const grants = ctx.auth
      .grantInbox(userId)
      .filter((grant) => ctx.auth.membership(grant.workspaceId, userId) !== null);
    return {
      grants: grants.map((grant) => ({
        id: grant.id,
        workspaceId: grant.workspaceId,
        nodeId: grant.nodeId,
        role: grant.role,
        granteeUserId: grant.granteeUserId,
        granteeEmail: grant.granteeEmail,
        grantedByEmail: grant.grantedByEmail,
        grantedByDisplayName: grant.grantedByDisplayName,
        createdAt: grant.createdAt,
        /** The caller's membership role on the grant's workspace — "member"
         * marks the caller RESTRICTED there (write-guarded to edit closures);
         * the client gates hover previews on it. */
        workspaceRole: ctx.auth.membership(grant.workspaceId, userId),
      })),
    };
  });
}
