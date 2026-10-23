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
});
