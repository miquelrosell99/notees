/**
 * Node merge route tests (POST /api/objects/:id/merge): the server plans
 * over its derived projection and submits existing-op batches through the
 * one write path; ?dryRun previews without writing; guards answer 422
 * before anything reaches the log.
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

function api(
  method: string,
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...server!.authHeaders, ...(options.headers ?? {}) };
  if (options.payload !== undefined) headers["content-type"] = "application/json";
  return server!.app.inject({
    method: method as "GET",
    url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
  });
}

async function createObject(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await api("POST", "/api/objects", { payload: { isEmbedded: false, name, ...extra } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("object merge route", () => {
  it("dryRun previews the plan without writing", async () => {
    server = await makeTestServer();
    const source = await createObject("Source");
    const target = await createObject("Target");
    const child = await createObject("Child", { parentId: source });

    const res = await api("POST", `/api/objects/${source}/merge?dryRun=true`, {
      payload: { targetId: target },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.summary.childrenMoved).toBe(1);
    expect(body.merged).toBeUndefined();

    // Nothing was written: the source is still active with its child.
    const fetched = await api("GET", `/api/objects/${source}`);
    expect(fetched.json().object.isActive).toBe(true);
    const children = await api("GET", `/api/objects/${source}/children`);
    expect(children.json().children).toHaveLength(1);
  });

  it("merges end to end through the one write path", async () => {
    server = await makeTestServer();
    const source = await createObject("Source");
    const target = await createObject("Target");
    // A child page under the source (parenting rides object.create; there is
    // deliberately no REST reparent — moves are the outliner/op-log path).
    const child = await createObject("Child", { parentId: source });
    // A class + an authored property on the source.
    const classRes = await api("POST", "/api/objects", { payload: { isClass: true, name: "Book" } });
    expect(classRes.statusCode).toBe(201);
    const bookClass = classRes.json().id as string;
    await api("PUT", `/api/objects/${source}/classes/${bookClass}`);
    const statusSchemaId = crypto.randomUUID();
    const schemaRes = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: statusSchemaId, name: "MergeStatus", type: "text" },
    });
    expect(schemaRes.statusCode).toBe(201);
    await api("POST", `/api/objects/${source}/properties`, {
      payload: { propertySchemaId: statusSchemaId, value: "draft" },
    });

    const res = await api("POST", `/api/objects/${source}/merge`, { payload: { targetId: target } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.merged).toBe(true);
    expect(body.targetId).toBe(target);
    expect(body.summary.childrenMoved).toBe(1);
    expect(body.summary.classesRemapped).toBe(1);
    expect(body.summary.propertiesCopied).toBe(1);

    // Source trashed, child moved, class + property remapped.
    const sourceAfter = await api("GET", `/api/objects/${source}`);
    expect(sourceAfter.json().object.isActive).toBe(false);
    const targetChildren = await api("GET", `/api/objects/${target}/children`);
    expect(targetChildren.json().children.map((c: { id: string }) => c.id)).toEqual([child]);
    const targetAfter = await api("GET", `/api/objects/${target}`);
    expect(targetAfter.json().object.classIds).toContain(bookClass);
    const targetProps = await api("GET", `/api/objects/${target}/effective-properties`);
    const status = targetProps
      .json()
      .properties.filter((p: { schemaId: string }) => p.schemaId === statusSchemaId);
    expect(status).toHaveLength(1);
    expect(status[0].value).toBe("draft");
    expect(status[0].source).toBe("authored");
  });

  it("guard failures answer 422 and write nothing", async () => {
    server = await makeTestServer();
    const source = await createObject("Source");
    const target = await createObject("Target");
    const child = await createObject("Child", { parentId: source });

    // Target inside the source subtree.
    const nested = await api("POST", `/api/objects/${source}/merge`, { payload: { targetId: child } });
    expect(nested.statusCode).toBe(422);
    expect(nested.json().error.code).toBe("validation_failed");

    // Source === target.
    const same = await api("POST", `/api/objects/${source}/merge`, { payload: { targetId: source } });
    expect(same.statusCode).toBe(422);

    // Bad body.
    const bad = await api("POST", `/api/objects/${source}/merge`, { payload: { targetId: "nope" } });
    expect(bad.statusCode).toBe(422);

    // Nothing reached the log: the source is intact.
    const fetched = await api("GET", `/api/objects/${source}`);
    expect(fetched.json().object.isActive).toBe(true);
  });

  it("missing source answers 404", async () => {
    server = await makeTestServer();
    const target = await createObject("Target");
    const res = await api("POST", "/api/objects/0192a000-0000-7000-8000-0000000000bf/merge", {
      payload: { targetId: target },
    });
    expect(res.statusCode).toBe(404);
  });

  it("scoped keys need objects.write", async () => {
    server = await makeTestServer();
    const source = await createObject("Source");
    const target = await createObject("Target");
    const setup = await server.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "admin-password-1" },
    });
    const session = setup.json().token as string;
    const key = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "merge-read-only", scopes: ["objects.read"] },
    });
    const res = await api("POST", `/api/objects/${source}/merge`, {
      payload: { targetId: target },
      headers: { "x-api-key": key.json().token as string },
    });
    expect(res.statusCode).toBe(403);
  });
});
