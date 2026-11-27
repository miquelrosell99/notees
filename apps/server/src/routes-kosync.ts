/**
 * KOReader Progress Sync (kosync) endpoints — the sync-server half of the
 * koreader connector. Mounted under /api/kosync; a KOReader device points
 * its "Progress sync → Custom sync server" at `<server>/api/kosync` and the
 * e-reader's pushes land in the reading tracker like any other write.
 *
 * Protocol (the de-facto kosync shape shared by the official
 * koreader-sync-server, kosync-dotnet, and the field's implementations —
 * verified 2026-11-27 against the public specs):
 *
 *  - GET  /kosync/healthcheck           → { state: "OK" }   (also /health)
 *  - POST /kosync/users/create          → register { username, password };
 *                                         REQUIRES Notees auth (registration
 *                                         is a Notees-side gesture — the web
 *                                         settings or an operator call; the
 *                                         device flow uses Login with the
 *                                         same user/pass). 409 when taken.
 *  - GET  /kosync/users/auth            → kosync auth (x-auth-user /
 *                                         x-auth-key headers; the key rides
 *                                         as KOReader sends it — md5(password)
 *                                         on the wire — stored verbatim).
 *  - PUT  /kosync/syncs/progress        → upsert { document, progress,
 *                                         percentage, device, device_id,
 *                                         metadata? { filename, title,
 *                                         authors } }. The timestamp is
 *                                         SERVER-assigned and MONOTONIC: an
 *                                         older PUT is a successful no-op
 *                                         (a delayed retry must never roll
 *                                         back a newer position).
 *  - GET  /kosync/syncs/progress/:doc   → the stored record, 404 when absent.
 *  - GET  /kosync/syncs/documents       → every document for the user, newest
 *                                         first (dashboards; unused by the
 *                                         KOReader client).
 *
 * The tracker mirror: when the workspace carries the reading-tracker
 * vocabulary (`Estado` select + `Primera lectura` / `Última lectura`), a PUT
 * whose metadata title matches a source node (normalized-containment, the
 * koreader.ts idiom) mirrors the state — percentage ≥ 0.99 → Consumido
 * (both read dates, primera fill-once, última overwrite), otherwise Leyendo
 * (última only). kosync carries no "abandoned" state and no reading
 * timestamps, so Abandonado el stays untouched and the server timestamp is
 * the honest date. Unmatched documents still store progress (the table is
 * the durability boundary; matching UI is proposal-phase work).
 *
 * Storage: two relay.db tables (CREATE-IF-NOT-EXISTS — coordination state,
 * the prefs/shares/plugin ruling: NOT log state).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { chainNodeIds, dateNodeLabel, parseIsoDate, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal } from "./routes-auth.js";
import { workspaceFor } from "./routes-objects.js";

const DDL = `
CREATE TABLE IF NOT EXISTS kosync_user (
    username TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kosync_progress (
    username TEXT NOT NULL,
    document TEXT NOT NULL,
    progress TEXT NOT NULL,
    percentage REAL NOT NULL,
    device TEXT,
    device_id TEXT,
    filename TEXT,
    title TEXT,
    authors TEXT,
    timestamp INTEGER NOT NULL,
    PRIMARY KEY (username, document)
);
`;

const createBodySchema = z
  .object({
    username: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(256),
  })
  .strict();

const progressBodySchema = z
  .object({
    document: z.string().trim().min(1).max(64),
    progress: z.string().max(4096),
    percentage: z.number().min(0).max(1),
    device: z.string().trim().max(64).default(""),
    device_id: z.string().trim().max(64).default(""),
    metadata: z
      .object({
        filename: z.string().trim().max(1024).optional(),
        title: z.string().trim().max(1024).optional(),
        authors: z.string().trim().max(1024).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

interface KosyncUserRow {
  username: string;
  key: string;
  workspace_id: string;
}

interface KosyncProgressRow {
  username: string;
  document: string;
  progress: string;
  percentage: number;
  device: string | null;
  device_id: string | null;
  filename: string | null;
  title: string | null;
  authors: string | null;
  timestamp: number;
}

/** Articles/prepositions dropped before title matching (EN + ES) — they overmatch. */
const TITLE_STOPWORDS = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "de", "del", "la", "el", "las", "los", "y", "en", "con", "por", "para", "un", "una", "al"]);

// Hyphens/apostrophes JOIN words ("peri-implantitis" is ONE term); other
// punctuation separates.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Resolve the kosync credential (the device sends no Notees auth). */
function kosyncUser(ctx: ServerContext, request: FastifyRequest): KosyncUserRow | null {
  const username = request.headers["x-auth-user"];
  const key = request.headers["x-auth-key"];
  if (typeof username !== "string" || typeof key !== "string") return null;
  const row = ctx.kosync.db
    .prepare("SELECT username, key, workspace_id FROM kosync_user WHERE username = ?")
    .get(username) as KosyncUserRow | undefined;
  if (row === undefined || row.key !== key) return null;
  return row;
}

