/**
 * Idempotency-Key support for the object/assets API.
 *
 * Agent safety for mutating routes: a caller may send `Idempotency-Key: <key>`
 * on any JSON mutation (POST/PATCH/PUT/DELETE). The first successful (2xx)
 * response is remembered in-process for 24h; replaying the SAME request
 * (method + URL + body) with the same key returns the ORIGINAL status and
 * body — no second write enters the op log. Reusing a key with a DIFFERENT
 * request fails loud with 409 `idempotency_replay`.
 *
 * Deliberate boundaries (documented, not faked):
 *  - Multipart uploads (POST /assets) are NOT captured — CAS dedupes bytes by
 *    hash, which is the honest idempotency story there.
 *  - The store is in-memory and single-process: a restart clears it (the same
 *    accepted tradeoff as the rate limiters and the login lockout). The relay
 *    surface needs nothing here — /batch dedupes by envelope id.
 *  - Keys are namespaced per (workspace, credential): one principal's key
 *    never replays another principal's response.
 */

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { extractCredential } from "./routes-auth.js";

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
/** Set on replayed responses so agents can distinguish a replay from a fresh write. */
export const IDEMPOTENCY_REPLAY_HEADER = "x-idempotency-replay";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface IdempotencyRecord {
  requestHash: string;
  statusCode: number;
  body: string;
  contentType: string | undefined;
  createdAt: number;
}

/** In-memory, TTL-bounded key→response store (single-process). */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS) {}

  lookup(key: string): IdempotencyRecord | undefined {
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    if (Date.now() - record.createdAt >= this.windowMs) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  save(key: string, record: IdempotencyRecord): void {
    this.records.set(key, record);
  }

  get size(): number {
    return this.records.size;
  }

  /** Housekeeping for long-lived processes (tests call this explicitly). */
  prune(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (now - record.createdAt >= this.windowMs) this.records.delete(key);
    }
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The store key namespaces an agent key by workspace and credential so a
 * replay only ever serves the same principal the same response.
 */
function storeKeyFor(ctx: ServerContext, request: FastifyRequest, key: string): string {
  const header = request.headers["x-workspace-id"];
  const workspaceId =
    typeof header === "string" && z.string().uuid().safeParse(header).success
      ? header
      : ctx.defaultWorkspace;
  const credential = extractCredential(request) ?? "anonymous";
  return `${workspaceId}|${sha256(credential).slice(0, 24)}|${key}`;
}

function requestHash(request: FastifyRequest): string {
  return sha256(`${request.method}|${request.url}|${JSON.stringify(request.body ?? null)}`);
}

/** The header when present and usable; null when idempotency does not apply. */
function idempotencyKeyOf(request: FastifyRequest): string | null {
  if (!MUTATING_METHODS.has(request.method)) return null;
  const contentType = request.headers["content-type"];
  if (typeof contentType === "string" && contentType.startsWith("multipart/")) return null;
  const header = request.headers["idempotency-key"];
  if (header === undefined) return null;
  if (typeof header !== "string" || header.length === 0) return null;
  if (header.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new AppError(422, "validation_failed", `Idempotency-Key exceeds ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return header;
}

// Stash the store key between the preHandler (miss → remember for capture)
// and onSend (capture). A WeakMap keeps the request type untouched.
const pendingCaptures = new WeakMap<FastifyRequest, string>();

/**
 * Register the replay-check + response-capture hooks on an encapsulated
 * context (the object/assets plugin). Runs AFTER the auth preHandler so a
 * replay still requires valid credentials, and AFTER the scope check so a
 * replayed mutation still needs the mutation's scope.
 */
export function registerIdempotencyHooks(app: FastifyInstance, ctx: ServerContext): void {
  app.addHook("preHandler", async (request, reply) => {
    const key = idempotencyKeyOf(request);
    if (key === null) return;
    const storeKey = storeKeyFor(ctx, request, key);
    const record = ctx.idempotency.lookup(storeKey);
    if (record === undefined) {
      pendingCaptures.set(request, storeKey);
      return;
    }
    if (record.requestHash !== requestHash(request)) {
      throw new AppError(
        409,
        "idempotency_replay",
        "Idempotency-Key was already used with a different request; use a fresh key",
      );
    }
    reply.code(record.statusCode).header(IDEMPOTENCY_REPLAY_HEADER, "true");
    if (record.contentType !== undefined) reply.header("content-type", record.contentType);
    return reply.send(record.body);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const storeKey = pendingCaptures.get(request);
    if (storeKey === undefined) return payload;
    pendingCaptures.delete(request);
    const statusCode = reply.statusCode;
    // Only successful mutations are replayable: errors (409s included) must
    // re-execute so their messages reflect current state.
    if (statusCode < 200 || statusCode >= 300) return payload;
    if (typeof payload !== "string") return payload;
    ctx.idempotency.save(storeKey, {
      requestHash: requestHash(request),
      statusCode,
      body: payload,
      contentType: typeof reply.getHeader("content-type") === "string"
        ? (reply.getHeader("content-type") as string)
        : undefined,
      createdAt: Date.now(),
    });
    return payload;
  });
}
