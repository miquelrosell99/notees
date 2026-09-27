/**
 * Query engine tests: QueryAST schema validation (fail-loud evolution) and
 * the SQLite compiler + execution helpers, run against BOTH store adapters —
 * sql.js (in-memory WASM, FTS4) and better-sqlite3 (file-backed temp dir,
 * FTS5) — so the SQL stays portable across both FTS modules and drivers.
 *
 * The fixture world (built from envelopes through the real appliers):
 *
 *   France (page, class Place) ─┬─ Paris (page, class City extends Place)
 *                               │   └─ parisBlock "Capital of France"
 *                               ├─ frBlock "The capital city" → mentions Paris
 *                               └─ outBlock "Traveller notes" → mentions Lone
 *   Lone Page (page) ── loneBlock "An orphan note about cooking"
 *
 *   Property schema "priority": Place binds default "medium", City "high";
 *   Lone Page has an authored value "low".
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { contentTokenSchema, newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  compile,
  countQuery,
  matches,
  parseQueryAst,
  runQuery,
  type Child,
  type QueryAst,
  type Scope,
} from "../src/index.js";

// ids ------------------------------------------------------------------------

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const FRANCE = "0192a000-0000-7000-8000-000000000101";
const PARIS = "0192a000-0000-7000-8000-000000000102";
const LONE = "0192a000-0000-7000-8000-000000000103";
const FR_BLOCK = "0192a000-0000-7000-8000-000000000111";
const PARIS_BLOCK = "0192a000-0000-7000-8000-000000000112";
const LONE_BLOCK = "0192a000-0000-7000-8000-000000000113";
const OUT_BLOCK = "0192a000-0000-7000-8000-000000000114";

const PLACE = "0192a000-0000-7000-8000-000000000201";
const CITY = "0192a000-0000-7000-8000-000000000202";

const PRIORITY = "0192a000-0000-7000-8000-000000000301";

const T0 = 1727200000000; // France
const STEP = 1000;

// envelope helpers ------------------------------------------------------------

function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-query",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

/** The France/Paris topology + classes + property bindings, in apply order. */
function worldEnvelopes(): Envelope[] {
  const t = (i: number) => T0 + i * STEP;
  const text = (s: string) => [{ type: "text", text: s }];
  const mention = (targetNodeId: string, captured: string) => [
    { type: "mention", targetNodeId, text: captured },
  ];
  return [
    env("class.create", { classId: PLACE, name: "Place" }, t(0)),
    env("class.create", { classId: CITY, name: "City" }, t(1)),
    env("class.setExtends", { classId: CITY, parentClassIds: [PLACE] }, t(2)),
    env("propertySchema.create", {
      propertySchemaId: PRIORITY,
      name: "priority",
      type: "select",
      options: [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
    }, t(3)),
    env("class.property.set", { classId: PLACE, propertySchemaId: PRIORITY, defaultValue: "medium" }, t(4)),
    env("class.property.set", { classId: CITY, propertySchemaId: PRIORITY, defaultValue: "high" }, t(5)),
    env("object.create", { objectId: FRANCE, nodeType: "page", name: "France", classIds: [PLACE] }, t(6)),
    env("object.create", { objectId: PARIS, nodeType: "page", name: "Paris", parentId: FRANCE, classIds: [CITY] }, t(7)),
    env("object.create", { objectId: LONE, nodeType: "page", name: "Lone Page" }, t(8)),
    env("object.create", {
      objectId: FR_BLOCK,
      nodeType: "block",
      parentId: FRANCE,
      contentAst: [...text("The capital city"), ...mention(PARIS, "Paris")],
    }, t(9)),
    env("object.create", {
      objectId: PARIS_BLOCK,
      nodeType: "block",
      parentId: PARIS,
      contentAst: text("Capital of France"),
    }, t(10)),
    env("object.create", {
      objectId: LONE_BLOCK,
      nodeType: "block",
      parentId: LONE,
      contentAst: text("An orphan note about cooking"),
    }, t(11)),
    env("object.create", {
      objectId: OUT_BLOCK,
      nodeType: "block",
      parentId: FRANCE,
      contentAst: [...text("Traveller notes"), ...mention(LONE, "Lone Page")],
    }, t(12)),
    env("property.set", { objectId: LONE, propertySchemaId: PRIORITY, value: "low" }, t(13)),
  ];
}

// AST helpers -------------------------------------------------------------------

function ast(scope: Scope, children: Child[], sort?: QueryAst["sort"]): QueryAst {
  return {
    version: 1,
    scope,
    root: { type: "group", logic: "and", children },
    ...(sort !== undefined ? { sort } : {}),
  };
}

const entire: Scope = { type: "entire_workspace" };
const pages: Scope = { type: "pages" };

const allIn = (scope: Scope): QueryAst => ({
  version: 1,
  scope,
  root: { type: "group", logic: "and", children: [] },
});

// adapters ------------------------------------------------------------------------

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

// Both store adapters, entered through the store's public factories (the
// better-sqlite3 adapter module itself is not part of the store's exports).
const adapters: { name: string; makeStore: () => Store }[] = [
  { name: "sqljs", makeStore: () => Store.open(sqljsBackend(sqlModule)) },
  {
    name: "better-sqlite3",
    makeStore: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-query-test-"));
      tmpDirs.push(dir);
      return Store.openFile(join(dir, "store.db"));
    },
  },
];

