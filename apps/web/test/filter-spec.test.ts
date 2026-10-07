/**
 * filterSpec tests — the transient filter layer's one grammar: the
 * FilterSpec shape is declarative and serializable (JSON round-trip through
 * the strict parser), it is the documented flat-AND subset of the query AST
 * (spec → AST → spec round-trips onto exactly the named conditions; anything
 * outside the subset reads back null, never a lossy default), and the row
 * predicate mirrors the compiler's scalar semantics over a stubbed
 * effective-values read model. No store — pure model units.
 */

import { describe, expect, it } from "vitest";

import { dayNodeId, monthNodeId, yearNodeId } from "@notees/domain";
import type { QueryAst } from "@notees/query";

import type { ClientNode, EffectiveProperty } from "../src/core/workspace-client.js";
import {
  EMPTY_FILTER_SPEC,
  filterSpecConditions,
  filterSpecToQueryAst,
  isFilterEmpty,
  matchesNodeFilter,
  parseFilterSpec,
  queryAstToFilterSpec,
  type FilterFactsClient,
  type FilterSpec,
} from "../src/ui/components/filterSpec.js";

const CLASS_A = "0192a000-0000-7000-8000-0000000000a1";
const CLASS_B = "0192a000-0000-7000-8000-0000000000a2";
const SCHEMA = "0192a000-0000-7000-8000-0000000000b1";

/** The full facet set — every field exercised at once. */
const FULL_SPEC: FilterSpec = {
  text: "  zebra ",
  classId: CLASS_A,
  propertyPredicates: [
    { schemaId: SCHEMA, op: "eq", value: "42" },
    { schemaId: SCHEMA, op: "exists" },
  ],
  dateRange: { after: "2026-01-01", before: "2026-12-31" },
};

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

function stubFacts(facts: {
  classChildren?: Record<string, string[]>;
  properties?: Record<string, Array<{ schemaId: string; value: unknown }>>;
}): FilterFactsClient {
  return {
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
          }) as EffectiveProperty,
      ),
  };
}

describe("the FilterSpec shape", () => {
  it("is empty by default and the identity filter matches everything", () => {
    expect(isFilterEmpty(EMPTY_FILTER_SPEC)).toBe(true);
    expect(isFilterEmpty({})).toBe(true);
    expect(isFilterEmpty({ text: "   " })).toBe(true);
    expect(isFilterEmpty({ dateRange: {} })).toBe(true);
    expect(isFilterEmpty(FULL_SPEC)).toBe(false);
    expect(matchesNodeFilter(stubFacts({}), makeNode({ title: "anything" }), EMPTY_FILTER_SPEC)).toBe(
      true,
    );
  });

  it("round-trips through JSON serialization and the strict parser", () => {
    const revived = parseFilterSpec(JSON.parse(JSON.stringify(FULL_SPEC)));
    expect(revived).toEqual(FULL_SPEC);
  });

  it("rejects unknown keys, bad shapes and unknown ops loudly", () => {
    expect(() => parseFilterSpec({ text: 42 })).toThrow();
    expect(() => parseFilterSpec({ classId: "not-a-uuid" })).toThrow();
    expect(() => parseFilterSpec({ propertyPredicates: [{ schemaId: SCHEMA, op: "fuzzy" }] })).toThrow();
    expect(() => parseFilterSpec({ dateRange: { after: "" } })).toThrow();
    expect(() => parseFilterSpec({ stray: true })).toThrow();
    expect(() => parseFilterSpec([FULL_SPEC])).toThrow();
  });
});

