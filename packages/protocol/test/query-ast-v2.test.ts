/**
 * QueryAST v2 — the parameterized grammar (`.plans/…-query-ast-v2` is the
 * design; this file pins the wire contract).
 *
 * v2 folds the v1 64-variant flat condition union into 6 types:
 * `member` (family × op × target-mode axes), `content` (folds contentSet),
 * `name`, `property` (folds propertyBetween/propertyWithin), `date` (folds
 * the ten created-/updated- types), `nodeField` (folds isClass/isEmbedded).
 *
 * Laws under test: `version: 1` is rejected outright (no backward
 * compatibility — v1 data converges by a one-time log rewrite, not by
 * dual-parse); every schema is `.strict()`; unknown condition types,
 * families, ops, and target modes fail loud at parse time.
 */

import { describe, expect, it } from "vitest";

import {
  conditionSchema,
  parseQueryAst,
  queryAstSchema,
  safeParseQueryAst,
} from "../src/index.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

const emptyGroup = { type: "group", logic: "and" as const, children: [] };

function wrap(condition: unknown) {
  return {
    version: 2,
    scope: { type: "pages" },
    root: { type: "group", logic: "and", children: [condition] },
  };
}

describe("queryAstSchema v2", () => {
  it("accepts version 2 and rejects version 1 outright", () => {
    expect(queryAstSchema.safeParse(wrap({ type: "content", op: "exists" })).success).toBe(true);
    const v1 = queryAstSchema.safeParse({ ...wrap({ type: "contentSet" }), version: 1 });
    expect(v1.success).toBe(false);
  });

  it("parses a full AST with sort and aggregation", () => {
    const ast = {
      version: 2,
      scope: { type: "subtree", pageId: ID_A },
      root: {
        type: "group",
        logic: "or",
        children: [
          { type: "content", op: "contains", value: "hello" },
          {
            type: "not",
            child: { type: "name", op: "eq", value: "draft" },
          },
        ],
      },
      sort: [{ field: "name", dir: "asc" }],
      aggregation: { dimensions: [{ kind: "isClass" }], measures: [{ function: "count" }] },
    };
    expect(queryAstSchema.safeParse(ast).success).toBe(true);
  });

  it("exposes parseQueryAst / safeParseQueryAst", () => {
    const ast = parseQueryAst(wrap({ type: "content", op: "exists" }));
    expect(ast.version).toBe(2);
    expect(safeParseQueryAst(wrap({ type: "content", op: "exists" })).success).toBe(true);
    expect(() => parseQueryAst(wrap({ type: "class", classId: ID_A }))).toThrow();
  });
});

describe("member condition", () => {
  const families = [
    "class",
    "tags",
    "links",
    "referencePath",
    "parent",
    "child",
    "childPath",
    "page",
    "parentPath",
    "root",
  ] as const;

  it("round-trips in/not-in over all three target modes, for every family", () => {
    const targets = [
      { mode: "ids", ids: [ID_A, ID_B] },
      { mode: "query", root: emptyGroup },
      { mode: "self" },
    ];
    for (const family of families) {
      for (const op of ["in", "not-in"] as const) {
        for (const target of targets) {
          const condition = { type: "member", family, op, target };
          const parsed = conditionSchema.safeParse(condition);
          expect(parsed.success, JSON.stringify(condition)).toBe(true);
          expect(parsed.success && parsed.data).toEqual(condition);
        }
      }
    }
  });

  it("round-trips exists / not-exists with no target, for every family", () => {
    for (const family of families) {
      for (const op of ["exists", "not-exists"] as const) {
        const condition = { type: "member", family, op };
        const parsed = conditionSchema.safeParse(condition);
        expect(parsed.success, JSON.stringify(condition)).toBe(true);
        expect(parsed.success && parsed.data).toEqual(condition);
      }
    }
  });

  it("accepts class exact with a single class id", () => {
    const condition = {
      type: "member",
      family: "class",
      op: "exact",
      target: { mode: "ids", ids: [ID_A] },
    };
    const parsed = conditionSchema.safeParse(condition);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(condition);
  });

  it("requires a target for in / not-in", () => {
    expect(
      conditionSchema.safeParse({ type: "member", family: "class", op: "in" }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({ type: "member", family: "tags", op: "not-in" }).success,
    ).toBe(false);
  });

  it("rejects a target on exists / not-exists", () => {
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "exists",
        target: { mode: "self" },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "links",
        op: "not-exists",
        target: { mode: "ids", ids: [ID_A] },
      }).success,
    ).toBe(false);
  });

  it("rejects exact on non-class families", () => {
    for (const family of families.filter((f) => f !== "class")) {
      expect(
        conditionSchema.safeParse({
          type: "member",
          family,
          op: "exact",
          target: { mode: "ids", ids: [ID_A] },
        }).success,
        family,
      ).toBe(false);
    }
  });

  it("rejects exact with zero or multiple ids, or a non-ids target", () => {
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "exact",
        target: { mode: "ids", ids: [ID_A, ID_B] },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "exact",
        target: { mode: "ids", ids: [] },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "exact",
        target: { mode: "self" },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown family / op / target mode", () => {
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "siblings",
        op: "in",
        target: { mode: "ids", ids: [ID_A] },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "overlaps",
        target: { mode: "ids", ids: [ID_A] },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "in",
        target: { mode: "every" },
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "in",
        target: { mode: "ids", ids: ["not-a-uuid"] },
      }).success,
    ).toBe(false);
  });

  it("round-trips nested query targets with conditions inside", () => {
    const condition = {
      type: "member",
      family: "links",
      op: "in",
      target: {
        mode: "query",
        root: {
          type: "group",
          logic: "and",
          children: [
            {
              type: "member",
              family: "class",
              op: "in",
              target: { mode: "ids", ids: [ID_C] },
            },
          ],
        },
      },
    };
    const parsed = conditionSchema.safeParse(condition);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(condition);
  });
});

