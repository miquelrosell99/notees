/**
 * Server configuration from the environment.
 *
 *  - NOTEES_DATA_DIR (default ./data): relay log, snapshots, derived DBs,
 *    CAS asset bytes, and the bootstrap API-key file all live under here;
 *  - NOTEES_API_KEY: bootstrap key (`nk_` + 32 chars). When absent, the first
 *    boot generates a key and persists it to <dataDir>/api_key.txt (0600) so
 *    the operator can recover it; the key is logged once on generation;
 *  - NOTEES_PORT (default 8377), NOTEES_HOST (default 0.0.0.0).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const API_KEY_PATTERN = /^nk_[A-Za-z0-9_-]{32}$/;

export interface ServerConfig {
  dataDir: string;
  apiKey: string;
  port: number;
  host: string;
  logger: boolean;
  /** Envelopes per workspace per minute accepted by the relay (v1: 30k). */
  relayBatchPerMinute: number;
  /** Global fallback: requests per minute per IP (WIRE.md §3). */
  globalRequestsPerMinute: number;
  /** Media size cap (v1: 50MB). */
  maxMediaBytes: number;
  /** Document (pdf/epub) size cap (v1: 100MB). */
  maxDocumentBytes: number;
}

export function generateApiKey(): string {
  // 24 random bytes → exactly 32 base64url characters.
  return `nk_${randomBytes(24).toString("base64url")}`;
}

export function isValidApiKeyShape(key: string): boolean {
  return API_KEY_PATTERN.test(key);
}

export interface ApiKeyResolution {
  apiKey: string;
  /** True when the key was generated on this boot (log it once). */
  generated: boolean;
}

/** Resolve the active API key: env > key file > generate + persist. */
export function resolveApiKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): ApiKeyResolution {
  mkdirSync(dataDir, { recursive: true });
  const fromEnv = env.NOTEES_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!isValidApiKeyShape(fromEnv)) {
      throw new Error(`NOTEES_API_KEY must match ${API_KEY_PATTERN} (got "${fromEnv.slice(0, 8)}…")`);
    }
    return { apiKey: fromEnv, generated: false };
  }
  const keyFile = join(dataDir, "api_key.txt");
  if (existsSync(keyFile)) {
    const stored = readFileSync(keyFile, "utf8").trim();
    if (!isValidApiKeyShape(stored)) {
      throw new Error(`refusing to start: ${keyFile} does not contain a valid nk_ API key`);
    }
    return { apiKey: stored, generated: false };
  }
  const apiKey = generateApiKey();
  writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
  return { apiKey, generated: true };
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig & { generatedKey: boolean } {
  const dataDir = resolve(env.NOTEES_DATA_DIR ?? "./data");
  const { apiKey, generated } = resolveApiKey(dataDir, env);
  return {
    dataDir,
    apiKey,
    generatedKey: generated,
    port: intFromEnv(env, "NOTEES_PORT", 8377),
    host: env.NOTEES_HOST ?? "0.0.0.0",
    logger: env.NOTEES_LOG?.toLowerCase() !== "false",
    relayBatchPerMinute: intFromEnv(env, "NOTEES_RELAY_BATCH_PER_MINUTE", 30_000),
    globalRequestsPerMinute: intFromEnv(env, "NOTEES_GLOBAL_REQ_PER_MINUTE", 10_000),
    maxMediaBytes: intFromEnv(env, "NOTEES_MAX_MEDIA_BYTES", 50 * 1024 * 1024),
    maxDocumentBytes: intFromEnv(env, "NOTEES_MAX_DOCUMENT_BYTES", 100 * 1024 * 1024),
  };
}