function requireKosyncUser(ctx: ServerContext, request: FastifyRequest): KosyncUserRow {
  const user = kosyncUser(ctx, request);
  if (user === null) throw new AppError(401, "unauthenticated", "invalid kosync credentials");
  return user;
}

/** The reading-tracker schemas present in this workspace (by name; absent = skip). */
function trackerSchemas(ctx: ServerContext, workspaceId: string): {
  estado: { id: string; options: Map<string, string> } | null;
  primera: string | null;
  ultima: string | null;
} {
  const rows = ctx.workspaces
    .storeFor(workspaceId)
    .database.prepare("SELECT id, name, options FROM property_schema WHERE active = 1 AND name IN ('Estado', 'Primera lectura', 'Última lectura')")
    .all() as Array<{ id: string; name: string; options: string | null }>;
  let estado: { id: string; options: Map<string, string> } | null = null;
  let primera: string | null = null;
  let ultima: string | null = null;
  for (const row of rows) {
    if (row.name === "Estado") {
      let options = new Map<string, string>();
      try {
        options = new Map(
          (JSON.parse(row.options ?? "[]") as Array<{ id: string; label: string }>).map((o) => [o.label, o.id]),
        );
      } catch {
        options = new Map();
      }
      estado = { id: row.id, options };
    } else if (row.name === "Primera lectura") primera = row.id;
    else if (row.name === "Última lectura") ultima = row.id;
  }
  return { estado, primera, ultima };
}

/** Title match against the workspace's source-ish nodes (normalized containment). */
function matchBookNode(ctx: ServerContext, workspaceId: string, title: string): string | null {
  const target = norm(title);
  if (target === "") return null;
  const rows = ctx.workspaces
    .storeFor(workspaceId)
    .database.prepare(
      "SELECT id, content FROM node WHERE is_active = 1 AND is_class = 0 AND parent_id IS NULL LIMIT 50000",
    )
    .all() as Array<{ id: string; content: string }>;
  let best: { id: string; score: number } | null = null;
  for (const row of rows) {
    let name = "";
    try {
      const ast = JSON.parse(row.content) as Array<{ type?: string; text?: string }>;
      name = typeof ast[0]?.text === "string" ? ast[0].text : "";
    } catch {
      continue;
    }
    const candidate = norm(name);
    if (candidate === "") continue;
    // Word-containment over CONTENT words (stopwords dropped — "of"/"de"
    // overmatch across unrelated titles): every target word present in the
    // candidate wins (author suffixes still match); similar-length unrelated
    // strings (highlight markers) share few content words and fail.
    const targetWords = new Set(target.split(" ").filter((w) => !TITLE_STOPWORDS.has(w)));
    const candidateWords = new Set(candidate.split(" "));
    let hits = 0;
    for (const word of targetWords) if (candidateWords.has(word)) hits += 1;
    const score = targetWords.size === 0 ? 0 : hits / targetWords.size;
    if (score >= 0.75 && (best === null || score > best.score)) best = { id: row.id, score };
  }
  return best?.id ?? null;
}

/** Ensure the year/month/day chain exists; return the day node id. */
async function ensureDayChain(ctx: ServerContext, workspaceId: string, dayIso: string): Promise<string> {
  const chain = chainNodeIds(dayIso);
  const store = ctx.workspaces.storeFor(workspaceId);
  const exists = (id: string): boolean =>
    store.database.prepare("SELECT 1 FROM node WHERE id = ?").get(id) !== undefined;
  const parts = parseIsoDate(dayIso);
  const levels: Array<{ id: string; precision: "year" | "month" | "day"; classId: string; parent: string | null }> = [
    { id: chain.year, precision: "year", classId: SYSTEM_CLASS_UUIDS.year, parent: null },
    { id: chain.month, precision: "month", classId: SYSTEM_CLASS_UUIDS.month, parent: chain.year },
    { id: chain.day, precision: "day", classId: SYSTEM_CLASS_UUIDS.day, parent: chain.month },
  ];
  for (const level of levels) {
    if (exists(level.id)) continue;
    await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: {
        objectId: level.id,
        parentId: level.parent,
        isEmbedded: false,
        classIds: [level.classId],
        contentAst: [{ type: "text", text: dateNodeLabel(parts, level.precision) }],
      },
      affectedNodeIds: [level.id],
      client: "kosync",
    });
  }
  return chain.day;
}

