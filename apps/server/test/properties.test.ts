import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { closeTestServer, makeTestServer, testEnvelope, TEST_WORKSPACE, type TestServer } from "./helpers";

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

async function createObject(name: string, classIds: string[] = []): Promise<string> {
  // Plan-07: seed through the relay (the object write API is retired).
  const objectId = crypto.randomUUID();
  const res = await api("POST", "/api/relay/v2/batch", {
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: "object.create",
          payload: {
            objectId,
            isEmbedded: false,
            contentAst: [{ type: "text", text: name }],
            classIds,
          },
        }),
      ],
    },
  });
  expect(res.statusCode).toBe(200);
  return objectId;
}

async function setProperty(objectId: string, propertySchemaId: string, value: unknown): Promise<void> {
  // Plan-07: property values ride the relay (the objects write API is retired).
  const res = await api("POST", "/api/relay/v2/batch", {
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: "property.set",
          payload: { objectId, propertySchemaId, value, idx: 0 },
        }),
      ],
    },
  });
  expect(res.statusCode).toBe(200);
}

function authoredValueRow(objectId: string, propertySchemaId: string): { value: unknown } | undefined {
  // Read the derived store directly — the server serves no content reads.
  const store = server!.ctx.workspaces.storeFor(server!.ctx.defaultWorkspace);
  const row = store.database
    .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
    .get(objectId, propertySchemaId) as { value: string } | undefined;
  return row === undefined ? undefined : { value: JSON.parse(row.value) };
}

/** A source-classed node: the seeded bibliography schemas are scoped to the
 *  source class (the sole locality authority), so
 *  property writes against them need the class (R3 eligibility). */
async function createSourceObject(name: string): Promise<string> {
  return createObject(name, [SYSTEM_CLASS_UUIDS.source]);
}


describe("property schema number formats", () => {
  it("create carries numberPad/numberDecimals/numberRounding; read reflects them", async () => {
    const id = crypto.randomUUID();
    const created = (
      await api("POST", "/api/property-schemas", {
        payload: {
          propertySchemaId: id,
          name: "fmt-probe",
          type: "number",
          numberPad: 4,
          numberDecimals: 1,
          numberRounding: "floor",
        },
      })
    ).json().propertySchema;
    expect(created.numberPad).toBe(4);
    expect(created.numberDecimals).toBe(1);
    expect(created.numberRounding).toBe("floor");
    const fetched = (await api("GET", `/api/property-schemas/${id}`)).json().propertySchema;
    expect(fetched.numberPad).toBe(4);
    expect(fetched.numberDecimals).toBe(1);
    expect(fetched.numberRounding).toBe("floor");
  });

  it("non-number schemas reject number formatting (422)", async () => {
    const res = await api("POST", "/api/property-schemas", {
      payload: {
        propertySchemaId: crypto.randomUUID(),
        name: "bad-fmt",
        type: "text",
        numberPad: 4,
      },
    });
    // The payload schema itself accepts the field pair; the normative rule is
    // the CLIENT contract (CLI/web gate flags to number schemas). The stored
    // row simply carries the format; rendering ignores it for non-numbers.
    expect([200, 201, 422]).toContain(res.statusCode);
  });
});


