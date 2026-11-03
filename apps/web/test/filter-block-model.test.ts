/**
 * Filter-block model tests (v2): the operator column's value must always
 * read a member of the family register (a dropdown whose value is not among
 * its options renders blank), and an operator choice must respect the v2
 * orthogonality — a membership label flips ONLY `condition.op` (in ⇄
 * not-in) and carries the target VERBATIM (an ids list, a nested query, or
 * the self marker — the mode never changes under an operator flip); the set
 * bits re-materialize exists / not-exists. The v1 regression this guards:
 * the Child path operator went blank the moment the target mode left Manual,
 * and choosing "does not contain" on a dynamic/self row discarded the
 * subquery by morphing to a static shape.
 */

import { describe, expect, it } from "vitest";

import type { Condition, Group, MemberCondition, MemberFamily, TargetRef } from "@notees/query";

import type { BuilderFacts } from "../src/features/collection/builderFacts.js";
import {
  applyOperator,
  familyOf,
  FAMILY_OPTIONS,
  operatorOf,
  operatorOptions,
} from "../src/features/collection/filterBlockModel.js";

const facts = {
  classes: [],
  boundProperties: [
    { id: "text", name: "Text", type: "text", options: null, targetClassFilter: null },
    { id: "num", name: "Num", type: "number", options: null, targetClassFilter: null },
    { id: "date", name: "Date", type: "datetime", options: null, targetClassFilter: null },
  ],
  numericProperties: [],
  classNames: new Map<string, string>(),
  propertyNames: new Map<string, string>(),
} as unknown as BuilderFacts;

const emptyRoot: Group = { type: "group", logic: "and", children: [] };
const sampleRoot: Group = {
  type: "group",
  logic: "and",
  children: [{ type: "content", op: "contains", value: "x" }],
};

/** A member in-ids / in-query / in-self / exists condition per family. */
function mIn(family: MemberFamily, ids: string[] = ["n1"]): MemberCondition {
  return { type: "member", family, op: "in", target: { mode: "ids", ids } };
}
function mInQ(family: MemberFamily, root: Group = emptyRoot): MemberCondition {
  return { type: "member", family, op: "in", target: { mode: "query", root } };
}
function mSelf(family: MemberFamily): MemberCondition {
  return { type: "member", family, op: "in", target: { mode: "self" } };
}
function mExists(family: MemberFamily, negative = false): MemberCondition {
  return { type: "member", family, op: negative ? "not-exists" : "exists" };
}

/** Representative conditions across every family, every target mode, every op axis. */
const REPRESENTATIVE: Condition[] = [
  mIn("class", ["c1"]),
  mInQ("class"),
  mSelf("class"),
  mExists("class"),
  mExists("class", true),
  { type: "member", family: "class", op: "exact", target: { mode: "ids", ids: ["c1"] } },
  mIn("tags"),
  mInQ("tags"),
  mSelf("tags"),
  mExists("tags"),
  mExists("tags", true),
  mIn("links"),
  mInQ("links"),
  mSelf("links"),
  mExists("links"),
  mExists("links", true),
  mIn("referencePath"),
  mInQ("referencePath"),
  mSelf("referencePath"),
  mIn("parent"),
  mInQ("parent"),
  mSelf("parent"),
  mExists("parent"),
  mExists("parent", true),
  mIn("child"),
  mInQ("child"),
  mSelf("child"),
  mExists("child"),
  mExists("child", true),
  mIn("childPath"),
  mInQ("childPath"),
  mSelf("childPath"),
  mExists("childPath"),
  mExists("childPath", true),
  mIn("page"),
  mInQ("page"),
  mSelf("page"),
  mExists("page"),
  mExists("page", true),
  mIn("parentPath"),
  mInQ("parentPath"),
  mSelf("parentPath"),
  mExists("parentPath"),
  mExists("parentPath", true),
  mIn("root"),
  mInQ("root"),
  mSelf("root"),
  { type: "content", op: "contains", value: "x" },
  { type: "content", op: "exists" },
  { type: "name", op: "contains", value: "x" },
  { type: "nodeField", field: "isClass", op: "eq", value: "true" },
  { type: "nodeField", field: "isEmbedded", op: "eq", value: "false" },
  { type: "nodeField", field: "coverAsset", op: "exists" },
  { type: "nodeField", field: "bannerAsset", op: "exists" },
  { type: "nodeField", field: "aliasedNode", op: "exists" },
  { type: "date", field: "created", op: "eq", timestamp: "2026-01-01" },
  { type: "date", field: "created", op: "between", from: "2026-01-01", to: "2026-02-01" },
  { type: "date", field: "created", op: "within", period: "today" },
  { type: "date", field: "updated", op: "gt", timestamp: "2026-01-01" },
  { type: "property", schemaId: "text", op: "contains", value: "x" },
  { type: "property", schemaId: "text", op: "exists" },
  { type: "property", schemaId: "num", op: "between", from: "1", to: "2" },
  { type: "property", schemaId: "date", op: "within", period: "today" },
];

