/**
 * Fastify assembly: plugins, the WIRE error envelope, request logging (pino
 * via fastify), the global 10k req/min per-IP fallback limiter, and the
 * public health/version probes. Every failure answer is the §3 envelope.
 */

import { mkdirSync } from "node:fs";

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";

import { StoreError, NotFoundError } from "@notees/store";

import type { ServerConfig } from "./config.js";
import { ServerContext } from "./context.js";
import { AppError, errorBody, type ErrorCode } from "./errors.js";
import { registerAssetRoutes } from "./assets.js";
import { registerObjectRoutes } from "./routes-objects.js";
import { registerRelayRoutes, requireApiKey } from "./routes-relay.js";

export const SERVER_VERSION = "2.0.0-m1";

export interface BuiltServer {
  app: FastifyInstance;
  ctx: ServerContext;
}

export async function buildServer(
  config: ServerConfig,
  options: { logger?: boolean } = {},
): Promise<BuiltServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const ctx = new ServerContext(config);
  const app = Fastify({
    logger: options.logger ?? config.logger,
    bodyLimit: 128 * 1024 * 1024,
  });

  // Cross-origin browser access (web client on another origin/port). Disabled
  // by default: with an empty corsOrigins no CORS headers are sent, so
  // same-origin and non-browser clients (CLI) are unaffected and browsers are
  // denied. Preflight (OPTIONS) is answered by the plugin before auth hooks.
  if (config.corsOrigins.length > 0) {
    await app.register(fastifyCors, {
      origin: config.corsOrigins.includes("*") ? "*" : config.corsOrigins,
      // The client may upload snapshots (PUT) and run other non-simple
      // methods cross-origin; fastify-cors defaults to GET/HEAD/POST only.
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    });
  }

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Math.max(config.maxMediaBytes, config.maxDocumentBytes) + 1024,
      files: 1,
      fields: 10,
    },
  });

  // Raw bodies (PUT /snapshot/data, octet-stream).
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  // Global fallback limiter: 10k requests/min per IP (WIRE.md §3).
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz") return;
    const ip = request.ip;
    if (
      !ctx.limiters.global.tryAcquire(`global:${ip}`, 1, config.globalRequestsPerMinute)
    ) {
      const body = errorBody(
        429,
        "rate_limited",
        `global rate limit exceeded (${config.globalRequestsPerMinute} req/min/IP)`,
      );
      reply.code(429).send(body);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.status).send(errorBody(error.status, error.code, error.message));
      return;
    }
    if (error instanceof NotFoundError) {
      reply.code(404).send(errorBody(404, "not_found", error.message));
      return;
    }
    if (error instanceof StoreError) {
      reply.code(422).send(errorBody(422, "validation_failed", error.message));
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      const code: ErrorCode = statusCode === 429 ? "rate_limited" : "validation_failed";
      reply.code(statusCode).send(errorBody(statusCode, code, (error as Error).message));
      return;
    }
    request.log.error(error);
    reply.code(500).send(errorBody(500, "internal", "internal server error"));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(errorBody(404, "not_found", "route not found"));
  });

  // Public probes (auth-free, for doctor and load balancers).
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/v1/version", async () => ({
    name: "notees-server",
    version: SERVER_VERSION,
    protocolVersion: 2,
    wsProtocolVersion: 2,
  }));

  await app.register(
    async (relay) => {
      registerRelayRoutes(relay, ctx);
    },
    { prefix: "/api/relay/v2" },
  );

  const apiAuth = async (request: import("fastify").FastifyRequest) => {
    requireApiKey(ctx, request);
  };

  await app.register(
    async (api) => {
      api.addHook("preHandler", apiAuth);
      registerObjectRoutes(api, ctx);
      registerAssetRoutes(api, ctx);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onClose", async () => {
    await ctx.close();
  });

  return { app, ctx };
}
