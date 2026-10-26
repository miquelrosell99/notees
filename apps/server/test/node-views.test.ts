/**
 * Node-scoped hosted views tests: the node_view table, the five prefs-channel
 * endpoints (list/create/rename/reorder/delete), the (node, section, name)
 * unique key, shared-across-users visibility, the "-" sentinel for a node's
 * main query, the legacy section_view migration, and fail-loud validation.
 * Custom tabs are cross-device UI state on the prefs channel — never op-log
 * state — and they belong to the node, not to a user.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuthStorage } from "../src/auth.js";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function setupUser(email = "admin@example.com"): Promise<{ token: string; userId: string }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password: "admin-password-1" },
  });
  expect(response.statusCode).toBe(201);
  return { token: response.json().token as string, userId: response.json().user.id as string };
}

/** A second account — under node-scoped storage it shares the first user's views. */
function createSecondUser(): { token: string } {
  const user = server!.ctx.auth.createUser({
    email: "second@example.com",
    passwordHash: "scrypt$16384$8$1$c2FsdA$hZ2ZoaDZk",
  });
  server!.ctx.auth.addMember(server!.ctx.defaultWorkspace, user.id, "owner");
  return { token: server!.ctx.auth.createSession(user.id).token };
}

const PAGE = "0192b000-0000-7000-8000-0000000000a1";
const OTHER_PAGE = "0192b000-0000-7000-8000-0000000000b2";

/** A minimal valid QueryAST v1 (flat AND root, workspace scope). */
const AST = {
  version: 1,
  scope: { type: "entire_workspace" },
  root: { type: "group", logic: "and", children: [] },
};

const AST_WITH_CONDITION = {
  version: 1,
  scope: { type: "entire_workspace" },
  root: {
    type: "group",
    logic: "and",
    children: [{ type: "isClass", isClass: false }],
  },
};

const BASE = `/api/nodes/${PAGE}/sections/linked-references/views`;

describe("GET /api/nodes/:nodeId/sections/:sectionKey/views", () => {
  it("returns an empty list for a surface that never hosted views", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ views: [] });
  });

  it("lists views in sequence order across sections and nodes", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const first = server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "linked-references", name: "Alpha", queryAst: AST,
    });
    server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "linked-references", name: "Beta", queryAst: AST,
    });
    server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "unlinked-mentions", name: "Other section", queryAst: AST,
    });
    server.ctx.auth.createNodeView({
      nodeId: OTHER_PAGE, sectionKey: "linked-references", name: "Other page", queryAst: AST,
    });
    expect(first.sequence).toBe(0);

    const response = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const views = response.json().views;
    expect(views.map((v: { name: string }) => v.name)).toEqual(["Alpha", "Beta"]);
    expect(views[0]).toMatchObject({
      nodeId: PAGE,
      sectionKey: "linked-references",
      sequence: 0,
      queryAst: AST,
    });
    expect(views[0].viewMode).toBeUndefined();
    expect(typeof views[0].id).toBe("string");
    expect(typeof views[0].createdAt).toBe("number");
    expect(typeof views[0].updatedAt).toBe("number");
  });

  it('accepts the "-" sentinel for the empty section key (a node\'s main query)', async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    const created = await server.app.inject({
      method: "POST",
      url: `/api/nodes/${PAGE}/sections/-/views`,
      headers: auth,
      payload: { name: "Main query tab", queryAst: AST },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().view.sectionKey).toBe("");

    const list = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${PAGE}/sections/-/views`,
      headers: auth,
    });
    expect(list.json().views.map((v: { name: string }) => v.name)).toEqual(["Main query tab"]);

    // The keyed sections are a different surface — no leakage.
    const keyed = await server.app.inject({ method: "GET", url: BASE, headers: auth });
    expect(keyed.json().views).toEqual([]);
  });

  it("rejects anonymous callers and the operator key (not a user)", async () => {
    server = await makeTestServer();
    await setupUser();
    const anonymous = await server.app.inject({ method: "GET", url: BASE });
    expect(anonymous.statusCode).toBe(401);
    const operator = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { "x-api-key": server.apiKey },
    });
    expect(operator.statusCode).toBe(401);
  });

  it("rejects an unknown section key and a non-uuid node id (422)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const badKey = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${PAGE}/sections/child-pages/views`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badKey.statusCode).toBe(422);
    expect(badKey.json().error.code).toBe("validation_failed");
    const badId = await server.app.inject({
      method: "GET",
      url: "/api/nodes/not-a-uuid/sections/linked-references/views",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badId.statusCode).toBe(422);
  });
});

