/**
 * The pure v1→v2 query-AST mapping (`scripts/lib/map-query-ast-v1-v2.ts`).
 *
 * Table-driven over EVERY v1 condition variant (the former 64-type flat
 * union — 63 concrete members, `name` is the identity map): each must land
 * on its exact v2 image per the design's mapping table, the output must
 * validate against the BUILT v2 `queryAstSchema` (protocol dist — dev-
 * condition exports law), `not` wrappers and nested query trees must be
 * preserved, and garbage must fail loud with the offending path.
 */

import { describe, expect, it } from "vitest";

import { queryAstSchema } from "../dist/index.js";
import {
  isQueryAstV1,
  mapQueryAstV1ToV2,
  QueryAstV1MapError,
} from "../../../scripts/lib/map-query-ast-v1-v2.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

const nestedGroup = {
  type: "group",
  logic: "and",
  children: [{ type: "content", op: "contains", value: "seed" }],
};

const inIds = (family: string, ids: string[]) => ({
  type: "member",
  family,
  op: "in",
  target: { mode: "ids", ids },
});
const inQuery = (family: string, root: unknown) => ({
  type: "member",
  family,
  op: "in",
  target: { mode: "query", root },
});
const inSelf = (family: string) => ({ type: "member", family, op: "in", target: { mode: "self" } });
const exists = (family: string) => ({ type: "member", family, op: "exists" });

