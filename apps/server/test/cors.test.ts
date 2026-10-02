/**
 * NOTEES_CORS_ORIGIN wiring: which requests get CORS headers, and which do
 * not. Empty corsOrigins (the default) must send no CORS headers at all —
 * same-origin and non-browser clients are unaffected either way.
 */

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("CORS (NOTEES_CORS_ORIGIN)", () => {
  it("answers no CORS headers when corsOrigins is empty (default)", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: "/api/version",
      headers: { origin: "http://localhost:8080" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects the allow-list for an allowed origin", async () => {
    server = await makeTestServer({ corsOrigins: ["http://localhost:8080"] });
    const res = await server.app.inject({
      method: "GET",
      url: "/api/version",
      headers: { origin: "http://localhost:8080" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
  });

  it("sends no allow-origin header for a non-listed origin", async () => {
    server = await makeTestServer({ corsOrigins: ["http://localhost:8080"] });
    const res = await server.app.inject({
      method: "GET",
      url: "/api/version",
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("wildcard entry allows any origin", async () => {
    server = await makeTestServer({ corsOrigins: ["*"] });
    const res = await server.app.inject({
      method: "GET",
      url: "/api/version",
      headers: { origin: "http://anything.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("preflight (OPTIONS) is answered before the auth hook", async () => {
    server = await makeTestServer({ corsOrigins: ["http://localhost:8080"] });
    const res = await server.app.inject({
      method: "OPTIONS",
      url: "/api/objects",
      headers: {
        origin: "http://localhost:8080",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-api-key, content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect(res.headers["access-control-allow-headers"]).toContain("x-api-key");
  });
});