describe("the one grammar with the query AST", () => {
  it("composes the flat-AND condition subset", () => {
    expect(filterSpecConditions(EMPTY_FILTER_SPEC)).toEqual([]);
    expect(filterSpecConditions(FULL_SPEC)).toEqual([
      { type: "content", op: "contains", value: "zebra" },
      { type: "class", classId: CLASS_A },
      { type: "property", schemaId: SCHEMA, op: "eq", value: "42" },
      { type: "property", schemaId: SCHEMA, op: "exists" },
      { type: "createdAfter", timestamp: "2026-01-01" },
      { type: "createdBefore", timestamp: "2026-12-31" },
    ]);
  });

  it("round-trips spec → AST → spec onto exactly the named conditions", () => {
    const ast = filterSpecToQueryAst(FULL_SPEC);
    expect(ast).toEqual({
      version: 1,
      scope: { type: "entire_workspace" },
      root: { type: "group", logic: "and", children: filterSpecConditions(FULL_SPEC) },
    });
    // The AST stores the trimmed text — the round-trip normalizes it.
    expect(queryAstToFilterSpec(ast)).toEqual({ ...FULL_SPEC, text: "zebra" });
    expect(queryAstToFilterSpec(filterSpecToQueryAst({ ...FULL_SPEC, text: "zebra" }))).toEqual({
      ...FULL_SPEC,
      text: "zebra",
    });
    expect(queryAstToFilterSpec(filterSpecToQueryAst(EMPTY_FILTER_SPEC))).toEqual(EMPTY_FILTER_SPEC);
  });

  it("reads an outside-subset AST back as null — never a lossy default", () => {
    const base = filterSpecToQueryAst(EMPTY_FILTER_SPEC);
    const asts: QueryAst[] = [
      { ...base, root: { type: "group", logic: "or", children: [] } },
      {
        ...base,
        root: {
          type: "group",
          logic: "and",
          children: [{ type: "group", logic: "and", children: [] }],
        },
      },
      {
        ...base,
        root: {
          type: "group",
          logic: "and",
          children: [{ type: "content", op: "fts", value: "zebra" }],
        },
      },
      {
        ...base,
        root: {
          type: "group",
          logic: "and",
          children: [{ type: "isClass", isClass: true }],
        },
      },
      {
        ...base,
        root: {
          type: "group",
          logic: "and",
          children: [{ type: "linkedTo", nodeId: CLASS_A }],
        },
      },
      { ...base, sort: [{ field: "name", dir: "asc" }] },
    ];
    for (const ast of asts) expect(queryAstToFilterSpec(ast)).toBeNull();
  });
});

