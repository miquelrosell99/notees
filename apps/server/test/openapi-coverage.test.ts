/**
 * OpenAPI contract gate — the drift check wired into CI as its
 * own job (`.github/workflows/ci.yml`, `openapi-coverage`):
 *
 *  1. Every route the Fastify app actually registers (collected via onRoute
 *     into `BuiltServer.registeredRoutes`) must appear in the OpenAPI
 *     document — a route added in code but not documented fails the build.
 *  2. The document may not list routes that do not exist (a renamed/removed
 *     route left a ghost) — the table and the app stay the same set.
 *  3. Document basics: OpenAPI 3.1, info, the pinned error taxonomy exposed
 *     under `x-error-codes`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/index.js";
import { ERROR_TAXONOMY } from "../src/errors.js";
import { buildOpenApiDocument, documentedRoutes } from "../src/openapi.js";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z]+)/g, "{$1}");
}

describe("openapi route coverage", () => {
  it("every registered Fastify route is documented", async () => {
    server = await makeTestServer();
    const document = buildOpenApiDocument(SERVER_VERSION);
    const paths = document.paths as Record<string, Record<string, unknown>>;

    const missing: string[] = [];
    for (const route of server.registeredRoutes) {
      if (route.method === "HEAD") continue; // Fastify auto-registers HEAD for GETs
      const pathItem = paths[toOpenApiPath(route.url)];
      if (pathItem === undefined || pathItem[route.method.toLowerCase()] === undefined) {
        missing.push(`${route.method} ${route.url}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the document lists no ghost routes (table ⊆ registered)", async () => {
    server = await makeTestServer();
    const registered = new Set(
      server.registeredRoutes
        .filter((route) => route.method !== "HEAD")
        .map((route) => `${route.method} ${route.url}`),
    );
    const ghosts = documentedRoutes().filter(
      (route) => !registered.has(`${route.method} ${route.path}`),
    );
    expect(ghosts).toEqual([]);
  });

  it("document basics: 3.1 shape, info version, pinned error taxonomy", async () => {
    const document = buildOpenApiDocument(SERVER_VERSION);
    expect(document.openapi).toBe("3.1.0");
    expect((document.info as { title: string }).title).toBe("Notees server API");
    expect((document.info as { version: string }).version).toBe(SERVER_VERSION);
    expect(document["x-error-codes"]).toEqual(
      Object.fromEntries(
        Object.entries(ERROR_TAXONOMY).map(([code, entry]) => [
          code,
          { status: entry.status, description: entry.description },
        ]),
      ),
    );
  });

  it("GET /api/openapi.json serves exactly the built document", async () => {
    server = await makeTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(buildOpenApiDocument(SERVER_VERSION));
  });

  it("documented routes carry scopes only from the pinned vocabulary", async () => {
    const { API_SCOPES } = await import("../src/scopes.js");
    const vocabulary = new Set<string>(API_SCOPES);
    for (const route of documentedRoutes()) {
      if (route.requiredScope !== undefined) {
        expect(vocabulary.has(route.requiredScope)).toBe(true);
      }
    }
  });
});
