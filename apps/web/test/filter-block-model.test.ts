/**
 * Filter-block model tests: the operator column's value must always read a
 * member of the family register (a dropdown whose value is not among its
 * options renders blank), and an operator choice on a Query/Self-mode row
 * must keep the row's mode — the negative wraps the *Query/*Self condition
 * in NOT (the compiler negates the whole probe, subquery / self marker
 * intact), it never morphs back to a static empty list. The regression this
 * guards: the Child path operator went blank the moment the target mode left
 * Manual (operatorOf returned is/is-not, absent from the contains register),
 * and choosing "does not contain" on any dynamic/self row discarded the
 * subquery by morphing to the static shape.
 */

import { describe, expect, it } from "vitest";

import type { Child, Condition, Group } from "@notees/query";

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

/** Representative conditions across every family and every target mode. */
const REPRESENTATIVE: Condition[] = [
  { type: "class", classId: "c1" },
  { type: "classAny", classIds: ["c1"] },
  { type: "classSet" },
  { type: "classAnyQuery", root: emptyRoot },
  { type: "classSelf" },
  { type: "content", op: "contains", value: "x" },
  { type: "contentSet" },
  { type: "isClass", isClass: true },
  { type: "isEmbedded", isEmbedded: false },
  { type: "tag", tagId: "t1" },
  { type: "tagAny", tagIds: ["t1"] },
  { type: "tagSet" },
  { type: "tagAnyQuery", root: emptyRoot },
  { type: "tagSelf" },
  { type: "linkedTo", nodeId: "n1" },
  { type: "linkedToAny", nodeIds: ["n1"] },
  { type: "linkSet" },
  { type: "linkedToQuery", root: emptyRoot },
  { type: "linkedToSelf" },
  { type: "parentOf", nodeIds: ["n1"] },
  { type: "parentSet" },
  { type: "parentOfQuery", root: emptyRoot },
  { type: "parentOfSelf" },
  { type: "childOf", nodeIds: ["n1"] },
  { type: "childSet" },
  { type: "childOfQuery", root: emptyRoot },
  { type: "childOfSelf" },
  { type: "descendantOf", nodeId: "n1" },
  { type: "descendantOfAny", nodeIds: ["n1"] },
  { type: "descendantSet" },
  { type: "descendantOfQuery", root: emptyRoot },
  { type: "descendantOfSelf" },
  { type: "referencePathOf", nodeIds: ["n1"] },
  { type: "referencePathOfQuery", root: emptyRoot },
  { type: "referencePathOfSelf" },
  { type: "pageOf", nodeIds: ["n1"] },
  { type: "pageSet" },
  { type: "pageOfQuery", root: emptyRoot },
  { type: "pageOfSelf" },
  { type: "ancestorIn", nodeIds: ["n1"] },
  { type: "ancestorInQuery", root: emptyRoot },
  { type: "ancestorInSelf" },
  { type: "rootIn", nodeIds: ["n1"] },
  { type: "rootInQuery", root: emptyRoot },
  { type: "rootInSelf" },
  { type: "coverAsset", op: "exists" },
  { type: "bannerAsset", op: "exists" },
  { type: "aliasedNode", op: "exists" },
  { type: "createdCmp", op: "eq", timestamp: "2026-01-01" },
  { type: "createdBetween", from: "2026-01-01", to: "2026-02-01" },
  { type: "createdWithin", period: "today" },
  { type: "updatedCmp", op: "gt", timestamp: "2026-01-01" },
  { type: "property", schemaId: "text", op: "contains", value: "x" },
  { type: "property", schemaId: "text", op: "exists" },
  { type: "propertyBetween", schemaId: "num", from: "1", to: "2" },
  { type: "propertyWithin", schemaId: "date", period: "today" },
];

