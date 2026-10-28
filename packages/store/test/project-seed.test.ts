/**
 * The `project` property seed materialization + semantics:
 * the task→project membership relation (SYSTEM_PROPERTY_SPECS.project —
 * object-typed {nodeId} refs, multi, targetClassFilter ["project"], GLOBAL
 * scope, hideWhenEmpty, with the class-local binding row on `task`) replays
 * through the standard envelope pipeline like every seed, and the pinned
 * semantics hold without any new machinery:
 *
 *  - a task node reads the property through the effective read; the
 *    hideWhenEmpty contract suppresses the bound-empty row on an unvalued
 *    task (no empty "Project" row in the panel);
 *  - a `task` SUBCLASS inherits the binding through extends-aware
 *    resolution — no per-subclass binding rows;
 *  - PG6 apply-time validation: a {nodeId} value whose target does not carry
 *    the `project` class (or an extends-descendant of it) rejects at apply
 *    time (PropertyValueShapeError — the linkedAuthors precedent);
 *  - the multi value set is an OR-Set: element adds/removes by elementId,
 *    add-wins on concurrent add/remove;
 *  - values derive edges like every node-typed property: the edge index
 *    carries type 'property' rows task→project, so the project's backlinks
 *    list its tasks and property-condition queries answer "this project's
 *    tasks" through the generic machinery;
 *  - re-applying the whole seed stream is a complete no-op.
 *
 * Runs against BOTH shipped adapters (the store-test convention) so the
 * driver-agnostic surface cannot drift.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import type { StoreBackend } from "../src/db.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { PropertyValueShapeError, Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000301";
const ACTOR = "0192a000-0000-7000-8000-000000000302";
const ACTOR_B = "0192a000-0000-7000-8000-000000000303";

const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const PROJECT_CLASS_ID = SYSTEM_CLASS_UUIDS.project;
const PROJECT_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.project;

/** A user class extending task (the binding-inheritance carrier). */
const SUBCLASS_ID = "0192a000-0000-7000-8000-0000000003a1";
/** A user class extending project (the extends-aware filter carrier). */
const PROJECT_SUBCLASS_ID = "0192a000-0000-7000-8000-0000000003a2";
/** A task node. */
const TASK_NODE = "0192a000-0000-7000-8000-0000000003b1";
/** A node carrying the task subclass. */
const SUBCLASS_NODE = "0192a000-0000-7000-8000-0000000003b2";
/** A project node (filter-legal target). */
const PROJECT_NODE = "0192a000-0000-7000-8000-0000000003b3";
/** A second project node (the multi second value). */
const PROJECT_NODE_2 = "0192a000-0000-7000-8000-0000000003b4";
/** A node carrying the project subclass (extends-aware filter-legal). */
const PROJECT_SUBCLASS_NODE = "0192a000-0000-7000-8000-0000000003b5";
/** A plain node (NOT classed project — the reject case). */
const PLAIN_NODE = "0192a000-0000-7000-8000-0000000003b6";

const ELEM_A = "0192a000-0000-7000-8000-0000000003c1";
const ELEM_B = "0192a000-0000-7000-8000-0000000003c2";
const ELEM_C = "0192a000-0000-7000-8000-0000000003c3";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actorId: string = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId,
    deviceId: "test-device-project-seed",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

const text = (s: string) => [{ type: "text", text: s }];

/**
 * The seed op stream for the relation — the same shapes the server seed
 * (apps/server/src/seed.ts) and the web ensure author: the task + project
 * class nodes, the propertySchema.create at the reserved id (global scope,
 * multi, the project filter, hideWhenEmpty), the class-local binding row.
 */
