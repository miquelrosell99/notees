/**
 * scripts/migrate-retire-class-class.mts tests — the `class` meta-class
 * retirement (owner ruling): members of the retired class-class become REAL
 * classes via the conversion capability (class.create on an existing node:
 * is_class flips, a parented member is cut to a root), the retired binding
 * drops (class.unassign), the has-template family relocates (binding unset +
 * the schema re-scoped to global through the propertySchema.create upsert —
 * the only wire path that can move scope), and the emptied class-class node
 * rides to the trash. Idempotent: a second run plans nothing.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  buildEnvelopes,
  planRetirement,
  validateEnvelopes,
  CLASS_CLASS_ID,
} from "../../../scripts/migrate-retire-class-class.mts";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const HAS_TEMPLATE = "00000000-0000-0000-0000-000000000026";
const TEMPLATE_CLASS = "00000000-0000-0000-0001-000000000013";
const PARENT = "0192a000-0000-7000-8000-0000000000b1";
const MEMBER_ROOT = "0192a000-0000-7000-8000-0000000000c1";
const MEMBER_CHILD = "0192a000-0000-7000-8000-0000000000c2";

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
    deviceId: "test-device-migrate-class-class",
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

/**
 * The pre-retirement world: the seeded class-class node hosts the has-template
 * binding; two nodes are bound to it (a parentless page and a parented child);
 * the has-template schema is class-scope (the old seed shape).
 */
function retirementWorld(): Store {
  const store = makeStore();
  store.applyMany([
    env(
      "class.create",
      { classId: CLASS_CLASS_ID, contentAst: [{ type: "text", text: "Class" }] },
      1000,
    ),
    env(
      "propertySchema.create",
      {
        propertySchemaId: HAS_TEMPLATE,
        name: "Templates",
        type: "object",
        multi: true,
        scope: "class",
        targetClassFilter: [TEMPLATE_CLASS],
      },
      1001,
    ),
    env(
      "class.property.set",
      { classId: CLASS_CLASS_ID, propertySchemaId: HAS_TEMPLATE, sequence: 0 },
      1002,
    ),
    env(
      "object.create",
      {
        objectId: PARENT,
        presentAsMain: true,
        contentAst: [{ type: "text", text: "Container" }],
      },
      1003,
    ),
    env(
      "object.create",
      {
        objectId: MEMBER_ROOT,
        presentAsMain: true,
        classIds: [CLASS_CLASS_ID],
        contentAst: [{ type: "text", text: "Genre" }],
      },
      1004,
    ),
    env(
      "object.create",
      {
        objectId: MEMBER_CHILD,
        parentId: PARENT,
        classIds: [CLASS_CLASS_ID],
        contentAst: [{ type: "text", text: "Subgenre" }],
      },
      1005,
    ),
  ]);
  return store;
}

describe("migrate-retire-class-class planning", () => {
  it("plans a conversion + unassign per member, the family relocation, and the trash", () => {
    const store = retirementWorld();
    const plan = planRetirement(store);

    expect(plan.conversions.map((c) => c.nodeId)).toEqual([MEMBER_ROOT, MEMBER_CHILD]);
    expect(plan.conversions.find((c) => c.nodeId === MEMBER_ROOT)?.title).toBe("Genre");
    expect(plan.conversions.every((c) => c.nodePresent)).toBe(true);
    expect(plan.templateBindingPresent).toBe(true);
    expect(plan.templateRescopeNeeded).toBe(true);
    expect(plan.templateSchemaAbsent).toBe(false);
    expect(plan.classClassLive).toBe(true);
    store.close();
  });

  it("plans nothing once the retirement landed (idempotence)", () => {
    const store = retirementWorld();
    const templateRow = store.database
      .prepare(
        "SELECT name, multi, target_class_filter AS targetClassFilter, display, readonly, hide_when_empty AS hideWhenEmpty FROM property_schema WHERE id = ?",
      )
      .get(HAS_TEMPLATE) as never;
    const envelopes = buildEnvelopes(WS, planRetirement(store), templateRow);
    validateEnvelopes(envelopes);
    for (const envelope of envelopes) store.apply(envelope);

    const second = planRetirement(store);
    expect(second.conversions).toEqual([]);
    expect(second.templateBindingPresent).toBe(false);
    expect(second.templateRescopeNeeded).toBe(false);
    expect(second.classClassLive).toBe(false);
    store.close();
  });
});