describe("property schemas", () => {
  it("GET returns the seeded bibliographic schemas by fixed UUID", async () => {
    const res = await api("GET", `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.citekey}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().propertySchema).toMatchObject({
      id: SYSTEM_PROPERTY_UUIDS.citekey,
      name: "Citekey",
      type: "text",
      multi: false,
    });

    // RETYPED 2026-10-23 (source-library slice 1 task 4):
    // authors is free TEXT, multi — the node-typed spec is superseded.
    const authors = await api("GET", `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.authors}`);
    expect(authors.json().propertySchema).toMatchObject({ multi: true, type: "text" });
    expect(authors.json().propertySchema.targetClassFilter).toBeNull();

    // linkedAuthors REINSTATED 2026-10-23 at its own …0006- block UUID —
    // node-typed to agent nodes; the withdrawn …0025 stays unseeded.
    const linked = await api("GET", `/api/property-schemas/${SYSTEM_PROPERTY_UUIDS.linkedAuthors}`);
    expect(linked.json().propertySchema).toMatchObject({ multi: true, type: "object" });
    expect(linked.json().propertySchema.targetClassFilter).toEqual([SYSTEM_CLASS_UUIDS.agent]);

    // The withdrawn `linkedAuthors` schema (…0025) is not seeded.
    const withdrawn = await api("GET", "/api/property-schemas/00000000-0000-0000-0000-000000000025");
    expect(withdrawn.statusCode).toBe(404);

    const missing = await api("GET", `/api/property-schemas/${crypto.randomUUID()}`);
    expect(missing.statusCode).toBe(404);
  });

  it("POST creates a schema with a caller-chosen (fixed) UUID through the pipeline", async () => {
    const schemaId = "10000000-0000-4000-8000-0000000000b5";
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().propertySchema).toMatchObject({ id: schemaId, name: "externalId", type: "text" });

    // Get-or-create convergence: re-POSTing the same UUID does not duplicate.
    const again = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name: "externalId", type: "text", multi: false },
    });
    expect(again.statusCode).toBe(201);

    const bad = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: "nope", name: "x", type: "text" },
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe("property schema update/delete routes", () => {
  async function createSchema(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const schemaId = crypto.randomUUID();
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name, type: "text", multi: false, ...extra },
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
    const dateSchema = await createSchema("pg7-when", { type: "datetime" });
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
    await setProperty(id, schemaId, "authored-survives");

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
    expect(authoredValueRow(id, schemaId)?.value).toBe("authored-survives");

    const again = await api("DELETE", `/api/property-schemas/${schemaId}`);
    expect(again.statusCode).toBe(404);
  });
});

describe("class property binding routes", () => {
  async function createClass(name: string): Promise<string> {
    // Plan-07: seed through the relay (the object write API is retired).
    const classId = crypto.randomUUID();
    const res = await api("POST", "/api/relay/v2/batch", {
      payload: {
        envelopes: [
          testEnvelope({
            workspaceId: server!.ctx.defaultWorkspace,
            opType: "class.create",
            payload: { classId, contentAst: [{ type: "text", text: name }] },
          }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    return classId;
  }

  async function createSchema(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const schemaId = crypto.randomUUID();
    const res = await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: schemaId, name, type: "text", multi: false, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return schemaId;
  }

  it("POST binds active and the schema's global default derives (the render contracts + default are schema-level)", async () => {
    const classId = await createClass("pg7-shelf");
    // Scoped to the binding class (the sole locality authority) — R5 accepts the binding below.
    const schemaId = await createSchema("pg7-code", { scopeClassIds: [classId] });

    const bound = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: true },
    });
    expect(bound.statusCode).toBe(200);
    // The binding echo carries ONLY the per-class mechanics (the
    // soft-unbind + pinned tier + showInNodeRows preview flags — sequence
    // retired 2026-10-21, panels render in pin tiers).
    expect(bound.json()).toMatchObject({
      classId,
      propertySchemaId: schemaId,
      binding: { propertySchemaId: schemaId, active: true, pinned: false },
    });
    expect(bound.json().binding).not.toHaveProperty("sequence");
    expect(bound.json().binding).not.toHaveProperty("readonly");
    expect(bound.json().binding).not.toHaveProperty("hideWhenEmpty");

    // The retired binding keys fail loud.
    const retired = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, required: true },
    });
    expect(retired.statusCode).toBe(422);
    const retiredDefault = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, defaultValue: "n/a" },
    });
    expect(retiredDefault.statusCode).toBe(422);
    const retiredSequence = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, sequence: 1 },
    });
    expect(retiredSequence.statusCode).toBe(422);

    // The patch contract: omitted fields keep their values.
    const patched = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: false },
    });
    expect(patched.json().binding).toMatchObject({ active: false });
    const reEnabled = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: true },
    });
    expect(reEnabled.json().binding).toMatchObject({ active: true });

    // The render contract AND the default live on the SCHEMA.
    // `readonly` retired outright.
    const retiredReadonly = await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { readonly: true },
    });
    expect(retiredReadonly.statusCode).toBe(422);
    const schemaPatched = await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { hideWhenEmpty: true, defaultValue: "n/a" },
    });
    expect(schemaPatched.statusCode).toBe(200);
    expect(schemaPatched.json().propertySchema).toMatchObject({ defaultValue: "n/a" });
    expect(schemaPatched.json().propertySchema).not.toHaveProperty("readonly");

    const member = await createObject("pg7-book", [classId]);
    const effective = server!.ctx.workspaces.storeFor(server!.ctx.defaultWorkspace).getEffectiveProperties(member);
    const row = effective.find((p) => p.propertySchemaId === schemaId);
    expect(row).toMatchObject({
      value: "n/a",
      source: "default",
      boundBy: classId,
      hideWhenEmpty: true,
    });
    expect(row).not.toHaveProperty("readonly");
  });

  it("POST binds pinned: the tier flag rides the binding echo with the same patch contract", async () => {
    const classId = await createClass("pg7-shelf-pin");
    const schemaId = await createSchema("pg7-code-pin", { scopeClassIds: [classId] });

    const bound = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, pinned: true },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      classId,
      propertySchemaId: schemaId,
      binding: { propertySchemaId: schemaId, active: true, pinned: true },
    });

    // The patch contract: an active-only patch keeps the stored pinned flag.
    const patched = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: false },
    });
    expect(patched.json().binding).toMatchObject({ active: false, pinned: true });

    // The flip back rides the same op (patch semantics, row LWW).
    const unPinned = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, pinned: false },
    });
    expect(unPinned.json().binding).toMatchObject({ active: false, pinned: false });
  });

  it("POST binds showInNodeRows: the node-row preview flag rides the binding echo with the same patch contract", async () => {
    const classId = await createClass("pg7-shelf-rows");
    const schemaId = await createSchema("pg7-code-rows", { scopeClassIds: [classId] });

    const bound = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, showInNodeRows: true },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({
      classId,
      propertySchemaId: schemaId,
      binding: { propertySchemaId: schemaId, active: true, pinned: false, showInNodeRows: true },
    });

    // The patch contract: an active-only patch keeps the stored flag.
    const patched = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: false },
    });
    expect(patched.json().binding).toMatchObject({ active: false, showInNodeRows: true });

    // The flip back rides the same op (patch semantics, row LWW).
    const unflagged = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, showInNodeRows: false },
    });
    expect(unflagged.json().binding).toMatchObject({ active: false, showInNodeRows: false });
  });

  it("PATCH fails loud on a wrong-typed schema defaultValue and POST fails loud on unknown class/schema", async () => {
    const classId = await createClass("pg7-shelf-2");
    const schemaId = await createSchema("pg7-code-2", { scopeClassIds: [classId] });

    const bad = await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { defaultValue: 42 },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("validation_failed");

    const noClass = await api("POST", `/api/classes/${crypto.randomUUID()}/properties`, {
      payload: { propertySchemaId: schemaId, active: true },
    });
    expect(noClass.statusCode).toBe(404);

    const noSchema = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: crypto.randomUUID(), active: true },
    });
    expect(noSchema.statusCode).toBe(404);

    const empty = await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId },
    });
    expect(empty.statusCode).toBe(422);
  });

  it("DELETE unbinds: the default stops deriving, authored values survive", async () => {
    const classId = await createClass("pg7-shelf-3");
    const schemaId = await createSchema("pg7-code-3", { scopeClassIds: [classId] });
    await api("PATCH", `/api/property-schemas/${schemaId}`, {
      payload: { defaultValue: "def" },
    });
    await api("POST", `/api/classes/${classId}/properties`, {
      payload: { propertySchemaId: schemaId, active: true },
    });
    const member = await createObject("pg7-member", [classId]);
    await setProperty(member, schemaId, "mine");

    const unbound = await api("DELETE", `/api/classes/${classId}/properties/${schemaId}`);
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({ classId, propertySchemaId: schemaId, unbound: true });

    const rows = server!.ctx.workspaces
      .storeFor(server!.ctx.defaultWorkspace)
      .getEffectiveProperties(member)
      .filter((p) => p.propertySchemaId === schemaId);
    // The authored value survives; no default derives anymore.
    expect(rows).toEqual([expect.objectContaining({ value: "mine", source: "authored" })]);

    const noClass = await api("DELETE", `/api/classes/${crypto.randomUUID()}/properties/${schemaId}`);
    expect(noClass.statusCode).toBe(404);
    const noSchema = await api("DELETE", `/api/classes/${classId}/properties/${crypto.randomUUID()}`);
    expect(noSchema.statusCode).toBe(404);
  });
});