describe("POST /api/nodes/:nodeId/sections/:sectionKey/views", () => {
  it("creates a view (201), appended after existing tabs, and round-trips the AST verbatim", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };

    const first = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "Pages only", queryAst: AST_WITH_CONDITION },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().view).toMatchObject({ name: "Pages only", sequence: 0 });
    expect(first.json().view.queryAst).toEqual(AST_WITH_CONDITION);

    const second = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "Cards", queryAst: AST },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().view.sequence).toBe(1);

    const list = await server.app.inject({ method: "GET", url: BASE, headers: auth });
    expect(list.json().views.map((v: { name: string }) => v.name)).toEqual(["Pages only", "Cards"]);
  });

  it("409s on a duplicate name within the same (node, section) — even from another user", async () => {
    server = await makeTestServer();
    const admin = await setupUser();
    const second = createSecondUser();
    const first = await server.app.inject({
      method: "POST", url: BASE,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "Dup", queryAst: AST },
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await server.app.inject({
      method: "POST", url: BASE,
      headers: { authorization: `Bearer ${second.token}` },
      payload: { name: "Dup", queryAst: AST },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("conflict");
    // The same name on ANOTHER section is fine (the unique key has section_key).
    const otherSection = await server.app.inject({
      method: "POST",
      url: `/api/nodes/${PAGE}/sections/unlinked-mentions/views`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "Dup", queryAst: AST },
    });
    expect(otherSection.statusCode).toBe(201);
  });

  it("422s on an invalid AST, a blank/overlong name, a viewMode pin (retired), unknown keys", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };

    const badAst = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "Broken", queryAst: { version: 2 } },
    });
    expect(badAst.statusCode).toBe(422);
    expect(badAst.json().error.code).toBe("validation_failed");

    const blankName = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "   ", queryAst: AST },
    });
    expect(blankName.statusCode).toBe(422);

    const overlong = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "x".repeat(121), queryAst: AST },
    });
    expect(overlong.statusCode).toBe(422);

    // view_mode is retired with the table — the key is rejected outright.
    const modePin = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "Mode", queryAst: AST, viewMode: "table" },
    });
    expect(modePin.statusCode).toBe(422);

    const unknownKey = await server.app.inject({
      method: "POST",
      url: BASE,
      headers: auth,
      payload: { name: "Extra", queryAst: AST, surprise: true },
    });
    expect(unknownKey.statusCode).toBe(422);
  });
});

describe("PATCH .../views/:viewId (rename)", () => {
  it("renames the view and 409s on collision, 404s on foreign rows", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    const a = server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "linked-references", name: "A", queryAst: AST,
    });
    const b = server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "linked-references", name: "B", queryAst: AST,
    });

    const renamed = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${a.id}`,
      headers: auth,
      payload: { name: "A2" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().view.name).toBe("A2");

    const collision = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${a.id}`,
      headers: auth,
      payload: { name: "B" },
    });
    expect(collision.statusCode).toBe(409);

    const missing = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/0192b000-0000-7000-8000-0000000000ff`,
      headers: auth,
      payload: { name: "X" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");

    // The same row under ANOTHER section's path is still 404.
    const wrongSection = await server.app.inject({
      method: "PATCH",
      url: `/api/nodes/${PAGE}/sections/unlinked-mentions/views/${b.id}`,
      headers: auth,
      payload: { name: "X" },
    });
    expect(wrongSection.statusCode).toBe(404);
  });

  it("rewrites a view's queryAST (with or without a rename) and validates it", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    const created = server.ctx.auth.createNodeView({
      nodeId: PAGE, sectionKey: "linked-references", name: "Q", queryAst: AST,
    });

    const rewrite = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${created.id}`,
      headers: auth,
      payload: { queryAst: AST_WITH_CONDITION },
    });
    expect(rewrite.statusCode).toBe(200);
    expect(rewrite.json().view.name).toBe("Q");
    expect(rewrite.json().view.queryAst).toEqual(AST_WITH_CONDITION);

    const both = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${created.id}`,
      headers: auth,
      payload: { name: "Q2", queryAst: AST },
    });
    expect(both.statusCode).toBe(200);
    expect(both.json().view).toMatchObject({ name: "Q2", queryAst: AST });

    const badAst = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${created.id}`,
      headers: auth,
      payload: { queryAst: { version: 2 } },
    });
    expect(badAst.statusCode).toBe(422);

    const empty = await server.app.inject({
      method: "PATCH",
      url: `${BASE}/${created.id}`,
      headers: auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
  });
});

