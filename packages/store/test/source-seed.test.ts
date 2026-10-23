/**
 * Source-library seed convergence (owner 2026-10-23, slice 1 task 6):
 * the 39 source type-classes materialize in a derived store from the seed
 * op stream — class rows, extends [source] edges, the per-class binding
 * rows of SYSTEM_SOURCE_CLASS_BINDINGS, and the archived-by-default bit
 * (SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES, `object.update {active: false}`).
 *
 * Archival is a VISIBILITY state, not an absence (the spec rule): an
 * archived class must still resolve through extends [source] — the
 * class_hierarchy closure, the family-members read, scope eligibility, and
 * the effective-properties extends reach — for queries, export, and
 * backlinks. The seed replays a LATER unrelated setExtends after the
 * archival flips (any live workspace keeps extending classes), which
 * rebuilds the whole closure: the archived classes must survive it.
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
  SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";

import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const SOURCE: SystemClassName = "source";
/** The 39 type-classes (every SYSTEM_SOURCE_CLASS_BINDINGS key extends source). */
const FAMILY = Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS) as SystemClassName[];
const ARCHIVED = new Set<SystemClassName>(SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES);

/** A node classed with an archived-by-default type. */
const NODE_ARCHIVED = "0192a000-0000-7000-8000-000000000501";
/** A node classed with an enabled type. */
const NODE_ACTIVE = "0192a000-0000-7000-8000-000000000502";
/** An unrelated user class authored AFTER the seed (the later-extends rebuild). */
const USER_CLASS = "0192a000-0000-7000-8000-0000000005c1";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-source-seed",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

const text = (s: string) => [{ type: "text", text: s }];

/**
 * The seed op stream, built from the domain manifests — the same shapes
 * the server seed authors (apps/server/src/seed.ts) and the web ensure
 * converges on. Order: classes, extends edges, schemas, binding rows,
 * archival flips, then the unrelated later setExtends.
 */
function sourceSeedEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);

  envelopes.push(
    env(
      "class.create",
      {
        classId: SYSTEM_CLASS_UUIDS.source,
        contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.source),
        icon: SYSTEM_CLASS_ICONS.source,
      },
      step(),
    ),
  );
  for (const name of FAMILY) {
    envelopes.push(
      env(
        "class.create",
        {
          classId: SYSTEM_CLASS_UUIDS[name],
          contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]),
          icon: SYSTEM_CLASS_ICONS[name],
        },
        step(),
      ),
    );
  }
  for (const name of FAMILY) {
    envelopes.push(
      env(
        "class.setExtends",
        {
          classId: SYSTEM_CLASS_UUIDS[name],
          parentClassIds: [SYSTEM_CLASS_UUIDS.source],
        },
        step(),
      ),
    );
  }
  // The pool: every spec bound to the source base (the task-4 pool is
  // scoped to source, `global` flips url) — schema row + the base's binding.
  const pool = (
    Object.entries(SYSTEM_PROPERTY_SPECS) as Array<
      [SystemPropertyName, (typeof SYSTEM_PROPERTY_SPECS)[SystemPropertyName]]
    >
  ).filter(([, spec]) => spec !== undefined && spec.bindTo === SOURCE);
  for (const [name, spec] of pool) {
    envelopes.push(
      env(
        "propertySchema.create",
        {
          propertySchemaId: SYSTEM_PROPERTY_UUIDS[name],
          name: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
          type: spec!.type,
          multi: spec!.multi ?? false,
          ...(spec!.global === true
            ? {}
            : { scopeClassIds: [SYSTEM_CLASS_UUIDS.source] }),
          ...(spec!.defaultValue !== undefined ? { defaultValue: spec!.defaultValue } : {}),
          ...(spec!.options !== undefined ? { options: spec!.options } : {}),
          ...(spec!.targetClassFilter !== undefined
            ? { targetClassFilter: spec!.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
            : {}),
        },
        step(),
      ),
    );
    envelopes.push(
      env(
        "class.property.set",
        { classId: SYSTEM_CLASS_UUIDS.source, propertySchemaId: SYSTEM_PROPERTY_UUIDS[name] },
        step(),
      ),
    );
  }
  // Per-class binding rows (SYSTEM_SOURCE_CLASS_BINDINGS).
  for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
    for (const property of properties) {
      envelopes.push(
        env(
          "class.property.set",
          {
            classId: SYSTEM_CLASS_UUIDS[name as SystemClassName],
            propertySchemaId: SYSTEM_PROPERTY_UUIDS[property],
          },
          step(),
        ),
      );
    }
  }
  // The archived-by-default flips (visibility, not absence).
  for (const name of SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES) {
    envelopes.push(
      env(
        "object.update",
        { objectId: SYSTEM_CLASS_UUIDS[name], active: false },
        step(),
      ),
    );
  }
  // A LATER unrelated extends write — any live workspace keeps extending
  // classes; the closure rebuild it triggers must not drop archived classes.
  envelopes.push(env("class.create", { classId: USER_CLASS, contentAst: text("Tag") }, step()));
  envelopes.push(
    env("class.setExtends", { classId: USER_CLASS, parentClassIds: [SYSTEM_CLASS_UUIDS.source] }, step()),
  );
  return envelopes;
}

