/**
 * Plugin registry routes (§34.59, owner 2026-10-04), prefix /api — the
 * INERT half of the plugin program: manifest schema + server registry.
 *
 * THE RUNTIME IS PARKED (plan §19 / §34.33 AG7): nothing here executes,
 * loads, spawns, imports, exports, or subscribes anything. The registry is
 * server state — validated manifest JSON + an enabled flag + an install
 * timestamp — the same ruling as prefs/shares: registry rows are NOT log
 * state, so no envelope, no op type, no fixture gate, no client lockstep.
 * The `capabilities`/`entrypoint`/`permissions` fields are DECLARED
 * vocabulary consumed by the future runtime; the toggle flips a bit that
 * nothing reads yet.
 *
 * Routes (owner/admin-scoped — the operator key or an administrator
 * account; a scoped API key additionally needs the "admin" scope, the first
 * enforcement of that reserved name):
 *
 *  - GET    /plugins              list installed manifests;
 *  - POST   /plugins              install (body = one manifest JSON,
 *                                 zod-strict validated fail-loud;
 *                                 idempotent on id+version — a repeat
 *                                 install answers the existing row; the
 *                                 same id at a DIFFERENT version is 409 —
 *                                 versioned updates are a runtime-era flow);
 *  - DELETE /plugins/:id          uninstall every version of the id;
 *  - POST   /plugins/:id/enabled  { enabled } toggle (applies to the id).
 *
 * Storage: a `plugin` table on the shared relay.db (CREATE-IF-NOT-EXISTS —
 * the additive-migration pattern; PK (id, version) makes install
 * idempotency a natural key, not a best-effort check).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  safeParsePluginManifest,
  type PluginManifest,
} from "@notees/protocol";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal } from "./routes-auth.js";

const DDL = `
CREATE TABLE IF NOT EXISTS plugin (
    id TEXT NOT NULL,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    author TEXT,
    manifest TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (id, version)
);
`;

export interface PluginRow {
  id: string;
  version: string;
  name: string;
  description: string | null;
  author: string | null;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
}

interface PluginRowRaw {
  id: string;
  version: string;
  name: string;
  description: string | null;
  author: string | null;
  manifest: string;
  enabled: number;
  installed_at: number;
}

function toPluginRow(raw: PluginRowRaw): PluginRow {
  return {
    id: raw.id,
    version: raw.version,
    name: raw.name,
    description: raw.description,
    author: raw.author,
    manifest: JSON.parse(raw.manifest) as PluginManifest,
    enabled: raw.enabled === 1,
    installedAt: raw.installed_at,
  };
}

export class PluginRegistry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    // Additive migration: CREATE-IF-NOT-EXISTS on the shared relay.db.
    this.db.exec(DDL);
  }

  list(): PluginRow[] {
    const rows = this.db
      .prepare("SELECT * FROM plugin ORDER BY id, version")
      .all() as unknown as PluginRowRaw[];
    return rows.map(toPluginRow);
  }

  find(id: string, version: string): PluginRow | null {
    const row = this.db
      .prepare("SELECT * FROM plugin WHERE id = ? AND version = ?")
      .get(id, version) as PluginRowRaw | undefined;
    return row === undefined ? null : toPluginRow(row);
  }

  /** INSERT-or-return-existing: the (id, version) PK is the idempotency key. */
  install(manifest: PluginManifest): { row: PluginRow; alreadyInstalled: boolean } {
    const existing = this.find(manifest.id, manifest.version);
    if (existing !== null) return { row: existing, alreadyInstalled: true };
    const raw: PluginRowRaw = {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description ?? null,
      author: manifest.author ?? null,
      manifest: JSON.stringify(manifest),
      enabled: 0,
      installed_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO plugin (id, version, name, description, author, manifest, enabled, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        raw.id,
        raw.version,
        raw.name,
        raw.description,
        raw.author,
        raw.manifest,
        raw.enabled,
        raw.installed_at,
      );
    return { row: toPluginRow(raw), alreadyInstalled: false };
  }

  /** True when a row with the id exists at any version. */
  hasAnyVersion(id: string): boolean {
    const row = this.db.prepare("SELECT 1 AS n FROM plugin WHERE id = ? LIMIT 1").get(id) as
      | { n: number }
      | undefined;
    return row !== undefined;
  }

  uninstall(id: string): boolean {
    const result = this.db.prepare("DELETE FROM plugin WHERE id = ?").run(id);
    return result.changes > 0;
  }

  setEnabled(id: string, enabled: boolean): PluginRow[] {
    this.db.prepare("UPDATE plugin SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    const rows = this.db
      .prepare("SELECT * FROM plugin WHERE id = ? ORDER BY version")
      .all(id) as unknown as PluginRowRaw[];
    return rows.map(toPluginRow);
  }

  close(): void {
    this.db.close();
  }
}

function rowToJson(row: PluginRow): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    author: row.author,
    manifest: row.manifest,
    enabled: row.enabled,
    installedAt: row.installedAt,
  };
}

