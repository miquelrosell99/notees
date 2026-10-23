/**
 * Relay routes — WIRE.md implemented exactly: POST /batch, POST
 * /catch-up, GET /snapshot, GET|PUT /snapshot/data, POST /compact, GET /stats,
 * POST /tickets, and the /ws/{workspaceId} socket (hello/ops/ack/error frames,
 * framing version 2). Auth: the credential (operator API key or account
 * session token) travels as X-API-Key / Authorization on HTTP. The socket
 * takes the credential as an Authorization header (native clients) or a
 * short-lived single-use ticket minted here (browsers, which cannot set
 * upgrade headers — WIRE.md §2); the bearer credential never rides a URL.
 * Account principals are authorized per workspace via membership: a workspace
 * with no members is claimed by the first account that writes to it (owner);
 * reads require an existing membership.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import type { WebSocket } from "ws";

import type { Envelope } from "@notees/protocol";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import type { Principal } from "./identity.js";
import { resolvePrincipal, rethrowImageError } from "./routes-auth.js";
import { RelayValidationError, validateRelayBatch } from "./validate.js";
import { countSnapshotNodes } from "./relay-storage.js";
import { SNAPSHOT_REBUILD_MIN_ENVELOPES } from "./workspace-store.js";

const WS_PROTOCOL_VERSION = 2;

const catchUpBodySchema = z
  .object({
    workspaceId: z.string().uuid(),
    afterSeq: z.number().int().nonnegative().default(0),
    limit: z.number().int().default(1000),
  })
  .strict();

const compactBodySchema = z
  .object({
    workspaceId: z.string().uuid(),
    upToHlc: z.object({
      physical: z.number().int().nonnegative(),
      logical: z.number().int().nonnegative(),
    }),
    prune: z.boolean().default(false),
    dataBase64: z.string().default(""),
  })
  .strict();

const workspaceQuerySchema = z.object({ workspaceId: z.string().uuid() });

const snapshotPutQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  physical: z.coerce.number().int().nonnegative(),
  logical: z.coerce.number().int().nonnegative(),
  /** `import` installs the body as the workspace's derived store instead of publishing it as a client checkpoint. */
  mode: z.enum(["import"]).optional(),
});

/**
 * The client-produced snapshot PUT rides a RAISED, route-local bodyLimit —
 * 512 MiB against the app's global 128 MiB. Snapshot blobs are the largest bodies this API ever carries (a
 * big workspace's full local projection) and they are authenticated,
 * workspace-scoped, and size-bounded by the client's own store — the one
 * route where the headroom is deliberate, not a DoS surface. Every other
 * route keeps the global limit untouched.
 */
const SNAPSHOT_PUT_BODY_LIMIT = 512 * 1024 * 1024;

/**
 * Resolves the request credential (throws 401 when absent/invalid) and
 * enforces workspace membership for account principals. The operator API
 * key keeps its historical unrestricted access (CLI, owned devices).
 * `access: "write"` claims unclaimed workspaces for the first account.
 *
 * Scoped API keys are object-API credentials — the whole relay
 * surface (HTTP and the WebSocket) rejects them with 403 `scope_denied`.
 */
export function requireCredential(
  ctx: ServerContext,
  request: FastifyRequest,
  workspaceId?: string,
  access: "read" | "write" = "read",
): Principal {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
  if (resolved.scopes !== null) {
    throw new AppError(
      403,
      "scope_denied",
      "scoped API keys are not accepted on the relay surface — they are object-API credentials",
    );
  }
  if (workspaceId !== undefined) {
    authorizeWorkspace(ctx, resolved.principal, workspaceId, access);
  }
  return resolved.principal;
}

