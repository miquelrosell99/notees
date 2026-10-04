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
 *  - POST /workspaces         create a workspace (creator becomes owner);
 *  - PATCH /workspaces/:id    rename a workspace (owner-only via membership);
 *  - GET  /workspaces/:id/export.zip
 *                             full-workspace ZIP export (§34.24 E5): one
 *                             Markdown file per page (roots + their
 *                             main-zone descendants), properties frontmatter,
 *                             relative links between the files, the bundle
 *                             manifest at the zip root as
 *                             notees-manifest.json, and — with
 *                             ?includeAssets=1 — the CAS bytes of every
 *                             asset_ref'd asset under assets/.
 *
 * Sessions travel in the Authorization: Bearer header or the X-API-Key slot
 * (the sync transport already uses both — see transport.ts).
 */

import { timingSafeEqual } from "node:crypto";

import { deriveDisplayName, parseDateNodeId, SYSTEM_PAGE_UUIDS } from "@notees/domain";
import type { ExportBundle, ExportContext, ExportNode } from "@notees/export";
import { bundleMarkdown, exportFileName } from "@notees/export";
import type { NodeRow } from "@notees/store";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { zipSync } from "fflate";

import { readAssetBytes } from "./assets.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { actorIdForUser, type Principal } from "./identity.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { parseApiScopes } from "./scopes.js";
import { fullObject } from "./routes-objects.js";

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

const renameWorkspaceSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();

const exportZipQuerySchema = z
  .object({
    /**
     * 1 bundles the CAS bytes of every asset the exported pages reference
     * (asset_ref) under assets/ and rewrites the Markdown refs to those
     * paths; 0 (default) keeps the raw uuid references and adds no bytes.
     */
    includeAssets: z.union([z.literal("0"), z.literal("1")]).optional(),
  })
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
function assignExportPaths(nodes: readonly ExportNode[]): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  for (const node of nodes) {
    let path = exportFileName(node, "slug");
    if (taken.has(path)) {
      const stem = path.replace(/\.md$/, "");
      let counter = 2;
      while (taken.has(`${stem}-${counter}.md`)) counter += 1;
      path = `${stem}-${counter}.md`;
    }
    taken.add(path);
    paths.set(node.id, path);
  }
  return paths;
}

/**
 * Re-point a rendered bundle's node files (and manifest entries) at the
 * pre-assigned paths. bundleMarkdown recomputes the policy names itself;
 * they agree with assignExportPaths except under a collision, where the
 * bundle still carries the duplicate. The node files are the bundle files
 * whose path equals the next manifest entry's path — the bundle emits one
 * `.md` per node in manifest order, followed by that node's whiteboard
 * sidecars — so the walk is deterministic.
 */
