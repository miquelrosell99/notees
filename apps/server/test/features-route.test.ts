/**
 * GET /api/features (research-tier2 slice 2b) — the workspace_feature
 * projection read the CLI's `feature list` consumes.
 *
 *  - Row projection: a toggled feature answers as
 *    {feature, enabled, settings} — the winning row's flag and its
 *    configuration record; a winning payload WITHOUT settings answers
 *    settings: null (the wire's absent-vs-empty distinction).
 *  - Absent means enabled (F2): the empty table is the pre-toggle state, so
 *    a workspace that never toggled anything answers {features: []} —
 *    untoggled features do not appear and callers default them to on.
 *  - Auth: the object-API group preHandler (operator key / session /
 *    per-user key), scoped keys need the objects.read scope.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  closeTestServer,
  ingest,
  makeTestServer,
  testEnvelope,
  type TestServer,
} from "./helpers.js";

let server: TestServer;

beforeAll(async () => {
  server = await makeTestServer();
  return async () => {
    await closeTestServer(server);
  };
});

afterEach(async () => {
  // No per-test server state to reset (each test toggles distinct features).
});

describe("GET /api/features", () => {
  it("projects toggled rows with enabled + settings", async () => {
    await ingest(server, [
      testEnvelope({
        opType: "workspace.feature.set",
        payload: {
          feature: "sources",
          enabled: false,
          settings: { citekeyPattern: "[auth:lower][year]", resolverEnabled: true },
        },
      }),
    ]);
    const response = await server.app.inject({
      method: "GET",
      url: "/api/features",
      headers: { ...server.authHeaders, "x-workspace-id": server.workspaceId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      features: Array<{ feature: string; enabled: boolean; settings: unknown }>;
    };
    const sources = body.features.find((row) => row.feature === "sources");
    expect(sources).toEqual({
      feature: "sources",
      enabled: false,
      settings: { citekeyPattern: "[auth:lower][year]", resolverEnabled: true },
    });
  });

  it("a winning payload without settings projects settings: null", async () => {
    await ingest(server, [
      testEnvelope({
        opType: "workspace.feature.set",
        payload: { feature: "journal", enabled: false },
      }),
    ]);
    const response = await server.app.inject({
      method: "GET",
      url: "/api/features",
      headers: { ...server.authHeaders, "x-workspace-id": server.workspaceId },
    });
    const body = response.json() as {
      features: Array<{ feature: string; enabled: boolean; settings: unknown }>;
    };
    const journal = body.features.find((row) => row.feature === "journal");
    expect(journal).toEqual({ feature: "journal", enabled: false, settings: null });
  });

  it("absent row means enabled — untoggled features do not appear", async () => {
    // `events` was never toggled in this workspace: F2 says the absent row
    // IS the enabled default, so the projection lists nothing for it.
    const response = await server.app.inject({
      method: "GET",
      url: "/api/features",
      headers: { ...server.authHeaders, "x-workspace-id": server.workspaceId },
    });
    const body = response.json() as {
      features: Array<{ feature: string; enabled: boolean; settings: unknown }>;
    };
    expect(body.features.some((row) => row.feature === "events")).toBe(false);
    // Only the two toggles from the other tests exist.
    expect(body.features.map((row) => row.feature).sort()).toEqual(["journal", "sources"]);
  });

  it("requires authentication", async () => {
    const response = await server.app.inject({ method: "GET", url: "/api/features" });
    expect(response.statusCode).toBe(401);
  });
});