describe("content / name / property / date / nodeField conditions", () => {
  it("content: ops plus the folded exists, value required to be a non-empty string when present", () => {
    for (const op of ["contains", "fts", "eq", "neq", "starts", "ends", "exists"] as const) {
      const condition = { type: "content", op };
      expect(conditionSchema.safeParse(condition).success, op).toBe(true);
    }
    expect(conditionSchema.safeParse({ type: "content", op: "contains", value: "x" }).success).toBe(true);
    expect(conditionSchema.safeParse({ type: "content", op: "contains" }).success).toBe(true);
    expect(conditionSchema.safeParse({ type: "content", op: "matches" }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "content", op: "exists", value: 4 }).success).toBe(false);
  });

  it("name: unchanged operator set", () => {
    for (const op of ["eq", "neq", "contains", "exists"] as const) {
      expect(conditionSchema.safeParse({ type: "name", op }).success, op).toBe(true);
      expect(conditionSchema.safeParse({ type: "name", op, value: "x" }).success, op).toBe(true);
    }
    expect(conditionSchema.safeParse({ type: "name", op: "starts", value: "x" }).success).toBe(false);
  });

  it("property: base ops plus folded between/within", () => {
    for (const op of ["eq", "neq", "contains", "exists", "gt", "gte", "lt", "lte", "between", "within"] as const) {
      expect(conditionSchema.safeParse({ type: "property", schemaId: ID_A, op }).success, op).toBe(true);
    }
    const full = {
      type: "property",
      schemaId: ID_A,
      op: "between",
      from: 1,
      to: 10,
      includeDefaults: false,
    };
    expect(conditionSchema.safeParse(full).success).toBe(true);
    const within = { type: "property", schemaId: ID_A, op: "within", period: "this_week" };
    expect(conditionSchema.safeParse(within).success).toBe(true);
    expect(conditionSchema.safeParse({ type: "property", schemaId: ID_A, op: "overlaps" }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "property", schemaId: "nope", op: "eq" }).success).toBe(false);
  });

  it("date: created/updated fields over the full 10-op set", () => {
    const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "after", "before", "between", "within"] as const;
    for (const field of ["created", "updated"] as const) {
      for (const op of ops) {
        expect(conditionSchema.safeParse({ type: "date", field, op, timestamp: "2026-01-01" }).success, `${field}.${op}`).toBe(true);
      }
      expect(
        conditionSchema.safeParse({ type: "date", field, op: "between", from: "a", to: "b" }).success,
      ).toBe(true);
      expect(
        conditionSchema.safeParse({ type: "date", field, op: "within", period: "today" }).success,
      ).toBe(true);
      expect(conditionSchema.safeParse({ type: "date", field, op: "since" }).success).toBe(false);
    }
    expect(
      conditionSchema.safeParse({ type: "date", field: "deleted", op: "eq", timestamp: "x" }).success,
    ).toBe(false);
  });

  it("nodeField: the five wire fields; isClass/isEmbedded ride eq with boolean strings", () => {
    for (const field of ["coverAsset", "bannerAsset", "aliasedNode"] as const) {
      for (const op of ["eq", "neq", "exists"] as const) {
        expect(conditionSchema.safeParse({ type: "nodeField", field, op }).success, `${field}.${op}`).toBe(true);
        expect(conditionSchema.safeParse({ type: "nodeField", field, op, value: ID_A }).success, `${field}.${op}`).toBe(true);
      }
    }
    for (const field of ["isClass", "isEmbedded"] as const) {
      expect(
        conditionSchema.safeParse({ type: "nodeField", field, op: "eq", value: "true" }).success,
        `${field}.true`,
      ).toBe(true);
      expect(
        conditionSchema.safeParse({ type: "nodeField", field, op: "eq", value: "false" }).success,
        `${field}.false`,
      ).toBe(true);
    }
    expect(conditionSchema.safeParse({ type: "nodeField", field: "icon", op: "eq" }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "nodeField", field: "isClass", op: "gt", value: "true" }).success).toBe(false);
  });
});

describe("strictness", () => {
  it("rejects unknown condition types and stray keys", () => {
    expect(conditionSchema.safeParse({ type: "class", classId: ID_A }).success).toBe(false);
    expect(conditionSchema.safeParse({ type: "content", op: "contains", value: "x", extra: 1 }).success).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: "member",
        family: "class",
        op: "in",
        target: { mode: "ids", ids: [ID_A], also: true },
      }).success,
    ).toBe(false);
  });
});
