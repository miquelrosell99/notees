/**
 * Fastify assembly: plugins, the WIRE error envelope, request logging (pino
 * via fastify), the global 10k req/min per-IP fallback limiter, and the
 * public health/version probes. Every failure answer is the §3 envelope.
 *
 * §34.33 developer-API additions: the meta plugin (GET /api/meta,
 * /api/openapi.json, /api/operations), AG3 scoped-key enforcement on the
 * object/assets group (route scopes from the OpenAPI table), and the AG5
 * Idempotency-Key hooks on the same group. The registered-route inventory
 * (`BuiltServer.registeredRoutes`, collected via onRoute) feeds the
 * route-coverage test that keeps the OpenAPI document honest.
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
import { registerIdempotencyHooks } from "./idempotency.js";
import { registerAuthRoutes, resolvePrincipal } from "./routes-auth.js";
import { registerMetaRoutes } from "./routes-meta.js";
import { registerObjectRoutes } from "./routes-objects.js";
import { registerRelayRoutes, authorizeWorkspace } from "./routes-relay.js";
import { buildOpenApiDocument, documentedRoutes } from "./openapi.js";
import { buildRouteScopeMap, enforceRouteScope } from "./scopes.js";

export const SERVER_VERSION = "2.0.0-m6";

export interface BuiltServer {
  app: FastifyInstance;
  ctx: ServerContext;
  /** Every route registered on the app (method + full url), via onRoute. */
  registeredRoutes: Array<{ method: string; url: string }>;
}

export async function buildServer(
  config: ServerConfig,
  options: { logger?: boolean } = {},
): Promise<BuiltServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const ctx = new ServerContext(config, SERVER_VERSION);
  const app = Fastify({
    logger: options.logger ?? config.logger,
    bodyLimit: 128 * 1024 * 1024,
  });

  // Route inventory for the OpenAPI coverage test (test/openapi-coverage
  // .test.ts): every registered route must appear in the document.
  const registeredRoutes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      registeredRoutes.push({ method: String(method).toUpperCase(), url: route.url });
    }
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
  app.get("/api/version", async () => ({
    name: "notees-server",
    version: SERVER_VERSION,
    protocolVersion: 3,
    wsProtocolVersion: 2,
  }));

  // Developer self-description (§34.33 AG4/AG5): meta, the OpenAPI contract,
  // and the paginated operation feed. Each route enforces its own auth, so
  // this plugin has no group preHandler.
  const openApiDocument = buildOpenApiDocument(SERVER_VERSION);
  await app.register(
    async (api) => {
      registerMetaRoutes(api, ctx, openApiDocument);
    },
    { prefix: "/api" },
  );

  await app.register(
    async (relay) => {
      registerRelayRoutes(relay, ctx);
    },
    { prefix: "/api/relay/v2" },
  );

  // Account surface: server-info/setup/login are UNAUTHENTICATED (the client
  // needs them to decide which first-run screen to show); auth/me, logout,
  // and the workspace list live here too, gated per-route by requireAccount.
  await app.register(
    async (api) => {
      registerAuthRoutes(api, ctx);
    },
    { prefix: "/api" },
  );

  // The object/assets machine API: any authenticated principal (operator API
  // key, account session, or per-user API key) — v1 of multi-account object
  // authorization is the default workspace, claimed by the first account
  // (see routes-auth /setup). Scoped API keys (§34.33 AG3) pass auth here
  // and are then checked against the route's scope from the OpenAPI table;
  // the relay surface rejects them outright.
  const routeScopes = buildRouteScopeMap(documentedRoutes());
  const apiAuth = async (request: import("fastify").FastifyRequest) => {
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    authorizeWorkspace(ctx, resolved.principal, ctx.defaultWorkspace, "write");
    enforceRouteScope(request, resolved.scopes, routeScopes);
  };

  await app.register(
    async (api) => {
      api.addHook("preHandler", apiAuth);
      // §34.33 AG5: Idempotency-Key replay after auth+scope, so a replayed
      // mutation still requires the caller's credentials and scope.
      registerIdempotencyHooks(api, ctx);
      registerObjectRoutes(api, ctx);
      registerAssetRoutes(api, ctx);
    },
    { prefix: "/api" },
  );

  app.addHook("onClose", async () => {
    await ctx.close();
  });

  return { app, ctx, registeredRoutes };
}