/** Every v1 condition variant → its exact v2 image. */
const CASES: { name: string; v1: Record<string, unknown>; v2: Record<string, unknown> }[] = [
  // member — class family
  { name: "class", v1: { type: "class", classId: ID_A }, v2: inIds("class", [ID_A]) },
  { name: "classAny", v1: { type: "classAny", classIds: [ID_A, ID_B] }, v2: inIds("class", [ID_A, ID_B]) },
  { name: "classAnyQuery", v1: { type: "classAnyQuery", root: nestedGroup }, v2: inQuery("class", nestedGroup) },
  { name: "classSelf", v1: { type: "classSelf" }, v2: inSelf("class") },
  { name: "classSet", v1: { type: "classSet" }, v2: exists("class") },
  {
    name: "classExact",
    v1: { type: "classExact", classId: ID_A },
    v2: { type: "member", family: "class", op: "exact", target: { mode: "ids", ids: [ID_A] } },
  },
  // member — tags family
  { name: "tag", v1: { type: "tag", tagId: ID_A }, v2: inIds("tags", [ID_A]) },
  { name: "tagAny", v1: { type: "tagAny", tagIds: [ID_A, ID_B] }, v2: inIds("tags", [ID_A, ID_B]) },
  { name: "tagAnyQuery", v1: { type: "tagAnyQuery", root: nestedGroup }, v2: inQuery("tags", nestedGroup) },
  { name: "tagSelf", v1: { type: "tagSelf" }, v2: inSelf("tags") },
  { name: "tagSet", v1: { type: "tagSet" }, v2: exists("tags") },
  // member — links family
  { name: "linkedTo", v1: { type: "linkedTo", nodeId: ID_A }, v2: inIds("links", [ID_A]) },
  { name: "linkedToAny", v1: { type: "linkedToAny", nodeIds: [ID_A, ID_B] }, v2: inIds("links", [ID_A, ID_B]) },
  { name: "linkedToQuery", v1: { type: "linkedToQuery", root: nestedGroup }, v2: inQuery("links", nestedGroup) },
  { name: "linkedToSelf", v1: { type: "linkedToSelf" }, v2: inSelf("links") },
  { name: "linkSet", v1: { type: "linkSet" }, v2: exists("links") },
  // member — referencePath family
  { name: "referencePathOf", v1: { type: "referencePathOf", nodeIds: [ID_A, ID_B] }, v2: inIds("referencePath", [ID_A, ID_B]) },
  { name: "referencePathOfQuery", v1: { type: "referencePathOfQuery", root: nestedGroup }, v2: inQuery("referencePath", nestedGroup) },
  { name: "referencePathOfSelf", v1: { type: "referencePathOfSelf" }, v2: inSelf("referencePath") },
  // member — parent family
  { name: "parentOf", v1: { type: "parentOf", nodeIds: [ID_A, ID_B] }, v2: inIds("parent", [ID_A, ID_B]) },
  { name: "parentOfQuery", v1: { type: "parentOfQuery", root: nestedGroup }, v2: inQuery("parent", nestedGroup) },
  { name: "parentOfSelf", v1: { type: "parentOfSelf" }, v2: inSelf("parent") },
  { name: "parentSet", v1: { type: "parentSet" }, v2: exists("parent") },
  // member — child family
  { name: "childOf", v1: { type: "childOf", nodeIds: [ID_A, ID_B] }, v2: inIds("child", [ID_A, ID_B]) },
  { name: "childOfQuery", v1: { type: "childOfQuery", root: nestedGroup }, v2: inQuery("child", nestedGroup) },
  { name: "childOfSelf", v1: { type: "childOfSelf" }, v2: inSelf("child") },
  { name: "childSet", v1: { type: "childSet" }, v2: exists("child") },
  // member — childPath family
  { name: "descendantOf", v1: { type: "descendantOf", nodeId: ID_A }, v2: inIds("childPath", [ID_A]) },
  { name: "descendantOfAny", v1: { type: "descendantOfAny", nodeIds: [ID_A, ID_B] }, v2: inIds("childPath", [ID_A, ID_B]) },
  { name: "descendantOfQuery", v1: { type: "descendantOfQuery", root: nestedGroup }, v2: inQuery("childPath", nestedGroup) },
  { name: "descendantOfSelf", v1: { type: "descendantOfSelf" }, v2: inSelf("childPath") },
  { name: "descendantSet", v1: { type: "descendantSet" }, v2: exists("childPath") },
  // member — page family
  { name: "pageOf", v1: { type: "pageOf", nodeIds: [ID_A, ID_B] }, v2: inIds("page", [ID_A, ID_B]) },
  { name: "pageOfQuery", v1: { type: "pageOfQuery", root: nestedGroup }, v2: inQuery("page", nestedGroup) },
  { name: "pageOfSelf", v1: { type: "pageOfSelf" }, v2: inSelf("page") },
  { name: "pageSet", v1: { type: "pageSet" }, v2: exists("page") },
  // member — parentPath family
  { name: "ancestorIn", v1: { type: "ancestorIn", nodeIds: [ID_A, ID_B] }, v2: inIds("parentPath", [ID_A, ID_B]) },
  { name: "ancestorInQuery", v1: { type: "ancestorInQuery", root: nestedGroup }, v2: inQuery("parentPath", nestedGroup) },
  { name: "ancestorInSelf", v1: { type: "ancestorInSelf" }, v2: inSelf("parentPath") },
  // member — root family
  { name: "rootIn", v1: { type: "rootIn", nodeIds: [ID_A, ID_B] }, v2: inIds("root", [ID_A, ID_B]) },
  { name: "rootInQuery", v1: { type: "rootInQuery", root: nestedGroup }, v2: inQuery("root", nestedGroup) },
  { name: "rootInSelf", v1: { type: "rootInSelf" }, v2: inSelf("root") },
  // content / name
  { name: "content", v1: { type: "content", op: "contains", value: "hi" }, v2: { type: "content", op: "contains", value: "hi" } },
  { name: "contentSet", v1: { type: "contentSet" }, v2: { type: "content", op: "exists" } },
  { name: "name", v1: { type: "name", op: "eq", value: "x" }, v2: { type: "name", op: "eq", value: "x" } },
  // property
  { name: "property", v1: { type: "property", schemaId: ID_A, op: "gt", value: 3, includeDefaults: false }, v2: { type: "property", schemaId: ID_A, op: "gt", value: 3, includeDefaults: false } },
  { name: "propertyBetween", v1: { type: "propertyBetween", schemaId: ID_A, from: 1, to: 9 }, v2: { type: "property", schemaId: ID_A, op: "between", from: 1, to: 9 } },
  { name: "propertyWithin", v1: { type: "propertyWithin", schemaId: ID_A, period: "this_month" }, v2: { type: "property", schemaId: ID_A, op: "within", period: "this_month" } },
  // date (created / updated × After / Before / Cmp / Between / Within)
  { name: "createdAfter", v1: { type: "createdAfter", timestamp: "2026-01-01" }, v2: { type: "date", field: "created", op: "after", timestamp: "2026-01-01" } },
  { name: "createdBefore", v1: { type: "createdBefore", timestamp: "2026-01-01" }, v2: { type: "date", field: "created", op: "before", timestamp: "2026-01-01" } },
  { name: "createdCmp", v1: { type: "createdCmp", op: "gte", timestamp: "2026-01-01" }, v2: { type: "date", field: "created", op: "gte", timestamp: "2026-01-01" } },
  { name: "createdBetween", v1: { type: "createdBetween", from: "a", to: "b" }, v2: { type: "date", field: "created", op: "between", from: "a", to: "b" } },
  { name: "createdWithin", v1: { type: "createdWithin", period: "today" }, v2: { type: "date", field: "created", op: "within", period: "today" } },
  { name: "updatedAfter", v1: { type: "updatedAfter", timestamp: "2026-01-01" }, v2: { type: "date", field: "updated", op: "after", timestamp: "2026-01-01" } },
  { name: "updatedBefore", v1: { type: "updatedBefore", timestamp: "2026-01-01" }, v2: { type: "date", field: "updated", op: "before", timestamp: "2026-01-01" } },
  { name: "updatedCmp", v1: { type: "updatedCmp", op: "lt", timestamp: "2026-01-01" }, v2: { type: "date", field: "updated", op: "lt", timestamp: "2026-01-01" } },
  { name: "updatedBetween", v1: { type: "updatedBetween", from: "a", to: "b" }, v2: { type: "date", field: "updated", op: "between", from: "a", to: "b" } },
  { name: "updatedWithin", v1: { type: "updatedWithin", period: "this_year" }, v2: { type: "date", field: "updated", op: "within", period: "this_year" } },
  // node fields
  { name: "isClass", v1: { type: "isClass", isClass: true }, v2: { type: "nodeField", field: "isClass", op: "eq", value: "true" } },
  { name: "isClass false", v1: { type: "isClass", isClass: false }, v2: { type: "nodeField", field: "isClass", op: "eq", value: "false" } },
  { name: "isEmbedded", v1: { type: "isEmbedded", isEmbedded: true }, v2: { type: "nodeField", field: "isEmbedded", op: "eq", value: "true" } },
  { name: "isEmbedded false", v1: { type: "isEmbedded", isEmbedded: false }, v2: { type: "nodeField", field: "isEmbedded", op: "eq", value: "false" } },
  { name: "coverAsset", v1: { type: "coverAsset", op: "eq", value: ID_A }, v2: { type: "nodeField", field: "coverAsset", op: "eq", value: ID_A } },
  { name: "bannerAsset", v1: { type: "bannerAsset", op: "exists" }, v2: { type: "nodeField", field: "bannerAsset", op: "exists" } },
  { name: "aliasedNode", v1: { type: "aliasedNode", op: "neq", value: ID_B }, v2: { type: "nodeField", field: "aliasedNode", op: "neq", value: ID_B } },
];

