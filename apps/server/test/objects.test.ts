import { afterEach, describe, expect, it } from "vitest";

import { newEnvelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

function api(method: string, url: string, options: { payload?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...server!.authHeaders, ...(options.headers ?? {}) };
  if (options.payload !== undefined) headers["content-type"] = "application/json";
  return server!.app.inject({
    method: method as "GET",
    url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
  });
}

describe("objects API", () => {
  it("create → get round-trip", async () => {
    server = await makeTestServer();
    const created = await api("POST", "/api/v1/objects", {
      payload: { nodeType: "page", name: "Round Trip", contentAst: [{ type: "text", text: "hello body" }] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = await api("GET", `/api/v1/objects/${id}`);
    expect(fetched.statusCode).toBe(200);
    const object = fetched.json().object;
    expect(object).toMatchObject({ id, nodeType: "page", isActive: true });
    // Title-is-content: `name` is no longer stored (the convenience field is
    // dropped when an explicit contentAst rides along); the API name is the
    // title derived from the content.
    expect(object.name).toBe("hello body");
    expect(object.contentAst).toEqual([{ type: "text", text: "hello body" }]);
    expect(object.workspaceId).toBe(server.ctx.defaultWorkspace);
  });

  it("PATCH updates fields (LWW: the later write wins)", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: "Before" } })).json();
    const patched = await api("PATCH", `/api/v1/objects/${id}`, { payload: { contentAst: [{ type: "text", text: "After" }] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().object.contentAst).toEqual([{ type: "text", text: "After" }]);

    await api("PATCH", `/api/v1/objects/${id}`, { payload: { contentAst: [{ type: "text", text: "Second" }] } });
    const fetched = await api("GET", `/api/v1/objects/${id}`);
    expect(fetched.json().object.contentAst).toEqual([{ type: "text", text: "Second" }]);
  });

  it("PATCH on a missing object is a 404 envelope", async () => {
    server = await makeTestServer();
    const res = await api("PATCH", `/api/v1/objects/${crypto.randomUUID()}`, { payload: { contentAst: [{ type: "text", text: "ghost" }] } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("soft delete keeps the object retrievable; permanent delete removes it", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: "Doomed" } })).json();

    const soft = await api("DELETE", `/api/v1/objects/${id}`);
    expect(soft.statusCode).toBe(200);
    expect(soft.json()).toMatchObject({ id, deleted: true, permanent: false });

    const fetched = await api("GET", `/api/v1/objects/${id}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().object.isActive).toBe(false);

    const noConfirm = await api("DELETE", `/api/v1/objects/${id}?permanent=true`);
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.code).toBe("validation_failed");

    const confirmed = await api("DELETE", `/api/v1/objects/${id}?permanent=true&confirm=${id}`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().permanent).toBe(true);

    const gone = await api("GET", `/api/v1/objects/${id}`);
    expect(gone.statusCode).toBe(404);
  });

  it("objects list supports nodeType filter and cursor pagination", async () => {
    server = await makeTestServer();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { id } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: `p${i}` } })).json();
      ids.push(id);
    }
    const block = (await api("POST", "/api/v1/objects", { payload: { nodeType: "block", name: "b1", parentId: ids[0] } })).json();
    expect(block.id).toBeTruthy();

    const page1 = (await api("GET", "/api/v1/objects?nodeType=page&limit=2")).json();
    expect(page1.objects).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await api("GET", `/api/v1/objects?nodeType=page&limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.objects).toHaveLength(2);
    expect(new Set([...page1.objects.map((o: { id: string }) => o.id), ...page2.objects.map((o: { id: string }) => o.id)]).size).toBe(4);

    const blocks = (await api("GET", "/api/v1/objects?nodeType=block")).json();
    expect(blocks.objects.map((o: { id: string }) => o.id)).toContain(block.id);
  });

  it("search finds inserted content", async () => {
    server = await makeTestServer();
    const { id } = (
      await api("POST", "/api/v1/objects", {
        payload: {
          nodeType: "page",
          name: "Searchable",
          contentAst: [{ type: "text", text: "quixotic expedition notes" }],
        },
      })
    ).json();
    const res = await api("GET", "/api/v1/search?q=quixotic");
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { id: string }) => r.id)).toContain(id);
  });

  it("backlinks reflect an emitted mention", async () => {
    server = await makeTestServer();
    const { id: target } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: "Target" } })).json();
    const { id: source } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: "Source" } })).json();
    // Title-is-content: pages carry text-only content, so the mention token
    // rides in a block child of the source page.
    const { id: block } = (
      await api("POST", "/api/v1/objects", {
        payload: {
          nodeType: "block",
          parentId: source,
          contentAst: [{ type: "mention", targetNodeId: target, text: "Target" }],
        },
      })
    ).json();

    const res = await api("GET", `/api/v1/objects/${target}/backlinks`);
    expect(res.statusCode).toBe(200);
    const backlinks = res.json().backlinks;
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({ source_id: block, target_id: target, type: "mention" });
  });

  it("classes listing includes the seeded system classes", async () => {
    server = await makeTestServer();
    const res = await api("GET", "/api/v1/classes");
    expect(res.statusCode).toBe(200);
    const classes = res.json().classes as { id: string; icon: string | null; memberCount: number }[];
    const byId = new Map(classes.map((c) => [c.id, c]));
    for (const expected of ["task", "day", "source", "collection", "whiteboard"] as const) {
      expect(byId.has(SYSTEM_CLASS_UUIDS[expected])).toBe(true);
    }
    const task = byId.get(SYSTEM_CLASS_UUIDS.task)!;
    expect(task.icon).toBe("mdiCheckboxMarkedCircleOutline");

    const detail = await api("GET", `/api/v1/classes/${SYSTEM_CLASS_UUIDS.task}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().members).toEqual([]);
  });

  it("create with a class assignment shows up in class members", async () => {
    server = await makeTestServer();
    const { id } = (
      await api("POST", "/api/v1/objects", {
        payload: { nodeType: "page", name: "Task page", classIds: [SYSTEM_CLASS_UUIDS.task] },
      })
    ).json();
    const detail = (await api("GET", `/api/v1/classes/${SYSTEM_CLASS_UUIDS.task}`)).json();
    expect(detail.members.map((m: { id: string }) => m.id)).toContain(id);
    const objects = (await api("GET", `/api/v1/objects?class=${SYSTEM_CLASS_UUIDS.task}`)).json();
    expect(objects.objects.map((o: { id: string }) => o.id)).toContain(id);
  });

  it("requires the API key on the object surface", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({ method: "GET", url: "/api/v1/objects/anything" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("property values endpoint returns stored values", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name: "Prop" } })).json();
    const isbnSchema = SYSTEM_PROPERTY_UUIDS.isbn;
    const env = newEnvelope({
      workspaceId: server.ctx.defaultWorkspace,
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now(), logical: 0 },
      opType: "property.set",
      payload: { objectId: id, propertySchemaId: isbnSchema, value: "978-3-16-148410-0", idx: 0 },
    });
    await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { envelopes: [env] },
    });
    const res = await api("GET", `/api/v1/properties/${isbnSchema}/values`);
    expect(res.statusCode).toBe(200);
    // The values endpoint still selects the (retired) node.name column, so
    // objectName is null post-title-is-content; the stored value is the point.
    expect(res.json().values).toEqual([{ objectId: id, objectName: null, idx: 0, value: "978-3-16-148410-0" }]);
  });
});
