import { afterEach, describe, expect, it } from "vitest";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";
import { API_SCOPES } from "../src/scopes.js";
import { ERROR_TAXONOMY } from "../src/errors.js";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) { await closeTestServer(server); server = null; }
});

describe("capture vocabulary", () => {
  it("capture.write is a mintable API-key scope", () => {
    expect(API_SCOPES).toContain("capture.write");
  });
  it("feature_disabled and e2ee_required are pinned taxonomy codes", () => {
    expect(ERROR_TAXONOMY.feature_disabled?.status).toBe(403);
    expect(ERROR_TAXONOMY.e2ee_required?.status).toBe(409);
  });
  it("an api-key mint request accepts the capture.write scope", async () => {
    server = await makeTestServer();
    await server.app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "admin-password-1" } });
    const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-password-1" } });
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${login.json().token}` },
      payload: { name: "connector", scopes: ["capture.write"] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().apiKey.scopes).toEqual(["capture.write"]);
  });
});