function v1Ast(child: unknown) {
  return {
    version: 1,
    scope: { type: "pages" },
    root: { type: "group", logic: "and", children: [child] },
  };
}

function v2Ast(child: unknown) {
  return {
    version: 2,
    scope: { type: "pages" },
    root: { type: "group", logic: "and", children: [child] },
  };
}

describe("mapQueryAstV1ToV2 — every v1 variant", () => {
  for (const { name, v1, v2 } of CASES) {
    it(`maps ${name}`, () => {
      expect(mapQueryAstV1ToV2(v1Ast(v1))).toEqual(v2Ast(v2));
    });

    it(`output for ${name} validates against the built v2 schema`, () => {
      const mapped = mapQueryAstV1ToV2(v1Ast(v1));
      const parsed = queryAstSchema.safeParse(mapped);
      expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    });
  }
});

describe("mapQueryAstV1ToV2 — structure", () => {
  it("preserves not wrappers around conditions and groups", () => {
    const v1 = v1Ast({
      type: "not",
      child: { type: "group", logic: "or", children: [{ type: "classSet" }] },
    });
    expect(mapQueryAstV1ToV2(v1)).toEqual(
      v2Ast({
        type: "not",
        child: { type: "group", logic: "or", children: [exists("class")] },
      }),
    );
  });

  it("maps nested member-in-query trees recursively", () => {
    const v1 = v1Ast({
      type: "classAnyQuery",
      root: {
        type: "group",
        logic: "and",
        children: [
          {
            type: "not",
            child: {
              type: "tagAnyQuery",
              root: {
                type: "group",
                logic: "or",
                children: [
                  { type: "linkedToSelf" },
                  { type: "descendantOfAny", nodeIds: [ID_C] },
                ],
              },
            },
          },
        ],
      },
    });
    expect(mapQueryAstV1ToV2(v1)).toEqual(
      v2Ast(
        inQuery("class", {
          type: "group",
          logic: "and",
          children: [
            {
              type: "not",
              child: inQuery("tags", {
                type: "group",
                logic: "or",
                children: [inSelf("links"), inIds("childPath", [ID_C])],
              }),
            },
          ],
        }),
      ),
    );
  });

  it("passes scope, sort, and aggregation through unchanged", () => {
    const v1 = {
      version: 1,
      scope: { type: "subtree", pageId: ID_A },
      root: { type: "group", logic: "or", children: [] },
      sort: [{ field: "createdAt", dir: "desc" }],
      aggregation: { dimensions: [{ kind: "class", id: ID_B }], measures: [{ function: "count" }] },
    };
    expect(mapQueryAstV1ToV2(v1)).toEqual({
      version: 2,
      scope: { type: "subtree", pageId: ID_A },
      root: { type: "group", logic: "or", children: [] },
      sort: [{ field: "createdAt", dir: "desc" }],
      aggregation: { dimensions: [{ kind: "class", id: ID_B }], measures: [{ function: "count" }] },
    });
  });

  it("does not alias the input", () => {
    const v1 = v1Ast({ type: "classAny", classIds: [ID_A] });
    const mapped = mapQueryAstV1ToV2(v1) as { root: { children: unknown[] } };
    expect(mapped.root.children[0]).not.toBe((v1.root.children as unknown[])[0]);
  });
});

