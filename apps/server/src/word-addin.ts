/**
 * Word add-in statics: GET /word/* serves the Office.js task-pane add-in's
 * files (manifest + assets) from NOTEES_WORD_ADDIN_DIR. PUBLIC BY DESIGN —
 * the add-in holds no credentials and talks only to the localhost CLI
 * bridge; the manifest must be fetchable by Word's sideloading flows. GET
 * only, no auth, path-traversal and symlink escapes refused. Hand-rolled streaming (the
 * assets.ts precedent) — no new dependency.
 */

import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";

import type { ServerConfig } from "./config.js";
import { AppError } from "./errors.js";

const WORD_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

export function registerWordAddinRoutes(app: FastifyInstance, config: ServerConfig): void {
  app.get("/word/*", async (request, reply) => {
    const rel = (request.params as { "*": string })["*"] ?? "";
    const addinDir = config.wordAddinDir ?? "";
    if (addinDir.length === 0 || rel.length === 0) {
      throw new AppError(404, "not_found", "word add-in statics are not hosted");
    }
    const root = resolve(addinDir);
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new AppError(404, "not_found", "not found");
    }
    if (!existsSync(target)) {
      throw new AppError(404, "not_found", "not found");
    }
    // Symlink-escape guard: the lexical check above follows no links, so a
    // symlink inside the dir pointing outside would otherwise stream the
    // outside file on this unauthenticated route. Re-apply the root-prefix
    // contract on the real paths.
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new AppError(404, "not_found", "not found");
    }
    const stat = statSync(target);
    if (!stat.isFile()) {
      throw new AppError(404, "not_found", "not found");
    }
    const size = stat.size;
    return reply
      .header("content-type", WORD_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream")
      .header("content-length", size)
      .send(createReadStream(target));
  });
}