// --- schema: fail-loud versioned evolution (adapter-independent) -----------------

describe("queryAstSchema", () => {
  it("accepts a minimal AST", () => {
    const parsed = parseQueryAst({
      version: 1,
      scope: { type: "subtree", pageId: FRANCE },
      root: { type: "group", logic: "and", children: [{ type: "class", classId: PLACE }] },
    });
    expect(parsed.version).toBe(1);
    expect(parsed.scope).toEqual({ type: "subtree", pageId: FRANCE });
  });

  it("rejects unknown condition types (loud, versioned evolution)", () => {
    expect(() =>
      parseQueryAst({
        version: 1,
        scope: { type: "pages" },
        root: {
          type: "group",
          logic: "and",
          children: [{ type: "style", styleType: "bold" }],
        },
      }),
    ).toThrow();
  });

  it("rejects newer AST versions and unknown keys", () => {
    const base = { scope: { type: "pages" }, root: { type: "group", logic: "and", children: [] } };
    expect(() => parseQueryAst({ ...base, version: 2 })).toThrow();
    expect(() => parseQueryAst({ ...base, version: 1, extra: true })).toThrow();
  });

  it("rejects malformed uuids in scope/condition ids", () => {
    expect(() =>
      parseQueryAst({
        version: 1,
        scope: { type: "subtree", pageId: "not-a-uuid" },
        root: { type: "group", logic: "and", children: [] },
      }),
    ).toThrow();
  });
});

// --- compiler: SQL shape (no store needed) -----------------------------------------