describe("operatorOf reads a member of the family register", () => {
  for (const condition of REPRESENTATIVE) {
    for (const negated of [false, true]) {
      it(`${condition.type}/${condition.type === "member" ? `${condition.family}.${condition.op}` : "…"}${negated ? " (negated)" : ""} renders an offered operator`, () => {
        const family = familyOf(condition);
        const offered = operatorOptions(family, condition, facts).map((option) => option.value);
        expect(offered).toContain(operatorOf(condition, negated));
      });
    }
  }

  it("every family option list is non-empty", () => {
    for (const { value } of FAMILY_OPTIONS) {
      expect(operatorOptions(value, undefined, facts).length).toBeGreaterThan(0);
    }
  });
});

describe("operator choice flips ONLY the op axis — the target rides verbatim", () => {
  const families: MemberFamily[] = [
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
  ];

  it("the negative label flips in → not-in, ids target carried verbatim", () => {
    for (const family of families) {
      const condition = mIn(family, ["n1", "n2"]);
      const negative =
        family === "class"
          ? "not-contains"
          : family === "child"
            ? "not-contains-any-of"
            : family === "childPath"
              ? "not-contains"
              : family === "referencePath"
                ? "is-not-any-of"
                : family === "parentPath"
                  ? "not-includes"
                  : "is-not";
      const result = applyOperator(condition, negative);
      expect(result, family).toEqual({ ...condition, op: "not-in" });
    }
  });

  it("the negative label on a QUERY-mode row preserves the nested query verbatim", () => {
    for (const family of families) {
      const condition = mInQ(family, sampleRoot);
      const negative =
        family === "class"
          ? "not-contains"
          : family === "child"
            ? "not-contains-any-of"
            : family === "childPath"
              ? "not-contains"
              : family === "referencePath"
                ? "is-not-any-of"
                : family === "parentPath"
                  ? "not-includes"
                  : "is-not";
      const result = applyOperator(condition, negative);
      // Wire-level negation — NOT a group wrapper, the target untouched.
      expect(result, family).toEqual({ ...condition, op: "not-in" });
    }
  });

  it("the negative label on a SELF-mode row preserves the self marker verbatim", () => {
    for (const family of families) {
      const condition = mSelf(family);
      const negative =
        family === "class"
          ? "is-not"
          : family === "child"
            ? "not-contains-any-of"
            : family === "childPath"
              ? "not-contains"
              : family === "referencePath"
                ? "is-not-any-of"
                : family === "parentPath"
                  ? "not-includes"
                  : "is-not";
      expect(applyOperator(condition, negative), family).toEqual({ ...condition, op: "not-in" });
    }
  });

  it("the positive label flips not-in → in, target carried verbatim", () => {
    const query: MemberCondition = {
      type: "member",
      family: "links",
      op: "not-in",
      target: { mode: "query", root: sampleRoot },
    };
    expect(applyOperator(query, "is")).toEqual({ ...query, op: "in" });
  });

  it("the set bits re-materialize exists / not-exists (no target at all)", () => {
    const query: MemberCondition = {
      type: "member",
      family: "childPath",
      op: "in",
      target: { mode: "query", root: sampleRoot },
    };
    expect(applyOperator(query, "set")).toEqual({
      type: "member",
      family: "childPath",
      op: "exists",
    });
    expect(applyOperator(query, "not-set")).toEqual({
      type: "member",
      family: "childPath",
      op: "not-exists",
    });
  });

  it("flipping back from a set bit re-materializes an in over an empty ids pick", () => {
    const set: MemberCondition = { type: "member", family: "links", op: "exists" };
    expect(applyOperator(set, "is")).toEqual({
      type: "member",
      family: "links",
      op: "in",
      target: { mode: "ids", ids: [] },
    });
    const notSet: MemberCondition = { type: "member", family: "links", op: "not-exists" };
    expect(applyOperator(notSet, "is")).toEqual({
      type: "member",
      family: "links",
      op: "not-in",
      target: { mode: "ids", ids: [] },
    });
  });

  it("class is / is-not bind the same in op as contains (the single/list split collapsed)", () => {
    const condition = mIn("class", ["c1"]);
    expect(applyOperator(condition, "is")).toEqual({ ...condition, op: "in" });
    expect(applyOperator(condition, "is-not")).toEqual({ ...condition, op: "not-in" });
  });

  it("the Manual ids carry across the membership flips", () => {
    const condition = mIn("childPath", ["n1", "n2"]);
    const negated = applyOperator(condition, "not-contains");
    expect(negated).toEqual({ ...condition, op: "not-in" });
  });
});

