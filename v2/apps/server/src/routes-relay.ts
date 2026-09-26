/**
 * Relay routes — WIRE.md §1–2 implemented exactly: POST /batch, POST
 * /catch-up, GET /snapshot, GET|PUT /snapshot/data, POST /compact, GET /stats,
 * and the /ws/{workspaceId} socket (hello/ops/ack/error frames, framing
 * version 2). Auth: X-API-Key on HTTP, ?token= or Authorization on the socket.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import type { WebSocket } from "ws";

import type { Envelope } from "@notees/protocol";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { constantTimeKeyEqual } from "./identity.js";
import { RelayValidationError, validateRelayBatch } from "./validate.js";

const WS_PROTOCOL_VERSION = 2;

export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return null;
}

export function requireApiKey(ctx: ServerContext, request: FastifyRequest): void {
  const key = extractApiKey(request);
  if (key === null || !constantTimeKeyEqual(key, ctx.config.apiKey)) {
    throw new AppError(401, "unauthenticated", "invalid or missing API key");
  }
}

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
});

export function registerRelayRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const relayPreHandler = async (request: FastifyRequest) => {
    requireApiKey(ctx, request);
  };

  app.post("/batch", { preHandler: relayPreHandler }, async (request) => {
    let envelopes: Envelope[];
    try {
      envelopes = validateRelayBatch(request.body);
    } catch (error) {
      if (error instanceof RelayValidationError) {
        throw new AppError(422, "validation_failed", error.message);
      }
      throw error;
    }
    const { savedIds } = await ctx.ingestBatch(envelopes);
    return { savedCount: savedIds.length, savedIds };
  });

  app.post("/catch-up", { preHandler: relayPreHandler }, async (request) => {
    const parsed = catchUpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid catch-up request");
    }
    const { workspaceId, afterSeq } = parsed.data;
    const limit = Math.min(Math.max(parsed.data.limit, 1), 10_000);
    const page = ctx.relay.catchUp(workspaceId, afterSeq, limit);
    return {
      envelopes: page.envelopes,
      nextAfterSeq: page.nextAfterSeq,
      hasMore: page.hasMore,
      restoreEpoch: ctx.relay.restoreEpoch(workspaceId),
      totalRemaining: page.totalRemaining,
    };
  });

  app.get("/snapshot", { preHandler: relayPreHandler }, async (request) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
    const { workspaceId } = parsed.data;
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

  app.get("/snapshot/data", { preHandler: relayPreHandler }, async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
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

  app.put("/snapshot/data", { preHandler: relayPreHandler }, async (request, reply) => {
    const parsed = snapshotPutQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId, physical and logical query parameters required");
    }
    const { workspaceId, physical, logical } = parsed.data;
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError(422, "validation_failed", "snapshot data must be a non-empty binary body");
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

  app.post("/compact", { preHandler: relayPreHandler }, async (request) => {
    const parsed = compactBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid compact request");
    }
    const { workspaceId, upToHlc, prune, dataBase64 } = parsed.data;
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

  app.get("/stats", { preHandler: relayPreHandler }, async (request) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", "workspaceId (uuid) query parameter required");
    }
    return ctx.relay.stats(parsed.data.workspaceId);
  });

  // --- WebSocket -------------------------------------------------------------

  // WIRE.md: socket auth via ?token= (API key) or the Authorization header.
  const wsPreHandler = async (request: FastifyRequest) => {
    const query = request.query as { token?: unknown };
    if (typeof query.token === "string" && constantTimeKeyEqual(query.token, ctx.config.apiKey)) {
      return;
    }
    requireApiKey(ctx, request);
  };

  app.get("/ws/:workspaceId", { websocket: true, preHandler: wsPreHandler }, (socket, request) => {
    const ws = socket as WebSocket;
    const { workspaceId } = request.params as { workspaceId: string };
    if (!z.string().uuid().safeParse(workspaceId).success) {
      ws.send(JSON.stringify({ type: "error", message: "invalid workspaceId" }));
      ws.close(1002, "invalid workspaceId");
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
      // Fail loud on newer framing versions (WIRE.md §2).
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
      // Unknown frame types are ignored (WIRE.md §2).
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