function projectSeedEnvelopes(): Envelope[] {
  const spec = SYSTEM_PROPERTY_SPECS.project!;
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  envelopes.push(
    env(
      "class.create",
      { classId: TASK_ID, contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.task) },
      step(),
    ),
  );
  envelopes.push(
    env(
      "class.create",
      { classId: PROJECT_CLASS_ID, contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.project) },
      step(),
    ),
  );
  envelopes.push(
    env(
      "propertySchema.create",
      {
        propertySchemaId: PROJECT_SCHEMA_ID,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES.project,
        type: spec.type,
        multi: spec.multi ?? false,
        // global: true → absent scopeClassIds (the seed-scope audit).
        ...(spec.targetClassFilter !== undefined
          ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
          : {}),
        ...(spec.hideWhenEmpty !== undefined ? { hideWhenEmpty: spec.hideWhenEmpty } : {}),
      },
      step(),
    ),
  );
  envelopes.push(
    env(
      "class.property.set",
      { classId: TASK_ID, propertySchemaId: PROJECT_SCHEMA_ID },
      step(),
    ),
  );
  return envelopes;
}

function seedStore(store: Store): void {
  store.applyMany(projectSeedEnvelopes());
}

function seedFixtures(store: Store): void {
  seedStore(store);
  let t = 1727201000000;
  const step = () => (t += 1000);
  store.apply(env("class.create", { classId: SUBCLASS_ID, contentAst: text("Errand") }, step()));
  store.apply(
    env("class.setExtends", { classId: SUBCLASS_ID, parentClassIds: [TASK_ID] }, step()),
  );
  store.apply(
    env("class.create", { classId: PROJECT_SUBCLASS_ID, contentAst: text("Program") }, step()),
  );
  store.apply(
    env(
      "class.setExtends",
      { classId: PROJECT_SUBCLASS_ID, parentClassIds: [PROJECT_CLASS_ID] },
      step(),
    ),
  );
  store.apply(
    env(
      "object.create",
      { objectId: TASK_NODE, classIds: [TASK_ID], contentAst: text("Write the report") },
      step(),
    ),
  );
  store.apply(
    env(
      "object.create",
      { objectId: SUBCLASS_NODE, classIds: [SUBCLASS_ID], contentAst: text("Buy milk") },
      step(),
    ),
  );
  store.apply(
    env(
      "object.create",
      { objectId: PROJECT_NODE, classIds: [PROJECT_CLASS_ID], contentAst: text("Website redesign") },
      step(),
    ),
  );
  store.apply(
    env(
      "object.create",
      { objectId: PROJECT_NODE_2, classIds: [PROJECT_CLASS_ID], contentAst: text("Newsletter") },
      step(),
    ),
  );
  store.apply(
    env(
      "object.create",
      {
        objectId: PROJECT_SUBCLASS_NODE,
        classIds: [PROJECT_SUBCLASS_ID],
        contentAst: text("Big program"),
      },
      step(),
    ),
  );
  store.apply(env("object.create", { objectId: PLAIN_NODE, contentAst: text("A plain page") }, step()));
}

