/**
 * Snapshot-image clone & import —
 *
 *  - POST /api/workspaces/:id/clone: an owner-only snapshot-image clone into
 *    a FRESH envelope-empty workspace. The clone's relay log starts EMPTY;
 *    the installed snapshot row is load-bearing (a derived wipe rehydrates
 *    from the snapshot, not a log carrying only the import-time checkpoint).
 *  - PUT /api/relay/v2/snapshot/data?mode=import: install a snapshot image as
 *    a workspace's derived store (workspace_id rewritten), refusing
 *    non-empty targets (409) and node-less images (422 at ANY log size).
 *
 * Both flows end at the same invariant: an envelope-empty workspace whose
 * only state is the derived file + the snapshot row, converging through
 * hydration's snapshot fast path (up_to_seq 0 >= maxSeq 0).
 */

import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import { Store } from "@notees/store";
import { betterSqlite3Backend } from "@notees/store/better-sqlite3";

import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

function sessionHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function setupAdmin(target: TestServer): Promise<string> {
  const res = await target.app.inject({
    method: "POST",
    url: "/api/setup",
    headers: { "content-type": "application/json" },
    payload: { email: "owner@example.test", password: "correct-horse-24" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

async function createWorkspace(target: TestServer, token: string, name: string): Promise<string> {
  const res = await target.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: sessionHeaders(token),
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function cloneWorkspace(
  target: TestServer,
  token: string,
  sourceId: string,
  name: string,
): Promise<Awaited<ReturnType<TestServer["app"]["inject"]>>> {
  return target.app.inject({
    method: "POST",
    url: `/api/workspaces/${sourceId}/clone`,
    headers: sessionHeaders(token),
    payload: { name },
  });
}

/** Seed `count` pages into a workspace through the one write path (relay /batch). */
async function seedPages(target: TestServer, workspaceId: string, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const envelopes = ids.map((id, i) =>
    testEnvelope({ workspaceId, opType: "object.create", payload: pagePayload(`page-${i}`, { objectId: id }) }),
  );
  const res = await ingest(target, envelopes);
  expect(res.statusCode).toBe(200);
  return ids;
}

/** Every distinct workspace_id value carried by a derived store file. */
function workspaceIdsInFile(file: string): Set<string> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const found = new Set<string>();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "workspace_id")) continue;
      const rows = db.prepare(`SELECT workspace_id AS ws FROM ${quoted} WHERE workspace_id IS NOT NULL`).all() as Array<{
        ws: string;
      }>;
      for (const row of rows) found.add(row.ws);
    }
    return found;
  } finally {
    db.close();
  }
}

describe("POST /api/workspaces/:id/clone", () => {
  it("clones a seeded workspace: same nodes, rewritten workspace ids, installed snapshot", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const sourceId = await createWorkspace(server, token, "source");
    const nodeIds = await seedPages(server, sourceId, 3);

    const clone = await cloneWorkspace(server, token, sourceId, "copy");
    expect(clone.statusCode).toBe(201);
    const body = clone.json();
    const cloneId = body.id as string;
    expect(cloneId).not.toBe(sourceId);
    expect(body).toMatchObject({ name: "copy", nodeCount: 3 });

    // The clone is a member workspace of the same account.
    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: sessionHeaders(token),
    });
    expect(list.json().workspaces.map((w: { id: string }) => w.id)).toContain(cloneId);

    // Object reads against the clone return the source's nodes (this route
    // is the first touch of the clone's store — it hydrates by RESTORING
    // the installed snapshot, the load-bearing rebuild path).
    for (const nodeId of nodeIds) {
      const object = await server.app.inject({
        method: "GET",
        url: `/api/objects/${nodeId}`,
        headers: { "x-workspace-id": cloneId, "x-api-key": server.apiKey },
      });
      expect(object.statusCode).toBe(200);
    }

    // Every workspace-scoped row in the clone's derived file carries the
    // clone id — the image's source workspace_id was rewritten on install.
    expect(workspaceIdsInFile(`${server.dataDir}/derived/${cloneId}.db`)).toEqual(new Set([cloneId]));

    // The clone's log is empty; the snapshot row (upToSeq 0) covers it.
    const stats = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/stats?workspaceId=${cloneId}`,
      headers: server.authHeaders,
    });
    expect(stats.json().envelopeCount).toBe(0);
    const meta = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot?workspaceId=${cloneId}`,
      headers: server.authHeaders,
    });
    expect(meta.json()).toMatchObject({ hasSnapshot: true, upToSeq: 0 });
  });

  it("clone of a clone works; a second clone of the same source refuses nothing", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const sourceId = await createWorkspace(server, token, "source");
    await seedPages(server, sourceId, 2);

    const first = await cloneWorkspace(server, token, sourceId, "first");
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id as string;

    const second = await cloneWorkspace(server, token, firstId, "second");
    expect(second.statusCode).toBe(201);
    expect(second.json().nodeCount).toBe(2);

    const third = await cloneWorkspace(server, token, sourceId, "third");
    expect(third.statusCode).toBe(201);
    expect(third.json().nodeCount).toBe(2);
  });

  it("non-members get 404 (the workspace's existence is not revealed)", async () => {
    server = await makeTestServer({ signupEnabled: true });
    const ownerToken = await setupAdmin(server);
    const sourceId = await createWorkspace(server, ownerToken, "source");
    await seedPages(server, sourceId, 1);

    const signup = await server.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      headers: { "content-type": "application/json" },
      payload: { email: "other@example.test", password: "correct-horse-24" },
    });
    expect(signup.statusCode).toBe(201);
    const otherToken = signup.json().token as string;

    const clone = await cloneWorkspace(server, otherToken, sourceId, "copy");
    expect(clone.statusCode).toBe(404);
    expect(clone.json().error.code).toBe("not_found");
  });

  it("a source with no derived data fails loud with 422", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const emptyId = await createWorkspace(server, token, "empty");

    const clone = await cloneWorkspace(server, token, emptyId, "copy");
    expect(clone.statusCode).toBe(422);
    expect(clone.json().error.code).toBe("validation_failed");
  });
});

