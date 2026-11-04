/**
 * Account routes — the user-facing auth surface of the sync server:
 *
 *  - GET  /server-info        unauthenticated: { setupRequired, version, … }
 *                             so a fresh client can choose between the
 *                             initial-setup screen and the login screen;
 *  - POST /setup              first-run only (refused once any user exists):
 *                             create the admin account, returns a session;
 *  - POST /auth/signup        open registration (NOTEES_SIGNUP_ENABLED only):
 *                             create a non-admin account, returns a session.
 *                             When the flag is off the route answers 404 —
 *                             the surface does not exist at all;
 *  - POST /auth/login         email + password → session token;
 *  - POST /auth/logout        revoke the current session (Bearer token);
 *  - GET  /auth/me            the authenticated account;
 *  - GET  /workspaces         the account's workspaces (membership view);
 *  - POST /workspaces         create a workspace (creator becomes owner);
 *  - PATCH /workspaces/:id    rename a workspace (owner-only via membership);
 *  - GET/PUT /workspaces/:id/key
 *                             the E2EE custody surface: one opaque wrapped-key
 *                             string per workspace (member-scoped; GET 404s
 *                             for non-members and keyless workspaces);
 *
 * Sessions travel in the Authorization: Bearer header or the X-API-Key slot
 * (the sync transport already uses both — see transport.ts).
 */

import { timingSafeEqual } from "node:crypto";

import {
  deriveDisplayName,
  LEGACY_SCRATCHPAD_PAGE_ID,
  parseDateNodeId,
  SYSTEM_PAGE_UUIDS,
} from "@notees/domain";
import type { NodeRow } from "@notees/store";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { actorIdForUser, type Principal } from "./identity.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { parseApiScopes } from "./scopes.js";
import { WorkspaceImageError } from "./workspace-store.js";

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

const signupBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(120).optional(),
  })
  .strict();

const createWorkspaceSchema = z
  .object({ name: z.string().trim().max(120).optional() })
  .strict();

const renameWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();

/** The E2EE custody body: one opaque wrapped-key string (client-wrapped). */
const workspaceKeySchema = z
  .object({ wrappedKey: z.string().min(1).max(4096) })
  .strict();

/** The workspace-name slug idiom (unicode letters/numbers, `-` separators). */
function slugifyName(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/**
 * Zip file naming for one asset: `assets/<original-name-slug>-<hash8>.<ext>`.
 * The extension prefers the upload's original name (sanitized to a short
 * alphanumeric token); a nameless upload falls back to the sniffed mime
 * mapping, then to `bin`. The hash8 suffix keeps identical names unique.
 */
function assetZipFileName(originalName: string, hash: string, mimeType: string): string {
  const slug = slugifyName(originalName.replace(/\.[A-Za-z0-9]{1,8}$/, ""));
  const dot = originalName.lastIndexOf(".");
  const rawExt = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : (ASSET_MIME_EXTENSIONS[mimeType] ?? "bin");
  return `${slug.length > 0 ? `${slug}-` : ""}${hash.slice(0, 8)}.${ext}`;
}

const ASSET_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
};

/**
 * Deterministic filename assignment for the exported pages: the slug
 * policy's `<title-slug>-<uuid8>.md` with uuid8 fallback for empty titles;
 * when two pages STILL collide (same title authored inside the same
 * uuidv7 timestamp window), the later page gains `-2`, `-3`, … before the
 * extension. The uuid→path map is computed BEFORE rendering because the
 * markdown link rewriting consults it.
 */

/** Extracts a credential from X-API-Key or Authorization: Bearer.
 *
 * Query-string credentials were retired (2026-10-22): a bearer token in a
 * URL lands in every proxy/access/error log along the way. Browser
 * WebSocket clients mint a short-lived single-use ticket instead
 * (POST /tickets, WIRE.md §2); native clients set headers normally.
 */
