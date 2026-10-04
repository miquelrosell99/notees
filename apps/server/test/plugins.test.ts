/**
 * Plugin registry tests (§34.59): the inert manifest registry — install
 * (strict manifest validation, idempotent on id+version), list, enable
 * toggle, uninstall — under the owner/admin gate (operator key, admin
 * session, admin-scoped key; non-admin and wrong-scope denials), plus the
 * load-bearing inertness checks: no envelope ever reaches the op log
 * (server state, not log state) and rows survive a server restart on the
 * existing relay.db (the additive CREATE-IF-NOT-EXISTS migration).
 */

import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/index.js";
import { hashPassword } from "../src/auth.js";
import {
  closeTestServer,
  makeConfig,
  makeTestServer,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

const MANIFEST = {
  manifestVersion: 1,
  id: "com.example.bibtex",
  name: "BibTeX bridge",
  version: "1.2.3",
  description: "BibTeX in and out.",
  capabilities: {
    exportFormats: [{ id: "bibtex", label: "BibTeX", mime: "application/x-bibtex" }],
    importers: [{ id: "bibtex", label: "BibTeX file", mime: "application/x-bibtex", mode: "file" }],
    commands: [{ id: "import", label: "Import BibTeX" }],
  },
  entrypoint: "dist/index.js",
  permissions: ["objects.read", "export"],
};

const MINIMAL_MANIFEST = {
  manifestVersion: 1,
  id: "dev.local.tool",
  name: "Local tool",
  version: "0.1.0",
  capabilities: {},
};

describe("plugin registry (§34.59)", () => {
  it("rejects unauthenticated calls on every route", async () => {
    server = await makeTestServer();
    const responses = [
      await server.app.inject({ method: "GET", url: "/api/plugins" }),
      await server.app.inject({ method: "POST", url: "/api/plugins", payload: MANIFEST }),
      await server.app.inject({ method: "DELETE", url: "/api/plugins/com.example.bibtex" }),
      await server.app.inject({
        method: "POST",
        url: "/api/plugins/com.example.bibtex/enabled",
        payload: { enabled: true },
      }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthenticated");
    }
  });

  it("install → list → enable → uninstall lifecycle on the operator key", async () => {
    server = await makeTestServer();

    const install = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MANIFEST,
    });
    expect(install.statusCode).toBe(201);
    expect(install.json().alreadyInstalled).toBe(false);
    const plugin = install.json().plugin;
    expect(plugin.id).toBe("com.example.bibtex");
    expect(plugin.version).toBe("1.2.3");
    expect(plugin.enabled).toBe(false);
    expect(plugin.manifest.capabilities.exportFormats[0].id).toBe("bibtex");
    expect(plugin.installedAt).toEqual(expect.any(Number));

    // Minimal manifest with empty capabilities also installs.
    const minimal = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MINIMAL_MANIFEST,
    });
    expect(minimal.statusCode).toBe(201);

    const list = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: server.authHeaders,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().plugins).toHaveLength(2);

    const toggle = await server.app.inject({
      method: "POST",
      url: "/api/plugins/com.example.bibtex/enabled",
      headers: server.authHeaders,
      payload: { enabled: true },
    });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().plugins[0].enabled).toBe(true);

    // Toggling is idempotent and accepts disabling too.
    const disable = await server.app.inject({
      method: "POST",
      url: "/api/plugins/com.example.bibtex/enabled",
      headers: server.authHeaders,
      payload: { enabled: false },
    });
    expect(disable.json().plugins[0].enabled).toBe(false);

    const uninstall = await server.app.inject({
      method: "DELETE",
      url: "/api/plugins/com.example.bibtex",
      headers: server.authHeaders,
    });
    expect(uninstall.statusCode).toBe(200);
    const after = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: server.authHeaders,
    });
    expect(after.json().plugins.map((p: { id: string }) => p.id)).toEqual(["dev.local.tool"]);
  });

  it("install is idempotent on id+version; a different version is 409", async () => {
    server = await makeTestServer();
    const first = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MANIFEST,
    });
    expect(first.statusCode).toBe(201);

    const repeat = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MANIFEST,
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().alreadyInstalled).toBe(true);
    expect(repeat.json().plugin.installedAt).toBe(first.json().plugin.installedAt);

    const bump = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: { ...MANIFEST, version: "1.3.0" },
    });
    expect(bump.statusCode).toBe(409);
    expect(bump.json().error.code).toBe("conflict");

    const list = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: server.authHeaders,
    });
    expect(list.json().plugins).toHaveLength(1);
  });

  it("rejects invalid manifests fail-loud (422) without storing anything", async () => {
    server = await makeTestServer();
    const bad: Array<[string, unknown]> = [
      ["unknown top-level key", { ...MANIFEST, homepage: "https://example.com" }],
      ["bad semver", { ...MANIFEST, version: "v1.2" }],
      ["bad id", { ...MANIFEST, id: "Not-A-Domain" }],
      ["unknown permission", { ...MANIFEST, permissions: ["steal-everything"] }],
      ["bad importer mode", {
        ...MANIFEST,
        capabilities: { importers: [{ id: "x", label: "X", mime: "text/plain", mode: "stream" }] },
      }],
      ["traversing entrypoint", { ...MANIFEST, entrypoint: "../escape.js" }],
      ["missing capabilities", (() => { const { capabilities: _c, ...rest } = MANIFEST; return rest; })()],
    ];
    for (const [label, payload] of bad) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/plugins",
        headers: server.authHeaders,
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode, label).toBe(422);
      expect(response.json().error.code, label).toBe("validation_failed");
    }
    const list = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: server.authHeaders,
    });
    expect(list.json().plugins).toHaveLength(0);
  });

  it("toggle/uninstall on an unknown id → 404; toggle with a non-boolean body → 422", async () => {
    server = await makeTestServer();
    const missing = await server.app.inject({
      method: "POST",
      url: "/api/plugins/ghost.example/enabled",
      headers: server.authHeaders,
      payload: { enabled: true },
    });
    expect(missing.statusCode).toBe(404);

    const badBody = await server.app.inject({
      method: "POST",
      url: "/api/plugins/ghost.example/enabled",
      headers: server.authHeaders,
      payload: { enabled: "yes" },
    });
    expect(badBody.statusCode).toBe(422);

    const uninstall = await server.app.inject({
      method: "DELETE",
      url: "/api/plugins/ghost.example",
      headers: server.authHeaders,
    });
    expect(uninstall.statusCode).toBe(404);
  });

  it("the registry is server state, not log state — no envelope reaches the op log", async () => {
    server = await makeTestServer();
    const before = server.ctx.relay.envelopeCount(server.workspaceId);
    await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MANIFEST,
    });
    await server.app.inject({
      method: "POST",
      url: "/api/plugins/com.example.bibtex/enabled",
      headers: server.authHeaders,
      payload: { enabled: true },
    });
    const after = server.ctx.relay.envelopeCount(server.workspaceId);
    expect(after).toBe(before);
  });

  it("rows survive a restart against the existing relay.db (additive migration)", async () => {
    server = await makeTestServer();
    await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: server.authHeaders,
      payload: MANIFEST,
    });
    const dataDir = server.dataDir;
    const apiKey = server.apiKey;
    // Close WITHOUT the helper's rmSync — the restart must see the same db.
    await server.app.close();
    server = null;

    const rebuilt = await buildServer(makeConfig(dataDir), { logger: false });
    try {
      const list = await rebuilt.app.inject({
        method: "GET",
        url: "/api/plugins",
        headers: { "x-api-key": apiKey },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().plugins).toHaveLength(1);
      expect(list.json().plugins[0].id).toBe("com.example.bibtex");
    } finally {
      await rebuilt.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("admin session manages plugins; a non-admin session gets 403", async () => {
    server = await makeTestServer();
    const admin = server.ctx.auth.createUser({
      email: "admin@example.com",
      passwordHash: await hashPassword("admin-password-1"),
      isAdmin: true,
    });
    const adminToken = server.ctx.auth.createSession(admin.id).token;
    const member = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
      isAdmin: false,
    });
    const memberToken = server.ctx.auth.createSession(member.id).token;

    const asAdmin = await server.app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: MANIFEST,
    });
    expect(asAdmin.statusCode).toBe(201);

    const asMember = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json().error.code).toBe("forbidden");
  });

  it("scoped API keys need the admin scope; ownership still requires the admin flag", async () => {
    server = await makeTestServer();
    const admin = server.ctx.auth.createUser({
      email: "admin@example.com",
      passwordHash: await hashPassword("admin-password-1"),
      isAdmin: true,
    });
    const member = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
      isAdmin: false,
    });
    const noScope = server.ctx.auth.createApiKey(admin.id, "plain", ["objects.read"]).token;
    const withAdmin = server.ctx.auth.createApiKey(admin.id, "scoped-admin", ["admin"]).token;
    const memberAdminScope = server.ctx.auth.createApiKey(member.id, "member-admin", ["admin"]).token;

    const denied = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { "x-api-key": noScope },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("scope_denied");

    const allowed = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { "x-api-key": withAdmin },
    });
    expect(allowed.statusCode).toBe(200);

    // A non-admin user cannot mint admin reach by self-scoping a key.
    const memberScoped = await server.app.inject({
      method: "GET",
      url: "/api/plugins",
      headers: { "x-api-key": memberAdminScope },
    });
    expect(memberScoped.statusCode).toBe(403);
    expect(memberScoped.json().error.code).toBe("forbidden");
  });
});
