/**
 * scripts/migrate-attachments-asset-type.mts tests — the attachments
 * property (…0011) retypes from `object` to `asset` (owner ruling, M38).
 * The retype rides the propertySchema.create UPSERT (the only wire path that
 * can change a schema's type — propertySchema.update deliberately carries
 * none), carrying the stored row's values verbatim; the explicit
 * targetClassFilter retires (the asset type's filter is implicit — the
 * asset class), and the {nodeId} values survive untouched. Idempotent: a
 * second run plans nothing.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  buildEnvelopes,
  planAssetType,
  validateEnvelopes,
  ATTACHMENTS_SCHEMA_ID,
} from "../../../scripts/migrate-attachments-asset-type.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const ASSET_CLASS = "00000000-0000-0000-0001-000000000009";
const SOURCE_CLASS = "00000000-0000-0000-0001-000000000023";
const PAGE = "0192a000-0000-7000-8000-0000000000f1";
const ASSET_NODE = "0192a000-0000-7000-8000-0000000000f2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-migrate-asset-type",
    hlc: { physical, logical: 0 },
    opType,
    payload,
  });
}

function makeStore(): Store {
  const store = Store.open(sqljsBackend(sqlModule));
  stores.push(store);
  return store;
}

/** The pre-M38 world: object-typed attachments with the explicit filter. */
function attachmentsWorld(): Store {
  const store = makeStore();
  store.applyMany([
    env(
      "class.create",
      { classId: ASSET_CLASS, contentAst: [{ type: "text", text: "Asset" }] },
      1000,
    ),
    env(
      "propertySchema.create",
      {
        propertySchemaId: ATTACHMENTS_SCHEMA_ID,
        name: "Attachments",
        type: "object",
        multi: true,
        scope: "class",
        targetClassFilter: [ASSET_CLASS],
      },
      1001,
    ),
    env(
      "class.property.set",
      { classId: SOURCE_CLASS, propertySchemaId: ATTACHMENTS_SCHEMA_ID, sequence: 0 },
      1002,
    ),
    env("object.create", { objectId: PAGE, presentAsMain: true }, 1003),
    env("object.create", { objectId: ASSET_NODE, presentAsMain: true, classIds: [ASSET_CLASS] }, 1004),
    env(
      "property.set",
      { objectId: PAGE, propertySchemaId: ATTACHMENTS_SCHEMA_ID, value: { nodeId: ASSET_NODE } },
      1005,
    ),
    // A user-set render contract + rename the retype must carry through.
    env("propertySchema.update", { propertySchemaId: ATTACHMENTS_SCHEMA_ID, display: "inline" }, 1006),
    env("propertySchema.update", { propertySchemaId: ATTACHMENTS_SCHEMA_ID, name: "Files" }, 1007),
  ]);
  return store;
}

describe("migrate-attachments-asset-type", () => {
  it("plans the retype only while the row is not yet asset-typed", () => {
    const store = attachmentsWorld();
    const plan = planAssetType(store);
    expect(plan.schemaAbsent).toBe(false);
    expect(plan.retypeNeeded).toBe(true);
    expect(plan.row).toMatchObject({ name: "Files", type: "object", multi: 1, display: "inline" });

    const envelopes = buildEnvelopes(WS, plan);
    validateEnvelopes(envelopes);
    expect(envelopes).toHaveLength(1);
    for (const envelope of envelopes) store.apply(envelope);

    const second = planAssetType(store);
    expect(second.retypeNeeded).toBe(false);
    store.close();
  });

  it("plans nothing when the schema was never authored", () => {
    const store = makeStore();
    const plan = planAssetType(store);
    expect(plan.schemaAbsent).toBe(true);
    expect(buildEnvelopes(WS, plan)).toEqual([]);
    store.close();
  });

  it("the retype upserts type + drops the explicit filter, preserving values, name, and flags", () => {
    const store = attachmentsWorld();
    const envelopes = buildEnvelopes(WS, planAssetType(store));
    for (const envelope of envelopes) store.apply(envelope);

    const row = store.database
      .prepare(
        "SELECT name, type, multi, scope, target_class_filter, display FROM property_schema WHERE id = ?",
      )
      .get(ATTACHMENTS_SCHEMA_ID) as Record<string, unknown>;
    expect(row).toMatchObject({
      name: "Files",
      type: "asset",
      multi: 1,
      target_class_filter: null,
      display: "inline",
    });
    // The {nodeId} value survived untouched (shape-compatible — no rewrite).
    const value = store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(PAGE, ATTACHMENTS_SCHEMA_ID) as { value: string };
    expect(JSON.parse(value.value)).toEqual({ nodeId: ASSET_NODE });
    // The binding row survived (retype touches the schema, not the binding).
    expect(
      store.database
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(SOURCE_CLASS, ATTACHMENTS_SCHEMA_ID),
    ).toBeDefined();
    store.close();
  });

  it("the gate rejects a malformed retype before anything is written", () => {
    const store = attachmentsWorld();
    const envelopes = buildEnvelopes(WS, planAssetType(store));
    const tampered = envelopes.map((envelope) => ({
      ...envelope,
      payload: { ...envelope.payload, type: "file" },
    }));
    expect(() => validateEnvelopes(tampered)).toThrow(/refusing to insert/);
    store.close();
  });
});