export function reassignExportPaths(bundle: ExportBundle, paths: Map<string, string>): void {
  let nodeIndex = 0;
  for (const file of bundle.files) {
    const entry = bundle.manifest.nodes[nodeIndex];
    if (entry === undefined) break;
    if (file.path !== entry.path) continue; // a sidecar, not the node's own file
    const assigned = paths.get(entry.id);
    if (assigned !== undefined) {
      file.path = assigned;
      entry.path = assigned;
    }
    nodeIndex += 1;
  }
}

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
  /** The raw session token when the principal is an account session (null for API keys). */
  sessionToken: string | null;
  /** The raw API key token when the principal authenticated via a user API key. */
  apiKeyToken?: string;
  /**
   * §34.33 AG3: the API key's scope set when the principal authenticated via
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

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/server-info", async () => ({
    name: "notees-server",
    version: ctx.serverVersion,
    protocolVersion: 3,
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
    const principal = requireUser(ctx, request);
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
    const principal = requireUser(ctx, request);
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

  // GET /workspaces/:id/export.zip — full-workspace ZIP export (§34.24 E5):
  // one Markdown file per page (top-level pages plus their main-zone child
  // pages, each rendered by @notees/export with properties frontmatter and
  // inline-body blocks as nested bullets), relative links between the files,
  // the bundle manifest at the zip root, and — with ?includeAssets=1 — the
  // CAS bytes of every referenced asset under assets/. Blocks are never
  // standalone files; classes are not exported.
  app.get("/workspaces/:id/export.zip", async (request, reply) => {
    const principal = requireUser(ctx, request);
    const { id } = request.params as { id: string };
    const parsed = exportZipQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid export query");
    }
    if (ctx.auth.membership(id, principal.userId) === null) {
      throw new AppError(404, "not_found", "no such workspace");
    }
    const store = ctx.workspaces.storeFor(id);
    const toExportNode = (row: NodeRow): ExportNode => {
      const object = fullObject(store, row);
      return {
        id: object.id,
        isClass: object.isClass ? 1 : 0,
        presentAsMain: object.presentAsMain ? 1 : 0,
        parentId: object.parentId,
        name: object.name,
        contentAst: object.contentAst as ExportNode["contentAst"],
        classIds: object.classIds,
        properties: object.properties.map((property) => ({
          schemaId: property.schemaId,
          schemaName: property.schemaName,
          value: property.value,
          ...(typeof property.metadata === "object" && property.metadata !== null && !Array.isArray(property.metadata)
            ? { metadata: property.metadata as Record<string, unknown> }
            : {}),
        })),
      };
    };
    const nameOf = (nodeId: string): string | undefined => {
      const row = store.database.prepare("SELECT * FROM node WHERE id = ?").get(nodeId) as
        | NodeRow
        | undefined;
      if (row === undefined) return undefined;
      return (
        deriveDisplayName({
          id: row.id,
          isClass: row.is_class,
          presentAsMain: row.present_as_main,
          name: row.name,
          contentAst: JSON.parse(row.content) as ExportNode["contentAst"],
          classIds: JSON.parse(row.class_ids) as string[],
        }) || undefined
      );
    };
    // The page set: workspace roots, then transitive descendants through the
    // main-children zone. Blocks (render bit unset) stay inside their page's
    // file; classes are never exported.
    //
    // §34.24 zip-roots exclusion (owner-via-register-recommendation,
    // 2026-10-04): the system-seed pages (scratchpad, inbox) and the whole
    // date chain (year/month/day nodes — 5,657 files of journal scaffolding
    // on the real workspace) stay OUT of the zip. Date-chain rows are
    // skipped at every level, so a user page parented under a day node is
    // skipped with the chain (the exclusion is documented in the export
    // options + SCHEMA.md zip conventions).
    const SYSTEM_ZIP_PAGE_IDS = new Set<string>(Object.values(SYSTEM_PAGE_UUIDS));
    const zipExcluded = (row: NodeRow): boolean =>
      SYSTEM_ZIP_PAGE_IDS.has(row.id) || parseDateNodeId(row.id) !== null;
    const pageRows: NodeRow[] = [];
    const seenPages = new Set<string>();
    const visitPage = (row: NodeRow): void => {
      if (seenPages.has(row.id) || zipExcluded(row)) return;
      seenPages.add(row.id);
      pageRows.push(row);
      for (const child of store.children(row.id)) {
        if (child.is_class === 0 && child.present_as_main === 1 && child.is_active === 1) {
          visitPage(child);
        }
      }
    };
    for (const root of store.roots(id)) visitPage(root);
    const exportNodes = pageRows.map(toExportNode);
    const pathById = assignExportPaths(exportNodes);

    // Assets (?includeAssets=1): scan the exported pages' rendered subtrees
    // (the page plus its inline-body descendants) for asset_ref tokens, then
    // map each asset to assets/<name-slug>-<hash8>.<ext> and read its bytes
    // from the local CAS. Unknown assets or missing bytes skip the file and
    // keep the raw uuid reference in the Markdown.
    const assetPaths = new Map<string, string>();
    const assetFiles: Array<{ path: string; bytes: Buffer }> = [];
    if (parsed.data.includeAssets === "1") {
      const inlineChildren = (row: NodeRow): NodeRow[] =>
        store
          .children(row.id)
          .filter((child) => child.is_class === 0 && child.present_as_main === 0 && child.is_active === 1);
      const assetRefIds = new Set<string>();
      const walkRefs = (row: NodeRow, visited: Set<string>): void => {
        if (visited.has(row.id)) return;
        visited.add(row.id);
        const ast = JSON.parse(row.content) as unknown;
        if (Array.isArray(ast)) {
          for (const token of ast) {
            if (
              typeof token === "object" &&
              token !== null &&
              (token as { type?: unknown }).type === "asset_ref" &&
              typeof (token as { assetId?: unknown }).assetId === "string"
            ) {
              assetRefIds.add((token as { assetId: string }).assetId);
            }
          }
        }
        for (const child of inlineChildren(row)) walkRefs(child, visited);
      };
      for (const row of pageRows) walkRefs(row, new Set<string>());
      const emittedPaths = new Set<string>();
      for (const assetId of assetRefIds) {
        const asset = ctx.relay.assetById(assetId);
        if (asset === null || asset.workspaceId !== id) continue;
        const bytes = readAssetBytes(ctx, id, asset.hash);
        if (bytes === null) continue;
        const path = `assets/${assetZipFileName(asset.originalName, asset.hash, asset.mimeType)}`;
        assetPaths.set(assetId, path);
        if (!emittedPaths.has(path)) {
          emittedPaths.add(path);
          assetFiles.push({ path, bytes });
        }
      }
    }

    const exportContext: ExportContext = {
      nameOf,
      childrenOf: (parentId) =>
        store
          .children(parentId)
          .filter((row) => row.is_class === 0 && row.present_as_main === 0 && row.is_active === 1)
          .map(toExportNode),
      // Relative links between the exported files (same zip directory).
      linkTarget: (nodeId) => {
        const path = pathById.get(nodeId);
        return path === undefined ? undefined : { path };
      },
      // Bundle-relative asset paths, only for assets whose bytes made it in.
      assetPath: (assetId) => assetPaths.get(assetId),
    };
    const bundle = bundleMarkdown(exportNodes, exportContext, {
      filenamePolicy: "slug",
      whiteboardMode: "sidecar",
    });
    reassignExportPaths(bundle, pathById);

    const entries: Record<string, Uint8Array> = {};
    for (const file of bundle.files) entries[file.path] = new TextEncoder().encode(file.content);
    for (const asset of assetFiles) entries[asset.path] = new Uint8Array(asset.bytes);
    entries["notees-manifest.json"] = new TextEncoder().encode(
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    );
    const workspaceName =
      (
        ctx.auth.listWorkspacesForUser(principal.userId, () => ({
          envelopeCount: 0,
          latestSeq: 0,
        })) as Array<{ id: string; name: string | null }>
      ).find((w) => w.id === id)?.name ?? id;
    const slug = slugifyName(workspaceName || "workspace") || "workspace";
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${slug}.zip"`)
      .send(Buffer.from(zipSync(entries)));
  });

  // GET /nodes/:id/location — which of the account's workspaces holds this
  // node. Deep-link resolution: a /<node-uuid> URL can then connect to the
  // right workspace instead of the remembered one. Only the caller's own
  // workspaces are searched, so a foreign node id returns 404.
  app.get("/nodes/:id/location", async (request) => {
    const principal = requireUser(ctx, request);
    const { id } = request.params as { id: string };
    const workspaces = ctx.auth.listWorkspacesForUser(principal.userId, () => ({
      envelopeCount: 0,
      latestSeq: 0,
    }));
    for (const workspace of workspaces) {
      const found = ctx.workspaces
        .storeFor(workspace.id)
        .database.prepare("SELECT 1 FROM node WHERE id = ?")
        .get(id);
      if (found !== undefined) return { workspaceId: workspace.id };
    }
    throw new AppError(404, "not_found", "node not found in any of your workspaces");
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
    // §34.33 AG3: an optional scope list makes the key a scoped object-API
    // credential; omitting it (or null) keeps the unrestricted M1 default.
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