describe("the row predicate (matchesNodeFilter)", () => {
  it("text is a case-insensitive substring over the title", () => {
    const client = stubFacts({});
    expect(matchesNodeFilter(client, makeNode({ title: "The Zebra Stripes" }), { text: "zebra" })).toBe(true);
    expect(matchesNodeFilter(client, makeNode({ title: "The Zebra Stripes" }), { text: "ZEBRA" })).toBe(true);
    expect(matchesNodeFilter(client, makeNode({ title: "The Zebra Stripes" }), { text: "yak" })).toBe(false);
  });

  it("classId is hierarchy-aware — the class or anything extending it", () => {
    const client = stubFacts({ classChildren: { [CLASS_A]: [CLASS_B] } });
    const onA = makeNode({ classIds: [CLASS_A] });
    const onB = makeNode({ classIds: [CLASS_B] });
    const onNone = makeNode({ classIds: [] });
    expect(matchesNodeFilter(client, onA, { classId: CLASS_A })).toBe(true);
    expect(matchesNodeFilter(client, onB, { classId: CLASS_A })).toBe(true);
    expect(matchesNodeFilter(client, onNone, { classId: CLASS_A })).toBe(false);
  });

  it("property ops read the effective-values read model", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const client = stubFacts({
      properties: {
        [id]: [
          { schemaId: SCHEMA, value: "hello world" },
          { schemaId: SCHEMA, value: 42 },
        ],
      },
    });
    const node = makeNode({ id });
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "eq", value: "hello world" }] })).toBe(true);
    // The bar's text input coerces against numeric values.
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "eq", value: "42" }] })).toBe(true);
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "neq", value: "hello world" }] })).toBe(true);
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "contains", value: "WORLD" }] })).toBe(true);
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "gt", value: "41" }] })).toBe(true);
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "exists" }] })).toBe(true);
    // Any-row semantics: "hello world" sorts after "zzz" lexicographically…
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "lt", value: "zzz" }] })).toBe(true);
    // …and no row survives a bound above every value.
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "gt", value: "zzz" }] })).toBe(false);
    // A value op without a bound matches nothing.
    expect(matchesNodeFilter(client, node, { propertyPredicates: [{ schemaId: SCHEMA, op: "eq" }] })).toBe(false);
    const bare = makeNode({ id: "0192a000-0000-7000-8000-0000000000c9" });
    expect(matchesNodeFilter(client, bare, { propertyPredicates: [{ schemaId: SCHEMA, op: "exists" }] })).toBe(false);
  });

  it("node-typed values match the ISO-date arms by the deterministic date id", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const day = dayNodeId("2026-10-07");
    const client = stubFacts({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: day } }] },
    });
    const node = makeNode({ id });
    const withOp = (op: "eq" | "neq" | "gt" | "lt", value: string) => ({
      propertyPredicates: [{ schemaId: SCHEMA, op, value }],
    });
    expect(matchesNodeFilter(client, node, withOp("eq", "2026-10-07"))).toBe(true);
    expect(matchesNodeFilter(client, node, withOp("eq", "2026-10-08"))).toBe(false);
    expect(matchesNodeFilter(client, node, withOp("neq", "2026-10-08"))).toBe(true);
    expect(matchesNodeFilter(client, node, withOp("gt", "2026-10-06"))).toBe(true);
    expect(matchesNodeFilter(client, node, withOp("lt", "2026-10-07"))).toBe(false);
    // Containment: a month node matches the days it contains.
    const monthHolder = stubFacts({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: monthNodeId("2026-10-01") } }] },
    });
    expect(matchesNodeFilter(monthHolder, node, withOp("eq", "2026-10-07"))).toBe(true);
    expect(matchesNodeFilter(monthHolder, node, withOp("eq", "2026-11-01"))).toBe(false);
    // …and a year node the days of its year.
    const yearHolder = stubFacts({
      properties: { [id]: [{ schemaId: SCHEMA, value: { nodeId: yearNodeId("2026-01-01") } }] },
    });
    expect(matchesNodeFilter(yearHolder, node, withOp("eq", "2026-12-31"))).toBe(true);
    expect(matchesNodeFilter(yearHolder, node, withOp("eq", "2027-01-01"))).toBe(false);
  });

  it("the created window is inclusive and `{today}` resolves on the run clock", () => {
    const client = stubFacts({});
    const node = makeNode({ createdAt: "2026-10-07T09:30:00.000Z" });
    expect(matchesNodeFilter(client, node, { dateRange: { after: "2026-10-07" } })).toBe(true);
    expect(matchesNodeFilter(client, node, { dateRange: { before: "2026-10-07" } })).toBe(false);
    expect(matchesNodeFilter(client, node, { dateRange: { before: "2026-10-08" } })).toBe(true);
    expect(matchesNodeFilter(client, node, { dateRange: { after: "2026-10-08" } })).toBe(false);
    const now = makeNode({ createdAt: new Date().toISOString() });
    expect(matchesNodeFilter(client, now, { dateRange: { after: "{today}" } })).toBe(true);
    // A node without a created_at never matches a date window.
    const timeless = makeNode({ createdAt: null });
    expect(matchesNodeFilter(client, timeless, { dateRange: { after: "2026-01-01" } })).toBe(false);
  });

  it("every active facet ANDs", () => {
    const id = "0192a000-0000-7000-8000-0000000000c1";
    const client = stubFacts({
      classChildren: { [CLASS_A]: [] },
      properties: { [id]: [{ schemaId: SCHEMA, value: 7 }] },
    });
    const node = makeNode({ id, title: "Zebra", classIds: [CLASS_A], createdAt: "2026-06-01T00:00:00.000Z" });
    const spec: FilterSpec = {
      text: "zebra",
      classId: CLASS_A,
      propertyPredicates: [{ schemaId: SCHEMA, op: "gte", value: "5" }],
      dateRange: { after: "2026-01-01" },
    };
    expect(matchesNodeFilter(client, node, spec)).toBe(true);
    expect(matchesNodeFilter(client, { ...node, classIds: [CLASS_B] }, spec)).toBe(false);
    expect(matchesNodeFilter(client, { ...node, createdAt: "2025-06-01T00:00:00.000Z" }, spec)).toBe(false);
  });
});