describe("compile: SQL shape", () => {
  it("entire_workspace scope: no scope clause, deterministic columns and order", () => {
    const { sql, params } = compile(allIn(entire));
    expect(sql).toBe(
      "SELECT n.*\nFROM node n\nWHERE n.is_active = 1\nORDER BY n.id ASC",
    );
    expect(params).toEqual([]);
  });

  it("pages scope filters node_type", () => {
    const { sql } = compile(allIn(pages));
    expect(sql).toContain("n.node_type = 'page'");
    expect(sql).not.toContain("distance");
  });

  it("subtree scope joins a recursive CTE and exposes distance", () => {
    const { sql, params } = compile(allIn({ type: "subtree", pageId: FRANCE }));
    expect(sql).toContain("WITH RECURSIVE sub(id, distance) AS");
    expect(sql).toContain("JOIN (WITH RECURSIVE sub(id, distance) AS");
    expect(sql).toContain("SELECT n.*, sc.distance AS distance");
    expect(params).toEqual([FRANCE]);
  });

  it("linkedTo scope uses the roll-up CTE (direct + containment, MIN distance)", () => {
    const { sql, params } = compile(allIn({ type: "linkedTo", nodeId: PARIS }));
    expect(sql).toContain("hits AS (");
    expect(sql).toContain("e.target_id = ?");
    expect(sql).toContain("sub.distance > 0 AND e.target_id NOT IN (SELECT id FROM sub)");
    expect(sql).toContain("MIN(distance) AS distance");
    expect(params).toEqual([PARIS, PARIS]);
  });

  it("class condition probes class_hierarchy (descendant classes match)", () => {
    const { sql, params } = compile(ast(entire, [{ type: "class", classId: PLACE }]));
    expect(sql).toContain("json_each(n.class_ids)");
    expect(sql).toContain(
      "value IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = ?)",
    );
    expect(params).toEqual([PLACE]);
  });

  it("nodeType and created-window conditions are parameterized", () => {
    const { sql, params } = compile(
      ast(entire, [
        { type: "nodeType", nodeType: "block" },
        { type: "createdAfter", timestamp: "2026-09-24T12:00:00.000Z" },
        { type: "createdBefore", timestamp: "2026-09-25T12:00:00.000Z" },
      ]),
    );
    expect(sql).toContain("n.node_type = ?");
    expect(sql).toContain("n.created_at >= ?");
    expect(sql).toContain("n.created_at <= ?");
    expect(params).toEqual(["block", "2026-09-24T12:00:00.000Z", "2026-09-25T12:00:00.000Z"]);
  });

  it("content contains LIKEs the derived plaintext; fts MATCHes it", () => {
    const contains = compile(ast(entire, [{ type: "content", op: "contains", value: "citi" }]));
    expect(contains.sql).toContain("s.content LIKE '%' || ? || '%'");
    expect(contains.params).toEqual(["citi"]);
    const fts = compile(ast(entire, [{ type: "content", op: "fts", value: "capital city" }]));
    expect(fts.sql).toContain("search_index MATCH ?");
    expect(fts.params).toEqual(["capital* AND city*"]);
  });

  it("property condition: effective read model (authored UNION derived defaults)", () => {
    const { sql, params } = compile(
      ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "high" }]),
    );
    // Three schema-id params: authored CTE, winning-binding CTE, derived
    // no-authored-at-idx-0 check; then the value param.
    expect(params).toEqual([PRIORITY, PRIORITY, PRIORITY, "high"]);
    expect(sql).toContain("WITH authored AS (");
    expect(sql).toContain("property_value_tombstone");
    expect(sql).toContain("ROW_NUMBER() OVER (");
    expect(sql).toContain("json_extract(value, '$') = ?");
    expect(sql).toContain("UNION ALL");
  });

  it("property condition with includeDefaults:false is authored-only", () => {
    const { sql, params } = compile(
      ast(entire, [
        { type: "property", schemaId: PRIORITY, op: "exists", includeDefaults: false },
      ]),
    );
    expect(params).toEqual([PRIORITY]);
    expect(sql).toContain("WITH authored AS (");
    expect(sql).not.toContain("derived AS (");
  });

  it("sort maps to a deterministic ORDER BY with id tiebreak", () => {
    const { sql } = compile(
      ast(pages, [], [
        { field: "name", dir: "asc" },
        { field: "createdAt", dir: "desc" },
      ]),
    );
    expect(sql).toContain(
      "ORDER BY n.name IS NULL, n.name ASC, n.created_at IS NULL, n.created_at DESC, n.id ASC",
    );
    const nodeType = compile(ast(pages, [], [{ field: "nodeType", dir: "desc" }]));
    expect(nodeType.sql).toContain("ORDER BY n.node_type DESC, n.id ASC");
  });

  it("user values never reach the SQL string (parameterization)", () => {
    const injection = "x' OR '1'='1";
    const { sql, params } = compile(
      ast(entire, [
        { type: "content", op: "contains", value: injection },
        { type: "class", classId: PLACE },
      ]),
    );
    expect(sql).not.toContain(injection);
    expect(params).toEqual([injection, PLACE]);
    expect(sql.match(/\?/g)!.length).toBeGreaterThanOrEqual(params.length);
  });

  it("fails loud: aggregation not implemented in M1", () => {
    const withAggregation: QueryAst = {
      ...allIn(pages),
      aggregation: {
        type: "aggregation",
        dimensions: [{ type: "dimension", field: "nodeType" }],
        measure: { type: "measure", function: "count" },
      },
    };
    expect(() => compile(withAggregation)).toThrow(/aggregation/);
  });

  it("fails loud: fts value with no searchable terms; property eq without value", () => {
    expect(() => compile(ast(entire, [{ type: "content", op: "fts", value: "!!!" }]))).toThrow(
      /no search terms/,
    );
    expect(() =>
      compile(ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq" }])),
    ).toThrow(/requires a non-null value/);
  });
});

// --- protocol token wiring (loose-optional forward compat) ------------------------