/**
 * Owner/admin gate: the operator key IS the owner path; otherwise an
 * administrator account is required. A scoped API key (§34.33 AG3) must
 * carry the "admin" scope — the first enforcement of that reserved name.
 */
export function requireAdmin(ctx: ServerContext, request: FastifyRequest): void {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
  if (resolved.principal.kind === "apikey") return;
  if (!resolved.principal.isAdmin) {
    throw new AppError(403, "forbidden", "plugin administration requires an administrator account");
  }
  if (resolved.scopes !== null && !resolved.scopes.includes("admin")) {
    throw new AppError(403, "scope_denied", 'this route requires the "admin" API-key scope');
  }
}

export function registerPluginRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /**
   * The registry listing — inert data: what is installed, its declared
   * capabilities, and the enable bit. NOTHING here is loaded or executed;
   * the runtime that would consume these rows is parked (§34.33 AG7).
   */
  app.get("/plugins", async () => ({
    plugins: ctx.plugins.list().map(rowToJson),
  }));

  /**
   * Install a plugin manifest. The body IS the manifest (the §34.59 grammar
   * in @notees/protocol) — strict-validated, fail-loud. Idempotent on
   * id+version: a repeat install answers the existing row; the same id at a
   * different version is 409 (versioned updates ride the parked runtime).
   * The stored row is data, not code: no entrypoint is ever resolved.
   */
  app.post("/plugins", async (request, reply) => {
    const parsed = safeParsePluginManifest(request.body);
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        `invalid plugin manifest: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
      );
    }
    const manifest = parsed.data;
    if (ctx.plugins.hasAnyVersion(manifest.id) && ctx.plugins.find(manifest.id, manifest.version) === null) {
      throw new AppError(
        409,
        "conflict",
        `plugin "${manifest.id}" is already installed at another version; versioned updates ship with the plugin runtime (parked, §34.33 AG7)`,
      );
    }
    const { row, alreadyInstalled } = ctx.plugins.install(manifest);
    if (alreadyInstalled) {
      return { plugin: rowToJson(row), alreadyInstalled: true };
    }
    reply.code(201);
    return { plugin: rowToJson(row), alreadyInstalled: false };
  });

  /** Uninstall every version of the id. Inert data deletion — nothing was ever loaded, so there is nothing to unload. */
  app.delete("/plugins/:id", async (request) => {
    const { id } = request.params as { id: string };
    if (!ctx.plugins.uninstall(id)) {
      throw new AppError(404, "not_found", `no installed plugin with id "${id}"`);
    }
    return { ok: true };
  });

  /** Enable/disable the plugin (all its versions). The bit is stored only — a parked runtime reads nothing. */
  app.post("/plugins/:id/enabled", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = zEnabledBody.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, "validation_failed", 'expected a JSON body of the form { "enabled": boolean }');
    }
    if (!ctx.plugins.hasAnyVersion(id)) {
      throw new AppError(404, "not_found", `no installed plugin with id "${id}"`);
    }
    const rows = ctx.plugins.setEnabled(id, parsed.data.enabled);
    return { plugins: rows.map(rowToJson) };
  });
}

const zEnabledBody = z.object({ enabled: z.boolean() }).strict();
