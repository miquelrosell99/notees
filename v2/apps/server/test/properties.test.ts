import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
beforeEach(async () => {
  server = await makeTestServer();
});
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

function api(method: string, url: string, options: { payload?: unknown } = {}) {
  const headers: Record<string, string> = { ...server!.authHeaders };
  if (options.payload !== undefined) headers["content-type"] = "application/json";
  return server!.app.inject({
    method: method as "GET",
    url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
  });
}

async function createObject(name: string): Promise<string> {
  const res = await api("POST", "/api/v1/objects", { payload: { nodeType: "page", name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("object property writes", () => {
  it("POST /objects/:id/properties sets a value (idx 0 default) returned on GET", async () => {
    const id = await createObject("prop-target");
    const res = await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "kuhn1962structure" },
    });
    expect(res.statusCode).toBe(200);
    const properties = res.json().object.properties as { schemaId: string; value: unknown }[];
    expect(properties).toContainEqual({
      schemaId: SYSTEM_PROPERTY_UUIDS.citekey,
      schemaName: "citekey",
      schemaType: "text",
      idx: 0,
      value: "kuhn1962structure",
    });

    const fetched = await api("GET", `/api/v1/objects/${id}`);
    expect(
      (fetched.json().object.properties as { schemaId: string; value: unknown }[]).find(
        (p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.citekey,
      )?.value,
    ).toBe("kuhn1962structure");

    // The write flowed through the one envelope pipeline: the relay log grew.
    const stats = await api(
      "GET",
      `/api/relay/v2/stats?workspaceId=${encodeURIComponent(server!.ctx.defaultWorkspace)}`,
    );
    expect(stats.statusCode).toBe(200);
    expect(stats.json().envelopeCount).toBeGreaterThan(0);
  });

  it("re-POST at the same idx overwrites (LWW); idx addresses multi-values", async () => {
    const id = await createObject("prop-multi");
    await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "978-0-00-1", idx: 0 },
    });
    await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "978-0-00-2", idx: 1 },
    });
    // LWW overwrite of idx 0.
    await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "978-0-00-1b", idx: 0 },
    });
    const fetched = await api("GET", `/api/v1/objects/${id}`);
    const values = (fetched.json().object.properties as { schemaId: string; idx: number; value: unknown }[])
      .filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)
      .sort((a, b) => a.idx - b.idx);
    expect(values).toEqual([
      { schemaId: SYSTEM_PROPERTY_UUIDS.isbn, schemaName: "isbn", schemaType: "text", idx: 0, value: "978-0-00-1b" },
      { schemaId: SYSTEM_PROPERTY_UUIDS.isbn, schemaName: "isbn", schemaType: "text", idx: 1, value: "978-0-00-2" },
    ]);
  });

  it("POST carries metadata qualifiers through to the stored value", async () => {
    const id = await createObject("prop-meta");
    const res = await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: {
        propertySchemaId: SYSTEM_PROPERTY_UUIDS.publisher,
        value: "University of Chicago Press",
        metadata: { locator: "2nd ed." },
      },
    });
    const property = (res.json().object.properties as { schemaId: string; metadata?: unknown }[]).find(
      (p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.publisher,
    );
    expect(property?.metadata).toEqual({ locator: "2nd ed." });
  });

  it("DELETE /objects/:id/properties/:schemaId unsets (default idx 0, explicit idx)", async () => {
    const id = await createObject("prop-unset");
    await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "one", idx: 0 },
    });
    await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "two", idx: 1 },
    });
    const deleted = await api("DELETE", `/api/v1/objects/${id}/properties/${SYSTEM_PROPERTY_UUIDS.isbn}?idx=1`);
    expect(deleted.statusCode).toBe(200);
    let properties = deleted.json().object.properties as { schemaId: string; idx: number }[];
    expect(properties.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)).toEqual([
      expect.objectContaining({ idx: 0 }),
    ]);

    await api("DELETE", `/api/v1/objects/${id}/properties/${SYSTEM_PROPERTY_UUIDS.isbn}`);
    const fetched = await api("GET", `/api/v1/objects/${id}`);
    properties = fetched.json().object.properties as { schemaId: string; idx: number }[];
    expect(properties.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)).toEqual([]);
  });

  it("validation: missing object 404, malformed body 422, unknown schema still writes", async () => {
    const ghost = await api("POST", `/api/v1/objects/${crypto.randomUUID()}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "x" },
    });
    expect(ghost.statusCode).toBe(404);

    const id = await createObject("prop-validation");
    const malformed = await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: "not-a-uuid", value: "x" },
    });
    expect(malformed.statusCode).toBe(422);

    // property.set has no schema FK: an arbitrary (valid-UUID) schema id stores.
    const custom = await api("POST", `/api/v1/objects/${id}/properties`, {
      payload: { propertySchemaId: crypto.randomUUID(), value: "loose" },
    });
    expect(custom.statusCode).toBe(200);
  });
});

describe("objects list property filter", () => {
  it("?property=<schemaId>:<value> matches the JSON-encoded scalar exactly", async () => {
    const a = await createObject("filter-a");
    const b = await createObject("filter-b");
    await api("POST", `/api/v1/objects/${a}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "kuhn1962structure" },
    });
    await api("POST", `/api/v1/objects/${b}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "david1962" },
    });

    const hit = await api(
      "GET",
      `/api/v1/objects?property=${SYSTEM_PROPERTY_UUIDS.citekey}:kuhn1962structure`,
    );
    expect(hit.statusCode).toBe(200);
    const ids = hit.json().objects.map((o: { id: string }) => o.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);

    const miss = await api("GET", `/api/v1/objects?property=${SYSTEM_PROPERTY_UUIDS.citekey}:kuhn`);
    expect(miss.json().objects).toEqual([]);

    const badSchema = await api("GET", `/api/v1/objects?property=not-a-uuid:x`);
    expect(badSchema.statusCode).toBe(422);
  });

  it("combines with the class filter for source-class lookups", async () => {
    const other = await createObject("filter-plain");
    const book = (
      await api("POST", "/api/v1/objects", {
        payload: { nodeType: "page", name: "filter-book", classIds: [SYSTEM_CLASS_UUIDS.book] },
      })
    ).json().id as string;
    await api("POST", `/api/v1/objects/${book}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "shared-key" },
    });
    await api("POST", `/api/v1/objects/${other}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "shared-key" },
    });

    const res = await api(
      "GET",
      `/api/v1/objects?class=${SYSTEM_CLASS_UUIDS.book}&property=${SYSTEM_PROPERTY_UUIDS.citekey}:shared-key`,
    );
    const ids = res.json().objects.map((o: { id: string }) => o.id);
    expect(ids).toEqual([book]);
  });
});

describe("property schemas", () => {
  it("GET returns the seeded bibliographic schemas by fixed UUID", async () => {
    const res = await api("GET", `/api/v1/property-schemas/${SYSTEM_PROPERTY_UUIDS.citekey}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().propertySchema).toMatchObject({
      id: SYSTEM_PROPERTY_UUIDS.citekey,
      name: "citekey",
      type: "text",
      multi: false,
    });

    const authors = await api("GET", `/api/v1/property-schemas/${SYSTEM_PROPERTY_UUIDS.authors}`);
    expect(authors.json().propertySchema).toMatchObject({ multi: true, type: "text" });
    expect(authors.json().propertySchema.targetClassFilter).toBeNull();

    // Explicit person linkage is the node-typed sibling property.
    const linked = await api("GET", `/api/v1/property-schemas/${SYSTEM_PROPERTY_UUIDS.linkedAuthors}`);
    expect(linked.json().propertySchema).toMatchObject({ multi: true, type: "object" });
    expect(linked.json().propertySchema.targetClassFilter).toEqual([SYSTEM_CLASS_UUIDS.agent]);

    const missing = await api("GET", `/api/v1/property-schemas/${crypto.randomUUID()}`);
    expect(missing.statusCode).toBe(404);
  });

  it("POST creates a schema with a caller-chosen (fixed) UUID through the pipeline", async () => {
    const schemaId = "10000000-0000-4000-8000-0000000000b5";
    const res = await api("POST", "/api/v1/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false, scope: "global" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().propertySchema).toMatchObject({ id: schemaId, name: "externalId", type: "text" });

    // Get-or-create convergence: re-POSTing the same UUID does not duplicate.
    const again = await api("POST", "/api/v1/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false, scope: "global" },
    });
    expect(again.statusCode).toBe(201);

    const bad = await api("POST", "/api/v1/property-schemas", {
      payload: { propertySchemaId: "nope", name: "x", type: "text" },
    });
    expect(bad.statusCode).toBe(422);
  });
});