// --- adapters under test -------------------------------------------------------

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  {
    name: "sqljs",
    makeBackend: () => sqljsBackend(sqlModule),
  },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-project-seed-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  describe("project property seed materialization", () => {
    it("materializes the schema at the reserved id — global scope, multi, the project filter, hideWhenEmpty — and the task binding row", () => {
      const store = makeStore();
      seedStore(store);
      const schema = store.database
        .prepare(
          "SELECT name, type, multi, scope_class_ids, target_class_filter, hide_when_empty FROM property_schema WHERE id = ?",
        )
        .get(PROJECT_SCHEMA_ID) as
        | {
            name: string;
            type: string;
            multi: number;
            scope_class_ids: string | null;
            target_class_filter: string | null;
            hide_when_empty: number | null;
          }
        | undefined;
      expect(schema).toEqual({
        name: "Project",
        type: "object",
        multi: 1,
        scope_class_ids: null,
        target_class_filter: JSON.stringify([PROJECT_CLASS_ID]),
        hide_when_empty: 1,
      });
      const binding = store.database
        .prepare("SELECT active, pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(TASK_ID, PROJECT_SCHEMA_ID) as { active: number; pinned: number } | undefined;
      expect(binding).toEqual({ active: 1, pinned: 0 });
    });

    it("re-applying the whole seed is a complete no-op (idempotent ensure)", () => {
      const store = makeStore();
      seedStore(store);
      const before = dumpDerived(store);
      store.applyMany(projectSeedEnvelopes());
      expect(dumpDerived(store)).toEqual(before);
    });
  });

  describe("the effective read + hideWhenEmpty", () => {
    it("an unvalued task shows NO project row (hideWhenEmpty suppresses the bound-empty row)", () => {
      const store = makeStore();
      seedFixtures(store);
      const effective = store.getEffectiveProperties(TASK_NODE);
      const row = effective.find((p) => p.propertySchemaId === PROJECT_SCHEMA_ID);
      expect(row).toBeUndefined();
    });

    it("a valued task reads the property through the effective read", () => {
      const store = makeStore();
      seedFixtures(store);
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE },
            elementId: ELEM_A,
            idx: 0,
          },
          1727202000000,
        ),
      );
      const effective = store.getEffectiveProperties(TASK_NODE);
      const row = effective.find((p) => p.propertySchemaId === PROJECT_SCHEMA_ID);
      expect(row).toBeDefined();
      expect(row!.value).toEqual({ nodeId: PROJECT_NODE });
      // The binding row supplies the boundBy name — the panel's "C" flag.
      expect(row!.boundBy).toBe(TASK_ID);
    });

    it("a task subclass inherits the binding through extends-aware resolution — no per-subclass rows", () => {
      const store = makeStore();
      seedFixtures(store);
      store.apply(
        env(
          "property.set",
          {
            objectId: SUBCLASS_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE },
            elementId: ELEM_A,
            idx: 0,
          },
          1727202000000,
        ),
      );
      const effective = store.getEffectiveProperties(SUBCLASS_NODE);
      const row = effective.find((p) => p.propertySchemaId === PROJECT_SCHEMA_ID);
      expect(row).toBeDefined();
      // The binder is the task class — the subclass rides its binding row.
      expect(row!.boundBy).toBe(TASK_ID);
      // No binding row was authored on the subclass.
      const subclassBinding = store.database
        .prepare("SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ?")
        .get(SUBCLASS_ID, PROJECT_SCHEMA_ID);
      expect(subclassBinding).toBeUndefined();
    });
  });

  describe("PG6 apply-time validation (extends-aware filter)", () => {
    it("a non-project target rejects at apply time; a project subclass target is accepted", () => {
      const store = makeStore();
      seedFixtures(store);
      expect(() =>
        store.apply(
          env(
            "property.set",
            {
              objectId: TASK_NODE,
              propertySchemaId: PROJECT_SCHEMA_ID,
              value: { nodeId: PLAIN_NODE },
              elementId: ELEM_A,
              idx: 0,
            },
            1727202000000,
          ),
        ),
      ).toThrow(PropertyValueShapeError);
      // The rejected row never lands.
      const row = store.database
        .prepare(
          "SELECT 1 FROM property_value WHERE node_id = ? AND property_schema_id = ?",
        )
        .get(TASK_NODE, PROJECT_SCHEMA_ID);
      expect(row).toBeUndefined();

      // Extends-aware membership: a target carrying a class that EXTENDS
      // project satisfies the filter (the linkedAuthors agent precedent).
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_SUBCLASS_NODE },
            elementId: ELEM_B,
            idx: 1,
          },
          1727202001000,
        ),
      );
      const effective = store.getEffectiveProperties(TASK_NODE);
      const values = effective
        .filter((p) => p.propertySchemaId === PROJECT_SCHEMA_ID)
        .map((p) => p.value);
      expect(values).toEqual([{ nodeId: PROJECT_SUBCLASS_NODE }]);
    });
  });

  describe("multi-value OR-Set element paths", () => {
    it("two values coexist; a remove by elementId drops exactly its row; a concurrent add beats an earlier remove (add-wins)", () => {
      const store = makeStore();
      seedFixtures(store);
      const h = 1727202000000;
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE },
            elementId: ELEM_A,
            idx: 0,
          },
          h,
          0,
          ACTOR,
        ),
      );
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE_2 },
            elementId: ELEM_B,
            idx: 1,
          },
          h,
          1,
          ACTOR_B,
        ),
      );
      const valuesOf = () =>
        store
          .getEffectiveProperties(TASK_NODE)
          .filter((p) => p.propertySchemaId === PROJECT_SCHEMA_ID)
          .map((p) => (p.value as { nodeId: string }).nodeId)
          .sort();
      expect(valuesOf()).toEqual([PROJECT_NODE, PROJECT_NODE_2].sort());

      // Remove exactly ELEM_B — ELEM_A survives.
      store.apply(
        env(
          "property.unset",
          { objectId: TASK_NODE, propertySchemaId: PROJECT_SCHEMA_ID, elementId: ELEM_B },
          h + 1000,
        ),
      );
      expect(valuesOf()).toEqual([PROJECT_NODE]);

      // OR-Set add-wins on the EXACT-HLC tie (the membership comparator is
      // HLC-only): a remove at (h+2k, logical 0) cannot kill a concurrent
      // add of the same element at the same (h+2k, logical 0) — regardless
      // of actor.
      store.apply(
        env(
          "property.unset",
          { objectId: TASK_NODE, propertySchemaId: PROJECT_SCHEMA_ID, elementId: ELEM_A },
          h + 2000,
          0,
          ACTOR_B,
        ),
      );
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE_2 },
            elementId: ELEM_A,
            idx: 0,
          },
          h + 2000,
          0,
          ACTOR,
        ),
      );
      expect(valuesOf()).toEqual([PROJECT_NODE_2]);
    });
  });

  describe("edge projection (the linkedAuthors precedent — no new machinery)", () => {
    it("values derive type 'property' edges; the project's backlinks list its tasks", () => {
      const store = makeStore();
      seedFixtures(store);
      store.apply(
        env(
          "property.set",
          {
            objectId: TASK_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE },
            elementId: ELEM_A,
            idx: 0,
          },
          1727202000000,
        ),
      );
      store.apply(
        env(
          "property.set",
          {
            objectId: SUBCLASS_NODE,
            propertySchemaId: PROJECT_SCHEMA_ID,
            value: { nodeId: PROJECT_NODE },
            elementId: ELEM_C,
            idx: 0,
          },
          1727202001000,
        ),
      );
      const edges = store.database
        .prepare(
          "SELECT source_id, target_id, type FROM edge WHERE type = 'property' AND target_id = ? ORDER BY source_id",
        )
        .all(PROJECT_NODE) as Array<{ source_id: string; target_id: string; type: string }>;
      expect(edges.map((e) => e.source_id)).toEqual([SUBCLASS_NODE, TASK_NODE].sort());
      expect(edges.every((e) => e.type === "property")).toBe(true);
      // The backlink read the surfaces use lists both tasks (raw edge rows).
      const backlinks = (store.backlinks(PROJECT_NODE) as Array<{ source_id: string }>).map(
        (row) => row.source_id,
      );
      expect(backlinks).toEqual([SUBCLASS_NODE, TASK_NODE].sort());
    });
  });
});

/** Deterministic dump of the derived tables this suite converges on. */
function dumpDerived(store: Store): Record<string, unknown[]> {
  const tables = ["class", "class_extends", "class_hierarchy", "class_property", "property_schema"];
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const rows = store.database.prepare(`SELECT * FROM "${table}"`).all() as Record<
      string,
      unknown
    >[];
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    dump[table] = rows;
  }
  return dump;
}