describe("mapQueryAstV1ToV2 — fail loud", () => {
  it("throws QueryAstV1MapError naming the offending type and path", () => {
    const garbage = v1Ast({ type: "siblingsOf", nodeIds: [ID_A] });
    let caught: unknown;
    try {
      mapQueryAstV1ToV2(garbage);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryAstV1MapError);
    expect((caught as QueryAstV1MapError).message).toContain("siblingsOf");
    expect((caught as QueryAstV1MapError).message).toContain("root.children[0]");
  });

  it.each([
    ["non-object input", 42],
    ["null input", null],
    ["missing version", { scope: { type: "pages" }, root: { type: "group" } }],
    ["v2 input", v2Ast({ type: "content", op: "exists" })],
    ["other versions", { version: 3, scope: { type: "pages" }, root: { type: "group", logic: "and", children: [] } }],
    ["root is not a group", { version: 1, scope: { type: "pages" }, root: { type: "leaf" } }],
    ["group child without a type", { version: 1, scope: { type: "pages" }, root: { type: "group", logic: "and", children: [{}] } }],
    ["condition missing its id", v1Ast({ type: "class" })],
    ["query target root not a group", v1Ast({ type: "classAnyQuery", root: { type: "leaf" } })],
  ])("throws on %s", (_name, input) => {
    expect(() => mapQueryAstV1ToV2(input)).toThrow(QueryAstV1MapError);
  });
});

describe("isQueryAstV1", () => {
  it("accepts v1 ASTs and rejects everything else", () => {
    expect(isQueryAstV1(v1Ast({ type: "classSet" }))).toBe(true);
    expect(isQueryAstV1(v2Ast({ type: "content", op: "exists" }))).toBe(false);
    expect(isQueryAstV1({ version: 1 })).toBe(false);
    expect(isQueryAstV1(null)).toBe(false);
    expect(isQueryAstV1("ast")).toBe(false);
  });
});
