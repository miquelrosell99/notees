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
  const res = await api("POST", "/api/objects", { payload: { presentAsMain: true, name } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("object property writes", () => {
  it("POST /objects/:id/properties sets a value (idx 0 default) returned on GET", async () => {
    const id = await createObject("prop-target");
    const res = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "kuhn1962structure" },
    });
    expect(res.statusCode).toBe(200);
    const properties = res.json().object.properties as { schemaId: string; value: unknown }[];
    expect(properties).toContainEqual({
      schemaId: SYSTEM_PROPERTY_UUIDS.citekey,
      schemaName: "citekey",
      schemaType: "text",
      // PG5: the authored row's stable element id (deterministic composite
      // for positional writes) rides every property entry.
      elementId: expect.stringContaining(`:${SYSTEM_PROPERTY_UUIDS.citekey}:0`),
      idx: 0,
      value: "kuhn1962structure",
    });

    const fetched = await api("GET", `/api/objects/${id}`);
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
    // PG6 cardinality: higher slots need a multi schema — create one and
    // address it at idx 0/1 (isbn is single-value; idx 1 there is a 422 now).
    const multi = (await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: crypto.randomUUID(), name: "alt-titles", type: "text", multi: true },
    })).json().propertySchema;
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: multi.id, value: "978-0-00-1", idx: 0 },
    });
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: multi.id, value: "978-0-00-2", idx: 1 },
    });
    // LWW overwrite of idx 0.
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: multi.id, value: "978-0-00-1b", idx: 0 },
    });
    const fetched = await api("GET", `/api/objects/${id}`);
    const values = (fetched.json().object.properties as { schemaId: string; idx: number; value: unknown }[])
      .filter((p) => p.schemaId === multi.id)
      .sort((a, b) => a.idx - b.idx);
    expect(values).toEqual([
      expect.objectContaining({ schemaId: multi.id, schemaName: "alt-titles", schemaType: "text", idx: 0, value: "978-0-00-1b" }),
      expect.objectContaining({ schemaId: multi.id, schemaName: "alt-titles", schemaType: "text", idx: 1, value: "978-0-00-2" }),
    ]);
  });

  it("POST carries metadata qualifiers through to the stored value", async () => {
    const id = await createObject("prop-meta");
    const res = await api("POST", `/api/objects/${id}/properties`, {
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
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "one", idx: 0 },
    });
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.isbn, value: "two", idx: 1 },
    });
    const deleted = await api("DELETE", `/api/objects/${id}/properties/${SYSTEM_PROPERTY_UUIDS.isbn}?idx=1`);
    expect(deleted.statusCode).toBe(200);
    let properties = deleted.json().object.properties as { schemaId: string; idx: number }[];
    expect(properties.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)).toEqual([
      expect.objectContaining({ idx: 0 }),
    ]);

    await api("DELETE", `/api/objects/${id}/properties/${SYSTEM_PROPERTY_UUIDS.isbn}`);
    const fetched = await api("GET", `/api/objects/${id}`);
    properties = fetched.json().object.properties as { schemaId: string; idx: number }[];
    expect(properties.filter((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.isbn)).toEqual([]);
  });

  it("validation: missing object 404, malformed body 422, unknown schema still writes", async () => {
    const ghost = await api("POST", `/api/objects/${crypto.randomUUID()}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "x" },
    });
    expect(ghost.statusCode).toBe(404);

    const id = await createObject("prop-validation");
    const malformed = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: "not-a-uuid", value: "x" },
    });
    expect(malformed.statusCode).toBe(422);

    // property.set has no schema FK: an arbitrary (valid-UUID) schema id stores.
    const custom = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: crypto.randomUUID(), value: "loose" },
    });
    expect(custom.statusCode).toBe(200);
  });
});

describe("objects list property filter", () => {
  it("?property=<schemaId>:<value> matches the JSON-encoded scalar exactly", async () => {
    const a = await createObject("filter-a");
    const b = await createObject("filter-b");
    await api("POST", `/api/objects/${a}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "kuhn1962structure" },
    });
    await api("POST", `/api/objects/${b}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "david1962" },
    });

    const hit = await api(
      "GET",
      `/api/objects?property=${SYSTEM_PROPERTY_UUIDS.citekey}:kuhn1962structure`,
    );
    expect(hit.statusCode).toBe(200);
    const ids = hit.json().objects.map((o: { id: string }) => o.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);

    const miss = await api("GET", `/api/objects?property=${SYSTEM_PROPERTY_UUIDS.citekey}:kuhn`);
    expect(miss.json().objects).toEqual([]);

    const badSchema = await api("GET", `/api/objects?property=not-a-uuid:x`);
    expect(badSchema.statusCode).toBe(422);
  });

  it("combines with the class filter for source-class lookups", async () => {
    const other = await createObject("filter-plain");
    const book = (
      await api("POST", "/api/objects", {
        payload: { presentAsMain: true, name: "filter-book", classIds: [SYSTEM_CLASS_UUIDS.book] },
      })
    ).json().id as string;
    await api("POST", `/api/objects/${book}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "shared-key" },
    });
    await api("POST", `/api/objects/${other}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "shared-key" },
    });

    const res = await api(
      "GET",
      `/api/objects?class=${SYSTEM_CLASS_UUIDS.book}&property=${SYSTEM_PROPERTY_UUIDS.citekey}:shared-key`,
    );
    const ids = res.json().objects.map((o: { id: string }) => o.id);
    expect(ids).toEqual([book]);
  });
});

describe("property schemas", () => {
  it("GET returns the seeded bibliographic schemas by fixed UUID", async () => {
    const res = await api("GET", `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.citekey}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().propertySchema).toMatchObject({
      id: SYSTEM_PROPERTY_UUIDS.citekey,
      name: "citekey",
      type: "text",
      multi: false,
    });

    // FINAL authorship (2026-09-27): authors is node-typed to agent nodes.
    const authors = await api("GET", `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.authors}`);
    expect(authors.json().propertySchema).toMatchObject({ multi: true, type: "object" });
    expect(authors.json().propertySchema.targetClassFilter).toEqual([SYSTEM_CLASS_UUIDS.agent]);

    // The withdrawn `linkedAuthors` schema (…0025) is not seeded.
    const withdrawn = await api("GET", "/api/property-schemas/00000000-0000-0000-0000-000000000025");
    expect(withdrawn.statusCode).toBe(404);

    const missing = await api("GET", `/api/property-schemas/${crypto.randomUUID()}`);
    expect(missing.statusCode).toBe(404);
  });

  it("POST creates a schema with a caller-chosen (fixed) UUID through the pipeline", async () => {
    const schemaId = "10000000-0000-4000-8000-0000000000b5";
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false, scope: "global" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().propertySchema).toMatchObject({ id: schemaId, name: "externalId", type: "text" });

    // Get-or-create convergence: re-POSTing the same UUID does not duplicate.
    const again = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false, scope: "global" },
    });
    expect(again.statusCode).toBe(201);

    const bad = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: "nope", name: "x", type: "text" },
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe("property schema update/delete routes (§34.32 PG7)", () => {
  async function createSchema(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const schemaId = crypto.randomUUID();
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name, type: "text", multi: false, scope: "global", ...extra },
    });
    expect(res.statusCode).toBe(201);
    return schemaId;
  }

  it("PATCH renames and patches options/date behavior; empty body and unknown id fail loud", async () => {
    const schemaId = await createSchema("pg7-color", { type: "select", options: [{ id: "opt-1", label: "Red" }] });

    const renamed = await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { name: "pg7-hue" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().propertySchema).toMatchObject({ id: schemaId, name: "pg7-hue" });

    const optionsPatched = await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { options: [{ id: "opt-1", label: "Crimson" }, { id: "opt-2", label: "Teal" }] },
    });
    expect(optionsPatched.statusCode).toBe(200);
    expect(optionsPatched.json().propertySchema.options).toEqual([
      { id: "opt-1", label: "Crimson" },
      { id: "opt-2", label: "Teal" },
    ]);

    // Date behavior patch (the Class View editor's surface).
    const dateSchema = await createSchema("pg7-when", { type: "date" });
    const datePatched = await api("PATCH", `/api/property-schemas/${dateSchema}`, {
      payload: { datePrecision: "year", dateQualified: true },
    });
    expect(datePatched.json().propertySchema).toMatchObject({ datePrecision: "year", dateQualified: true });

    const empty = await api("PATCH", `/api/property-schemas/${schemaId}`, { payload: {} });
    expect(empty.statusCode).toBe(422);

    const missing = await api("PATCH", `/api/property-schemas/${crypto.randomUUID()}`, {
      payload: { name: "ghost" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("DELETE soft-deletes: gone from reads, authored values survive, second delete 404s", async () => {
    const schemaId = await createSchema("pg7-doomed");
    const id = await createObject("pg7-carrier");
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: schemaId, value: "authored-survives" },
    });

    const deleted = await api("DELETE", `/api/property-schemas/${schemaId}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: schemaId, deleted: true });

    expect((await api("GET", `/api/property-schemas/${schemaId}`)).statusCode).toBe(404);
    const list = await api("GET", "/api/property-schemas");
    expect(
      (list.json().propertySchemas as Array<{ id: string }>).some((s) => s.id === schemaId),
    ).toBe(false);

    // The authored value row is untouched (SCHEMA.md: the soft-delete hides
    // the schema; values stay stored).
    const fetched = await api("GET", `/api/objects/${id}`);
    expect(
      (fetched.json().object.properties as Array<{ schemaId: string; value: unknown }>).find(
        (p) => p.schemaId === schemaId,
      )?.value,
    ).toBe("authored-survives");

    const again = await api("DELETE", `/api/property-schemas/${schemaId}`);
    expect(again.statusCode).toBe(404);
  });
});

describe("class property binding routes (§34.32 PG7)", () => {
  async function createClass(name: string): Promise<string> {
    const res = await api("POST", "/api/objects", { payload: { isClass: true, name } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createSchema(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const schemaId = crypto.randomUUID();
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name, type: "text", multi: false, scope: "class", ...extra },
    });
    expect(res.statusCode).toBe(201);
    return schemaId;
  }

  it("POST binds sequence/flags/defaultValue and the effective read derives the default", async () => {
    const classId = await createClass("pg7-shelf");
    const schemaId = await createSchema("pg7-code");

    const bound = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, sequence: 2, required: true, defaultValue: "n/a" },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      classId,
      propertySchemaId: schemaId,
      binding: { propertySchemaId: schemaId, sequence: 2, required: true, readonly: null, hideWhenEmpty: null, defaultValue: "n/a" },
    });

    // The patch contract: omitted fields keep their values.
    const patched = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, readonly: false },
    });
    expect(patched.json().binding).toMatchObject({ sequence: 2, required: true, readonly: false });

    const member = (
      await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "pg7-book", classIds: [classId] } })
    ).json().id as string;
    const effective = await api("GET", `/api/objects/${member}/effective-properties`);
    const row = (effective.json().properties as Array<Record<string, unknown>>).find(
      (p) => p.schemaId === schemaId,
    );
    expect(row).toMatchObject({ value: "n/a", source: "default", boundBy: classId });
  });

  it("POST fails loud on a wrong-typed defaultValue (PC2) and on unknown class/schema", async () => {
    const classId = await createClass("pg7-shelf-2");
    const schemaId = await createSchema("pg7-code-2");

    const bad = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, defaultValue: 42 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("validation_failed");

    const noClass = await api("POST", `/api/classes/${crypto.randomUUID()}/properties`, {
      payload: { propertySchemaId: schemaId, sequence: 0 },
    });
    expect(noClass.statusCode).toBe(404);

    const noSchema = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: crypto.randomUUID(), sequence: 0 },
    });
    expect(noSchema.statusCode).toBe(404);

    const empty = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId },
    });
    expect(empty.statusCode).toBe(422);
  });

  it("DELETE unbinds: the default stops deriving, authored values survive", async () => {
    const classId = await createClass("pg7-shelf-3");
    const schemaId = await createSchema("pg7-code-3");
    await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, sequence: 0, defaultValue: "def" },
    });
    const member = (
      await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "pg7-member", classIds: [classId] } })
    ).json().id as string;
    await api("POST", `/api/objects/${member}/properties`, {
      payload: { propertySchemaId: schemaId, value: "mine" },
    });

    const unbound = await api("DELETE", `/api/classes/${classId}/properties/${schemaId}`);
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({ classId, propertySchemaId: schemaId, unbound: true });

    const effective = await api("GET", `/api/objects/${member}/effective-properties`);
    const rows = (effective.json().properties as Array<Record<string, unknown>>).filter(
      (p) => p.schemaId === schemaId,
    );
    // The authored value survives; no default derives anymore.
    expect(rows).toEqual([expect.objectContaining({ value: "mine", source: "authored" })]);

    const noClass = await api("DELETE", `/api/classes/${crypto.randomUUID()}/properties/${schemaId}`);
    expect(noClass.statusCode).toBe(404);
    const noSchema = await api("DELETE", `/api/classes/${classId}/properties/${crypto.randomUUID()}`);
    expect(noSchema.statusCode).toBe(404);
  });
});

describe("effective-properties endpoint", () => {
  it("returns authored rows plus derived class-binding defaults (source/boundBy)", async () => {
    // Create the classed node first — it triggers workspace seeding (the
    // binding op below requires the source class node to exist).
    const created = await api("POST", "/api/objects", {
      payload: {
        presentAsMain: true,
        name: "EffPage",
        classIds: [SYSTEM_CLASS_UUIDS.source],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    // Bind a default onto the seeded source class via the relay batch.
    const envelope = {
      id: "0192a000-0000-7000-8000-000000000601",
      protocolVersion: 3,
      workspaceId: server!.ctx.defaultWorkspace,
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "test-device",
      hlc: { physical: 9999999999999, logical: 0 },
      affectedNodeIds: [SYSTEM_CLASS_UUIDS.source],
      opType: "class.property.set",
      timestamp: "2026-09-27T10:00:00.000Z",
      payload: {
        classId: SYSTEM_CLASS_UUIDS.source,
        propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey,
        sequence: 40,
        defaultValue: "default-key",
      },
    };
    const batch = await server!.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { ...server!.authHeaders, "content-type": "application/json" },
      payload: { envelopes: [envelope] },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().savedCount).toBe(1);

    const res = await api("GET", `/api/objects/${id}/effective-properties`);
    expect(res.statusCode).toBe(200);
    const properties = res.json().properties as Array<Record<string, unknown>>;
    const citekey = properties.find((p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.citekey);
    expect(citekey).toMatchObject({
      value: "default-key",
      source: "default",
      boundBy: SYSTEM_CLASS_UUIDS.source,
    });

    // An authored value shadows the default.
    await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "authored-key" },
    });
    const after = await api("GET", `/api/objects/${id}/effective-properties`);
    const overridden = (after.json().properties as Array<Record<string, unknown>>).find(
      (p) => p.schemaId === SYSTEM_PROPERTY_UUIDS.citekey,
    );
    expect(overridden).toMatchObject({ value: "authored-key", source: "authored" });
  });
});