describe("migrate-retire-class-class envelopes", () => {
  it("converts members (root cut included), relocates the family, trashes the class-class", () => {
    const store = retirementWorld();
    const plan = planRetirement(store);
    const templateRow = store.database
      .prepare(
        "SELECT name, multi, target_class_filter AS targetClassFilter, display, readonly, hide_when_empty AS hideWhenEmpty FROM property_schema WHERE id = ?",
      )
      .get(HAS_TEMPLATE) as never;
    const envelopes = buildEnvelopes(WS, plan, templateRow);
    validateEnvelopes(envelopes);

    // 2 conversions + 2 unassigns + 1 binding unset + 1 re-scope + 1 trash.
    const byOp = (op: string) => envelopes.filter((e) => e.opType === op);
    expect(byOp("class.create")).toHaveLength(2);
    expect(byOp("class.unassign")).toHaveLength(2);
    expect(byOp("class.property.unset")).toHaveLength(1);
    expect(byOp("propertySchema.create")).toHaveLength(1);
    expect(byOp("object.delete")).toHaveLength(1);
    // The conversion rides a bare classId — no content, the node's title
    // is the class title.
    expect(byOp("class.create").every((e) => Object.keys(e.payload).sort())).toBe(true);
    expect(byOp("class.create")[0]!.payload).toEqual({ classId: expect.any(String) });
    // The re-scope carries the stored name (rename-safe) at global scope.
    expect(byOp("propertySchema.create")[0]!.payload).toMatchObject({
      propertySchemaId: HAS_TEMPLATE,
      name: "Templates",
      type: "object",
      multi: true,
      scope: "global",
      targetClassFilter: [TEMPLATE_CLASS],
    });

    for (const envelope of envelopes) store.apply(envelope);

    // Both members are real classes now; the parented one was cut to a root.
    expect(store.getNode(MEMBER_ROOT)).toMatchObject({ is_class: 1, parent_id: null });
    expect(store.getNode(MEMBER_CHILD)).toMatchObject({ is_class: 1, parent_id: null });
    expect(store.children(PARENT)).toEqual([]);
    // The registry adopted the node titles.
    expect(
      (store.database.prepare("SELECT name FROM class WHERE id = ?").get(MEMBER_ROOT) as {
        name: string;
      }).name,
    ).toBe("Genre");
    // The retired binding is gone everywhere.
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM class_member_set WHERE class_id = ? AND present = 1")
        .get(CLASS_CLASS_ID),
    ).toMatchObject({ n: 0 });
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM class_property WHERE property_schema_id = ?")
        .get(HAS_TEMPLATE),
    ).toMatchObject({ n: 0 });
    // The schema is global-scope now.
    expect(
      (store.database.prepare("SELECT scope FROM property_schema WHERE id = ?").get(HAS_TEMPLATE) as {
        scope: string;
      }).scope,
    ).toBe("global");
    // The class-class node is trashed (recoverable).
    expect(store.getNode(CLASS_CLASS_ID)).toMatchObject({ is_active: 0 });
    store.close();
  });

  it("the gate rejects a malformed plan before anything is written", () => {
    const store = retirementWorld();
    const plan = planRetirement(store);
    const templateRow = store.database
      .prepare(
        "SELECT name, multi, target_class_filter AS targetClassFilter, display, readonly, hide_when_empty AS hideWhenEmpty FROM property_schema WHERE id = ?",
      )
      .get(HAS_TEMPLATE) as never;
    const envelopes = buildEnvelopes(WS, plan, templateRow);
    const tampered = envelopes.map((envelope) =>
      envelope.opType === "class.create"
        ? { ...envelope, payload: { classId: "not-a-uuid" } }
        : envelope,
    );
    expect(() => validateEnvelopes(tampered)).toThrow(/refusing to insert/);
    store.close();
  });
});
