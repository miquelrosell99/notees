/**
 * Node-level property assignment (owner ruling 2026-10-23 — the v1
 * `node_property` lineage): the (node, property) pair declaration WITHOUT a
 * value.
 *
 *  - property.assign upserts a presence row per (node, schema), LWW by the
 *    full (hlc, actor) tuple (the class_property precedent) — concurrent
 *    assigns converge on one row, an older/equal re-issue is dropped.
 *  - R3 stays the sole locality authority: a scoped schema rejects an
 *    ineligible node, fail loud, exactly like property.set.
 *  - property.unassign deletes the declaration only — authored values
 *    survive (never retroactive) and keep rendering as unbound authored rows.
 *  - The effective read synthesizes an EMPTY row (value null, source
 *    "assigned") for an assigned schema with no authored rows and no
 *    derived default; authored rows and defaults shadow it; hideWhenEmpty
 *    suppresses it; unbound authored rows still sort last.
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { MoveGuardError, Store, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const PAGE = "0192a000-0000-7000-8000-000000000010";
const OTHER_PAGE = "0192a000-0000-7000-8000-000000000011";
const GENRE = "0192a000-0000-7000-8000-000000000012";
const SCHEMA_URL = "0192a000-0000-7000-8000-0000000000a1";
const SCHEMA_RATING = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA_PRIVATE = "0192a000-0000-7000-8000-0000000000a3";
const SCHEMA_LINKS = "0192a000-0000-7000-8000-0000000000a4";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-assign",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

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
  { name: "sqljs", makeBackend: () => sqljsBackend(sqlModule) },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-assign-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  /** Owner page + the schema menu the suite writes through. */
  function seededStore(): Store {
    const store = makeStore();
    store.apply(env("object.create", { objectId: PAGE, contentAst: [{ type: "text", text: "Owner" }] }, 1727200000000));
    store.apply(
      env("propertySchema.create", { propertySchemaId: SCHEMA_URL, name: "URL", type: "url" }, 1727200000100),
    );
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA_RATING, name: "Rating", type: "number", defaultValue: 0 },
        1727200000100,
      ),
    );
    // A class-scoped schema: only nodes classed Genre (or its extends
    // descendants) may carry it — the R3 guard's substrate.
    store.apply(env("class.create", { classId: GENRE, contentAst: [{ type: "text", text: "Genre" }] }, 1727200000100));
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA_PRIVATE, name: "Mood", type: "text", scopeClassIds: [GENRE] },
        1727200000100,
      ),
    );
    // Multi-value menu entry for the property.empty sweep tests.
    store.apply(
      env(
        "propertySchema.create",
        { propertySchemaId: SCHEMA_LINKS, name: "Links", type: "url", multi: true },
        1727200000100,
      ),
    );
    return store;
  }

  function assignmentRow(store: Store, nodeId: string, schemaId: string): { hlc_physical: number } | undefined {
    return store.database
      .prepare("SELECT hlc_physical FROM node_property WHERE node_id = ? AND property_schema_id = ?")
      .get(nodeId, schemaId) as { hlc_physical: number } | undefined;
  }

  describe("property.assign: the presence row", () => {
    it("assigns without a value — the effective read synthesizes an empty row", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeDefined();
      const rows = store.getEffectiveProperties(PAGE);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        propertySchemaId: SCHEMA_URL,
        value: null,
        source: "assigned",
        boundBy: null,
        eligible: true,
      });
      expect(rows[0]!.elementId).toBe(`assigned:${SCHEMA_URL}`);
      store.close();
    });

    it("concurrent assigns converge on one row; an older re-issue is dropped", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      const phone = "0192a000-0000-7000-8000-000000000099";
      // A newer writer re-stamps the row…
      store.apply(
        env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200002000, 0, phone),
      );
      expect(assignmentRow(store, PAGE, SCHEMA_URL)?.hlc_physical).toBe(1727200002000);
      // …an older causal stamp is a pure no-op (dropped, like a stale binding).
      const stale = store.apply(
        env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000),
      );
      expect(stale.ignored).toBe(true);
      expect(assignmentRow(store, PAGE, SCHEMA_URL)?.hlc_physical).toBe(1727200002000);
      expect(store.getEffectiveProperties(PAGE)).toHaveLength(1);
      store.close();
    });

    it("a scoped schema rejects an ineligible node, fail loud (R3)", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: OTHER_PAGE, contentAst: [{ type: "text", text: "Other" }] }, 1727200000050));
      expect(() =>
        store.apply(
          env("property.assign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_PRIVATE }, 1727200001000),
        ),
      ).toThrow(MoveGuardError);
      // The eligible carrier (classed Genre) assigns cleanly.
      store.apply(
        env(
          "object.create",
          { objectId: OTHER_PAGE, classIds: [GENRE], contentAst: [{ type: "text", text: "Genre page" }] },
          1727200000060,
        ),
      );
      store.apply(
        env("property.assign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_PRIVATE }, 1727200001000),
      );
      expect(assignmentRow(store, OTHER_PAGE, SCHEMA_PRIVATE)).toBeDefined();
      store.close();
    });
  });

  describe("property.unassign: the declaration dies, the values survive", () => {
    it("unassign removes the row; an authored value renders as an unbound authored row", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001100),
      );
      store.apply(env("property.unassign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001200));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeUndefined();
      const rows = store.getEffectiveProperties(PAGE);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        propertySchemaId: SCHEMA_URL,
        value: "https://x.org",
        source: "authored",
        boundBy: null,
      });
      store.close();
    });

    it("re-assign after unassign revives the empty row (a newer HLC wins)", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(env("property.unassign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001100));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeUndefined();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001200));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeDefined();
      store.close();
    });
  });

  describe("the effective read: shadowing, hideWhenEmpty, ordering", () => {
    it("an authored value shadows the assigned-empty row (no duplicate)", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001100),
      );
      const rows = store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "authored", value: "https://x.org" });
      store.close();
    });

    it("a derived default shadows the assigned-empty row", () => {
      const store = seededStore();
      // Rating carries a schema default and Genre binds it; the page is
      // classed Genre. Assign Rating WITHOUT a value: the default row wins
      // (the binding path already renders it — no synthetic duplicate).
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_RATING }, 1727200000200),
      );
      store.apply(
        env(
          "object.create",
          { objectId: OTHER_PAGE, classIds: [GENRE], contentAst: [{ type: "text", text: "Genre page" }] },
          1727200000060,
        ),
      );
      store.apply(
        env("property.assign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_RATING }, 1727200001000),
      );
      const rows = store.getEffectiveProperties(OTHER_PAGE).filter((r) => r.propertySchemaId === SCHEMA_RATING);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "default", value: 0, boundBy: GENRE });
      store.close();
    });

    it("hideWhenEmpty suppresses the assigned-empty row", () => {
      const store = seededStore();
      store.apply(
        env("propertySchema.update", { propertySchemaId: SCHEMA_URL, hideWhenEmpty: true }, 1727200000050),
      );
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      expect(store.getEffectiveProperties(PAGE)).toHaveLength(0);
      store.close();
    });

    it("unbound authored rows sort last; the assigned-empty row rides the main block", () => {
      const store = seededStore();
      // URL: assigned, empty. Rating: bound default (needs the binding to
      // derive). An authored unbound value on the scoped schema is authored
      // while classed, then the class is removed → unbound authored.
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_PRIVATE }, 1727200000200),
      );
      store.apply(
        env(
          "object.create",
          { objectId: OTHER_PAGE, classIds: [GENRE], contentAst: [{ type: "text", text: "Genre page" }] },
          1727200000060,
        ),
      );
      store.apply(
        env(
          "property.set",
          { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_PRIVATE, value: "noir" },
          1727200001000,
        ),
      );
      store.apply(env("class.unassign", { objectId: OTHER_PAGE, classId: GENRE }, 1727200001100));
      store.apply(env("property.assign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_URL }, 1727200001200));
      const rows = store.getEffectiveProperties(OTHER_PAGE);
      const sources = rows.map((r) => r.source);
      expect(sources[sources.length - 1]).toBe("authored");
      expect(rows[sources.length - 1]).toMatchObject({ boundBy: null, value: "noir" });
      expect(rows.slice(0, -1).some((r) => r.source === "assigned")).toBe(true);
      store.close();
    });

    it("property.set stays legal without an assignment (values need no declaration)", () => {
      const store = seededStore();
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001000),
      );
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeUndefined();
      expect(store.getEffectiveProperties(PAGE)[0]).toMatchObject({ source: "authored" });
      store.close();
    });
  });

  describe("property.empty: the values die, the declaration survives", () => {
    it("clears the single authored value and keeps the assignment — the empty row renders again", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001100),
      );
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001200));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeDefined();
      const rows = store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "assigned", value: null });
      store.close();
    });

    it("clears EVERY value of a multi property — every element and idx", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200001000));
      store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://a.org", elementId: "0192a000-0000-7000-8000-0000000000e1" },
          1727200001100,
        ),
      );
      store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://b.org", elementId: "0192a000-0000-7000-8000-0000000000e2", idx: 1 },
          1727200001150,
        ),
      );
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200001200));
      const authored = store
        .getEffectiveProperties(PAGE)
        .filter((r) => r.propertySchemaId === SCHEMA_LINKS && r.source === "authored");
      expect(authored).toHaveLength(0);
      const assigned = store
        .getEffectiveProperties(PAGE)
        .filter((r) => r.propertySchemaId === SCHEMA_LINKS && r.source === "assigned");
      expect(assigned).toHaveLength(1);
      store.close();
    });

    it("clear causality: older adds at OBSERVED slots stay dead; an add at an UNOBSERVED slot survives (the house add-wins rule)", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200001000));
      store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://old.org", elementId: "0192a000-0000-7000-8000-0000000000e1" },
          1727200001100,
        ),
      );
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200002000));
      // An older add at the OBSERVED idx 0 arrives late (fresh element id,
      // positional carrier) — the empty stamped the slot tombstone there, so
      // the read suppresses it either way.
      const lateObserved = store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://late.org", elementId: "0192a000-0000-7000-8000-0000000000e3" },
          1727200001500,
        ),
      );
      expect(lateObserved.ignored).toBe(false); // inserted, then read-suppressed
      // An older add at an UNOBSERVED idx (3) arrives late — it SURVIVES:
      // the empty never touched that slot, and add-wins is the house rule.
      const lateUnobserved = store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://kept.org", elementId: "0192a000-0000-7000-8000-0000000000e4", idx: 3 },
          1727200001600,
        ),
      );
      expect(lateUnobserved.ignored).toBe(false);
      const rows = store
        .getEffectiveProperties(PAGE)
        .filter((r) => r.propertySchemaId === SCHEMA_LINKS && r.source === "authored");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ value: "https://kept.org", idx: 3 });
      store.close();
    });

    it("a RE-ISSUED element add (the empty SAW the element) stays dead after the empty", () => {
      const store = seededStore();
      const element = "0192a000-0000-7000-8000-0000000000e5";
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200001000));
      store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://a.org", elementId: element },
          1727200001100,
        ),
      );
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_LINKS }, 1727200002000));
      // The same element re-added with an older HLC — the element tombstone
      // the empty stamped kills it.
      const readd = store.apply(
        env(
          "property.set",
          { objectId: PAGE, propertySchemaId: SCHEMA_LINKS, value: "https://a.org", elementId: element },
          1727200001500,
        ),
      );
      expect(readd.ignored).toBe(true);
      const rows = store
        .getEffectiveProperties(PAGE)
        .filter((r) => r.propertySchemaId === SCHEMA_LINKS);
      expect(rows.some((r) => r.source === "authored")).toBe(false);
      store.close();
    });

    it("a concurrent NEWER set survives the empty", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001100),
      );
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001200));
      // The set is NEWER than the empty — it lands and survives.
      store.apply(
        env("property.set", { objectId: PAGE, propertySchemaId: SCHEMA_URL, value: "https://new.org" }, 1727200001300),
      );
      const rows = store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "authored", value: "https://new.org" });
      store.close();
    });

    it("a bound default resurfaces after the empty", () => {
      const store = seededStore();
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_RATING }, 1727200000200),
      );
      store.apply(
        env(
          "object.create",
          { objectId: OTHER_PAGE, classIds: [GENRE], contentAst: [{ type: "text", text: "Genre page" }] },
          1727200000060,
        ),
      );
      store.apply(
        env("property.set", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_RATING, value: 5 }, 1727200001000),
      );
      store.apply(env("property.empty", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_RATING }, 1727200001100));
      const rows = store
        .getEffectiveProperties(OTHER_PAGE)
        .filter((r) => r.propertySchemaId === SCHEMA_RATING);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "default", value: 0, boundBy: GENRE });
      store.close();
    });

    it("empty with no values is a harmless no-op — the assignment stands", () => {
      const store = seededStore();
      store.apply(env("property.assign", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      store.apply(env("property.empty", { objectId: PAGE, propertySchemaId: SCHEMA_URL }, 1727200001100));
      expect(assignmentRow(store, PAGE, SCHEMA_URL)).toBeDefined();
      expect(
        store.getEffectiveProperties(PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL),
      ).toHaveLength(1);
      store.close();
    });
  });

  describe("bound-but-empty: the virtual property shows as coming from the class", () => {
    function classedStore(): Store {
      const store = seededStore();
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_URL }, 1727200000200),
      );
      store.apply(
        env(
          "object.create",
          { objectId: OTHER_PAGE, classIds: [GENRE], contentAst: [{ type: "text", text: "Genre page" }] },
          1727200000060,
        ),
      );
      return store;
    }

    it("a winning active binding with nothing on the slot synthesizes a bound-empty row — scalar types included", () => {
      const store = classedStore();
      const rows = store.getEffectiveProperties(OTHER_PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "bound",
        value: null,
        boundBy: GENRE,
        eligible: true,
      });
      expect(rows[0]!.elementId).toBe(`bound:${SCHEMA_URL}`);
      store.close();
    });

    it("unrealize (property.unassign) drops the pin — the bound row still renders (the class still supplies it)", () => {
      const store = classedStore();
      store.apply(env("property.assign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_URL }, 1727200001000));
      // Realized first: the node's own declaration wins the slot.
      let rows = store.getEffectiveProperties(OTHER_PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows[0]).toMatchObject({ source: "assigned", boundBy: null });
      // Unrealize — the binding carries the row now.
      store.apply(env("property.unassign", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_URL }, 1727200001100));
      expect(assignmentRow(store, OTHER_PAGE, SCHEMA_URL)).toBeUndefined();
      rows = store.getEffectiveProperties(OTHER_PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: "bound", boundBy: GENRE, value: null });
      store.close();
    });

    it("an authored value or a derived default shadows the bound-empty row", () => {
      const store = classedStore();
      // Default first: Rating binds at Genre in seededStore? — bind it here
      // for a clean single assertion.
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_RATING }, 1727200000210),
      );
      store.apply(
        env("property.set", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_URL, value: "https://x.org" }, 1727200001000),
      );
      const rows = store.getEffectiveProperties(OTHER_PAGE);
      const url = rows.filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(url).toHaveLength(1);
      expect(url[0]).toMatchObject({ source: "authored", value: "https://x.org" });
      const rating = rows.filter((r) => r.propertySchemaId === SCHEMA_RATING);
      expect(rating).toHaveLength(1);
      expect(rating[0]).toMatchObject({ source: "default", value: 0, boundBy: GENRE });
      expect(rows.some((r) => r.source === "bound")).toBe(false);
      store.close();
    });

    it("hideWhenEmpty suppresses the bound-empty row; R4 suppresses it for an ineligible node", () => {
      // hideWhenEmpty:
      const store = classedStore();
      store.apply(
        env("propertySchema.update", { propertySchemaId: SCHEMA_URL, hideWhenEmpty: true }, 1727200000300),
      );
      expect(store.getEffectiveProperties(OTHER_PAGE)).toHaveLength(0);
      store.close();

      // R4: narrow the schema's scope AFTER the binding — the node no
      // longer qualifies, so neither the row nor (had one existed) a
      // default renders. (A second class the node does NOT carry.)
      const store2 = classedStore();
      const elsewhere = "0192a000-0000-7000-8000-0000000000f1";
      store2.apply(env("class.create", { classId: elsewhere, contentAst: [{ type: "text", text: "Elsewhere" }] }, 1727200000300));
      store2.apply(
        env("propertySchema.update", { propertySchemaId: SCHEMA_URL, scopeClassIds: [elsewhere] }, 1727200000400),
      );
      expect(
        store2.getEffectiveProperties(OTHER_PAGE).filter((r) => r.propertySchemaId === SCHEMA_URL),
      ).toHaveLength(0);
      store2.close();
    });

    it("bound rows ride the main alphabetical block; unbound authored still sorts last", () => {
      const store = seededStore();
      const moodClass = "0192a000-0000-7000-8000-0000000000f2";
      store.apply(env("class.create", { classId: moodClass, contentAst: [{ type: "text", text: "MoodClass" }] }, 1727200000300));
      store.apply(
        env("class.property.set", { classId: GENRE, propertySchemaId: SCHEMA_URL }, 1727200000200),
      );
      // Scope Mood to MoodClass FIRST (R5: a binding on a class the scope
      // excludes is dead config), then bind it there.
      store.apply(
        env("propertySchema.update", { propertySchemaId: SCHEMA_PRIVATE, scopeClassIds: [moodClass] }, 1727200000250),
      );
      store.apply(
        env("class.property.set", { classId: moodClass, propertySchemaId: SCHEMA_PRIVATE }, 1727200000210),
      );
      store.apply(
        env(
          "object.create",
          {
            objectId: OTHER_PAGE,
            classIds: [GENRE, moodClass],
            contentAst: [{ type: "text", text: "Genre page" }],
          },
          1727200000060,
        ),
      );
      store.apply(
        env("property.set", { objectId: OTHER_PAGE, propertySchemaId: SCHEMA_PRIVATE, value: "noir" }, 1727200001000),
      );
      // Remove only MoodClass — Mood's value survives unbound; URL stays
      // bound via Genre.
      store.apply(env("class.unassign", { objectId: OTHER_PAGE, classId: moodClass }, 1727200001100));
      const rows = store.getEffectiveProperties(OTHER_PAGE);
      expect(rows[rows.length - 1]).toMatchObject({
        propertySchemaId: SCHEMA_PRIVATE,
        source: "authored",
        boundBy: null,
        value: "noir",
      });
      const url = rows.filter((r) => r.propertySchemaId === SCHEMA_URL);
      expect(url).toHaveLength(1);
      expect(url[0]).toMatchObject({ source: "bound", boundBy: GENRE });
      store.close();
    });
  });
});
