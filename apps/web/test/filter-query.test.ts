/**
 * filterQuery tests — the transient filter layer's data: the FilterQuery
 * shape (quick text plus a draft query-AST root group), the draft→composed
 * prune rules (half-typed rows drop, the text unshifts as a content-contains
 * condition, null when nothing survives), and the row-predicate semantics
 * battery — text substring, class closure, property eq/neq/contains/
 * ordering/exists with the ISO-date arms, the {today} created window —
 * now exercised through the ONE evaluation implementation
 * (planSectionView + createSectionViewMatcher) over a stub client. No store
 * — pure model units.
 */

import { describe, expect, it } from "vitest";

import { dayNodeId, monthNodeId, yearNodeId } from "@notees/domain";
import type { Group } from "@notees/query";

import type { ClientNode, EffectiveProperty } from "../src/core/workspace-client.js";
import {
  createCondition,
  EMPTY_FILTER_QUERY,
  filterKindOptionsForConfig,
  filterQueryToGroup,
  isFilterInactive,
  type FilterQuery,
} from "../src/ui/components/filterQuery.js";
import {
  createSectionViewMatcher,
  planSectionView,
  type SectionViewResolveClient,
} from "../src/ui/views/sectionViewResolve.js";

const CLASS_A = "0192a000-0000-7000-8000-0000000000a1";
const CLASS_B = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA = "0192a000-0000-7000-8000-0000000000b1";

function makeNode(facts: {
  id?: string;
  title?: string;
  classIds?: string[];
  createdAt?: string | null;
}): ClientNode {
  return {
    id: facts.id ?? "0192a000-0000-7000-8000-0000000000c1",
    contentAst: facts.title !== undefined ? [{ type: "text", text: facts.title }] : [],
    classIds: facts.classIds ?? [],
    createdAt: facts.createdAt ?? null,
  } as unknown as ClientNode;
}

function stubClient(facts: {
  classChildren?: Record<string, string[]>;
  properties?: Record<string, Array<{ schemaId: string; value: unknown; source?: "authored" | "default" }>>;
}): SectionViewResolveClient {
  return {
    getNode: (id) => makeNode({ id }),
    getClassChildren: (classId) =>
      (facts.classChildren?.[classId] ?? []).map((id) => makeNode({ id })),
    getEffectiveProperties: (id) =>
      (facts.properties?.[id] ?? []).map(
        (row, idx) =>
          ({
            propertySchemaId: row.schemaId,
            idx,
            elementId: `${id}-el-${idx}`,
            schema: null,
            value: row.value,
            source: row.source ?? "authored",
          }) as EffectiveProperty,
      ),
    runQueryAst: async () => ({ ids: [] }),
    subscribe: () => () => {},
  };
}

/** Compose the query and match a node through the one evaluator. */
function matches(
  client: SectionViewResolveClient,
  node: ClientNode,
  query: FilterQuery,
): boolean {
  const group = filterQueryToGroup(query);
  if (group === null) return true; // the inactive filter is the identity
  const plan = planSectionView({
    version: 1,
    scope: { type: "entire_workspace" },
    root: group,
  });
  expect(plan.needsProbe).toBe(false);
  return createSectionViewMatcher(client, plan)(node);
}

describe("the FilterQuery shape", () => {
  it("is inactive by default and the identity filter matches everything", () => {
    expect(isFilterInactive(EMPTY_FILTER_QUERY)).toBe(true);
    expect(isFilterInactive({ text: "   ", group: EMPTY_FILTER_QUERY.group })).toBe(true);
    expect(
      isFilterInactive({
        text: "",
        group: { type: "group", logic: "and", children: [] },
      }),
    ).toBe(true);
    expect(isFilterInactive({ text: "zebra", group: EMPTY_FILTER_QUERY.group })).toBe(false);
    expect(
      isFilterInactive({
        text: "",
        group: { type: "group", logic: "and", children: [createCondition("isClass")] },
      }),
    ).toBe(false);
    expect(matches(stubClient({}), makeNode({ title: "anything" }), EMPTY_FILTER_QUERY)).toBe(true);
  });

  it("createCondition seeds a half-typed default per kind", () => {
    expect(createCondition("class")).toEqual({ type: "class", classId: "" });
    expect(createCondition("isClass")).toEqual({ type: "isClass", isClass: true });
    expect(createCondition("presentAsMain")).toEqual({ type: "presentAsMain", presentAsMain: true });
    expect(createCondition("content")).toEqual({ type: "content", op: "contains", value: "" });
    expect(createCondition("property")).toEqual({ type: "property", schemaId: "", op: "eq", value: "" });
    expect(createCondition("createdAfter")).toEqual({ type: "createdAfter", timestamp: "" });
    expect(createCondition("createdBefore")).toEqual({ type: "createdBefore", timestamp: "" });
    expect(createCondition("coverAsset")).toEqual({ type: "coverAsset", op: "exists" });
    expect(createCondition("bannerAsset")).toEqual({ type: "bannerAsset", op: "exists" });
    expect(createCondition("aliasedNode")).toEqual({ type: "aliasedNode", op: "exists" });
  });
});

