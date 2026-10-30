// @vitest-environment node
/**
 * Property-row shells tests (the cheap bulk read, property-shells.ts):
 *
 *  - Shape: a node carrying a LIGHT-typed property (select — value present,
 *    deferred: false) and a HEAVY-typed one (text — value null, valueCount
 *    reports the cardinality, deferred: true); bound-but-empty rows and
 *    eligibility mirror the full read field for field; the full read still
 *    ships the heavy value (byte-identical contract).
 *  - LIGHT_PROPERTY_VALUE_TYPES: the derived light set + the conservative
 *    default (unknown types defer).
 *  - WorkerCore delta: a repeated multiRead answers READ_UNCHANGED for the
 *    shells key; a property.set re-serves it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { isReadUnchanged } from "../src/core/workspace-client/read-revisions.js";
import {
  LIGHT_PROPERTY_VALUE_TYPES,
  type PropertyRowShell,
} from "../src/core/workspace-client/index.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const FILE = `${WS}.db`;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const cores: WorkerCore[] = [];

afterEach(async () => {
  while (cores.length > 0) await cores.pop()!.close();
  vi.restoreAllMocks();
});

function createMemoryOpfs(): OpfsStore {
  const files = new Map<string, Uint8Array>();
  return {
    loadFile: async (name) => files.get(name) ?? null,
    saveFile: async (name, bytes) => {
      files.set(name, new Uint8Array(bytes));
    },
  };
}

async function createCore(): Promise<WorkerCore> {
  const core = await WorkerCore.create({
    SQL: sqlModule,
    opfs: createMemoryOpfs(),
    fileName: FILE,
    workspaceId: WS,
    transport: new MemoryTransport(new MemoryRelay()),
  });
  cores.push(core);
  return core;
}

describe("LIGHT_PROPERTY_VALUE_TYPES (the derived light set)", () => {
  it("ships values for the light scalar/option types; defers everything else", () => {
    for (const light of ["select", "multi_select", "boolean", "number", "date", "datetime"]) {
      expect(LIGHT_PROPERTY_VALUE_TYPES.has(light)).toBe(true);
    }
    // HEAVY by declaration and by the conservative default (unknown types
    // defer — the wire vocabulary: text/email/object/asset/image, plus any
    // future type).
    for (const heavy of ["text", "url", "email", "object", "asset", "image", "future_type"]) {
      expect(LIGHT_PROPERTY_VALUE_TYPES.has(heavy)).toBe(false);
    }
  });
});

describe("getPropertyRowShells (WorkerCore over sql.js)", () => {
  it("light rows carry the value; heavy rows defer it with the cardinality; empty/eligibility mirror the full read", async () => {
    const core = await createCore();
    const nodeId = (await core.invoke("createObject", [
      { isEmbedded: false, name: "Carrier" },
    ])) as string;

    const selectSchemaId = (await core.invoke("createPropertySchema", [
      {
        name: "status",
        type: "select",
        options: [{ id: "opt-1", label: "Doing" }],
      },
    ])) as string;
    const textSchemaId = (await core.invoke("createPropertySchema", [
      { name: "notes", type: "text" },
    ])) as string;
    // A scoped schema bound to a class the node does NOT carry: an authored
    // value written while eligible (the write gate passes), then the class
    // is removed — the value survives (never retroactive) and reads
    // eligible: false (the R4 row).
    const otherClassId = (await core.invoke("createClass", ["ScopedOwner"])) as string;
    const scopedSchemaId = (await core.invoke("createPropertySchema", [
      { name: "local", type: "text", scopeClassIds: [otherClassId] },
    ])) as string;

    // Bound-but-empty rows via a class binding (the virtual property shows
    // as coming from the class until realized or valued).
    const classId = (await core.invoke("createClass", ["Taskish"])) as string;
    await core.invoke("setClassProperty", [classId, selectSchemaId, {}]);
    await core.invoke("setClassProperty", [classId, textSchemaId, {}]);
    await core.invoke("assignClass", [nodeId, classId]);

    const emptyShells = (await core.invoke("getPropertyRowShells", [nodeId])) as PropertyRowShell[];
    const boundSelect = emptyShells.find((r) => r.propertySchemaId === selectSchemaId);
    const boundText = emptyShells.find((r) => r.propertySchemaId === textSchemaId);
    // Both bindings synthesize their bound-empty row…
    expect(boundSelect?.source).toBe("bound");
    expect(boundText?.source).toBe("bound");
    // …empty rows are NEVER deferred (no value to withhold)…
    expect(boundSelect).toMatchObject({ value: null, valueCount: 0, deferred: false, eligible: true });
    expect(boundText).toMatchObject({ value: null, valueCount: 0, deferred: false, eligible: true });
    // …and boundBy names the binder, same as the full read.
    const emptyFull = (await core.invoke("getEffectiveProperties", [nodeId])) as Array<Record<string, unknown>>;
    const fullBoundText = emptyFull.find((r) => r.propertySchemaId === textSchemaId);
    expect(boundText?.boundBy).toBe(classId);
    expect(fullBoundText?.boundBy).toBe(classId);

    // Value the two bound properties.
    await core.invoke("setProperty", [nodeId, selectSchemaId, "opt-1", 0]);
    const body = "a long text body " + "x".repeat(500);
    await core.invoke("setProperty", [nodeId, textSchemaId, body, 0]);
    // An authored heavy value on the out-of-scope schema (eligible: false):
    // written while the node carried the scoped class, then removed.
    await core.invoke("assignClass", [nodeId, otherClassId]);
    await core.invoke("setProperty", [nodeId, scopedSchemaId, "stray", 0]);
    await core.invoke("unassignClass", [nodeId, otherClassId]);

    const shells = (await core.invoke("getPropertyRowShells", [nodeId])) as PropertyRowShell[];
    const full = (await core.invoke("getEffectiveProperties", [nodeId])) as Array<Record<string, unknown>>;

    const shellSelect = shells.find((r) => r.propertySchemaId === selectSchemaId)!;
    const shellText = shells.find((r) => r.propertySchemaId === textSchemaId)!;
    const shellScoped = shells.find((r) => r.propertySchemaId === scopedSchemaId)!;

    // LIGHT: the value ships identically to the full read.
    expect(shellSelect).toMatchObject({ value: "opt-1", valueCount: 1, deferred: false, source: "authored" });
    // HEAVY: value withheld, the cardinality reports it, deferred is the flag.
    expect(shellText.value).toBeNull();
    expect(shellText.valueCount).toBe(1);
    expect(shellText.deferred).toBe(true);
    // The full read still ships the heavy value (its byte-identical contract).
    expect(full.find((r) => r.propertySchemaId === textSchemaId)?.value).toBe(body);
    // Eligibility mirrors the full read on the deferred row.
    expect(shellScoped.deferred).toBe(true);
    expect(shellScoped.valueCount).toBe(1);
    expect(shellScoped.eligible).toBe(false);
    expect(full.find((r) => r.propertySchemaId === scopedSchemaId)?.eligible).toBe(false);

    // Every shared identity/derivation field matches the full read row for
    // row (schema, elementId addressing).
    const sharedKeys = [
      "propertySchemaId",
      "idx",
      "elementId",
      "schema",
      "metadata",
      "source",
      "boundBy",
      "eligible",
      "hideWhenEmpty",
      "display",
    ] as const;
    for (const shell of shells) {
      const twin = full.find(
        (r) => r.propertySchemaId === shell.propertySchemaId && r.elementId === shell.elementId,
      );
      expect(twin, `full-read twin of ${shell.propertySchemaId}:${shell.elementId}`).toBeDefined();
      for (const key of sharedKeys) {
        expect(shell[key], `${shell.propertySchemaId}.${key}`).toEqual(twin![key]);
      }
    }
    // Same row count and order as the full read.
    expect(shells.map((r) => `${r.propertySchemaId}:${r.elementId}`)).toEqual(
      full.map((r) => `${String(r.propertySchemaId)}:${String(r.elementId)}`),
    );
  });

  it("multiRead delta: a repeated refresh answers READ_UNCHANGED; a property.set re-serves", async () => {
    const core = await createCore();
    const nodeId = (await core.invoke("createObject", [
      { isEmbedded: false, name: "Carrier" },
    ])) as string;
    const selectSchemaId = (await core.invoke("createPropertySchema", [
      { name: "status", type: "select", options: [{ id: "opt-1", label: "Doing" }] },
    ])) as string;
    await core.invoke("setProperty", [nodeId, selectSchemaId, "opt-1", 0]);

    const key = JSON.stringify(["getPropertyRowShells", [nodeId]]);
    const keys = [key, JSON.stringify(["getEffectiveProperties", [nodeId]])];

    const first = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(first.every((v) => !isReadUnchanged(v))).toBe(true);
    const shellsFirst = first[0] as PropertyRowShell[];
    expect(shellsFirst.find((r) => r.propertySchemaId === selectSchemaId)?.value).toBe("opt-1");

    // Nothing changed: both reads delta away.
    const second = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(second.every((v) => isReadUnchanged(v))).toBe(true);

    // A property write on the node re-serves both stamps (the p: family).
    await core.invoke("unsetProperty", [nodeId, selectSchemaId, 0]);
    const third = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(third[0])).toBe(false);
    expect(isReadUnchanged(third[1])).toBe(false);
    const shellsThird = third[0] as PropertyRowShell[];
    // The value cleared: the row is gone from the authored set (the select
    // schema has no binding — nothing synthesizes an empty row).
    expect(shellsThird.find((r) => r.propertySchemaId === selectSchemaId)).toBeUndefined();
  });
});