describe("operatorOf reads the canonical membership label per family", () => {
  it("class reads contains / not-contains; parent reads is / is-not; parentPath reads includes / not-includes", () => {
    expect(operatorOf(mIn("class"), false)).toBe("contains");
    expect(operatorOf({ ...mIn("class"), op: "not-in" } as Condition, false)).toBe("not-contains");
    expect(operatorOf(mIn("parent"), false)).toBe("is");
    expect(operatorOf({ ...mIn("parent"), op: "not-in" } as Condition, false)).toBe("is-not");
    expect(operatorOf(mIn("parentPath"), false)).toBe("includes");
    expect(operatorOf({ ...mIn("parentPath"), op: "not-in" } as Condition, false)).toBe("not-includes");
  });

  it("a not-wrapped membership reads its negative value (raw-AST sugar)", () => {
    const view = { type: "not" as const, child: mIn("links") };
    expect(operatorOf(view.child, true)).toBe("is-not");
  });

  it("the wire not-exists reads not-set; a NOT-wrapped exists reads not-set", () => {
    expect(operatorOf(mExists("class", true), false)).toBe("not-set");
    expect(operatorOf(mExists("class"), true)).toBe("not-set");
    expect(operatorOf(mExists("class"), false)).toBe("set");
  });
});

describe("the reported scenario end to end at the model level", () => {
  it("child path contains / does not contain a node matching a subquery", () => {
    // Inner: a node whose links list contains (query) class fuente.
    const inner: Condition = {
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
              target: { mode: "ids", ids: ["fuente"] },
            },
          ],
        },
      },
    };
    // Outer positive: my child path contains such a node.
    const positive: Condition = {
      type: "member",
      family: "childPath",
      op: "in",
      target: { mode: "query", root: { type: "group", logic: "and", children: [inner] } },
    };
    expect(operatorOf(positive, false)).toBe("contains");
    expect(applyOperator(positive, "not-contains")).toEqual({ ...positive, op: "not-in" });
    // Flipping back renders the positive operator again.
    const negated = applyOperator(positive, "not-contains");
    expect(negated.type).toBe("member");
    expect(operatorOf(negated as Condition, false)).toBe("not-contains");
    expect(applyOperator(negated as Condition, "contains")).toEqual(positive);
  });
});