/** Mirror a kosync PUT onto the reading tracker (best-effort, never blocks the sync). */
async function mirrorToTracker(
  ctx: ServerContext,
  workspaceId: string,
  body: z.infer<typeof progressBodySchema>,
  timestampSec: number,
): Promise<void> {
  const title = body.metadata?.title;
  if (title === undefined || title.trim() === "") return;
  const tracker = trackerSchemas(ctx, workspaceId);
  if (tracker.estado === null || tracker.estado.options.size === 0 || tracker.ultima === null) return;
  const nodeId = matchBookNode(ctx, workspaceId, title);
  if (nodeId === null) return;
  const done = body.percentage >= 0.99;
  const optionLabel = done ? "Consumido" : "Leyendo";
  const optionId = tracker.estado.options.get(optionLabel);
  if (optionId === undefined) return;
  await ctx.submit({
    workspaceId,
    opType: "property.set",
    payload: { objectId: nodeId, propertySchemaId: tracker.estado.id, value: optionId },
    affectedNodeIds: [nodeId],
    client: "kosync",
  });
  const iso = new Date(timestampSec * 1000).toISOString().slice(0, 10);
  const dayId = await ensureDayChain(ctx, workspaceId, iso);
  await ctx.submit({
    workspaceId,
    opType: "property.set",
    payload: { objectId: nodeId, propertySchemaId: tracker.ultima, value: { nodeId: dayId } },
    affectedNodeIds: [nodeId],
    client: "kosync",
  });
  if (done && tracker.primera !== null) {
    const held = ctx.workspaces
      .storeFor(workspaceId)
      .database.prepare("SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(nodeId, tracker.primera);
    if (held === undefined) {
      await ctx.submit({
        workspaceId,
        opType: "property.set",
        payload: { objectId: nodeId, propertySchemaId: tracker.primera, value: { nodeId: dayId } },
        affectedNodeIds: [nodeId],
        client: "kosync",
      });
    }
  }
}

export function registerKosyncRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/kosync/healthcheck", async () => ({ state: "OK" }));
  app.get("/kosync/health", async () => ({ status: "ok" }));

  // Registration is a Notees-side gesture (the device's "Register" button
  // answers 403 with this honest pointer; the device flow is "Login").
  app.post("/kosync/users/create", async (request, reply) => {
    const principal = resolvePrincipal(ctx, request);
    if (principal === null) {
      throw new AppError(
        403,
        "forbidden",
        "kosync registration happens inside Notees (Settings → Sources → KOReader sync, or an authenticated call) — the device then LOGS IN with the same username and password",
      );
    }
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid body");
    }
    const { username, password } = parsed.data;
    const taken = ctx.kosync.db.prepare("SELECT 1 FROM kosync_user WHERE username = ?").get(username);
    if (taken !== undefined) throw new AppError(409, "conflict", "username already registered");
    ctx.kosync.db
      .prepare("INSERT INTO kosync_user (username, key, workspace_id, created_at) VALUES (?, ?, ?, ?)")
      .run(username, password, workspaceFor(ctx, request), Date.now());
    reply.code(201);
    return { username };
  });

  app.get("/kosync/users/auth", async (request) => {
    if (kosyncUser(ctx, request) === null) {
      throw new AppError(401, "unauthenticated", "invalid kosync credentials");
    }
    return { authorized: true };
  });

  app.put("/kosync/syncs/progress", async (request) => {
    const user = requireKosyncUser(ctx, request);
    const parsed = progressBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", parsed.error.issues[0]?.message ?? "invalid body");
    }
    const body = parsed.data;
    // kosync clients send no reading timestamp, so the server stamps LWW:
    // the newest PUT wins unconditionally (the official-server semantics).
    const timestamp = Math.floor(Date.now() / 1000);
    ctx.kosync.db
      .prepare(
        `INSERT INTO kosync_progress (username, document, progress, percentage, device, device_id, filename, title, authors, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (username, document) DO UPDATE SET
           progress = excluded.progress, percentage = excluded.percentage, device = excluded.device,
           device_id = excluded.device_id, timestamp = excluded.timestamp,
           filename = COALESCE(excluded.filename, kosync_progress.filename),
           title = COALESCE(excluded.title, kosync_progress.title),
           authors = COALESCE(excluded.authors, kosync_progress.authors)`,
      )
      .run(
        user.username,
        body.document,
        body.progress,
        body.percentage,
        body.device,
        body.device_id,
        body.metadata?.filename ?? null,
        body.metadata?.title ?? null,
        body.metadata?.authors ?? null,
        timestamp,
      );
    // Best-effort tracker mirror — the sync response never waits on graph writes.
    try {
      await mirrorToTracker(ctx, user.workspace_id, body, timestamp);
    } catch (error) {
      // The progress row is the durability boundary; a mirror failure is a
      // logged miss, never a failed sync.
      console.error("[kosync] mirror failed:", error instanceof Error ? error.message : String(error));
    }
    return { document: body.document, timestamp };
  });

  app.get("/kosync/syncs/progress/:document", async (request) => {
    const user = requireKosyncUser(ctx, request);
    const { document } = request.params as { document: string };
    const row = ctx.kosync.db
      .prepare("SELECT * FROM kosync_progress WHERE username = ? AND document = ?")
      .get(user.username, document) as KosyncProgressRow | undefined;
    if (row === undefined) throw new AppError(404, "not_found", "no progress for this document");
    return row;
  });

  app.get("/kosync/syncs/documents", async (request) => {
    const user = requireKosyncUser(ctx, request);
    const rows = ctx.kosync.db
      .prepare("SELECT * FROM kosync_progress WHERE username = ? ORDER BY timestamp DESC LIMIT 1000")
      .all(user.username) as KosyncProgressRow[];
    return { documents: rows };
  });
}

/** Small storage handle for the two kosync tables (the PluginRegistry idiom). */
export class KosyncStorage {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
  }
}