export function extractCredential(request: FastifyRequest): string | null {
  const header = request.headers["x-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const authorization = request.headers.authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
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
  /** The raw session token when the principal is an account session (null for API keys). */
  sessionToken: string | null;
  /** The raw API key token when the principal authenticated via a user API key. */
  apiKeyToken?: string;
  /**
   * The API key's scope set when the principal authenticated via
   * a scoped user API key; null means unrestricted (operator key, sessions,
   * and keys minted without a scope list).
   */
  scopes: string[] | null;
}

/** Resolves the request credential to a principal (API key, session, or user API key). */
export function resolvePrincipal(ctx: ServerContext, request: FastifyRequest): ResolvedRequest | null {
  const credential = extractCredential(request);
  if (credential === null) return null;
  if (constantTimeEquals(credential, ctx.config.apiKey)) {
    return { principal: { kind: "apikey", actorId: ctx.actorId }, sessionToken: null, scopes: null };
  }
  const session = ctx.auth.resolveSession(credential);
  if (session !== null) {
    return {
      principal: {
        kind: "user",
        userId: session.user.id,
        actorId: actorIdForUser(session.user.id),
        isAdmin: session.user.isAdmin,
      },
      sessionToken: credential,
      scopes: null,
    };
  }
  const apiKey = ctx.auth.resolveApiKey(credential);
  if (apiKey !== null) {
    return {
      principal: {
        kind: "user",
        userId: apiKey.userId,
        actorId: actorIdForUser(apiKey.userId),
        isAdmin: apiKey.isAdmin,
      },
      sessionToken: null,
      apiKeyToken: credential,
      scopes: apiKey.scopes,
    };
  }
  return null;
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

/**
 * Any user-authenticated principal (session or user API key). Used by routes
 * that describe the account or its workspaces — a minted API key is how
 * machines (and the web client's API-key sign-in) discover where to sync.
 */
export function requireUser(
  ctx: ServerContext,
  request: FastifyRequest,
): Extract<Principal, { kind: "user" }> {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null || resolved.principal.kind !== "user") {
    throw new AppError(401, "unauthenticated", "a valid session or API key is required");
  }
  return resolved.principal as Extract<Principal, { kind: "user" }>;
}

/**
 * The account-DISCOVERY guard: the identity read and the workspace list the
 * web client's API-key sign-in (and machine clients) need to find where to
 * sync. Accepts any user principal (session or per-user key) OR the operator
 * key — the operator is the deployment owner and its data-plane access is
 * already unrestricted, so hiding the workspace directory from it buys
 * nothing. Everything mutating (profile, prefs, key minting, workspace
 * create/rename) stays user-bound via requireUser/requireAccount.
 */
export function requireUserOrOperator(
  ctx: ServerContext,
  request: FastifyRequest,
): ResolvedRequest {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "a valid session or API key is required");
  }
  return resolved;
}

/** The operator key's synthetic identity (GET /auth/me) — the web client's API-key tab renders it like any account. */
export const OPERATOR_IDENTITY = {
  id: "operator",
  email: "operator",
  displayName: "Operator",
  name: null,
  surnames: null,
  avatarUrl: null,
  isAdmin: true,
} as const;

