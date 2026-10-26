/**
 * Search freshness contract tests: every write the object API acknowledges
 * is IMMEDIATELY visible to every search/list surface it feeds — no sleeps,
 * same-test, straight through the HTTP write path (POST /api/objects, the
 * property route, DELETE). The server's search index is maintained
 * synchronously inside the applier transaction (packages/store/src/
 * appliers.ts reindexNode / removeSearchIndexEntry — the same transaction
 * that applies the op), the write path awaits that apply before responding
 * (workspace-store.ts applyNow ← context.submit), and reads ride the same
 * single better-sqlite3 connection — so an acknowledged write IS the
 * freshness boundary. These tests pin that contract: a future asynchronous
 * indexer, debounce, or batch on the server must turn them red.
 *
 * Surfaces pinned per write:
 *  - GET /api/search?q= (the ranked FTS route)
 *  - GET /api/objects?q= (the list filter — the CLI importer's
 *    title-match narrowing reads)
 *  - POST /api/query with the exists-arm AST (the DSL `prop:name:`
 *    contract the CLI compiles client-side)
 */

import { afterEach, describe, expect, it } from "vitest";

import type { Child, QueryAst } from "@notees/query";

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

function ast(children: Child[]): QueryAst {
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

async function createFreshnessProbe(): Promise<{ id: string; title: string; schemaId: string; value: string }> {
  const title = "freshness-probe-aldrin";
  const value = "freshness-value-quasar";
  const created = await api("POST", "/api/objects", { payload: { name: title } });
  expect(created.statusCode).toBe(201);
  const { id } = created.json() as { id: string };
  const schema = await api("POST", "/api/property-schemas", {
    payload: { propertySchemaId: crypto.randomUUID(), name: "freshnessProbe", type: "text" },
  });
  expect(schema.statusCode).toBe(201);
  const schemaId = (schema.json() as { propertySchema: { id: string } }).propertySchema.id;
  // The write whose acknowledgment IS the freshness boundary for this probe.
  const set = await api("POST", `/api/objects/${id}/properties`, {
    payload: { propertySchemaId: schemaId, value, idx: 0 },
  });
  expect(set.statusCode).toBe(200);
  return { id, title, schemaId, value };
}

describe("search freshness over the HTTP write path", () => {
  it("an acknowledged create + property set is immediately visible to /api/search, the q= filter, and the exists-arm", async () => {
    server = await makeTestServer();
    const { id, title, schemaId, value } = await createFreshnessProbe();

    // FTS by title.
    const byTitle = await api("GET", `/api/search?q=${encodeURIComponent(title)}`);
    expect(byTitle.statusCode).toBe(200);
    expect(
      (byTitle.json() as { results: Array<{ id: string }> }).results.map((hit) => hit.id),
    ).toContain(id);

    // FTS by property value — text-ish property values fold into the owner's
    // indexed plaintext, so a value written seconds ago is findable now.
    const byValue = await api("GET", `/api/search?q=${encodeURIComponent(value)}`);
    expect(byValue.statusCode).toBe(200);
    expect(
      (byValue.json() as { results: Array<{ id: string }> }).results.map((hit) => hit.id),
    ).toContain(id);

    // The list q= filter (the importer's title-match narrowing surface).
    const list = await api("GET", `/api/objects?q=${encodeURIComponent(title)}`);
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as { objects: Array<{ id: string }> }).objects.map((row) => row.id),
    ).toContain(id);

    // The DSL exists-arm: `prop:freshnessProbe:` compiled client-side is this
    // AST through POST /api/query.
    const exists = await api("POST", "/api/query", {
      payload: { ast: ast([{ type: "property", schemaId, op: "exists" }]) },
    });
    expect(exists.statusCode).toBe(200);
    expect((exists.json() as { ids: string[] }).ids).toContain(id);
  });

  it("an acknowledged delete is immediately absent from /api/search and the q= filter", async () => {
    server = await makeTestServer();
    const { id, title } = await createFreshnessProbe();

    const deleted = await api("DELETE", `/api/objects/${id}`);
    expect(deleted.statusCode).toBe(200);

    const search = await api("GET", `/api/search?q=${encodeURIComponent(title)}`);
    expect(search.statusCode).toBe(200);
    expect(
      (search.json() as { results: Array<{ id: string }> }).results.map((hit) => hit.id),
    ).not.toContain(id);

    const list = await api("GET", `/api/objects?q=${encodeURIComponent(title)}`);
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as { objects: Array<{ id: string }> }).objects.map((row) => row.id),
    ).not.toContain(id);
  });
});