describe("PUT /snapshot/data?mode=import", () => {
  /** A one-node store image built with @notees/store in memory. */
  function buildImage(workspaceId: string, name: string): Buffer {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    try {
      store.apply(
        testEnvelope({
          workspaceId,
          opType: "object.create",
          payload: pagePayload(name, { objectId: crypto.randomUUID() }),
        }),
      );
      return Buffer.from(store.snapshot());
    } finally {
      store.close();
    }
  }

  async function putImport(
    target: TestServer,
    workspaceId: string,
    bytes: Buffer,
    headers: Record<string, string>,
  ): Promise<Awaited<ReturnType<TestServer["app"]["inject"]>>> {
    return target.app.inject({
      method: "PUT",
      url: `/api/relay/v2/snapshot/data?workspaceId=${workspaceId}&physical=${Date.now()}&logical=0&mode=import`,
      headers: { ...headers, "content-type": "application/octet-stream" },
      payload: bytes,
    });
  }

  it("installs an image into a fresh workspace: restore-on-hydration + rewritten workspace ids", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const targetId = await createWorkspace(server, token, "imported");
    const image = buildImage("11111111-2222-4333-8444-555555555555", "imported-page");

    const put = await putImport(server, targetId, image, sessionHeaders(token));
    expect(put.statusCode).toBe(201);
    expect(put.json()).toMatchObject({ workspaceId: targetId, upToSeq: 0, nodeCount: 1 });

    // The next open of the store restores the snapshot: the node is there,
    // carrying the TARGET workspace id (the image's source id was rewritten).
    const store = server.ctx.workspaces.storeFor(targetId);
    const row = store.database
      .prepare("SELECT id, workspace_id AS ws FROM node WHERE is_class = 0")
      .get() as { id: string; ws: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.ws).toBe(targetId);

    // The snapshot row exists (the load-bearing checkpoint for rebuilds).
    const meta = await server.app.inject({
      method: "GET",
      url: `/api/relay/v2/snapshot?workspaceId=${targetId}`,
      headers: server.authHeaders,
    });
    expect(meta.json()).toMatchObject({ hasSnapshot: true, upToSeq: 0 });
  });

  it("refuses a non-empty target with 409", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const targetId = await createWorkspace(server, token, "occupied");
    await seedPages(server, targetId, 1); // log envelopes + open handle

    const put = await putImport(server, targetId, buildImage(crypto.randomUUID(), "x"), sessionHeaders(token));
    expect(put.statusCode).toBe(409);
    expect(put.json().error.code).toBe("conflict");
  });

  it("refuses a node-less image with 422 regardless of the envelope threshold", async () => {
    server = await makeTestServer();
    const token = await setupAdmin(server);
    const targetId = await createWorkspace(server, token, "fresh");

    const empty = Store.open(betterSqlite3Backend(":memory:"));
    const image = Buffer.from(empty.snapshot());
    empty.close();

    const put = await putImport(server, targetId, image, sessionHeaders(token));
    expect(put.statusCode).toBe(422);
    expect(put.json().error.code).toBe("validation_failed");
  });
});
