/**
 * Account routes — the user-facing auth surface of the sync server:
 *
 *  - GET  /server-info        unauthenticated: { setupRequired, version, … }
 *                             so a fresh client can choose between the
 *                             initial-setup screen and the login screen;
 *  - POST /setup              first-run only (refused once any user exists):
 *                             create the admin account, returns a session;
 *  - POST /auth/login         email + password → session token;
 *  - POST /auth/logout        revoke the current session (Bearer token);
 *  - GET  /auth/me            the authenticated account;
 *  - GET  /workspaces         the account's workspaces (membership view);
 *  - POST /workspaces         create a workspace (creator becomes owner).
 *
 * Sessions travel in the Authorization: Bearer header or the X-API-Key slot
 * (the sync transport already uses both — see transport.ts).
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { actorIdForUser, type Principal } from "./identity.js";
import { hashPassword, verifyPassword } from "./auth.js";

const emailSchema = z.string().trim().email();
const passwordSchema = z.string().min(8).max(256);

const loginBodySchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(256) })
  .strict();

const setupBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(120).optional(),
  })
  .strict();

const createWorkspaceSchema = z
  .object({ name: z.string().trim().max(120).optional() })
  .strict();

/** Extracts a credential from X-API-Key, Authorization: Bearer, or ?token=. */
export function extractCredential(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  // WebSocket clients put the credential in the query string (headers are
  // not settable on browser WebSocket upgrades).
  const query = request.query as { token?: unknown };
  if (typeof query.token === "string" && query.token.length > 0) return query.token;
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export interface ResolvedRequest {
  principal: Principal;
  /** The raw session token when the principal is an account (null for API key). */
  sessionToken: string | null;
}

/** Resolves the request credential to a principal (API key or session). */
export function resolvePrincipal(ctx: ServerContext, request: FastifyRequest): ResolvedRequest | null {
  const credential = extractCredential(request);
  if (credential === null) return null;
  if (constantTimeEquals(credential, ctx.config.apiKey)) {
    return { principal: { kind: "apikey", actorId: ctx.actorId }, sessionToken: null };
  }
  const session = ctx.auth.resolveSession(credential);
  if (session === null) return null;
  return {
    principal: {
      kind: "user",
      userId: session.user.id,
      actorId: actorIdForUser(session.user.id),
      isAdmin: session.user.isAdmin,
    },
    sessionToken: credential,
  };
}

export interface AccountRequest {
  principal: Extract<Principal, { kind: "user" }>;
  sessionToken: string;
}

/** preHandler for account routes: requires a session token (not the API key). */
export function requireAccount(ctx: ServerContext, request: FastifyRequest): AccountRequest {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null || resolved.sessionToken === null) {
    throw new AppError(401, "unauthenticated", "a valid session token is required");
  }
  return {
    principal: resolved.principal as Extract<Principal, { kind: "user" }>,
    sessionToken: resolved.sessionToken,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/server-info", async () => ({
    name: "notees-server",
    version: ctx.serverVersion,
    protocolVersion: 2,
    wsProtocolVersion: 2,
    setupRequired: ctx.auth.userCount() === 0,
  }));

  app.post("/setup", async (request, reply) => {
    if (ctx.auth.userCount() > 0) {
      throw new AppError(409, "already_provisioned", "setup is only available before any account exists");
    }
    const parsed = setupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid setup request");
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const user = ctx.auth.createUser({
      email: parsed.data.email,
      passwordHash,
      displayName: parsed.data.displayName ?? null,
      isAdmin: true,
    });
    // The first account owns the server's default workspace (the object/assets
    // API surface) so reads there never 403 before the first write.
    try {
      ctx.auth.createWorkspace({ id: ctx.defaultWorkspace, name: "Default", createdBy: user.id });
    } catch {
      // Row already exists (e.g. migration ran first).
    }
    ctx.auth.addMember(ctx.defaultWorkspace, user.id, "owner");
    const { token, expiresAt } = ctx.auth.createSession(user.id);
    reply.code(201);
    return {
      token,
      expiresAt,
      user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin: true },
    };
  });

  app.post("/auth/login", async (request) => {
    if (!ctx.limiters.login.tryAcquire(`login:${request.ip}`, 1, ctx.config.loginPerMinute)) {
      throw new AppError(
        429,
        "rate_limited",
        `too many login attempts (max ${ctx.config.loginPerMinute}/min)`,
      );
    }
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid login request");
    }
    const user = ctx.auth.findUserByEmail(parsed.data.email);
    // Verify against a dummy hash when the account is unknown so response
    // time does not reveal which emails exist.
    const stored = user?.passwordHash ?? ctx.dummyPasswordHash;
    const ok = await verifyPassword(parsed.data.password, stored);
    if (user === null || !ok) {
      throw new AppError(401, "invalid_credentials", "invalid email or password");
    }
    const { token, expiresAt } = ctx.auth.createSession(user.id);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isAdmin: user.isAdmin === 1,
      },
    };
  });

  app.post("/auth/logout", async (request) => {
    const { sessionToken } = requireAccount(ctx, request);
    ctx.auth.deleteSession(sessionToken);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const { principal } = requireAccount(ctx, request);
    const user = ctx.auth.findUserById(principal.userId);
    if (user === null) throw new AppError(401, "unauthenticated", "account no longer exists");
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin === 1,
    };
  });

  app.get("/workspaces", async (request) => {
    const { principal } = requireAccount(ctx, request);
    return {
      workspaces: ctx.auth.listWorkspacesForUser(principal.userId, (workspaceId) => ({
        envelopeCount: ctx.relay.stats(workspaceId).envelopeCount,
        latestSeq: ctx.relay.latestSeq(workspaceId),
      })),
    };
  });

  app.post("/workspaces", async (request, reply) => {
    const { principal } = requireAccount(ctx, request);
    const parsed = createWorkspaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid workspace request");
    }
    const id = ctx.auth.createWorkspace({
      name: parsed.data.name ?? null,
      createdBy: principal.userId,
    });
    ctx.auth.addMember(id, principal.userId, "owner");
    reply.code(201);
    return { id, name: parsed.data.name ?? null, role: "owner" };
  });
}