describe("protocol query token", () => {
  const validAst = allIn(pages);

  it("parses a known AST into the typed model", () => {
    const token = contentTokenSchema.parse({ type: "query", queryAst: validAst });
    expect(token.type).toBe("query");
    if (token.type === "query") expect(token.queryAst).toEqual(validAst);
  });

  it("accepts a newer/foreign AST shape as a plain record (forward compat)", () => {
    const foreign = { version: 2, scope: { type: "pages" }, root: { type: "group", logic: "and", children: [] }, future: ["x"] };
    const token = contentTokenSchema.parse({ type: "query", queryAst: foreign });
    expect(token.type).toBe("query");
    if (token.type === "query") expect(token.queryAst).toEqual(foreign);
  });

  it("accepts an unknown-condition AST as a record rather than rejecting the token", () => {
    const foreign = {
      version: 1,
      scope: { type: "pages" },
      root: { type: "group", logic: "and", children: [{ type: "weather", sunny: true }] },
    };
    const token = contentTokenSchema.parse({ type: "query", queryAst: foreign });
    if (token.type === "query") expect(token.queryAst).toEqual(foreign);
  });
});

// --- execution against the real derived store (both adapters) ----------------------

describe.each(adapters)("$name", ({ makeStore }) => {
  function worldStore(): Store {
    const store = makeStore();
    store.applyMany(worldEnvelopes());
    return store;
  }

  describe("scope isolation", () => {
    it("entire_workspace returns every active node (pages, blocks, classes)", () => {
      const { ids } = runQuery(worldStore(), allIn(entire));
      // 7 world nodes + the Place/City class nodes (class.create is a node row).
      expect(ids).toHaveLength(9);
      expect(ids).toContain(FRANCE);
      expect(ids).toContain(LONE_BLOCK);
      expect(ids).toContain(PLACE);
    });

    it("pages returns only pages", () => {
      const { ids } = runQuery(worldStore(), allIn(pages));
      expect(ids.sort()).toEqual([FRANCE, LONE, PARIS].sort());
    });

    it("subtree returns the page plus descendants, with distances, excluding outsiders", () => {
      const { ids, rows } = runQuery(worldStore(), allIn({ type: "subtree", pageId: FRANCE }));
      expect(ids.sort()).toEqual([FRANCE, PARIS, FR_BLOCK, PARIS_BLOCK, OUT_BLOCK].sort());
      expect(ids).not.toContain(LONE);
      expect(ids).not.toContain(LONE_BLOCK);
      const distance = new Map(rows.map((r) => [String(r.id), r.distance]));
      expect(distance.get(FRANCE)).toBe(0);
      expect(distance.get(PARIS)).toBe(1);
      expect(distance.get(FR_BLOCK)).toBe(1);
      expect(distance.get(PARIS_BLOCK)).toBe(2);
      expect(distance.get(OUT_BLOCK)).toBe(1);
    });

    it("subtree of a nonexistent page matches nothing", () => {
      const { ids } = runQuery(
        worldStore(),
        allIn({ type: "subtree", pageId: "0192a000-0000-7000-8000-000000000999" }),
      );
      expect(ids).toEqual([]);
    });
  });

  describe("class conditions (hierarchy-aware)", () => {
    it("direct membership matches", () => {
      const { ids } = runQuery(worldStore(), ast(entire, [{ type: "class", classId: CITY }]));
      expect(ids).toEqual([PARIS]);
    });

    it("child classes match the ancestor class condition", () => {
      // City extends Place, so a Place query must find City members too.
      const { ids } = runQuery(worldStore(), ast(entire, [{ type: "class", classId: PLACE }]));
      expect(ids.sort()).toEqual([FRANCE, PARIS].sort());
    });
  });

  describe("property conditions (effective read model)", () => {
    it("eq matches binding-derived defaults (includeDefaults default)", () => {
      const store = worldStore();
      expect(runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "medium" }])).ids).toEqual([FRANCE]);
      expect(runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "high" }])).ids).toEqual([PARIS]);
      expect(runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "low" }])).ids).toEqual([LONE]);
    });

    it("exists matches default-derived and authored values", () => {
      const { ids } = runQuery(
        worldStore(),
        ast(entire, [{ type: "property", schemaId: PRIORITY, op: "exists" }]),
      );
      expect(ids.sort()).toEqual([FRANCE, PARIS, LONE].sort());
    });

    it("includeDefaults:false tests authored rows only", () => {
      const store = worldStore();
      expect(
        runQuery(
          store,
          ast(entire, [
            { type: "property", schemaId: PRIORITY, op: "exists", includeDefaults: false },
          ]),
        ).ids,
      ).toEqual([LONE]);
      expect(
        runQuery(
          store,
          ast(entire, [
            { type: "property", schemaId: PRIORITY, op: "eq", value: "medium", includeDefaults: false },
          ]),
        ).ids,
      ).toEqual([]);
    });

    it("authored value shadows the class-binding default", () => {
      const store = worldStore();
      store.apply(
        env("property.set", { objectId: FRANCE, propertySchemaId: PRIORITY, value: "urgent" }, T0 + 20 * STEP),
      );
      expect(
        runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "medium" }])).ids,
      ).toEqual([]);
      expect(
        runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "eq", value: "urgent" }])).ids,
      ).toEqual([FRANCE]);
      // The panel agrees: authored wins in the effective read model.
      expect(
        store.getEffectiveProperties(FRANCE).find((p) => p.propertySchemaId === PRIORITY)?.value,
      ).toBe("urgent");
    });

    it("tombstoned authored values drop out (and the default resurfaces)", () => {
      const store = worldStore();
      store.apply(
        env("property.unset", { objectId: LONE, propertySchemaId: PRIORITY, idx: 0 }, T0 + 21 * STEP),
      );
      expect(
        runQuery(
          store,
          ast(entire, [{ type: "property", schemaId: PRIORITY, op: "exists", includeDefaults: false }]),
        ).ids,
      ).toEqual([]);
    });

    it("contains matches substrings of effective values; neq negates membership", () => {
      const store = worldStore();
      expect(
        runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "contains", value: "med" }])).ids,
      ).toEqual([FRANCE]);
      expect(
        runQuery(store, ast(entire, [{ type: "property", schemaId: PRIORITY, op: "neq", value: "medium" }])).ids.sort(),
      ).toEqual([LONE, PARIS].sort());
    });
  });

  describe("linkedTo (backlinksWithRollup semantics)", () => {
    it("direct edges match", () => {
      const { ids } = runQuery(worldStore(), ast(entire, [{ type: "linkedTo", nodeId: PARIS }]));
      expect(ids).toEqual([FR_BLOCK]);
    });

    it("containment roll-up: a block inside France linking outward links France", () => {
      const { ids } = runQuery(worldStore(), ast(entire, [{ type: "linkedTo", nodeId: FRANCE }]));
      // frBlock -> Paris is intra-subtree (excluded); outBlock -> Lone Page is
      // an outward link from inside France's subtree.
      expect(ids).toEqual([OUT_BLOCK]);
    });

    it("scope form restricts the universe and carries distance", () => {
      const { ids, rows } = runQuery(
        worldStore(),
        ast({ type: "linkedTo", nodeId: FRANCE }, [{ type: "nodeType", nodeType: "block" }]),
      );
      expect(ids).toEqual([OUT_BLOCK]);
      expect(rows[0]!.distance).toBe(1);
    });
  });

  describe("composition (and / or / not)", () => {
    it("and intersects", () => {
      const { ids } = runQuery(
        worldStore(),
        ast(entire, [
          { type: "content", op: "contains", value: "capital" },
          { type: "nodeType", nodeType: "block" },
        ]),
      );
      expect(ids.sort()).toEqual([FR_BLOCK, PARIS_BLOCK].sort());
    });

    it("or unions", () => {
      const orAst: QueryAst = {
        version: 1,
        scope: entire,
        root: {
          type: "group",
          logic: "or",
          children: [
            { type: "class", classId: PLACE },
            { type: "nodeType", nodeType: "block" },
          ],
        },
      };
      const { ids } = runQuery(worldStore(), orAst);
      // class(Place) = France + Paris; blocks = frBlock, parisBlock, loneBlock, outBlock.
      expect(ids.sort()).toEqual(
        [FRANCE, PARIS, FR_BLOCK, PARIS_BLOCK, LONE_BLOCK, OUT_BLOCK].sort(),
      );
    });

    it("not negates a condition and a nested group", () => {
      const store = worldStore();
      expect(
        runQuery(
          store,
          ast(pages, [{ type: "not", child: { type: "content", op: "contains", value: "france" } }]),
        ).ids,
      ).toEqual([PARIS, LONE]); // Only the France page's name carries "france".
      expect(
        runQuery(
          store,
          ast(entire, [
            { type: "nodeType", nodeType: "block" },
            {
              type: "not",
              child: {
                type: "group",
                logic: "or",
                children: [
                  { type: "linkedTo", nodeId: PARIS },
                  { type: "linkedTo", nodeId: LONE },
                ],
              },
            },
          ]),
        ).ids.sort(),
      ).toEqual([PARIS_BLOCK, LONE_BLOCK].sort());
    });
  });

  describe("content: contains vs fts", () => {
    it("contains is a substring match over name + content plaintext", () => {
      const store = worldStore();
      expect(runQuery(store, ast(entire, [{ type: "content", op: "contains", value: "cook" }])).ids).toEqual([LONE_BLOCK]);
      // Pages are findable by name (the derived plaintext includes it).
      expect(
        runQuery(store, ast(pages, [{ type: "content", op: "contains", value: "lone p" }])).ids,
      ).toEqual([LONE]);
    });

    it("fts matches whole-token prefixes; contains matches any substring", () => {
      const store = worldStore();
      // "ity" is a substring of "city" but no token STARTS with it.
      expect(runQuery(store, ast(entire, [{ type: "content", op: "contains", value: "ity" }])).ids).toEqual([FR_BLOCK]);
      expect(runQuery(store, ast(entire, [{ type: "content", op: "fts", value: "ity" }])).ids).toEqual([]);
      // Prefix-AND across terms: both tokens must be present.
      expect(runQuery(store, ast(entire, [{ type: "content", op: "fts", value: "capital france" }])).ids).toEqual([PARIS_BLOCK]);
    });
  });

  describe("created window and is_active", () => {
    it("createdAfter / createdBefore are inclusive on node.created_at", () => {
      const store = worldStore();
      const t = (i: number) => new Date(T0 + i * STEP).toISOString();
      // Paris is created exactly at t(7); the boundary is inclusive.
      const after = runQuery(store, ast(entire, [{ type: "createdAfter", timestamp: t(7) }]));
      expect(after.ids).not.toContain(FRANCE);
      expect(after.ids.sort()).toEqual(
        [PARIS, LONE, FR_BLOCK, PARIS_BLOCK, LONE_BLOCK, OUT_BLOCK].sort(),
      );
      const before = runQuery(store, ast(entire, [{ type: "createdBefore", timestamp: t(7) }]));
      // Class nodes are node rows too (created at t0/t1).
      expect(before.ids.sort()).toEqual([PLACE, CITY, FRANCE, PARIS].sort());
    });

    it("soft-deleted nodes are excluded", () => {
      const store = worldStore();
      store.apply(env("object.delete", { objectId: LONE_BLOCK, permanent: false }, T0 + 22 * STEP));
      expect(runQuery(store, ast(entire, [{ type: "content", op: "contains", value: "cook" }])).ids).toEqual([]);
      expect(countQuery(store, allIn(entire))).toBe(8);
    });
  });

  describe("sort", () => {
    it("orders by name with id tiebreak; desc reverses", () => {
      const store = worldStore();
      const asc = runQuery(store, ast(pages, [], [{ field: "name", dir: "asc" }]));
      expect(asc.ids).toEqual([FRANCE, LONE, PARIS]);
      const desc = runQuery(store, ast(pages, [], [{ field: "name", dir: "desc" }]));
      expect(desc.ids).toEqual([PARIS, LONE, FRANCE]);
    });
  });

  describe("execute helpers", () => {
    it("countQuery matches runQuery length", () => {
      const store = worldStore();
      const astBlocks = ast(entire, [{ type: "nodeType", nodeType: "block" }]);
      expect(countQuery(store, astBlocks)).toBe(4);
      expect(runQuery(store, astBlocks).ids).toHaveLength(4);
    });

    it("matches tests a single node", () => {
      const store = worldStore();
      const cityQuery = ast(entire, [{ type: "class", classId: CITY }]);
      expect(matches(store, PARIS, cityQuery)).toBe(true);
      expect(matches(store, FRANCE, cityQuery)).toBe(false);
      expect(matches(store, PARIS, allIn({ type: "subtree", pageId: FRANCE }))).toBe(true);
      expect(matches(store, LONE, allIn({ type: "subtree", pageId: FRANCE }))).toBe(false);
    });
  });
});
