/**
 * POST /api/query tests: the QueryAST execution endpoint — plain runs
 * (ids + node summaries), property comparison operators, aggregated ASTs
 * (grouped grid), fail-loud 422s for invalid ASTs / unsupported compilations,
 * and the GET /property-schemas listing the DSL's name resolution needs.
 */

import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
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

async function createPaper(name: string, year?: number): Promise<string> {
  const { id } = (
    await api("POST", "/api/objects", {
      payload: {
        presentAsMain: true,
        // Title-is-content: the paper's own content IS its title.
        contentAst: [{ type: "text", text: name }],
        classIds: [SYSTEM_CLASS_UUIDS.paper],
      },
    })
  ).json();
  if (year !== undefined) {
    const yearSchema = await ensureYearSchema();
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: yearSchema, value: year, idx: 0 },
    });
  }
  return id;
}

// Per-server cache: each test boots a fresh server (fresh workspace), so the
// year schema id must not leak across servers.
const yearSchemaByServer = new WeakMap<TestServer, string>();
async function ensureYearSchema(): Promise<string> {
  const cached = yearSchemaByServer.get(server!);
  if (cached !== undefined) return cached;
  const res = await api("POST", "/api/property-schemas", {
    payload: { propertySchemaId: crypto.randomUUID(), name: "year", type: "number" },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().propertySchema.id as string;
  yearSchemaByServer.set(server!, id);
  return id;
}

describe("POST /api/query", () => {
  it("runs a plain AST: ids plus node summaries (class + property comparison)", async () => {
    server = await makeTestServer();
    const old = await createPaper("query-old-paper", 1901);
    const modern = await createPaper("query-modern-paper", 2015);
    await createPaper("query-unclassed");

    const res = await api("POST", "/api/query", {
      payload: {
        ast: ast([
          { type: "class", classId: SYSTEM_CLASS_UUIDS.paper },
          { type: "property", schemaId: await ensureYearSchema(), op: "gt", value: 1900 },
        ]),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ids.sort()).toEqual([old, modern].sort());
    expect(body.columns).toBeUndefined();
    const byId = new Map(body.rows.map((row: { id: string }) => [row.id, row]));
    expect(byId.get(modern)).toMatchObject({
      isClass: false,
      presentAsMain: true,
      // Title-is-content: the summary name derives from the node's content.
      name: "query-modern-paper",
      createdAt: expect.any(String),
    });
  });

  it("numeric gt selects by year (the class:paper AND year:>2010 shape)", async () => {
    server = await makeTestServer();
    await createPaper("query-1901", 1901);
    const recent = await createPaper("query-2015", 2015);
    const res = await api("POST", "/api/query", {
      payload: {
        ast: ast([
          { type: "class", classId: SYSTEM_CLASS_UUIDS.paper },
          { type: "property", schemaId: await ensureYearSchema(), op: "gte", value: 2010 },
        ]),
      },
    });
    expect(res.json().ids).toEqual([recent]);
  });

  it("runs an aggregated AST as the grouped grid", async () => {
    server = await makeTestServer();
    await createPaper("query-agg-a", 1901);
    await createPaper("query-agg-b", 1901);
    await createPaper("query-agg-c", 2015);
    const res = await api("POST", "/api/query", {
      payload: {
        ast: {
          ...ast([{ type: "class", classId: SYSTEM_CLASS_UUIDS.paper }]),
          aggregation: {
            dimensions: [{ kind: "property", id: await ensureYearSchema() }],
            measures: [{ function: "count" }],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().columns).toEqual([`property:${await ensureYearSchema()}` , "count"]);
    expect(res.json().rows.sort()).toEqual([[1901, 2], [2015, 1]]);
  });

  it("422s loudly on invalid ASTs, unknown conditions and bad bodies", async () => {
    server = await makeTestServer();
    const invalid = await api("POST", "/api/query", {
      payload: { ast: { version: 2, scope: { type: "pages" }, root: { type: "group", logic: "and", children: [] } } },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.message).toContain("invalid query AST");

    const unknownCondition = await api("POST", "/api/query", {
      payload: {
        ast: ast([{ type: "weather", sunny: true }] as unknown as Child[]),
      },
    });
    expect(unknownCondition.statusCode).toBe(422);

    const badBody = await api("POST", "/api/query", { payload: { notAst: 1 } });
    expect(badBody.statusCode).toBe(422);
  });

  it("422s loudly on unexecutable ASTs (fts with no searchable terms)", async () => {
    server = await makeTestServer();
    const res = await api("POST", "/api/query", {
      payload: { ast: ast([{ type: "content", op: "fts", value: "!!!" }]) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("query not supported");
  });

  it("requires the API key", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/query",
      headers: { "content-type": "application/json" },
      payload: { ast: ast([]) },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/property-schemas", () => {
  it("lists active property schemas by name (the DSL resolver read)", async () => {
    server = await makeTestServer();
    const year = await ensureYearSchema();
    const res = await api("GET", "/api/property-schemas");
    expect(res.statusCode).toBe(200);
    const schemas = res.json().propertySchemas as { id: string; name: string; type: string; multi: boolean }[];
    const byName = new Map(schemas.map((schema) => [schema.name, schema]));
    expect(byName.get("year")).toMatchObject({ id: year, type: "number", multi: false });
    // Seeded bibliographic schemas are listed too (citekey is the DSL's
    // prop:citekey:… target — seeded under its normal-wording name).
    expect(byName.has("Citekey")).toBe(true);
  });
});