describe("operatorOf reads a member of the family register", () => {
  for (const condition of REPRESENTATIVE) {
    for (const negated of [false, true]) {
      it(`${condition.type}${negated ? " (negated)" : ""} renders an offered operator`, () => {
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

describe("operator choice on a Query-mode row keeps the subquery", () => {
  it("child path: does not contain wraps, contains unwraps", () => {
    const condition: Condition = { type: "descendantOfQuery", root: sampleRoot };
    expect(applyOperator(condition, "not-contains")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "contains")).toEqual(condition);
  });

  it("child path: the set bits swap the target for the emptiness shape", () => {
    const condition: Condition = { type: "descendantOfQuery", root: sampleRoot };
    expect(applyOperator(condition, "set")).toEqual({ type: "descendantSet" });
    expect(applyOperator(condition, "not-set")).toEqual({
      type: "not",
      child: { type: "descendantSet" },
    });
  });

  it("links: is-not wraps, keeping the nested query", () => {
    const condition: Condition = { type: "linkedToQuery", root: sampleRoot };
    expect(applyOperator(condition, "is-not")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "is")).toEqual(condition);
  });

  it("tags: is-not wraps, keeping the nested query", () => {
    const condition: Condition = { type: "tagAnyQuery", root: sampleRoot };
    expect(applyOperator(condition, "is-not")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "is")).toEqual(condition);
  });

  it("class: both negatives wrap, keeping the nested query", () => {
    const condition: Condition = { type: "classAnyQuery", root: sampleRoot };
    expect(applyOperator(condition, "is-not")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "not-contains")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "contains")).toEqual(condition);
  });

  it("parent / child: the negative wraps, keeping the nested query", () => {
    const parent: Condition = { type: "parentOfQuery", root: sampleRoot };
    expect(applyOperator(parent, "is-not")).toEqual({ type: "not", child: parent });
    const child: Condition = { type: "childOfQuery", root: sampleRoot };
    expect(applyOperator(child, "not-contains-any-of")).toEqual({ type: "not", child: child });
  });

  it("reference path: is-not-any-of wraps, keeping the nested query", () => {
    const condition: Condition = { type: "referencePathOfQuery", root: sampleRoot };
    expect(applyOperator(condition, "is-not-any-of")).toEqual({ type: "not", child: condition });
    expect(applyOperator(condition, "is-any-of")).toEqual(condition);
  });

  it("page / parent path / root: the negative wraps, keeping the nested query", () => {
    const page: Condition = { type: "pageOfQuery", root: sampleRoot };
    expect(applyOperator(page, "is-not")).toEqual({ type: "not", child: page });
    const path: Condition = { type: "ancestorInQuery", root: sampleRoot };
    expect(applyOperator(path, "not-includes")).toEqual({ type: "not", child: path });
    const root: Condition = { type: "rootInQuery", root: sampleRoot };
    expect(applyOperator(root, "is-not")).toEqual({ type: "not", child: root });
  });
});

describe("operator choice on a Self-mode row keeps the self marker", () => {
  const cases: Array<{ condition: Condition; negative: string }> = [
    { condition: { type: "descendantOfSelf" }, negative: "not-contains" },
    { condition: { type: "linkedToSelf" }, negative: "is-not" },
    { condition: { type: "tagSelf" }, negative: "is-not" },
    { condition: { type: "classSelf" }, negative: "is-not" },
    { condition: { type: "parentOfSelf" }, negative: "is-not" },
    { condition: { type: "childOfSelf" }, negative: "not-contains-any-of" },
    { condition: { type: "referencePathOfSelf" }, negative: "is-not-any-of" },
    { condition: { type: "pageOfSelf" }, negative: "is-not" },
    { condition: { type: "ancestorInSelf" }, negative: "not-includes" },
    { condition: { type: "rootInSelf" }, negative: "is-not" },
  ];
  for (const { condition, negative } of cases) {
    it(`${condition.type}: ${negative} wraps, keeping the self marker`, () => {
      expect(applyOperator(condition, negative)).toEqual({ type: "not", child: condition });
    });
  }
});

describe("operator choice on a Manual row keeps the carried ids", () => {
  it("child path: the single and list shapes carry into descendantOfAny", () => {
    const single: Condition = { type: "descendantOf", nodeId: "n1" };
    expect(applyOperator(single, "contains")).toEqual({
      type: "descendantOfAny",
      nodeIds: ["n1"],
    });
    const list: Condition = { type: "descendantOfAny", nodeIds: ["n1", "n2"] };
    expect(applyOperator(list, "not-contains")).toEqual({
      type: "not",
      child: { type: "descendantOfAny", nodeIds: ["n1", "n2"] },
    });
  });

  it("links: is-not wraps the picked list", () => {
    const list: Condition = { type: "linkedToAny", nodeIds: ["n1"] };
    expect(applyOperator(list, "is-not")).toEqual({
      type: "not",
      child: { type: "linkedToAny", nodeIds: ["n1"] },
    });
  });

  it("class: contains carries the picked ids", () => {
    const single: Condition = { type: "class", classId: "c1" };
    expect(applyOperator(single, "contains")).toEqual({ type: "classAny", classIds: ["c1"] });
  });
});

describe("the reported scenario end to end at the model level", () => {
  it("child path contains / does not contain a node matching a subquery", () => {
    // Inner: a node whose links list contains (query) class fuente.
    const inner: Condition = {
      type: "linkedToQuery",
      root: {
        type: "group",
        logic: "and",
        children: [{ type: "class", classId: "fuente" }],
      },
    };
    // Outer positive: my child path contains such a node.
    const positive: Child = { type: "descendantOfQuery", root: { type: "group", logic: "and", children: [inner] } };
    expect(operatorOf(positive as Condition, false)).toBe("contains");
    expect(applyOperator(positive as Condition, "not-contains")).toEqual({
      type: "not",
      child: positive,
    });
    // Flipping back renders the positive operator again.
    const negated = applyOperator(positive as Condition, "not-contains");
    const view = negated.type === "not" ? negated.child : null;
    expect(view).not.toBeNull();
    expect(operatorOf(view as Condition, true)).toBe("not-contains");
  });
});