describe("filterQueryToGroup — the draft prune", () => {
  it("returns null for the untouched query", () => {
    expect(filterQueryToGroup(EMPTY_FILTER_QUERY)).toBeNull();
  });

  it("unshifts the trimmed text as a content-contains condition", () => {
    expect(filterQueryToGroup({ text: "  zebra ", group: EMPTY_FILTER_QUERY.group })).toEqual({
      type: "group",
      logic: "and",
      children: [{ type: "content", op: "contains", value: "zebra" }],
    });
  });

  it("drops half-typed conditions: blank content value, empty classId, empty schemaId, blank timestamps", () => {
    const draft: Group = {
      type: "group",
      logic: "and",
      children: [
        { type: "content", op: "contains", value: "   " },
        { type: "class", classId: "" },
        { type: "property", schemaId: "", op: "eq", value: "42" },
        { type: "createdAfter", timestamp: "" },
        { type: "createdBefore", timestamp: "  " },
        { type: "isClass", isClass: true },
      ],
    };
    expect(filterQueryToGroup({ text: "", group: draft })).toEqual({
      type: "group",
      logic: "and",
      children: [{ type: "isClass", isClass: true }],
    });
  });

  it("keeps fully-specified conditions verbatim and preserves the root logic", () => {
    const draft: Group = {
      type: "group",
      logic: "or",
      children: [
        { type: "class", classId: CLASS_A },
        { type: "property", schemaId: SCHEMA, op: "gte", value: "5" },
        { type: "createdAfter", timestamp: "2026-01-01" },
        { type: "coverAsset", op: "exists" },
      ],
    };
    expect(filterQueryToGroup({ text: "", group: draft })).toEqual(draft);
  });

  it("recurses into nested groups, drops emptied ones, and drops a not whose child pruned away", () => {
    const draft: Group = {
      type: "group",
      logic: "and",
      children: [
        {
          type: "group",
          logic: "or",
          children: [
            { type: "content", op: "contains", value: "" },
            { type: "class", classId: CLASS_B },
          ],
        },
        { type: "not", child: { type: "class", classId: "" } },
        {
          type: "not",
          child: {
            type: "group",
            logic: "and",
            children: [{ type: "content", op: "contains", value: "draft" }],
          },
        },
      ],
    };
    expect(filterQueryToGroup({ text: "", group: draft })).toEqual({
      type: "group",
      logic: "and",
      children: [
        {
          type: "group",
          logic: "or",
          children: [{ type: "class", classId: CLASS_B }],
        },
        {
          type: "not",
          child: {
            type: "group",
            logic: "and",
            children: [{ type: "content", op: "contains", value: "draft" }],
          },
        },
      ],
    });
  });
});

describe("the add-menu registry", () => {
  it("offers the full wire grammar plus the group constructors, v1 order", () => {
    expect(filterKindOptionsForConfig().map((option) => option.value)).toEqual([
      "class",
      "isClass",
      "presentAsMain",
      "content",
      "property",
      "linkedTo",
      "descendantOf",
      "createdAfter",
      "createdBefore",
      "coverAsset",
      "bannerAsset",
      "aliasedNode",
      "group-and",
      "group-or",
      "not",
    ]);
  });

  it("config gates the class/property/date kinds only", () => {
    const values = filterKindOptionsForConfig({ class: false, properties: false, dateRange: false }).map(
      (option) => option.value,
    );
    expect(values).not.toContain("class");
    expect(values).not.toContain("property");
    expect(values).not.toContain("createdAfter");
    expect(values).not.toContain("createdBefore");
    expect(values).toContain("content");
    expect(values).toContain("group-and");
    expect(values).toContain("not");
  });
});