/** Maps a WorkspaceManager image refusal onto the error envelope; rethrows anything else. */
export function rethrowImageError(error: unknown): never {
  if (error instanceof WorkspaceImageError) {
    throw new AppError(
      error.status,
      error.status === 409 ? "conflict" : "validation_failed",
      error.message,
    );
  }
  throw error;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/server-info", async () => ({
    name: "notees-server",
    version: ctx.serverVersion,
    protocolVersion: 3,
    wsProtocolVersion: 2,
    setupRequired: ctx.auth.userCount() === 0,
    signupEnabled: ctx.config.signupEnabled,
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
    // Password-derived encryption key record (E2EE groundwork): the master
    // key is wrapped with the password-derived key; only the wrapped form
    // and a verifier tag are stored.
    const kdf = await ctx.auth.ensureKdfRecord(user.id, parsed.data.password);
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
      user: { id: user.id, email: user.email, displayName: user.displayName, name: user.name, surnames: user.surnames, avatarUrl: user.avatarUrl, isAdmin: true },
      kdf,
    };
  });

  app.post("/auth/signup", async (request, reply) => {
    // Gated by NOTEES_SIGNUP_ENABLED: when off the surface does not exist at
    // all (404, not 403) — same contract as the sonarly signup gate.
    if (!ctx.config.signupEnabled) {
      throw new AppError(404, "not_found", "not found");
    }
    if (!ctx.limiters.login.tryAcquire(`signup:${request.ip}`, 1, ctx.config.loginPerMinute)) {
      throw new AppError(
        429,
        "rate_limited",
        `too many signup attempts (max ${ctx.config.loginPerMinute}/min)`,
      );
    }
    const parsed = signupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid signup request");
    }
    if (ctx.auth.findUserByEmail(parsed.data.email) !== null) {
      throw new AppError(409, "conflict", "an account with this email already exists");
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const user = ctx.auth.createUser({
      email: parsed.data.email,
      passwordHash,
      displayName: parsed.data.displayName ?? null,
      isAdmin: false,
    });
    const kdf = await ctx.auth.ensureKdfRecord(user.id, parsed.data.password);
    const { token, expiresAt } = ctx.auth.createSession(user.id);
    reply.code(201);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        name: user.name,
        surnames: user.surnames,
        avatarUrl: user.avatarUrl,
        isAdmin: false,
      },
      kdf,
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
    const email = parsed.data.email;
    // Per-account lockout (5 failures → 15 min), keyed by normalized email —
    // checked before the IP limiter would even matter and before verifying,
    // so a locked account stays silent about whether the password was right.
    const lock = ctx.lockout.status(email);
    if (lock.locked) {
      throw new AppError(
        429,
        "account_locked",
        `too many failed attempts — try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minutes`,
      );
    }
    const user = ctx.auth.findUserByEmail(email);
    // Verify against a dummy hash when the account is unknown so response
    // time does not reveal which emails exist.
    const stored = user?.passwordHash ?? ctx.dummyPasswordHash;
    const ok = await verifyPassword(parsed.data.password, stored);
    if (user === null || !ok) {
      const after = ctx.lockout.recordFailure(email);
      if (after.locked) {
        throw new AppError(
          429,
          "account_locked",
          `too many failed attempts — try again in ${Math.ceil(after.retryAfterSeconds / 60)} minutes`,
        );
      }
      throw new AppError(401, "invalid_credentials", "invalid email or password");
    }
    ctx.lockout.recordSuccess(email);
    const { token, expiresAt } = ctx.auth.createSession(user.id);
    // Backfill the password-derived key record for accounts that predate it
    // (the plaintext password is only in memory here, so this is the one
    // place the upgrade can happen).
    const kdf = await ctx.auth.ensureKdfRecord(user.id, parsed.data.password);
    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        name: user.name,
        surnames: user.surnames,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin === 1,
      },
      kdf,
    };
  });

  app.post("/auth/logout", async (request) => {
    const { sessionToken } = requireAccount(ctx, request);
    ctx.auth.deleteSession(sessionToken);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const resolved = requireUserOrOperator(ctx, request);
    // The operator key answers as its synthetic owner identity — it is not a
    // row in the accounts table.
    if (resolved.principal.kind === "apikey") return { ...OPERATOR_IDENTITY };
    const principal = resolved.principal as Extract<Principal, { kind: "user" }>;
    const user = ctx.auth.findUserById(principal.userId);
    if (user === null) throw new AppError(401, "unauthenticated", "account no longer exists");
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      name: user.name,
      surnames: user.surnames,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin === 1,
    };
  });

  app.patch("/auth/me", async (request) => {
    const principal = requireUser(ctx, request);
    const parsed = z
      .object({
        displayName: z.string().trim().max(120).nullable().optional(),
        name: z.string().trim().max(60).nullable().optional(),
        surnames: z.string().trim().max(120).nullable().optional(),
        avatarUrl: z.string().trim().max(500).nullable().optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid profile update");
    }
    ctx.auth.updateProfile(principal.userId, parsed.data);
    const user = ctx.auth.findUserById(principal.userId);
    if (user === null) throw new AppError(401, "unauthenticated", "account no longer exists");
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      name: user.name,
      surnames: user.surnames,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin === 1,
    };
  });

  app.get("/workspaces", async (request) => {
    const resolved = requireUserOrOperator(ctx, request);
    // The operator key sees the whole directory (role "operator"): the
    // workspace table plus any id present only in the relay log — imported
    // and migrated workspaces included.
    if (resolved.principal.kind === "apikey") {
      return {
        workspaces: ctx.auth.listAllWorkspaces((workspaceId) => ({
          envelopeCount: ctx.relay.stats(workspaceId).envelopeCount,
          latestSeq: ctx.relay.latestSeq(workspaceId),
        })),
      };
    }
    const principal = resolved.principal as Extract<Principal, { kind: "user" }>;
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

  app.patch("/workspaces/:id", async (request) => {
    const { principal } = requireAccount(ctx, request);
    const { id } = request.params as { id: string };
    const parsed = renameWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid workspace rename request");
    }
    // Owner-only via membership: non-members get a 404 (the workspace's
    // existence is not revealed), members without the owner role get a 403.
    const role = ctx.auth.membership(id, principal.userId);
    if (role === null) {
      throw new AppError(404, "not_found", "no such workspace");
    }
    if (role !== "owner") {
      throw new AppError(403, "forbidden", "only the workspace owner can rename it");
    }
    ctx.auth.renameWorkspace(id, parsed.data.name);
    return { id, name: parsed.data.name };
  });

  // DELETE removes the workspace AND its data (relay log, snapshots, derived
  // db). Owner-only; the confirmation lives in the client.
  app.delete("/workspaces/:id", async (request) => {
    const { principal } = requireAccount(ctx, request);
    const { id } = request.params as { id: string };
    const role = ctx.auth.membership(id, principal.userId);
    if (role === null) {
      throw new AppError(404, "not_found", "no such workspace");
    }
    if (role !== "owner") {
      throw new AppError(403, "forbidden", "only the workspace owner can delete it");
    }
    await ctx.workspaces.drop(id);
    ctx.relay.deleteWorkspaceData(id);
    ctx.auth.deleteWorkspace(id);
    return { ok: true };
  });

  // POST /workspaces/:id/clone — snapshot-image clone into a FRESH workspace:
  // a consistent image of the source's derived store becomes the target's
  // initial state (workspace_id rewritten; the source must carry node rows).
  // The clone's relay log starts EMPTY — the snapshot row installed below is
  // load-bearing: a derived wipe rehydrates from the snapshot, not a log
  // that has nothing but the import-time checkpoint. Owner-only, same
  // membership shape as DELETE; a failure after createWorkspace rolls the
  // half workspace back best-effort.
  app.post("/workspaces/:id/clone", async (request, reply) => {
    const { principal } = requireAccount(ctx, request);
    const { id: sourceId } = request.params as { id: string };
    const role = ctx.auth.membership(sourceId, principal.userId);
    if (role === null) {
      throw new AppError(404, "not_found", "no such workspace");
    }
    if (role !== "owner") {
      throw new AppError(403, "forbidden", "only the workspace owner can clone it");
    }
    const parsed = createWorkspaceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid clone request");
    }
    let bytes: Buffer;
    try {
      bytes = await ctx.workspaces.snapshotImage(sourceId);
    } catch (error) {
      rethrowImageError(error);
    }
    const name = parsed.data.name ?? null;
    const id = ctx.auth.createWorkspace({ name, createdBy: principal.userId });
    ctx.auth.addMember(id, principal.userId, "owner");
    let nodeCount: number;
    try {
      ({ nodeCount } = ctx.workspaces.installImage(id, bytes));
      ctx.relay.saveSnapshot(
        id,
        uuidv7(),
        ctx.relay.maxHlc(sourceId),
        ctx.relay.latestSeq(id),
        bytes,
      );
    } catch (error) {
      // Best-effort rollback — a failed clone must not leave a half workspace.
      try {
        await ctx.workspaces.drop(id);
      } catch {
        // Cleanup is best-effort.
      }
      try {
        ctx.relay.deleteWorkspaceData(id);
        ctx.auth.deleteWorkspace(id);
      } catch {
        // Cleanup is best-effort.
      }
      rethrowImageError(error);
    }
    reply.code(201);
    return { id, name, nodeCount };
  });

  // GET/PUT /workspaces/:id/key — the E2EE custody surface. The server stores
  // ONE opaque wrapped-key string per workspace (the client wraps the
  // workspace key with the account master key; the server never sees either
  // key). Authorization (Review Focus 1): a USER principal with membership;
  // a user without membership gets 404 on GET (key existence is not
  // revealed) and 403 on PUT; an API-key principal (the operator key) gets
  // 403 on both — keys are user custody, not operator; unauthenticated 401.
  app.get("/workspaces/:id/key", async (request) => {
    const { id } = request.params as { id: string };
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "a valid session or API key is required");
    }
    if (resolved.principal.kind !== "user") {
      throw new AppError(403, "forbidden", "workspace keys are user custody; an API-key principal cannot read them");
    }
    if (ctx.auth.membership(id, resolved.principal.userId) === null) {
      throw new AppError(404, "not_found", "no such workspace");
    }
    const wrappedKey = ctx.auth.getWorkspaceKey(id);
    if (wrappedKey === undefined) {
      throw new AppError(404, "not_found", "no workspace key stored");
    }
    return { wrappedKey };
  });

  app.put("/workspaces/:id/key", async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "a valid session or API key is required");
    }
    if (resolved.principal.kind !== "user") {
      throw new AppError(403, "forbidden", "workspace keys are user custody; an API-key principal cannot write them");
    }
    if (ctx.auth.membership(id, resolved.principal.userId) === null) {
      throw new AppError(403, "forbidden", "only a workspace member can store its key");
    }
    const parsed = workspaceKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid workspace key request");
    }
    // First write wins: an existing row is NEVER overwritten. Two devices
    // opening a never-keyed workspace concurrently both GET 404 and race
    // their PUTs — the loser must learn it lost (409), fetch the winner's
    // wrapped key, and unwrap THAT (a blind upsert here would permanently
    // split the workspace's keys).
    if (ctx.auth.getWorkspaceKey(id) !== undefined) {
      throw new AppError(409, "conflict", "a workspace key already exists; fetch and unwrap it instead");
    }
    ctx.auth.putWorkspaceKey(id, parsed.data.wrappedKey);
    reply.code(204);
    return reply.send();
  });

  // --- API keys (session-managed; the keys themselves authenticate as the user) ----

  app.get("/api-keys", async (request) => {
    const { principal } = requireAccount(ctx, request);
    return { apiKeys: ctx.auth.listApiKeys(principal.userId) };
  });

  app.post("/api-keys", async (request, reply) => {
    const { principal } = requireAccount(ctx, request);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(120), scopes: z.unknown().optional() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "name is required");
    }
    // An optional scope list makes the key a scoped object-API
    // credential; omitting it (or null) keeps the unrestricted default.
    const scopes = parseApiScopes(parsed.data.scopes);
    if (scopes === null) {
      throw new AppError(422, "validation_failed", "scopes must be an array of known scope names");
    }
    const { row, token } = ctx.auth.createApiKey(principal.userId, parsed.data.name, scopes);
    reply.code(201);
    // The full token is returned exactly once; only its sha256 is stored.
    return { apiKey: row, token };
  });

  app.delete("/api-keys/:id", async (request) => {
    const { id } = request.params as { id: string };
    const resolved = resolvePrincipal(ctx, request);
    if (resolved === null) {
      throw new AppError(401, "unauthenticated", "invalid or missing credentials");
    }
    if (resolved.sessionToken !== null) {
      // Account session: revoke any of the user's keys.
      const { principal } = requireAccount(ctx, request);
      const revoked = ctx.auth.revokeApiKey(principal.userId, id);
      if (!revoked) {
        throw new AppError(404, "not_found", "no such API key (or already revoked)");
      }
      return { ok: true };
    }
    if (resolved.apiKeyToken !== undefined) {
      // Self-revocation: a key may revoke ITSELF (the CLI's `notees auth
      // logout` holds no session); other keys still require an account
      // session — possession of one key must not manage the rest.
      const own = ctx.auth.resolveApiKey(resolved.apiKeyToken);
      if (own === null || own.keyId !== id) {
        throw new AppError(401, "unauthenticated", "an API key may only revoke itself; use a session for other keys");
      }
      ctx.auth.revokeApiKey(own.userId, own.keyId);
      return { ok: true };
    }
    throw new AppError(401, "unauthenticated", "a valid session token is required");
  });
}
