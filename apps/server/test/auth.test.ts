/**
 * Account auth tests: the setup gate, login/logout, sessions, the workspace
 * list, and relay authorization for account principals (claim-on-first-write,
 * read denial for non-members) — with the operator API key kept as the
 * unrestricted legacy principal.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { chainNodeIds, SYSTEM_PAGE_UUIDS } from "@notees/domain";

import { hashPassword } from "../src/auth.js";
import {
  closeTestServer,
  ingest,
  makeTestServer,
  pagePayload,
  testEnvelope,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function setupAdmin(email = "admin@example.com", password = "admin-password-1") {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password },
  });
  return response;
}

describe("setup gate", () => {
  it("server-info reports setupRequired on a fresh server and false after setup", async () => {
    server = await makeTestServer();
    const before = await server.app.inject({ method: "GET", url: "/api/server-info" });
    expect(before.statusCode).toBe(200);
    expect(before.json().setupRequired).toBe(true);

    const setup = await setupAdmin();
    expect(setup.statusCode).toBe(201);
    expect(setup.json().token).toMatch(/^nt_/);
    expect(setup.json().user.isAdmin).toBe(true);

    const after = await server.app.inject({ method: "GET", url: "/api/server-info" });
    expect(after.json().setupRequired).toBe(false);
  });

  it("setup is refused once any account exists", async () => {
    server = await makeTestServer();
    expect((await setupAdmin()).statusCode).toBe(201);
    const again = await server.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "other@example.com", password: "admin-password-2" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("setup claims the default workspace for the first account", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().workspaces.map((ws: { id: string }) => ws.id);
    expect(ids).toContain(server.ctx.defaultWorkspace);
  });
});

describe("login and sessions", () => {
  it("login returns a session that authenticates account routes", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const login = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;

    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("admin@example.com");
  });

  it("wrong password and unknown email both yield 401", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const wrongPw = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" },
    });
    expect(wrongPw.statusCode).toBe(401);
    const unknown = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "admin-password-1" },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("logout revokes the session", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const out = await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("account routes reject the operator API key", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: server.authHeaders,
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("relay authorization for accounts", () => {
  it("a session token works as the relay credential", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const env = testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Via session" }] } });
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { envelopes: [env] },
    });
    expect(response.statusCode).toBe(200);
  });

  it("first write claims an unclaimed workspace; a second account is denied", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin("one@example.com");
    const first = setup.json().token as string;
    const secondUser = server.ctx.auth.createUser({
      email: "two@example.com",
      passwordHash: await hashPassword("second-password-1"),
    });
    const second = server.ctx.auth.createSession(secondUser.id).token;

    const workspace = "22222222-3333-4444-8555-666666666666";
    // First account writes → claims the workspace.
    const env = testEnvelope({
      workspaceId: workspace,
      opType: "object.create",
      payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Claimed" }] },
    });
    const write = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${first}` },
      payload: { envelopes: [env] },
    });
    expect(write.statusCode).toBe(200);

    // Second account: read and write both denied.
    const read = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", authorization: `Bearer ${second}` },
      payload: { workspaceId: workspace, afterSeq: 0 },
    });
    expect(read.statusCode).toBe(403);
    const write2 = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${second}` },
      payload: { envelopes: [env] },
    });
    expect(write2.statusCode).toBe(403);
  });

  it("read (catch-up) is denied for a non-member", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    const token = setup.json().token as string;
    const foreign = "22222222-3333-4444-8555-666666666666";
    // Seed the foreign workspace via the operator key, then attempt a read
    // with the account token (membership exists only on the default ws).
    await ingest(server, [
      testEnvelope({ workspaceId: foreign, opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Foreign" }] } }),
    ]);
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload: { workspaceId: foreign, afterSeq: 0 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("the operator API key keeps unrestricted access", async () => {
    server = await makeTestServer();
    const foreign = "22222222-3333-4444-8555-666666666666";
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/catch-up",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { workspaceId: foreign, afterSeq: 0 },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("workspace rename", () => {
  it("PATCH /workspaces/:id renames for the owner and refuses non-owners", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;

    // A second account the owner adds as a plain (non-owner) member.
    const memberUser = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
    });
    const member = server.ctx.auth.createSession(memberUser.id).token;

    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Old name" },
    });
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json().id as string;
    server.ctx.auth.addMember(workspaceId, memberUser.id, "member");

    // Non-owner member: forbidden.
    const byMember = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
      payload: { name: "Hijacked" },
    });
    expect(byMember.statusCode).toBe(403);

    // Unrelated account: the workspace's existence is not revealed.
    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${stranger}` },
      payload: { name: "Hijacked" },
    });
    expect(byStranger.statusCode).toBe(404);

    // Owner: renamed, and the list reflects it.
    const renamed = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "New name" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toEqual({ id: workspaceId, name: "New name" });

    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
    });
    const entry = list
      .json()
      .workspaces.find((ws: { id: string }) => ws.id === workspaceId);
    expect(entry.name).toBe("New name");

    // Empty names are rejected outright.
    const empty = await server.app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "   " },
    });
    expect(empty.statusCode).toBe(422);
  });
});

describe("workspace delete and export", () => {
  it("DELETE removes the workspace and its data (owner only)", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Doomed" },
    });
    const workspaceId = created.json().id as string;

    const memberUser = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
    });
    const member = server.ctx.auth.createSession(memberUser.id).token;
    server.ctx.auth.addMember(workspaceId, memberUser.id, "member");

    // Non-owner member: forbidden.
    const byMember = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
    });
    expect(byMember.statusCode).toBe(403);

    // Owner deletes.
    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    // Gone from the owner's list; memberships went with it.
    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(list.json().workspaces.map((w: { id: string }) => w.id)).not.toContain(workspaceId);

    // A second delete no longer finds it (also for the ex-member).
    const again = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(again.statusCode).toBe(404);
    const byExMember = await server.app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceId}`,
      headers: { authorization: `Bearer ${member}` },
    });
    expect(byExMember.statusCode).toBe(404);
  });

  it("GET /workspaces/:id/export.zip downloads the workspace as a zip of page files", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Export Me" },
    });
    const workspaceId = created.json().id as string;

    // A root page (property set), a main-zone child page it mentions from
    // an inline block, and nested inline-body blocks. Rich tokens (mentions)
    // survive only on inline blocks — document-chrome nodes flatten to
    // text-only content (SCHEMA.md content flatten invariant).
    const pageId = crypto.randomUUID();
    const childPageId = crypto.randomUUID();
    const mentionBlockId = crypto.randomUUID();
    const blockId = crypto.randomUUID();
    const nestedBlockId = crypto.randomUUID();
    const schemaId = crypto.randomUUID();
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId,
        opType: "propertySchema.create",
        payload: { propertySchemaId: schemaId, name: "Status", type: "text" },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: pageId,
          presentAsMain: true,
          contentAst: [{ type: "text", text: "Exported Page" }],
        },
      }),
      testEnvelope({
        workspaceId,
        opType: "property.set",
        payload: { objectId: pageId, propertySchemaId: schemaId, value: "in progress", idx: 0 },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: childPageId,
          parentId: pageId,
          presentAsMain: true,
          contentAst: [{ type: "text", text: "Child Page" }],
        },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: mentionBlockId,
          parentId: pageId,
          contentAst: [
            { type: "text", text: "see " },
            { type: "mention", targetNodeId: childPageId, text: "Child Page", displayText: "Child Page" },
          ],
        },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: blockId,
          parentId: pageId,
          contentAst: [{ type: "text", text: "child block body" }],
        },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: nestedBlockId,
          parentId: blockId,
          contentAst: [{ type: "text", text: "nested grandchild" }],
        },
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const exported = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/zip");
    expect(exported.headers["content-disposition"]).toContain("Export-Me.zip");

    const files = unzipSync(new Uint8Array(exported.rawPayload));
    const findMd = (slug: string): string => {
      const match = Object.keys(files).filter((name) => new RegExp(`^${slug}-[0-9a-f]{8}\\.md$`).test(name));
      expect(match).toHaveLength(1);
      return match[0]!;
    };
    const rootPath = findMd("Exported-Page");
    const childPath = findMd("Child-Page");
    expect(Object.keys(files).sort()).toEqual(
      [rootPath, childPath, "notees-manifest.json"].sort(),
    );
    const decode = (entry: Uint8Array | undefined): string =>
      new TextDecoder().decode(entry ?? new Uint8Array());
    const root = decode(files[rootPath]);
    const child = decode(files[childPath]);

    // Properties ride the frontmatter now (the retired single-file route
    // dropped them); blocks render as nested bullets inside their page.
    expect(root).toContain("properties:");
    expect(root).toContain("Status: in progress");
    expect(root).toContain("child block body");
    expect(root).toContain("nested grandchild");
    // The mention became a relative link into the child page's file.
    expect(root).toContain(`[Child Page](${childPath})`);
    expect(root).not.toContain("[[Child Page]]");
    // The child page is its own document.
    expect(child).toContain("# Child Page");

    const manifest = JSON.parse(decode(files["notees-manifest.json"])) as {
      format: string;
      version: number;
      nodes: Array<{ id: string; path: string; name: string; type: string }>;
    };
    expect(manifest.format).toBe("notees-markdown");
    expect(manifest.version).toBe(2);
    const byId = new Map(manifest.nodes.map((node) => [node.id, node]));
    expect(byId.get(pageId)).toMatchObject({ path: rootPath, name: "Exported Page", type: "page" });
    expect(byId.get(childPageId)).toMatchObject({ path: childPath, name: "Child Page", type: "page" });

    // The replaced single-file route is gone, and unknown includeAssets
    // values fail loud.
    const gone = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(gone.statusCode).toBe(404);
    const badQuery = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip?includeAssets=2`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(badQuery.statusCode).toBe(422);

    // Non-member: the workspace's existence is not revealed.
    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(byStranger.statusCode).toBe(404);
  });

  it("workspace zip excludes system-seed pages and the date chain (zip-roots, owner 2026-10-04)", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Zip Roots" },
    });
    const workspaceId = created.json().id as string;

    // A real page, a date chain (year → month → day, deterministic ids), a
    // day-parented user page (rides the chain's exclusion), and a system
    // page authored like the seed does. Envelopes apply in order — the
    // chain parents before the pages under them.
    const pageId = crypto.randomUUID();
    const underDayId = crypto.randomUUID();
    const dayParentedPageId = crypto.randomUUID();
    const chain = chainNodeIds("2026-09-27");
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: pageId, presentAsMain: true, contentAst: [{ type: "text", text: "Real Page" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: chain.year, presentAsMain: true, contentAst: [{ type: "text", text: "2026" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: chain.month, parentId: chain.year, presentAsMain: true, contentAst: [{ type: "text", text: "2026-09" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: chain.day, parentId: chain.month, presentAsMain: true, contentAst: [{ type: "text", text: "2026-09-27" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: underDayId, parentId: chain.day, presentAsMain: true, contentAst: [{ type: "text", text: "Under A Day" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: dayParentedPageId, parentId: underDayId, presentAsMain: true, contentAst: [{ type: "text", text: "Nested Under Day" }] },
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: { objectId: SYSTEM_PAGE_UUIDS.inbox, presentAsMain: true, contentAst: [{ type: "text", text: "inbox" }] },
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const exported = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(exported.statusCode).toBe(200);
    const files = unzipSync(new Uint8Array(exported.rawPayload));
    const names = Object.keys(files);
    const manifest = JSON.parse(new TextDecoder().decode(files["notees-manifest.json"])) as {
      nodes: Array<{ id: string }>;
    };
    const exportedIds = new Set(manifest.nodes.map((node) => node.id));
    // Only the real page exports; the date chain, the day-parented pages,
    // and the system inbox stay out.
    expect(exportedIds.has(pageId)).toBe(true);
    expect(exportedIds.has(chain.year)).toBe(false);
    expect(exportedIds.has(chain.month)).toBe(false);
    expect(exportedIds.has(chain.day)).toBe(false);
    expect(exportedIds.has(underDayId)).toBe(false);
    expect(exportedIds.has(dayParentedPageId)).toBe(false);
    expect(exportedIds.has(SYSTEM_PAGE_UUIDS.inbox)).toBe(false);
    expect(names.filter((name) => name.endsWith(".md"))).toHaveLength(1);
  });

  it("reassignExportPaths keeps files, manifest, and links agreeing under a filename collision", async () => {
    // The FNV-1a id8 suffix makes real collisions unreachable through the zip
    // route (distinct ids → distinct suffixes), so the de-dupe machinery is
    // defensive; exercise it directly with a synthetic colliding bundle.
    const { reassignExportPaths } = await import("../src/routes-auth.js");
    const bundle = {
      files: [
        { path: "Dup-a1.md", content: "first" },
        { path: "Dup-a1.md", content: "second" },
      ],
      manifest: {
        format: "notees-markdown" as const,
        version: 2 as const,
        generatedAt: "2026-10-03T00:00:00.000Z",
        nodes: [
          { id: "id-1", path: "Dup-a1.md", name: "Dup", type: "page" as const, isClass: false, presentAsMain: true },
          { id: "id-2", path: "Dup-a1.md", name: "Dup", type: "page" as const, isClass: false, presentAsMain: true },
        ],
      },
    };
    reassignExportPaths(bundle, new Map([["id-1", "Dup-a1.md"], ["id-2", "Dup-a1-2.md"]]));
    expect(bundle.files.map((file) => file.path)).toEqual(["Dup-a1.md", "Dup-a1-2.md"]);
    expect(bundle.manifest.nodes.map((node) => node.path)).toEqual(["Dup-a1.md", "Dup-a1-2.md"]);
  });

  it("GET /workspaces/:id/export.zip gives colliding slugs distinct id8 suffixes", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Dupes" },
    });
    const workspaceId = created.json().id as string;

    // Two pages with the SAME title: the hash id8 suffix disambiguates the
    // slug without any counter de-dupe.
    const firstId = "11111111-0000-4000-8000-000000000001";
    const secondId = "11111111-0000-4000-8000-000000000002";
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: pagePayload("Dup", { objectId: firstId }),
      }),
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: pagePayload("Dup", { objectId: secondId }),
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const exported = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(exported.statusCode).toBe(200);
    const files = unzipSync(new Uint8Array(exported.rawPayload));
    expect(Object.keys(files).sort()).toEqual(
      ["Dup-143f8b7a.md", "Dup-133f89e7.md", "notees-manifest.json"].sort(),
    );
    const manifest = JSON.parse(new TextDecoder().decode(files["notees-manifest.json"])) as {
      nodes: Array<{ id: string; path: string }>;
    };
    const byId = new Map(manifest.nodes.map((node) => [node.id, node.path]));
    expect(byId.get(firstId)).toBe("Dup-143f8b7a.md");
    expect(byId.get(secondId)).toBe("Dup-133f89e7.md");
  });

  it("GET /workspaces/:id/export.zip?includeAssets=1 bundles referenced CAS bytes", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Asset Me" },
    });
    const workspaceId = created.json().id as string;

    // An uploaded asset: CAS bytes on disk + the relay's asset index (what
    // the multipart upload route writes), referenced from a page.
    const assetId = crypto.randomUUID();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const hashDir = join(server.dataDir, "workspaces", workspaceId, "assets", hash.slice(0, 4));
    mkdirSync(hashDir, { recursive: true });
    writeFileSync(join(hashDir, hash), bytes);
    server.ctx.relay.recordAsset({
      assetId,
      workspaceId,
      hash,
      mimeType: "image/png",
      size: bytes.length,
      originalName: "My Photo.PNG",
      uploadedAt: new Date().toISOString(),
    });
    const pageId = crypto.randomUUID();
    const assetBlockId = crypto.randomUUID();
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: pageId,
          presentAsMain: true,
          contentAst: [{ type: "text", text: "With Asset" }],
        },
      }),
      // asset_ref lives on an inline block (document-chrome content is
      // text-only; block-scale rich tokens survive on inline blocks).
      testEnvelope({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: assetBlockId,
          parentId: pageId,
          contentAst: [{ type: "asset_ref", assetId }],
        },
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    // Default: no asset bytes, the raw uuid reference stands.
    const without = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip`,
      headers: { authorization: `Bearer ${owner}` },
    });
    const pagePath = (() => {
      const match = Object.keys(unzipSync(new Uint8Array(without.rawPayload))).filter((name) =>
        /^With-Asset-[0-9a-f]{8}\.md$/.test(name),
      );
      expect(match).toHaveLength(1);
      return match[0]!;
    })();
    const assetPath = `assets/My-Photo-${hash.slice(0, 8)}.png`;
    const filesWithout = unzipSync(new Uint8Array(without.rawPayload));
    expect(Object.keys(filesWithout).sort()).toEqual([pagePath, "notees-manifest.json"].sort());
    expect(new TextDecoder().decode(filesWithout[pagePath])).toContain(`![asset](<${assetId}>)`);

    // includeAssets=1: bytes ride under assets/ and the ref is rewritten.
    const withAssets = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceId}/export.zip?includeAssets=1`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(withAssets.statusCode).toBe(200);
    const filesWith = unzipSync(new Uint8Array(withAssets.rawPayload));
    expect(Object.keys(filesWith).sort()).toEqual(
      [pagePath, assetPath, "notees-manifest.json"].sort(),
    );
    expect(new TextDecoder().decode(filesWith[pagePath])).toContain(`![asset](${assetPath})`);
    expect(Buffer.from(filesWith[assetPath] ?? new Uint8Array())).toEqual(bytes);
  });

  it("GET /nodes/:id/location resolves the workspace holding the node", async () => {
    server = await makeTestServer();
    const owner = (await setupAdmin("owner@example.com")).json().token as string;
    const first = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "First" },
    });
    const firstId = first.json().id as string;
    const second = await server.app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${owner}` },
      payload: { name: "Second" },
    });
    const secondId = second.json().id as string;

    // A page in the SECOND workspace.
    const pageId = crypto.randomUUID();
    const batch = await ingest(server, [
      testEnvelope({
        workspaceId: secondId,
        opType: "object.create",
        payload: pagePayload("Faraway Page", { objectId: pageId }),
      }),
    ]);
    expect(batch.statusCode).toBe(200);

    const located = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${pageId}/location`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(located.statusCode).toBe(200);
    expect(located.json()).toEqual({ workspaceId: secondId });

    // Unknown node: 404. Stranger asking about a node they cannot reach: 404.
    const unknown = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${crypto.randomUUID()}/location`,
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(unknown.statusCode).toBe(404);

    const strangerUser = server.ctx.auth.createUser({
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-password-1"),
    });
    const stranger = server.ctx.auth.createSession(strangerUser.id).token;
    const byStranger = await server.app.inject({
      method: "GET",
      url: `/api/nodes/${pageId}/location`,
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(byStranger.statusCode).toBe(404);
  });
});

describe("api keys", () => {
  it("minted keys authenticate as their owner and list workspaces", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "laptop CLI" },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json().token as string;
    expect(key).toMatch(/^nk_[A-Za-z0-9_-]{40}$/);
    expect(created.json().apiKey.prefix).toBe(key.slice(0, 12));

    const workspaces = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().workspaces.length).toBeGreaterThan(0);
  });

  it("key management is session-only; keys cannot mint keys", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const key = (
      await server.app.inject({
        method: "POST",
        url: "/api/api-keys",
        headers: { authorization: `Bearer ${session}` },
        payload: { name: "k" },
      })
    ).json().token as string;
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${key}` },
      payload: { name: "nested" },
    });
    expect(denied.statusCode).toBe(401);
  });

  it("revoked keys stop authenticating; keys cannot manage themselves", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "temp" },
    });
    const { id } = created.json().apiKey as { id: string };
    const key = created.json().token as string;

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/api-keys/${id}`,
      headers: { authorization: `Bearer ${session}` },
    });
    expect(revoked.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("a key can revoke itself (the CLI logout path) but no other key", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const authHeaders = { authorization: `Bearer ${session}` };
    const self = (
      await server.app.inject({ method: "POST", url: "/api/api-keys", headers: authHeaders, payload: { name: "self" } })
    ).json() as { apiKey: { id: string }; token: string };
    const other = (
      await server.app.inject({ method: "POST", url: "/api/api-keys", headers: authHeaders, payload: { name: "other" } })
    ).json() as { apiKey: { id: string }; token: string };

    // Managing another key still demands an account session.
    const foreign = await server.app.inject({
      method: "DELETE",
      url: `/api/api-keys/${other.apiKey.id}`,
      headers: { authorization: `Bearer ${self.token}` },
    });
    expect(foreign.statusCode).toBe(401);

    // Self-revocation succeeds and kills the key immediately.
    const own = await server.app.inject({
      method: "DELETE",
      url: `/api/api-keys/${self.apiKey.id}`,
      headers: { authorization: `Bearer ${self.token}` },
    });
    expect(own.statusCode).toBe(200);
    const me = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${self.token}` },
    });
    expect(me.statusCode).toBe(401);
    const otherMe = await server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(otherMe.statusCode).toBe(200);
  });

  it("an api key syncs the relay with its owner's memberships", async () => {
    server = await makeTestServer();
    const session = (await setupAdmin()).json().token as string;
    const key = (
      await server.app.inject({
        method: "POST",
        url: "/api/api-keys",
        headers: { authorization: `Bearer ${session}` },
        payload: { name: "sync" },
      })
    ).json().token as string;
    const env = testEnvelope({ opType: "object.create", payload: { objectId: crypto.randomUUID(), presentAsMain: true, contentAst: [{ type: "text", text: "Via key" }] } });
    const response = await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      payload: { envelopes: [env] },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("per-account lockout", () => {
  it("locks after 5 failures for 15 minutes, even with the right password", async () => {
    server = await makeTestServer();
    await setupAdmin();
    const bad = { email: "admin@example.com", password: "wrong-password" };
    // Failures 1–4 answer 401; the 5th crosses the threshold and answers 429.
    for (let i = 0; i < 4; i += 1) {
      const response = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: bad });
      expect(response.statusCode).toBe(401);
    }
    const fifth = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: bad });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.code).toBe("account_locked");
    // The next attempt with the CORRECT password is refused while locked.
    const locked = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("account_locked");
  });

  it("a successful login clears the failure count", async () => {
    server = await makeTestServer();
    await setupAdmin();
    for (let i = 0; i < 3; i += 1) {
      await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "wrong-password" },
      });
    }
    const good = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(good.statusCode).toBe(200);
    // Failures were reset: it takes a full 5 again to lock.
    for (let i = 0; i < 4; i += 1) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: "wrong-password" },
      });
      expect(response.statusCode).toBe(401);
    }
    const stillOpen = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    expect(stillOpen.statusCode).toBe(200);
  });
});

describe("password-derived encryption keys", () => {
  it("setup and login return the kdf record; it backfills lazily", async () => {
    server = await makeTestServer();
    const setup = await setupAdmin();
    expect(setup.statusCode).toBe(201);
    const kdf = setup.json().kdf;
    expect(kdf.algorithm).toBe("scrypt");
    expect(kdf.N).toBe(131072);
    expect(typeof kdf.salt).toBe("string");
    expect(typeof kdf.wrappedMasterKey).toBe("string");
    expect(typeof kdf.keyVerifier).toBe("string");

    // Accounts created directly in storage (no setup) get the record on login.
    const legacy = server.ctx.auth.createUser({
      email: "legacy@example.com",
      passwordHash: await hashPassword("legacy-password-1"),
    });
    const login = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "legacy@example.com", password: "legacy-password-1" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().kdf.wrappedMasterKey).toBeTruthy();
    // The record persisted: a second login returns the SAME wrapped key.
    const stored = server.ctx.auth.getKdfRecord(legacy.id);
    expect(stored?.wrappedMasterKey).toBe(login.json().kdf.wrappedMasterKey);
  });
});