describe("the row predicate through the one evaluator", () => {
  it("text is a case-insensitive substring over the title", () => {
    const client = stubClient({});
    expect(matches(client, makeNode({ title: "The Zebra Stripes" }), { text: "zebra", group: EMPTY_FILTER_QUERY.group })).toBe(true);
    expect(matches(client, makeNode({ title: "The Zebra Stripes" }), { text: "ZEBRA", group: EMPTY_FILTER_QUERY.group })).toBe(true);
    expect(matches(client, makeNode({ title: "The Zebra Stripes" }), { text: "yak", group: EMPTY_FILTER_QUERY.group })).toBe(false);
  });

  it("class is hierarchy-aware — the class or anything extending it", () => {
    const client = stubClient({ classChildren: { [CLASS_A]: [CLASS_B] } });
    const query: FilterQuery = {
      text: "",
      group: { type: "group", logic: "and", children: [{ type: "class", classId: CLASS_A }] },
    };
    expect(matches(client, makeNode({ classIds: [CLASS_A] }), query)).toBe(true);
    expect(matches(client, makeNode({ classIds: [CLASS_B] }), query)).toBe(true);
    expect(matches(client, makeNode({ classIds: [] }), query)).toBe(false);
  });

  it("property ops read the effective-values read model (any row may match)", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const client = stubClient({
      properties: {
        [id]: [
          { schemaId: SCHEMA, value: "hello world" },
          { schemaId: SCHEMA, value: 42 },
        ],
      },
    });
    const withOp = (op: string, value?: string): FilterQuery => ({
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [
          value === undefined
            ? { type: "property", schemaId: SCHEMA, op: op as never }
            : { type: "property", schemaId: SCHEMA, op: op as never, value },
        ],
      },
    });
    const node = makeNode({ id });
    expect(matches(client, node, withOp("eq", "hello world"))).toBe(true);
    // The bar's text input coerces against numeric values.
    expect(matches(client, node, withOp("eq", "42"))).toBe(true);
    expect(matches(client, node, withOp("neq", "hello world"))).toBe(true);
    expect(matches(client, node, withOp("contains", "WORLD"))).toBe(true);
    expect(matches(client, node, withOp("gt", "41"))).toBe(true);
    expect(matches(client, node, withOp("exists"))).toBe(true);
    // "hello world" sorts before "zzz" lexicographically, 42 is below it numerically…
    expect(matches(client, node, withOp("lt", "zzz"))).toBe(true);
    // …and no row survives a bound above every value.
    expect(matches(client, node, withOp("gt", "zzz"))).toBe(false);
    // A value op without a bound matches nothing.
    expect(matches(client, node, withOp("eq"))).toBe(false);
    const bare = makeNode({ id: "0192a000-0000-7000-8000-0000000000c9" });
    expect(matches(client, bare, withOp("exists"))).toBe(false);
  });

  it("includeDefaults false narrows to authored rows", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const client = stubClient({
      properties: { [id]: [{ schemaId: SCHEMA, value: 7, source: "default" }] },
    });
    const node = makeNode({ id });
    const withDefaults = (includeDefaults: boolean): FilterQuery => ({
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [
          { type: "property", schemaId: SCHEMA, op: "exists", includeDefaults },
        ],
      },
    });
    expect(matches(client, node, withDefaults(true))).toBe(true);
    expect(matches(client, node, withDefaults(false))).toBe(false);
  });

  it("node-typed values match the ISO-date arms by the deterministic date id", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const withOp = (op: string, value: string): FilterQuery => ({
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [{ type: "property", schemaId: SCHEMA, op: op as never, value }],
      },
    });
    const day = dayNodeId("2026-10-07");
    const client = stubClient({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: day } }] },
    });
    const node = makeNode({ id });
    expect(matches(client, node, withOp("eq", "2026-10-07"))).toBe(true);
    expect(matches(client, node, withOp("eq", "2026-10-08"))).toBe(false);
    expect(matches(client, node, withOp("neq", "2026-10-08"))).toBe(true);
    expect(matches(client, node, withOp("gt", "2026-10-06"))).toBe(true);
    expect(matches(client, node, withOp("lt", "2026-10-07"))).toBe(false);
    // Containment: a month node matches the days it contains.
    const monthHolder = stubClient({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: monthNodeId("2026-10-01") } }] },
    });
    expect(matches(monthHolder, node, withOp("eq", "2026-10-07"))).toBe(true);
    expect(matches(monthHolder, node, withOp("eq", "2026-11-01"))).toBe(false);
    // …and a year node the days of its year.
    const yearHolder = stubClient({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: yearNodeId("2026-01-01") } }] },
    });
    expect(matches(yearHolder, node, withOp("eq", "2026-12-31"))).toBe(true);
    expect(matches(yearHolder, node, withOp("eq", "2027-01-01"))).toBe(false);
  });

  it("the created window is inclusive and `{today}` resolves on the run clock", () => {
    const client = stubClient({});
    const withRange = (after?: string, before?: string): FilterQuery => ({
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [
          ...(after !== undefined ? [{ type: "createdAfter", timestamp: after } as const] : []),
          ...(before !== undefined ? [{ type: "createdBefore", timestamp: before } as const] : []),
        ],
      },
    });
    const node = makeNode({ createdAt: "2026-10-07T09:30:00.000Z" });
    expect(matches(client, node, withRange("2026-10-07"))).toBe(true);
    expect(matches(client, node, withRange(undefined, "2026-10-07"))).toBe(false);
    expect(matches(client, node, withRange(undefined, "2026-10-08"))).toBe(true);
    expect(matches(client, node, withRange("2026-10-08"))).toBe(false);
    const now = makeNode({ createdAt: new Date().toISOString() });
    expect(matches(client, now, withRange("{today}"))).toBe(true);
    // A node without a created_at never matches a date window.
    const timeless = makeNode({ createdAt: null });
    expect(matches(client, timeless, withRange("2026-01-01"))).toBe(false);
  });

  it("every active constraint ANDs; nested OR and NOT compose", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const client = stubClient({
      classChildren: { [CLASS_A]: [] },
      properties: { [id]: [{ schemaId: SCHEMA, value: 7 }] },
    });
    const node = makeNode({
      id,
      title: "Zebra",
      classIds: [CLASS_A],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const query: FilterQuery = {
      text: "zebra",
      group: {
        type: "group",
        logic: "and",
        children: [
          { type: "class", classId: CLASS_A },
          { type: "property", schemaId: SCHEMA, op: "gte", value: "5" },
          { type: "createdAfter", timestamp: "2026-01-01" },
        ],
      },
    };
    expect(matches(client, node, query)).toBe(true);
    expect(matches(client, { ...node, classIds: [CLASS_B] }, query)).toBe(false);
    expect(matches(client, { ...node, createdAt: "2025-06-01T00:00:00.000Z" }, query)).toBe(false);

    // An OR group matches either side.
    const orQuery: FilterQuery = {
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [
          {
            type: "group",
            logic: "or",
            children: [
              { type: "content", op: "contains", value: "yak" },
              { type: "content", op: "contains", value: "zeb" },
            ],
          },
        ],
      },
    };
    expect(matches(client, makeNode({ title: "Zebra" }), orQuery)).toBe(true);
    expect(matches(client, makeNode({ title: "Yak" }), orQuery)).toBe(true);
    expect(matches(client, makeNode({ title: "Moose" }), orQuery)).toBe(false);

    // A NOT wrapper inverts its child.
    const notQuery: FilterQuery = {
      text: "",
      group: {
        type: "group",
        logic: "and",
        children: [
          { type: "not", child: { type: "class", classId: CLASS_A } },
        ],
      },
    };
    expect(matches(client, makeNode({ classIds: [CLASS_A] }), notQuery)).toBe(false);
    expect(matches(client, makeNode({ classIds: [] }), notQuery)).toBe(true);
  });
});