describe("PUT .../views/order (reorder)", () => {
  it("rewrites sequences 0..n-1 to the given order", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    await server.app.inject({
      method: "POST", url: BASE, headers: auth, payload: { name: "One", queryAst: AST },
    });
    await server.app.inject({
      method: "POST", url: BASE, headers: auth, payload: { name: "Two", queryAst: AST },
    });
    await server.app.inject({
      method: "POST", url: BASE, headers: auth, payload: { name: "Three", queryAst: AST },
    });
    const before = (
      await server.app.inject({ method: "GET", url: BASE, headers: auth })
    ).json().views as Array<{ id: string; name: string }>;
    expect(before.map((v) => v.name)).toEqual(["One", "Two", "Three"]);

    const reversed = await server.app.inject({
      method: "PUT",
      url: `${BASE}/order`,
      headers: auth,
      payload: { orderedIds: [before[2]!.id, before[0]!.id, before[1]!.id] },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json().views.map((v: { name: string; sequence: number }) => `${v.sequence}:${v.name}`)).toEqual([
      "0:Three",
      "1:One",
      "2:Two",
    ]);

    const after = (
      await server.app.inject({ method: "GET", url: BASE, headers: auth })
    ).json().views as Array<{ name: string }>;
    expect(after.map((v) => v.name)).toEqual(["Three", "One", "Two"]);
  });

  it("422s when the order list drops a view or names an unknown one", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    await server.app.inject({
      method: "POST", url: BASE, headers: auth, payload: { name: "Only", queryAst: AST },
    });
    const list = (
      await server.app.inject({ method: "GET", url: BASE, headers: auth })
    ).json().views as Array<{ id: string }>;

    const dropped = await server.app.inject({
      method: "PUT",
      url: `${BASE}/order`,
      headers: auth,
      payload: { orderedIds: [] },
    });
    expect(dropped.statusCode).toBe(422);

    const unknown = await server.app.inject({
      method: "PUT",
      url: `${BASE}/order`,
      headers: auth,
      payload: { orderedIds: ["0192b000-0000-7000-8000-0000000000ee"] },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe("validation_failed");

    // The failed reorder left the order untouched.
    const after = (
      await server.app.inject({ method: "GET", url: BASE, headers: auth })
    ).json().views as Array<{ id: string }>;
    expect(after.map((v) => v.id)).toEqual([list[0]!.id]);
  });
});

describe("DELETE .../views/:viewId", () => {
  it("deletes (204), 404s twice, and emptying the surface restores the empty list", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };
    const created = await server.app.inject({
      method: "POST", url: BASE, headers: auth, payload: { name: "Gone", queryAst: AST },
    });
    const id = created.json().view.id as string;

    const deleted = await server.app.inject({
      method: "DELETE",
      url: `${BASE}/${id}`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);

    const again = await server.app.inject({ method: "DELETE", url: `${BASE}/${id}`, headers: auth });
    expect(again.statusCode).toBe(404);

    const list = await server.app.inject({ method: "GET", url: BASE, headers: auth });
    expect(list.json().views).toEqual([]);
  });
});

describe("shared node scoping", () => {
  it("every user sees the same tabs on a node, and all of them can add to them", async () => {
    server = await makeTestServer();
    const admin = await setupUser();
    const second = createSecondUser();

    await server.app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: "Admin view", queryAst: AST },
    });
    await server.app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${second.token}` },
      payload: { name: "Second view", queryAst: AST },
    });

    const adminRead = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const secondRead = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(adminRead.json().views.map((v: { name: string }) => v.name)).toEqual([
      "Admin view",
      "Second view",
    ]);
    expect(secondRead.json().views.map((v: { name: string }) => v.name)).toEqual([
      "Admin view",
      "Second view",
    ]);
  });

  it("accepts a per-user API key (its owner as the principal)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "cli" },
    });
    const apiKeyToken = created.json().token as string;
    const response = await server.app.inject({
      method: "GET",
      url: BASE,
      headers: { "x-api-key": apiKeyToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().views).toEqual([]);
  });
});

describe("legacy section_view migration", () => {
  it("copies rows dropping user_id/view_mode, dedupes by (node, section, name), drops the old table", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-node-view-migration-"));
    const dbPath = join(dir, "auth.db");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE section_view (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            section_key TEXT NOT NULL,
            name TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            query_ast TEXT NOT NULL,
            view_mode TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (user_id, node_id, section_key, name)
        );
        INSERT INTO section_view (id, user_id, node_id, section_key, name, sequence, query_ast, view_mode, created_at, updated_at)
            VALUES
            ('0192b000-0000-7000-8000-000000000001', 'user-a', '${PAGE}', 'linked-references', 'Keep me', 0, '${JSON.stringify(AST).replaceAll("'", "''")}', 'table', 100, 100),
            ('0192b000-0000-7000-8000-000000000002', 'user-b', '${PAGE}', 'linked-references', 'Keep me', 1, '${JSON.stringify(AST).replaceAll("'", "''")}', NULL, 200, 200),
            ('0192b000-0000-7000-8000-000000000003', 'user-a', '${PAGE}', 'unlinked-mentions', 'Other', 0, '${JSON.stringify(AST).replaceAll("'", "''")}', NULL, 50, 50);
      `);
      legacy.close();

      const migrated = new AuthStorage(dbPath);
      const linked = migrated.listNodeViews(PAGE, "linked-references");
      expect(linked.map((v) => v.name)).toEqual(["Keep me"]);
      expect(linked[0]).toMatchObject({ nodeId: PAGE, sectionKey: "linked-references", sequence: 0, queryAst: AST });
      expect(migrated.listNodeViews(PAGE, "unlinked-mentions").map((v) => v.name)).toEqual(["Other"]);
      expect(
        (migrated as unknown as { db: Database.Database }).db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'section_view'")
          .get(),
      ).toBeUndefined();
      migrated.close();

      // Idempotent: a second boot over the migrated file is a no-op.
      const reopened = new AuthStorage(dbPath);
      expect(reopened.listNodeViews(PAGE, "linked-references").map((v) => v.name)).toEqual(["Keep me"]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