function seedStore(store: Store): void {
  store.applyMany(sourceSeedEnvelopes());
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
      const dir = mkdtempSync(join(tmpdir(), "notees-source-seed-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  describe("source-library seed materialization", () => {
    it("materializes the 39 type-classes with extends [source] and the base", () => {
      const store = makeStore();
      seedStore(store);
      const familyIds = FAMILY.map((name) => SYSTEM_CLASS_UUIDS[name]);
      const rows = store.database
        .prepare(
          `SELECT id, is_class, is_active FROM node
           WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(JSON.stringify([...familyIds, SYSTEM_CLASS_UUIDS.source])) as Array<{
        id: string;
        is_class: number;
        is_active: number;
      }>;
      expect(rows).toHaveLength(40);
      expect(rows.every((r) => r.is_class === 1)).toBe(true);
      const edges = store.database
        .prepare(
          `SELECT class_id, parent_class_id FROM class_extends
           WHERE class_id IN (SELECT value FROM json_each(?)) ORDER BY class_id`,
        )
        .all(JSON.stringify(familyIds)) as Array<{ class_id: string; parent_class_id: string }>;
      expect(edges).toHaveLength(39);
      expect(edges.every((e) => e.parent_class_id === SYSTEM_CLASS_UUIDS.source)).toBe(true);
    });

    it("seeds the 18 archived-by-default classes with active = false, the rest active", () => {
      const store = makeStore();
      seedStore(store);
      const familyIds = FAMILY.map((name) => SYSTEM_CLASS_UUIDS[name]);
      const registry = store.database
        .prepare(
          `SELECT id, active FROM class
           WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
        )
        .all(JSON.stringify(familyIds)) as Array<{ id: string; active: number }>;
      expect(registry).toHaveLength(39);
      const activeIds = new Set(registry.filter((r) => r.active === 1).map((r) => r.id));
      const expectedActive = FAMILY.filter((name) => !ARCHIVED.has(name)).map(
        (name) => SYSTEM_CLASS_UUIDS[name],
      );
      expect([...activeIds].sort()).toEqual(expectedActive.sort());
      // The node bit mirrors the registry projection.
      for (const name of FAMILY) {
        const node = store.database
          .prepare("SELECT is_active FROM node WHERE id = ?")
          .get(SYSTEM_CLASS_UUIDS[name]) as { is_active: number };
        expect(node.is_active).toBe(ARCHIVED.has(name) ? 0 : 1);
      }
      // The picker/catalog visibility read: exactly the 21 enabled types.
      expect(activeIds.size).toBe(21);
    });

    it("materializes every SYSTEM_SOURCE_CLASS_BINDINGS row", () => {
      const store = makeStore();
      seedStore(store);
      const rows = store.database
        .prepare(
          "SELECT class_id, property_schema_id FROM class_property WHERE active = 1 ORDER BY class_id, property_schema_id",
        )
        .all() as Array<{ class_id: string; property_schema_id: string }>;
      const byClass = new Map<string, string[]>();
      for (const row of rows) {
        const list = byClass.get(row.class_id);
        if (list) list.push(row.property_schema_id);
        else byClass.set(row.class_id, [row.property_schema_id]);
      }
      for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
        const own = (byClass.get(SYSTEM_CLASS_UUIDS[name as SystemClassName]) ?? []).sort();
        const expected = properties.map((p) => SYSTEM_PROPERTY_UUIDS[p]).sort();
        expect(own).toEqual(expected);
      }
      // The base's own rows ride too (the pool bound on source).
      const sourceRows = byClass.get(SYSTEM_CLASS_UUIDS.source) ?? [];
      expect(sourceRows.length).toBeGreaterThan(0);
    });

    it("re-applying the whole seed is a complete no-op (idempotent ensure)", () => {
      const store = makeStore();
      seedStore(store);
      const before = dumpDerived(store);
      store.applyMany(sourceSeedEnvelopes());
      expect(dumpDerived(store)).toEqual(before);
    });
  });

  describe("archived semantics (visibility only, not absence)", () => {
    it("an archived class survives the later-extends closure rebuild", () => {
      const store = makeStore();
      seedStore(store);
      for (const name of ["book_section", "artwork", "patent"] as SystemClassName[]) {
        const closure = store.database
          .prepare(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ? ORDER BY ancestor_id",
          )
          .all(SYSTEM_CLASS_UUIDS[name]) as Array<{ ancestor_id: string }>;
        expect(closure.map((r) => r.ancestor_id).sort()).toEqual(
          [SYSTEM_CLASS_UUIDS[name], SYSTEM_CLASS_UUIDS.source].sort(),
        );
      }
    });

    it("classMembers of [source] lists nodes classed by an archived type", () => {
      const store = makeStore();
      seedStore(store);
      store.apply(
        env(
          "object.create",
          {
            objectId: NODE_ARCHIVED,
            classIds: [SYSTEM_CLASS_UUIDS.book_section],
            contentAst: text("A chapter"),
          },
          1727201000000,
        ),
      );
      const members = store
        .classMembers(SYSTEM_CLASS_UUIDS.source)
        .map((row) => row.id);
      expect(members).toContain(NODE_ARCHIVED);
    });

    it("effective properties of an archived-type node resolve through extends [source]", () => {
      const store = makeStore();
      seedStore(store);
      store.apply(
        env(
          "object.create",
          {
            objectId: NODE_ARCHIVED,
            classIds: [SYSTEM_CLASS_UUIDS.book_section],
            contentAst: text("A chapter"),
          },
          1727201000000,
        ),
      );
      const effective = store.getEffectiveProperties(NODE_ARCHIVED);
      const schemaIds = effective.map((p) => p.propertySchemaId);
      // citekey rides the source base (defaultValue "") — it must resolve
      // for a book_section node even though book_section is archived.
      expect(schemaIds).toContain(SYSTEM_PROPERTY_UUIDS.citekey);
      const citekey = effective.find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
      expect(citekey?.source).toBe("default");
      // And a book_section-local row (bookTitle) lists as bound.
      expect(schemaIds).toContain(SYSTEM_PROPERTY_UUIDS.bookTitle);
    });

    it("enabled types resolve exactly the same way", () => {
      const store = makeStore();
      seedStore(store);
      store.apply(
        env(
          "object.create",
          {
            objectId: NODE_ACTIVE,
            classIds: [SYSTEM_CLASS_UUIDS.journal_article],
            contentAst: text("An article"),
          },
          1727201000000,
        ),
      );
      const members = store
        .classMembers(SYSTEM_CLASS_UUIDS.source)
        .map((row) => row.id);
      expect(members).toContain(NODE_ACTIVE);
      expect(
        store.getEffectiveProperties(NODE_ACTIVE).map((p) => p.propertySchemaId),
      ).toContain(SYSTEM_PROPERTY_UUIDS.citekey);
    });
  });
});

/** Deterministic dump of the derived tables this suite converges on. */
function dumpDerived(store: Store): Record<string, unknown[]> {
  const tables = [
    "class",
    "class_extends",
    "class_hierarchy",
    "class_member_set",
    "class_property",
    "node",
    "property_schema",
  ];
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
