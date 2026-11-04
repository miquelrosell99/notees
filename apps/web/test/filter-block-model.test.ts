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

import type { Child, Condition, Group, MemberCondition, MemberFamily, TargetRef } from "@notees/query";

import type { BuilderFacts } from "../src/features/collection/builderFacts.js";
import type { ConditionKind } from "../src/features/collection/filterQuery.js";
import {
  applyBooleanValue,
  applyOperator,
  blockView,
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
    { id: "bool", name: "Bool", type: "boolean", options: null, targetClassFilter: null },
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
  // The boolean rows (Type/Placement) ride a single value selector — no
  // operator column at all (the owner's register ruling: the non-nullable
  // wire booleans make is/is-not redundant with the value). Their option
  // list is empty by contract; every OTHER family renders an operator that
  // is a member of its offered list.
  const NO_OPERATOR_COLUMN: readonly ConditionKind[] = ["type", "placement"];

  for (const condition of REPRESENTATIVE) {
    for (const negated of [false, true]) {
      it(`${condition.type}/${condition.type === "member" ? `${condition.family}.${condition.op}` : "…"}${negated ? " (negated)" : ""} renders an offered operator`, () => {
        const family = familyOf(condition);
        const offered = operatorOptions(family, condition, facts).map((option) => option.value);
        if (NO_OPERATOR_COLUMN.includes(family)) {
          expect(offered, family).toEqual([]);
          return;
        }
        expect(offered).toContain(operatorOf(condition, negated));
      });
    }
  }

  it("every family option list is non-empty (except the single-selector boolean rows)", () => {
    for (const { value } of FAMILY_OPTIONS) {
      if (NO_OPERATOR_COLUMN.includes(value)) continue;
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

// --- the coupling matrix -------------------------------------------------------------
//
// The two selector columns of every filter row are ORTHOGONAL: an operator
// choice touches only the polarity/op axis (the value payload rides across
// it), and a value write touches only the value axis (the operator read and
// the not-wrap polarity hold). Where the register is intentionally
// single-axis (boolean properties — the value IS the predicate; the
// cover/banner/alias set bits — no value column exists), the intended
// behavior is pinned by a named test so the distinction stays documented.

/** Mirror of the BlockRow's operator-column onChange (FilterBlockBuilder.tsx). */
function rowApplyOperator(child: Child, op: string): Child {
  const view = blockView(child);
  if (view === null) throw new Error("not a single-condition block row");
  return applyOperator(view.condition, op);
}

/** Mirror of the BlockRow's BlockValue onChange (FilterBlockBuilder.tsx). */
function rowApplyValue(child: Child, next: Condition): Child {
  const view = blockView(child);
  if (view === null) throw new Error("not a single-condition block row");
  return view.negated ? { type: "not", child: next } : next;
}

/** The operator read a row renders (blockView unwrap + operatorOf). */
function rowOperatorOf(child: Child): string {
  const view = blockView(child);
  if (view === null) throw new Error("not a single-condition block row");
  return operatorOf(view.condition, view.negated);
}

describe("coupling audit — an operator choice never mutates the value payload", () => {
  const MEMBER_FAMILIES: MemberFamily[] = [
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

  it("member (all ten families): every offered operator keeps the picked ids verbatim or swaps to the set shape", () => {
    for (const family of MEMBER_FAMILIES) {
      const ids = mIn(family, ["n1", "n2"]) as Extract<MemberCondition, { target: TargetRef }>;
      for (const { value: op } of operatorOptions(family, ids, facts)) {
        const result = applyOperator(ids, op);
        if (op === "set") {
          expect(result, `${family}/${op}`).toEqual({ type: "member", family, op: "exists" });
          continue;
        }
        if (op === "not-set") {
          expect(result, `${family}/${op}`).toEqual({ type: "member", family, op: "not-exists" });
          continue;
        }
        // A membership label flips only the wire op — the target rides verbatim.
        const r = result as Extract<MemberCondition, { target: TargetRef }>;
        expect(r.family, `${family}/${op}`).toBe(family);
        expect(["in", "not-in"], `${family}/${op}`).toContain(r.op);
        expect(r.target, `${family}/${op}`).toEqual(ids.target);
      }
    }
  });

  it("content: the text rides every text operator; the negatives wrap with the text inside", () => {
    const text: Condition = { type: "content", op: "contains", value: "hello" };
    expect(applyOperator(text, "is")).toEqual({ type: "content", op: "eq", value: "hello" });
    expect(applyOperator(text, "is-not")).toEqual({
      type: "not",
      child: { type: "content", op: "eq", value: "hello" },
    });
    expect(applyOperator(text, "contains")).toEqual(text);
    expect(applyOperator(text, "not-contains")).toEqual({ type: "not", child: text });
    expect(applyOperator(text, "starts")).toEqual({ type: "content", op: "starts", value: "hello" });
    expect(applyOperator(text, "ends")).toEqual({ type: "content", op: "ends", value: "hello" });
    expect(applyOperator(text, "fts")).toEqual({ type: "content", op: "fts", value: "hello" });
    expect(applyOperator(text, "set")).toEqual({ type: "content", op: "exists" });
    expect(applyOperator(text, "not-set")).toEqual({
      type: "not",
      child: { type: "content", op: "exists" },
    });
  });

  it("name: the title text rides the eq/contains flips; the negative wraps with the text inside", () => {
    const title: Condition = { type: "name", op: "contains", value: "hello" };
    expect(applyOperator(title, "is")).toEqual({ type: "name", op: "eq", value: "hello" });
    expect(applyOperator(title, "is-not")).toEqual({
      type: "not",
      child: { type: "name", op: "eq", value: "hello" },
    });
    expect(applyOperator(title, "contains")).toEqual(title);
    expect(applyOperator(title, "not-contains")).toEqual({ type: "not", child: title });
  });

  it("property (scalar): the value rides eq/neq/contains/the comparators; not-contains wraps with it", () => {
    const prop: Condition = { type: "property", schemaId: "text", op: "contains", value: "abc" };
    expect(applyOperator(prop, "eq")).toEqual({ type: "property", schemaId: "text", op: "eq", value: "abc" });
    expect(applyOperator(prop, "neq")).toEqual({ type: "property", schemaId: "text", op: "neq", value: "abc" });
    expect(applyOperator(prop, "contains")).toEqual(prop);
    expect(applyOperator(prop, "not-contains")).toEqual({ type: "not", child: prop });
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      expect(applyOperator(prop, op)).toEqual({ type: "property", schemaId: "text", op, value: "abc" });
    }
  });

  it("property (boolean): the is-true/is-false morphs SET the value and never wrap (Raw-AST arms — the register folded)", () => {
    const truthy: Condition = { type: "property", schemaId: "bool", op: "eq", value: true };
    expect(applyOperator(truthy, "is-true")).toEqual(truthy);
    expect(applyOperator(truthy, "is-false")).toEqual({
      type: "property",
      schemaId: "bool",
      op: "eq",
      value: false,
    });
    // The value IS the predicate: either choice yields a POSITIVE condition —
    // polarity never rides an is-true/is-false label.
    expect(applyOperator(truthy, "is-false").type).toBe("property");
    expect(applyOperator({ ...truthy, value: false }, "is-true").type).toBe("property");
  });

  it("property (bounds/period): re-picking between keeps both bounds; re-picking within keeps the period", () => {
    const between: Condition = { type: "property", schemaId: "num", op: "between", from: "1", to: "9" };
    expect(applyOperator(between, "between")).toEqual(between);
    const within: Condition = { type: "property", schemaId: "date", op: "within", period: "this_week" };
    expect(applyOperator(within, "within")).toEqual(within);
  });

  it("date: the timestamp rides is/is-not/the comparisons; between carries it into the range", () => {
    for (const field of ["created", "updated"] as const) {
      const stamp: Condition = { type: "date", field, op: "eq", timestamp: "2026-03-01" };
      expect(applyOperator(stamp, "is"), field).toEqual(stamp);
      expect(applyOperator(stamp, "is-not"), field).toEqual({
        type: "not",
        child: { type: "date", field, op: "eq", timestamp: "2026-03-01" },
      });
      for (const op of ["gt", "gte", "lt", "lte"] as const) {
        expect(applyOperator(stamp, op), `${field}/${op}`).toEqual({
          type: "date",
          field,
          op,
          timestamp: "2026-03-01",
        });
      }
      expect(applyOperator(stamp, "between"), field).toEqual({
        type: "date",
        field,
        op: "between",
        from: "2026-03-01",
        to: "2026-03-01",
      });
      const between: Condition = { type: "date", field, op: "between", from: "2026-01-01", to: "2026-02-01" };
      expect(applyOperator(between, "between"), field).toEqual(between);
      // The raw-AST ordering arms carry the timestamp too (DSL-parsed rows).
      const after: Condition = { type: "date", field, op: "after", timestamp: "2026-03-01" };
      expect(applyOperator(after, "before"), field).toEqual({
        type: "date",
        field,
        op: "before",
        timestamp: "2026-03-01",
      });
    }
  });

  it("nodeField cover/banner/alias — single-axis register: the set bits ARE the condition (no value column exists)", () => {
    for (const field of ["coverAsset", "bannerAsset", "aliasedNode"] as const) {
      const set: Condition = { type: "nodeField", field, op: "exists" };
      expect(applyOperator(set, "exists"), field).toEqual(set);
      expect(applyOperator(set, "not-exists"), field).toEqual({ type: "not", child: set });
    }
  });

  it("nodeField isClass/isEmbedded: an operator choice NEVER touches the boolean value", () => {
    for (const field of ["isClass", "isEmbedded"] as const) {
      for (const value of ["true", "false"] as const) {
        const role: Condition = { type: "nodeField", field, op: "eq", value };
        expect(applyOperator(role, "is"), `${field}/${value}`).toEqual(role);
        expect(applyOperator(role, "is-not"), `${field}/${value}`).toEqual({
          type: "not",
          child: role,
        });
      }
    }
  });
});

describe("coupling audit — a value write never mutates the operator/polarity", () => {
  it("member: retargeting the ids pick keeps the operator label at both polarities", () => {
    const child: Child = mIn("links", ["n1"]);
    const retargeted = rowApplyValue(child, mIn("links", ["n9", "n8"]));
    expect(rowOperatorOf(retargeted)).toBe(rowOperatorOf(child));
    const negated: Child = { type: "not", child: mIn("links", ["n1"]) };
    const negRetargeted = rowApplyValue(negated, mIn("links", ["n9"]));
    expect(negRetargeted).toEqual({
      type: "not",
      child: { type: "member", family: "links", op: "in", target: { mode: "ids", ids: ["n9"] } },
    });
    expect(rowOperatorOf(negRetargeted)).toBe(rowOperatorOf(negated));
  });

  it("content/name: retyping the text keeps the operator at both polarities", () => {
    const text: Child = { type: "content", op: "contains", value: "hello" };
    expect(rowOperatorOf(rowApplyValue(text, { ...text, value: "world" }))).toBe("contains");
    const negated: Child = { type: "not", child: { type: "content", op: "eq", value: "hello" } };
    expect(rowOperatorOf(rowApplyValue(negated, { type: "content", op: "eq", value: "world" }))).toBe("is-not");
    const title: Child = { type: "name", op: "eq", value: "hello" };
    expect(rowOperatorOf(rowApplyValue(title, { type: "name", op: "eq", value: "world" }))).toBe("is");
  });

  it("property (scalar): retyping the value keeps the op at both polarities", () => {
    const prop: Child = { type: "property", schemaId: "text", op: "gt", value: "1" };
    expect(rowOperatorOf(rowApplyValue(prop, { type: "property", schemaId: "text", op: "gt", value: "9" }))).toBe("gt");
    const negated: Child = { type: "not", child: { type: "property", schemaId: "text", op: "contains", value: "a" } };
    expect(
      rowOperatorOf(rowApplyValue(negated, { type: "property", schemaId: "text", op: "contains", value: "b" })),
    ).toBe("not-contains");
  });

  it("property (boolean): re-picking true/false moves the VALUE only — the operator column stays on the set axis", () => {
    const truthy: Child = { type: "property", schemaId: "bool", op: "eq", value: true };
    expect(rowOperatorOf(truthy)).toBe("set");
    // The value IS the predicate: a value write moves only the value; the
    // operator column holds the set axis (is-true ≡ set + true).
    expect(rowOperatorOf(rowApplyValue(truthy, { type: "property", schemaId: "bool", op: "eq", value: false }))).toBe("set");
    // The not-wrap polarity is the explicit axis (the operator reads not-set).
    const negated: Child = { type: "not", child: { type: "property", schemaId: "bool", op: "eq", value: true } };
    expect(rowOperatorOf(negated)).toBe("not-set");
    expect(rowOperatorOf(rowApplyValue(negated, { type: "property", schemaId: "bool", op: "eq", value: false }))).toBe("not-set");
  });

  it("date: retyping the timestamp keeps the operator at both polarities", () => {
    const stamp: Child = { type: "date", field: "created", op: "gt", timestamp: "2026-01-01" };
    expect(
      rowOperatorOf(rowApplyValue(stamp, { type: "date", field: "created", op: "gt", timestamp: "2026-06-01" })),
    ).toBe("gt");
    const negated: Child = { type: "not", child: { type: "date", field: "updated", op: "eq", timestamp: "2026-01-01" } };
    expect(
      rowOperatorOf(rowApplyValue(negated, { type: "date", field: "updated", op: "eq", timestamp: "2026-06-01" })),
    ).toBe("is-not");
  });

  it("nodeField isClass/isEmbedded: flipping the boolean keeps the operator read at both polarities", () => {
    for (const field of ["isClass", "isEmbedded"] as const) {
      const page: Child = { type: "nodeField", field, op: "eq", value: "false" };
      const block = rowApplyValue(page, { type: "nodeField", field, op: "eq", value: "true" });
      expect(rowOperatorOf(block), `${field} positive`).toBe(rowOperatorOf(page));
      const notPage: Child = { type: "not", child: { type: "nodeField", field, op: "eq", value: "false" } };
      const notBlock = rowApplyValue(notPage, { type: "nodeField", field, op: "eq", value: "true" });
      expect(rowOperatorOf(notBlock), `${field} negated`).toBe(rowOperatorOf(notPage));
    }
  });
});

describe("structural role (isEmbedded) / type (isClass): the not-wrap arms back Exclude (NOT) and Raw AST rows", () => {
  // The operator×value conflation fix made polarity and value independent;
  // the owner's register ruling then collapsed the row to a SINGLE value
  // selector (is/is-not is redundant with a non-nullable boolean). Negatives
  // remain reachable through the group-level Exclude (NOT) wrapper and Raw
  // AST pastes — these walks pin the applyOperator arms and the not-wrap
  // display path that back them.
  for (const field of ["isEmbedded", "isClass"] as const) {
    it(`${field}: is/page → is-not/page → is-not/block → is/block → is/page`, () => {
      const role = (value: "true" | "false"): Condition => ({
        type: "nodeField",
        field,
        op: "eq",
        value,
      });

      // is/page (the placement default; "false" = standalone).
      let child: Child = role("false");
      expect(rowOperatorOf(child)).toBe("is");
      expect(child).toEqual(role("false"));

      // → is-not/page: the operator choice wraps; the value HOLDS.
      child = rowApplyOperator(child, "is-not");
      expect(child).toEqual({ type: "not", child: role("false") });
      expect(rowOperatorOf(child)).toBe("is-not");

      // → is-not/block: the value choice flips only the boolean; the wrap HOLDS.
      child = rowApplyValue(child, role("true"));
      expect(child).toEqual({ type: "not", child: role("true") });
      expect(rowOperatorOf(child)).toBe("is-not");

      // → is/block: the operator choice unwraps; the value HOLDS.
      child = rowApplyOperator(child, "is");
      expect(child).toEqual(role("true"));
      expect(rowOperatorOf(child)).toBe("is");

      // → is/page: the value choice flips only the boolean; the polarity HOLDS.
      child = rowApplyValue(child, role("false"));
      expect(child).toEqual(role("false"));
      expect(rowOperatorOf(child)).toBe("is");
    });
  }
});

// --- the single-selector boolean register (the owner's ruling) -----------------------
//
// The wire booleans are non-nullable (the compiler's columns are
// nullable:false), so "is not block" ≡ "is page" — the two-axis register was
// semantically redundant. The builder now offers the values DIRECTLY in one
// selector; negatives remain reachable via group-level Exclude (NOT) and the
// Raw AST. Wire shapes unchanged.

describe("the boolean rows ride a single value selector (the owner's register ruling)", () => {
  it("structural role / type rows offer NO operator column at either value", () => {
    for (const family of ["type", "placement"] as const) {
      const field = family === "type" ? "isClass" : "isEmbedded";
      for (const value of ["true", "false"] as const) {
        const condition: Condition = { type: "nodeField", field, op: "eq", value };
        expect(operatorOptions(family, condition, facts), `${family}/${value}`).toEqual([]);
      }
    }
  });

  it("structural role: the value selector alone reaches Page and Block, stable both ways", () => {
    const role = (value: "true" | "false"): Condition => ({
      type: "nodeField",
      field: "isEmbedded",
      op: "eq",
      value,
    });
    // The placement default: Page ("false" = standalone).
    let child: Child = role("false");
    expect(rowOperatorOf(child)).toBe("is");
    expect(child).toEqual(role("false"));
    // → Block: the value write IS the whole predicate.
    child = rowApplyValue(child, role("true"));
    expect(child).toEqual(role("true"));
    expect(rowOperatorOf(child)).toBe("is");
    // → Page: back again, nothing else moves.
    child = rowApplyValue(child, role("false"));
    expect(child).toEqual(role("false"));
    expect(rowOperatorOf(child)).toBe("is");
  });

  it("type: the value selector alone reaches a-class and not-a-class", () => {
    const role = (value: "true" | "false"): Condition => ({
      type: "nodeField",
      field: "isClass",
      op: "eq",
      value,
    });
    let child: Child = role("true");
    expect(child).toEqual(role("true"));
    child = rowApplyValue(child, role("false"));
    expect(child).toEqual(role("false"));
    expect(rowOperatorOf(child)).toBe("is");
    child = rowApplyValue(child, role("true"));
    expect(child).toEqual(role("true"));
  });

  it("boolean property rows: the operator column offers ONLY is set / is not set", () => {
    const truthy: Condition = { type: "property", schemaId: "bool", op: "eq", value: true };
    expect(operatorOptions("property", truthy, facts).map((option) => option.value)).toEqual([
      "set",
      "not-set",
    ]);
    const exists: Condition = { type: "property", schemaId: "bool", op: "exists" };
    expect(operatorOptions("property", exists, facts).map((option) => option.value)).toEqual([
      "set",
      "not-set",
    ]);
    // The operator column reads the set axis at both polarities.
    expect(operatorOf(truthy, false)).toBe("set");
    expect(operatorOf(exists, false)).toBe("set");
    expect(operatorOf(exists, true)).toBe("not-set");
  });

  it("boolean property rows: is-true / is-false / is set / is not set are all reachable and stable", () => {
    type BoolProp = Extract<Condition, { type: "property" }>;
    const eq = (value: boolean): BoolProp => ({ type: "property", schemaId: "bool", op: "eq", value });
    const exists: BoolProp = { type: "property", schemaId: "bool", op: "exists" };
    const pickValue = (child: Child, value: boolean): Child =>
      rowApplyValue(child, applyBooleanValue(child as BoolProp, value));

    // is true: the default eq row.
    let child: Child = eq(true);
    expect(rowOperatorOf(child)).toBe("set");
    // → is false: the value write moves only the value.
    child = pickValue(child, false);
    expect(child).toEqual(eq(false));
    expect(rowOperatorOf(child)).toBe("set");
    // → is set: the set bit re-materializes exists (the value folds away).
    child = rowApplyOperator(child as Condition, "set");
    expect(child).toEqual(exists);
    expect(rowOperatorOf(child)).toBe("set");
    // → is not set: the negative set bit wraps.
    child = rowApplyOperator(child as Condition, "not-set");
    expect(child).toEqual({ type: "not", child: exists });
    expect(rowOperatorOf(child)).toBe("not-set");
    // → is set: the positive unwraps.
    child = rowApplyOperator(child as Condition, "set");
    expect(child).toEqual(exists);
    // → is true: the value selector re-materializes the eq row from exists
    // (the set+value fold the ruling defines).
    child = pickValue(child, true);
    expect(child).toEqual(eq(true));
    expect(rowOperatorOf(child)).toBe("set");
  });

  it("boolean property rows: the value selector is the whole predicate — a value write never moves the set axis", () => {
    const truthy = { type: "property", schemaId: "bool", op: "eq", value: true } as const;
    const falsy = rowApplyValue(truthy, applyBooleanValue(truthy, false));
    expect(falsy).toEqual({ type: "property", schemaId: "bool", op: "eq", value: false });
    expect(rowOperatorOf(falsy)).toBe("set");
  });
});
