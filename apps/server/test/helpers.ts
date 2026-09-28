import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { newEnvelope, type Envelope } from "@notees/protocol";

import { buildServer, type BuiltServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";

export const TEST_API_KEY = `nk_${"a".repeat(32)}`;
export const TEST_WORKSPACE = "11111111-2222-4333-8444-555555555555";
export const TEST_ACTOR = "99999999-8888-4777-8666-555555555555";

export interface TestServer extends BuiltServer {
  dataDir: string;
  apiKey: string;
  workspaceId: string;
  authHeaders: Record<string, string>;
}

export function makeConfig(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir,
    apiKey: TEST_API_KEY,
    port: 0,
    host: "127.0.0.1",
    logger: false,
    relayBatchPerMinute: 30_000,
    globalRequestsPerMinute: 10_000,
    maxMediaBytes: 50 * 1024 * 1024,
    maxDocumentBytes: 100 * 1024 * 1024,
    corsOrigins: [],
    ...overrides,
  };
}

export async function makeTestServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-server-test-"));
  const built = await buildServer(makeConfig(dataDir, overrides), { logger: false });
  return {
    ...built,
    dataDir,
    apiKey: TEST_API_KEY,
    workspaceId: TEST_WORKSPACE,
    authHeaders: { "x-api-key": TEST_API_KEY },
  };
}

export async function closeTestServer(server: TestServer): Promise<void> {
  await server.app.close();
  rmSync(server.dataDir, { recursive: true, force: true });
}

export interface TestEnvelopeOptions {
  workspaceId?: string;
  opType: string;
  payload: Record<string, unknown>;
  id?: string;
  actorId?: string;
}

let clock = 1_700_000_000_000;

export function testEnvelope(options: TestEnvelopeOptions): Envelope {
  clock += 1;
  const envelope = newEnvelope({
    workspaceId: options.workspaceId ?? TEST_WORKSPACE,
    actorId: options.actorId ?? TEST_ACTOR,
    deviceId: "test-device",
    client: "test",
    hlc: { physical: clock, logical: 0 },
    affectedNodeIds: [],
    opType: options.opType,
    payload: options.payload,
  });
  if (options.id !== undefined) {
    return { ...envelope, id: options.id };
  }
  return envelope;
}

export function pagePayload(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectId: crypto.randomUUID(),
    nodeType: "page",
    name,
    ...extra,
  };
}

export async function ingest(
  server: TestServer,
  envelopes: Envelope[],
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return server.app.inject({
    method: "POST",
    url: "/api/relay/v2/batch",
    headers: { "content-type": "application/json", ...server.authHeaders },
    payload: { envelopes },
  });
}
