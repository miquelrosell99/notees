import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateApiKey, isValidApiKeyShape, loadConfig, parseCorsOrigins } from "../src/config.js";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("config / API key bootstrap", () => {
  it("generates nk_ keys of the pinned shape", () => {
    const key = generateApiKey();
    expect(key.startsWith("nk_")).toBe(true);
    expect(key.length).toBe(3 + 32);
    expect(isValidApiKeyShape(key)).toBe(true);
  });

  it("persists a generated key to <dataDir>/api_key.txt with 0600 perms", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "notees-config-test-"));
    try {
      const first = loadConfig({ NOTEES_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
      expect(first.generatedKey).toBe(true);
      expect(isValidApiKeyShape(first.apiKey)).toBe(true);
      const mode = statSync(join(dataDir, "api_key.txt")).mode & 0o777;
      expect(mode).toBe(0o600);
      // Second boot reads the same key (no regeneration).
      const second = loadConfig({ NOTEES_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
      expect(second.generatedKey).toBe(false);
      expect(second.apiKey).toBe(first.apiKey);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prefers NOTEES_API_KEY over the file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "notees-config-test-"));
    try {
      const envKey = generateApiKey();
      const config = loadConfig({ NOTEES_DATA_DIR: dataDir, NOTEES_API_KEY: envKey } as NodeJS.ProcessEnv);
      expect(config.apiKey).toBe(envKey);
      expect(config.generatedKey).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed env key", () => {
    expect(() => loadConfig({ NOTEES_API_KEY: "nk_tooshort" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("defaults: port 8377, logger on", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "notees-config-test-"));
    try {
      const config = loadConfig({ NOTEES_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
      expect(config.port).toBe(8377);
      expect(config.logger).toBe(true);
      expect(config.relayBatchPerMinute).toBe(30_000);
      expect(config.globalRequestsPerMinute).toBe(10_000);
      expect(config.corsOrigins).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("config / NOTEES_CORS_ORIGIN", () => {
  it("parses a comma-separated origin list", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "notees-config-test-"));
    try {
      const config = loadConfig({
        NOTEES_DATA_DIR: dataDir,
        NOTEES_CORS_ORIGIN: "http://localhost:8080, https://notees.example.com",
      } as NodeJS.ProcessEnv);
      expect(config.corsOrigins).toEqual([
        "http://localhost:8080",
        "https://notees.example.com",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("empty/whitespace value means no CORS", () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins("")).toEqual([]);
    expect(parseCorsOrigins(" ,  ")).toEqual([]);
  });
});

describe("boot smoke", () => {
  it("generated key file works against the live routes", async () => {
    server = await makeTestServer();
    const health = await server.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const version = await server.app.inject({ method: "GET", url: "/api/version" });
    expect(version.json()).toMatchObject({ name: "notees-server", protocolVersion: 3, wsProtocolVersion: 2 });
  });

  it("unknown routes get the error envelope, not an HTML page", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("global fallback limiter answers 429 beyond 10k req/min/IP (small limit)", async () => {
    server = await makeTestServer({ globalRequestsPerMinute: 5 });
    let last = 0;
    for (let i = 0; i < 8; i += 1) {
      last = (await server.app.inject({ method: "GET", url: "/healthz" })).statusCode;
    }
    // /healthz is exempt; use an authed route for counting.
    let limited = 0;
    for (let i = 0; i < 8; i += 1) {
      const res = await server.app.inject({
        method: "GET",
        url: `/api/relay/v2/stats?workspaceId=${server.workspaceId}`,
        headers: server.authHeaders,
      });
      if (res.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    expect(last).toBe(200);
  });
});