export function authorizeWorkspace(
  ctx: ServerContext,
  principal: Principal,
  workspaceId: string,
  access: "read" | "write",
): void {
  if (principal.kind === "apikey") return;
  if (ctx.auth.membership(workspaceId, principal.userId) !== null) return;
  if (access === "write" && !ctx.auth.hasAnyMembership(workspaceId)) {
    // First account to write to an unclaimed workspace adopts it — this is
    // also how a migrated workspace (data present, no membership rows yet)
    // is claimed by its owner. Migration assigns memberships explicitly.
    try {
      ctx.auth.createWorkspace({ id: workspaceId });
    } catch {
      // UNIQUE conflict: the workspace row already exists.
    }
    ctx.auth.addMember(workspaceId, principal.userId, "owner");
    return;
  }
  throw new AppError(
    403,
    "forbidden",
    access === "write"
      ? "this workspace belongs to another account"
      : "you are not a member of this workspace",
  );
}

export function registerRelayRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/batch", async (request) => {
    const principal = requireCredential(ctx, request);
    let envelopes: Envelope[];
    try {
      envelopes = validateRelayBatch(request.body);
    } catch (error) {
      if (error instanceof RelayValidationError) {
        throw new AppError(422, "validation_failed", error.message);
      }
      throw error;
    }
    for (const workspaceId of new Set(envelopes.map((env) => env.workspaceId))) {
      authorizeWorkspace(ctx, principal, workspaceId, "write");
    }
    const { savedIds } = await ctx.ingestBatch(envelopes);
    return { savedCount: savedIds.length, savedIds };
  });

  app.post("/catch-up", async (request) => {
    const parsed = catchUpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid catch-up request");
    }
    const { workspaceId, afterSeq } = parsed.data;
    const limit = Math.min(Math.max(parsed.data.limit, 1), 10_000);
    requireCredential(ctx, request, workspaceId, "read");
    const page = ctx.relay.catchUp(workspaceId, afterSeq, limit);
    return {
      envelopes: page.envelopes,
      nextAfterSeq: page.nextAfterSeq,
      hasMore: page.hasMore,
      restoreEpoch: ctx.relay.restoreEpoch(workspaceId),
      totalRemaining: page.totalRemaining,
    };
  });

  app.get("/snapshot", async (request) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
    const { workspaceId } = parsed.data;
    requireCredential(ctx, request, workspaceId, "read");
    const snapshot = ctx.relay.latestSnapshot(workspaceId);
    const restoreEpoch = ctx.relay.restoreEpoch(workspaceId);
    if (snapshot === null) {
      return {
        snapshotId: "",
        hlc: { physical: 0, logical: 0 },
        hasSnapshot: false,
        restoreEpoch,
        upToSeq: null,
      };
    }
    return {
      snapshotId: snapshot.id,
      hlc: { physical: snapshot.hlc_physical, logical: snapshot.hlc_logical },
      hasSnapshot: true,
      restoreEpoch,
      upToSeq: snapshot.up_to_seq,
    };
  });

  app.get("/snapshot/data", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
    requireCredential(ctx, request, parsed.data.workspaceId, "read");
    const snapshot = ctx.relay.latestSnapshot(parsed.data.workspaceId);
    if (snapshot === null) {
      throw new AppError(404, "not_found", "no snapshot for this workspace");
    }
    const bytes = ctx.relay.readSnapshotData(snapshot.id);
    if (bytes === null) {
      throw new AppError(404, "not_found", "snapshot blob missing on disk");
    }
    return reply.header("content-type", "application/octet-stream").send(bytes);
  });

  app.put("/snapshot/data", { bodyLimit: SNAPSHOT_PUT_BODY_LIMIT }, async (request, reply) => {
    const parsed = snapshotPutQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId, physical and logical query parameters required");
    }
    const { workspaceId, physical, logical, mode } = parsed.data;
    requireCredential(ctx, request, workspaceId, "write");
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError(422, "validation_failed", "snapshot data must be a non-empty binary body");
    }
    // mode=import: install the body as the workspace's DERIVED STORE (a
    // snapshot image — usually produced by POST /api/workspaces/:id/clone's
    // source side or a store export), not as a client checkpoint. The
    // workspace must be envelope-empty (hydration's snapshot fast path only
    // fires while the log is empty) and the sanity gate applies REGARDLESS
    // of the envelope threshold — an imported image below the threshold must
    // still be a derived store with node rows.
    if (mode === "import") {
      const nodes = countSnapshotNodes(body);
      if (nodes === null || nodes === 0) {
        throw new AppError(
          422,
          "validation_failed",
          "import failed the sanity gate: the body must be a derived store with node rows — refusing to install an empty or foreign image",
        );
      }
      let nodeCount: number;
      try {
        ({ nodeCount } = ctx.workspaces.installImage(workspaceId, body));
      } catch (error) {
        rethrowImageError(error);
      }
      const snapshotId = uuidv7();
      const upToSeq = ctx.relay.latestSeq(workspaceId);
      ctx.relay.saveSnapshot(workspaceId, snapshotId, { physical, logical }, upToSeq, body);
      reply.code(201);
      return {
        snapshotId,
        workspaceId,
        upToHlc: { physical, logical },
        upToSeq,
        nodeCount,
      };
    }
    // The sanity gate (owner incident 2026-10-21): for a workspace with a
    // real log, the uploaded checkpoint must be a parseable derived store
    // WITH node rows — an empty-store upload (a wiped/broken/old-device
    // client) would otherwise replace the good snapshot and blank every
    // fresh client's restore. Small logs stay exempt (a fresh workspace's
    // empty checkpoint is legitimate; the threshold mirrors the server's
    // own post-replay self-heal).
    if (ctx.relay.envelopeCount(workspaceId) > SNAPSHOT_REBUILD_MIN_ENVELOPES) {
      const nodes = countSnapshotNodes(body);
      if (nodes === null || nodes === 0) {
        throw new AppError(
          422,
          "validation_failed",
          "snapshot failed the sanity gate: not a derived store with node rows, " +
            `but the workspace log carries ${ctx.relay.envelopeCount(workspaceId)} envelopes — refusing to replace the checkpoint`,
        );
      }
    }
    const snapshotId = uuidv7();
    const upToSeq = ctx.relay.latestSeq(workspaceId);
    ctx.relay.saveSnapshot(workspaceId, snapshotId, { physical, logical }, upToSeq, body);
    reply.code(201);
    return {
      snapshotId,
      workspaceId,
      upToHlc: { physical, logical },
      upToSeq,
    };
  });

  app.post("/compact", async (request) => {
    const parsed = compactBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid compact request");
    }
    const { workspaceId, upToHlc, prune, dataBase64 } = parsed.data;
    requireCredential(ctx, request, workspaceId, "write");
    if (prune && dataBase64.length === 0) {
      throw new AppError(422, "validation_failed", "prune: true requires non-empty dataBase64");
    }
    let data: Buffer | null = null;
    if (dataBase64.length > 0) {
      data = Buffer.from(dataBase64, "base64");
      if (data.length === 0) {
        throw new AppError(422, "validation_failed", "dataBase64 did not decode to any bytes");
      }
    }
    const result = ctx.relay.compact(
      workspaceId,
      uuidv7(), // segmentId
      uuidv7(), // snapshotId
      upToHlc,
      prune,
      data ?? Buffer.alloc(0),
    );
    return {
      snapshotId: result.snapshotId,
      segmentId: result.segmentId,
      workspaceId,
      upToHlc,
      operationCount: result.operationCount,
    };
  });

  app.get("/stats", async (request) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
    requireCredential(ctx, request, parsed.data.workspaceId, "read");
    return ctx.relay.stats(parsed.data.workspaceId);
  });

  /**
   * Mint a WebSocket admission ticket (WIRE.md §2). Authenticated with the
   * normal credential headers; the ticket inherits the principal and is
   * bound to this workspace — single-use, 60 s, and worthless in a log.
   */
  app.post("/tickets", async (request) => {
    const parsed = z
      .object({ workspaceId: z.string().uuid() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid ticket request");
    }
    const { workspaceId } = parsed.data;
    const principal = requireCredential(ctx, request, workspaceId, "read");
    return ctx.tickets.mint(principal, workspaceId);
  });

  // --- WebSocket -------------------------------------------------------------

  // WIRE.md §2: the socket admits an Authorization header (native clients) or
  // ?ticket= (browsers — minted via POST /tickets just above). The preHandler
  // answers plain-HTTP probes and bad tickets with the 401 JSON envelope —
  // a ticket is consumed AT the handshake, so a refused upgrade never opens.
  const wsTicket = (request: FastifyRequest): string | null => {
    const query = request.query as { ticket?: unknown };
    return typeof query.ticket === "string" && query.ticket.length > 0 ? query.ticket : null;
  };

  interface WsUpgradeRequest extends FastifyRequest {
    /** Set by the preHandler when a ticket admits the upgrade. */
    wsPrincipal?: Principal;
  }

  const wsPreHandler = async (request: FastifyRequest) => {
    const { workspaceId } = request.params as { workspaceId: string };
    if (!z.string().uuid().safeParse(workspaceId).success) return; // handler answers with an error frame
    const upgrade = request as WsUpgradeRequest;
    const ticket = wsTicket(request);
    if (ticket !== null) {
      upgrade.wsPrincipal = ctx.tickets.consume(ticket, workspaceId);
      return;
    }
    requireCredential(ctx, request, workspaceId, "read");
  };

  app.get("/ws/:workspaceId", { websocket: true, preHandler: wsPreHandler }, (socket, request) => {
    const ws = socket as WebSocket;
    const { workspaceId } = request.params as { workspaceId: string };
    if (!z.string().uuid().safeParse(workspaceId).success) {
      ws.send(JSON.stringify({ type: "error", message: "invalid workspaceId" }));
      ws.close(1002, "invalid workspaceId");
      return;
    }
    let principal: Principal;
    try {
      principal =
        (request as WsUpgradeRequest).wsPrincipal ??
        requireCredential(ctx, request, workspaceId, "read");
    } catch {
      ws.close(1002, "unauthorized");
      return;
    }
    const send = (frame: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    send({
      type: "hello",
      wsProtocolVersion: WS_PROTOCOL_VERSION,
      restoreEpoch: ctx.relay.restoreEpoch(workspaceId),
      latestSeq: ctx.relay.latestSeq(workspaceId),
    });
    ctx.bus.subscribe(workspaceId, ws);

    ws.on("message", (raw: Buffer | string) => {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        send({ type: "error", message: "frame is not valid JSON" });
        return;
      }
      if (typeof frame !== "object" || frame === null) {
        send({ type: "error", message: "frame must be a JSON object" });
        return;
      }
      const typed = frame as { type?: unknown; wsProtocolVersion?: unknown; envelopes?: unknown };
      const type = typeof typed.type === "string" ? typed.type : undefined;
      // Fail loud on newer framing versions (WIRE.md).
      if (
        (type === "hello" || type === "ops") &&
        typeof typed.wsProtocolVersion === "number" &&
        typed.wsProtocolVersion > WS_PROTOCOL_VERSION
      ) {
        send({
          type: "error",
          message: `unsupported wsProtocolVersion ${typed.wsProtocolVersion} (server speaks ${WS_PROTOCOL_VERSION})`,
        });
        ws.close(1002, "unsupported framing version");
        return;
      }
      if (type === "batch") {
        handleSocketBatch(typed.envelopes).catch(() => undefined);
        return;
      }
      // Unknown frame types are ignored (WIRE.md).
    });

    ws.on("close", () => {
      ctx.bus.unsubscribe(workspaceId, ws);
    });
    ws.on("error", () => {
      ctx.bus.unsubscribe(workspaceId, ws);
    });

    async function handleSocketBatch(rawEnvelopes: unknown): Promise<void> {
      let envelopes: Envelope[];
      try {
        envelopes = validateRelayBatch({ envelopes: rawEnvelopes });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof RelayValidationError ? error.message : "invalid batch frame",
        });
        return;
      }
      try {
        for (const envWorkspaceId of new Set(envelopes.map((env) => env.workspaceId))) {
          authorizeWorkspace(ctx, principal, envWorkspaceId, "write");
        }
        const { savedIds } = await ctx.ingestBatch(envelopes);
        send({ type: "ack", savedIds });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "ingest failed",
        });
      }
    }
  });
}
