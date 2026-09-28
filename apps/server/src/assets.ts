/**
 * Content-addressed asset storage (v1 app/features/assets port):
 *  - POST   /api/v1/assets         multipart upload; magic-byte sniffing
 *                                  (jpeg/png/webp/pdf/epub/audio); size caps
 *                                  (50MB media / 100MB documents, v1 caps);
 *                                  sha256; bytes at
 *                                  <dataDir>/workspaces/<ws>/assets/<hash[:4]>/<hash>;
 *                                  emits asset.attach when an objectId is given.
 *  - GET    /api/v1/assets/:id     auth; Range requests supported (206).
 *  - GET    /api/v1/assets/:id/info
 *
 * The id in the API is an asset uuid; bytes are content-addressed by hash,
 * so identical uploads dedupe to one file with multiple refs (v1 asset_ref).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { uuidv7 } from "uuidv7";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";

interface SniffResult {
  mimeType: string;
  category: "media" | "document";
}

function matchesAt(bytes: Buffer, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Buffer, offset: number, length: number): string | null {
  if (bytes.length < offset + length) return null;
  return bytes.subarray(offset, offset + length).toString("latin1");
}

/** Magic-byte sniffing (v1 app/features/assets/utils.py signature table). */
export function sniffAssetType(bytes: Buffer): SniffResult | null {
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", category: "media" };
  if (matchesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", category: "media" };
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mimeType: "image/webp", category: "media" };
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return { mimeType: "application/pdf", category: "document" };
  // EPUB: ZIP container whose first entry is the OCF mimetype member.
  if (matchesAt(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) && ascii(bytes, 30, 31) === "mimetypeapplication/epub+zip") {
    return { mimeType: "application/epub+zip", category: "document" };
  }
  if (ascii(bytes, 0, 3) === "ID3" || matchesAt(bytes, 0, [0xff, 0xfb]) || matchesAt(bytes, 0, [0xff, 0xf3]) || matchesAt(bytes, 0, [0xff, 0xf2])) {
    return { mimeType: "audio/mpeg", category: "media" };
  }
  if (ascii(bytes, 0, 4) === "OggS") return { mimeType: "audio/ogg", category: "media" };
  if (ascii(bytes, 0, 4) === "fLaC") return { mimeType: "audio/flac", category: "media" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return { mimeType: "audio/wav", category: "media" };
  }
  if (ascii(bytes, 4, 4) === "ftyp") return { mimeType: "audio/mp4", category: "media" };
  return null;
}

function workspaceFor(ctx: ServerContext, request: FastifyRequest): string {
  const header = request.headers["x-workspace-id"];
  if (typeof header === "string" && z.string().uuid().safeParse(header).success) {
    return header;
  }
  return ctx.defaultWorkspace;
}

function assetPath(ctx: ServerContext, workspaceId: string, hash: string): string {
  return join(ctx.config.dataDir, "workspaces", workspaceId, "assets", hash.slice(0, 4), hash);
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  if (rawStart === "") {
    // Suffix range: last N bytes.
    const suffix = Number.parseInt(rawEnd ?? "", 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number.parseInt(rawStart ?? "", 10);
  const end = rawEnd === "" || rawEnd === undefined ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return "invalid";
  return { start, end };
}

export function registerAssetRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/assets", async (request, reply) => {
    const file = await request.file();
    if (file === undefined) {
      throw new AppError(422, "validation_failed", "multipart body must include a file part");
    }
    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch {
      throw new AppError(422, "validation_failed", "upload exceeded the multipart size limit");
    }
    const sniffed = sniffAssetType(bytes);
    if (sniffed === null) {
      throw new AppError(
        422,
        "validation_failed",
        "unsupported file type (sniffed: not jpeg/png/webp/pdf/epub/audio)",
      );
    }
    const cap = sniffed.category === "document" ? ctx.config.maxDocumentBytes : ctx.config.maxMediaBytes;
    if (bytes.length > cap) {
      throw new AppError(422, "validation_failed", `file exceeds the ${sniffed.category} size cap (${cap} bytes)`);
    }
    const workspaceId = workspaceFor(ctx, request);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = assetPath(ctx, workspaceId, hash);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const assetId = uuidv7();
    const uploadedAt = new Date().toISOString();
    ctx.relay.recordAsset({
      assetId,
      workspaceId,
      hash,
      mimeType: sniffed.mimeType,
      size: bytes.length,
      originalName: file.filename ?? assetId,
      uploadedAt,
    });

    // Optional attach to an object: multipart text field "objectId".
    const fields = file.fields as Record<string, unknown>;
    const objectIdField = fields["objectId"];
    const objectId =
      typeof objectIdField === "object" && objectIdField !== null && "value" in objectIdField
        ? String((objectIdField as { value: unknown }).value)
        : null;
    let attachedTo: string | null = null;
    if (objectId !== null) {
      if (!z.string().uuid().safeParse(objectId).success) {
        throw new AppError(422, "validation_failed", "objectId multipart field must be a uuid");
      }
      await ctx.submit({
        workspaceId,
        opType: "asset.attach",
        payload: {
          objectId,
          assetId,
          hash,
          mimeType: sniffed.mimeType,
          size: bytes.length,
          originalName: file.filename ?? assetId,
        },
        affectedNodeIds: [objectId, assetId],
        client: "api",
      });
      attachedTo = objectId;
    }

    reply.code(201);
    return {
      assetId,
      hash,
      mimeType: sniffed.mimeType,
      size: bytes.length,
      originalName: file.filename ?? assetId,
      refs: ctx.relay.assetRefs(hash),
      ...(attachedTo !== null ? { objectId: attachedTo } : {}),
    };
  });

  app.get("/assets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = workspaceFor(ctx, request);
    const asset = /^[0-9a-f]{64}$/.test(id) ? null : ctx.relay.assetById(id);
    if (!/^[0-9a-f]{64}$/.test(id) && asset === null) {
      throw new AppError(404, "not_found", `asset ${id} does not exist`);
    }
    const hash = asset !== null ? asset.hash : id;
    const path = assetPath(ctx, workspaceId, hash);
    if (!existsSync(path)) {
      throw new AppError(404, "not_found", `asset bytes for ${id} do not exist`);
    }
    const size = statSync(path).size;
    const mimeType = asset?.mimeType ?? "application/octet-stream";
    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      throw new AppError(416, "validation_failed", `range is not satisfiable for ${size}-byte asset`);
    }
    reply.header("accept-ranges", "bytes").header("content-type", mimeType);
    if (range !== null) {
      const { start, end } = range;
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(createReadStream(path, { start, end }));
    }
    return reply.header("content-length", size).send(createReadStream(path));
  });

  app.get("/assets/:id/info", async (request) => {
    const { id } = request.params as { id: string };
    const asset = ctx.relay.assetById(id);
    if (asset === null) {
      throw new AppError(404, "not_found", `asset ${id} does not exist`);
    }
    return {
      assetId: asset.assetId,
      hash: asset.hash,
      mimeType: asset.mimeType,
      size: asset.size,
      originalName: asset.originalName,
      refs: ctx.relay.assetRefs(asset.hash),
    };
  });
}
