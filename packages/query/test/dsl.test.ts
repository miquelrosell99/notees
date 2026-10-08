/**
 * Text query DSL tests: every field kind, every operator, boolean composition,
 * quoting, value coercion, name resolution (injected resolvers) and the
 * fail-loud error surface (unknown fields list the known ones, unresolvable
 * names, bad operators, unterminated strings, missing values).
 */

import { describe, expect, it } from "vitest";

import {
  looksLikeQueryLanguage,
  parseQueryAst,
  parseQueryLanguage,
  QueryLanguageError,
  type Child,
  type QueryAst,
} from "../src/index.js";

// A small fixed world for resolution.
const CLASS_PAPER = "0192a000-0000-7000-8000-000000000201";
const CLASS_BOOK = "0192a000-0000-7000-8000-000000000202";
const SCHEMA_YEAR = "0192a000-0000-7000-8000-000000000301";
const SCHEMA_TITLE = "0192a000-0000-7000-8000-000000000302";
const NODE_PARIS = "0192a000-0000-7000-8000-000000000401";

const resolvers = {
  resolveClass: (name: string) =>
    ({ paper: CLASS_PAPER, book: CLASS_BOOK })[name.toLowerCase()],
  resolvePropertySchema: (name: string) =>
    ({ year: SCHEMA_YEAR, title: SCHEMA_TITLE })[name.toLowerCase()],
  resolveNode: (name: string) => (name.toLowerCase() === "paris" ? NODE_PARIS : undefined),
};
const KNOWN_FIELDS = ["year", "title"];

function parse(text: string, options: Parameters<typeof parseQueryLanguage>[1] = {}): QueryAst {
  return parseQueryLanguage(text, { resolvers, knownFields: KNOWN_FIELDS, ...options });
}

function children(ast: QueryAst): Child[] {
  return ast.root.children;
}

function only(ast: QueryAst): Child {
  const kids = children(ast);
  expect(kids).toHaveLength(1);
  return kids[0]!;
}

describe("parseQueryLanguage: fields", () => {
  it("parses an empty query to an everything-matching AST", () => {
    const ast = parse("   ");
    expect(ast.version).toBe(1);
    expect(ast.scope).toEqual({ type: "entire_workspace" });
    expect(ast.root).toEqual({ type: "group", logic: "and", children: [] });
  });

  it("honours a caller-supplied scope", () => {
    const scope = { type: "pages" } as const;
    expect(parse("class:paper", { scope }).scope).toEqual(scope);
  });

  it("class:Name resolves the class by name", () => {
    expect(only(parse("class:paper"))).toEqual({ type: "class", classId: CLASS_PAPER });
    expect(only(parse("class:book"))).toEqual({ type: "class", classId: CLASS_BOOK });
  });

  it("isClass:true|false and presentAsMain:true|false emit boolean conditions (case-insensitive field)", () => {
    expect(only(parse("isClass:true"))).toEqual({ type: "isClass", isClass: true });
    expect(only(parse("isclass:false"))).toEqual({ type: "isClass", isClass: false });
    expect(only(parse("presentAsMain:true"))).toEqual({ type: "presentAsMain", presentAsMain: true });
    expect(only(parse("presentasmain:FALSE"))).toEqual({ type: "presentAsMain", presentAsMain: false });
  });

  it("text:term and bare words emit content-contains conditions", () => {
    expect(only(parse("text:relativity"))).toEqual({
      type: "content",
      op: "contains",
      value: "relativity",
    });
    expect(only(parse("relativity"))).toEqual({ type: "content", op: "contains", value: "relativity" });
  });

  it("linked:Name resolves the node by name", () => {
    expect(only(parse("linked:Paris"))).toEqual({ type: "linkedTo", nodeId: NODE_PARIS });
  });

  it("prop:<name>:<value> with a bare colon is contains", () => {
    expect(only(parse("prop:title:revolution"))).toEqual({
      type: "property",
      schemaId: SCHEMA_TITLE,
      op: "contains",
      value: "revolution",
    });
  });

  it("prop with no value is exists (also before AND/OR/NOT)", () => {
    expect(only(parse("prop:year"))).toEqual({ type: "property", schemaId: SCHEMA_YEAR, op: "exists" });
    expect(only(parse("prop:year:"))).toEqual({ type: "property", schemaId: SCHEMA_YEAR, op: "exists" });
    const ast = parse("prop:year NOT class:paper");
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [
        { type: "property", schemaId: SCHEMA_YEAR, op: "exists" },
        { type: "not", child: { type: "class", classId: CLASS_PAPER } },
      ],
    });
  });

  it("a bare property-schema field is shorthand for prop: (year:>2010)", () => {
    expect(only(parse("year:>2010"))).toEqual({
      type: "property",
      schemaId: SCHEMA_YEAR,
      op: "gt",
      value: 2010,
    });
    expect(only(parse("title:revolution"))).toEqual({
      type: "property",
      schemaId: SCHEMA_TITLE,
      op: "contains",
      value: "revolution",
    });
  });

  it("coverAsset:/bannerAsset:/aliasedNode: bare is the set probe, a value is eq (uuid passthrough or node-name resolution)", () => {
    const ASSET_UUID = "0192a000-0000-7000-8000-000000000501";
    const OTHER_UUID = "0192a000-0000-7000-8000-000000000502";
    expect(only(parse("coverAsset:"))).toEqual({ type: "coverAsset", op: "exists" });
    // Bare colon before a boolean keyword still reads exists (the prop: precedent).
    expect(parse("coverAsset: NOT bannerAsset:").root).toEqual({
      type: "group",
      logic: "and",
      children: [
        { type: "coverAsset", op: "exists" },
        { type: "not", child: { type: "bannerAsset", op: "exists" } },
      ],
    });
    // A uuid value skips name resolution.
    expect(only(parse(`coverAsset:${ASSET_UUID}`))).toEqual({
      type: "coverAsset",
      op: "eq",
      value: ASSET_UUID,
    });
    expect(only(parse(`bannerAsset:=${ASSET_UUID}`))).toEqual({
      type: "bannerAsset",
      op: "eq",
      value: ASSET_UUID,
    });
    // A non-uuid value resolves through the node-name resolver (linked: precedent).
    expect(only(parse("aliasedNode:Paris"))).toEqual({
      type: "aliasedNode",
      op: "eq",
      value: NODE_PARIS,
    });
    // "!=" is neq (SQL NULL semantics: unset matches neither — "is unset" is NOT coverAsset:).
    expect(only(parse(`coverAsset!=${OTHER_UUID}`))).toEqual({
      type: "coverAsset",
      op: "neq",
      value: OTHER_UUID,
    });
    // Field names are case-insensitive like the rest of the grammar.
    expect(only(parse("CoverAsset:"))).toEqual({ type: "coverAsset", op: "exists" });
  });
});

describe("parseQueryLanguage: operators", () => {
  const ops: Array<[string, string, unknown]> = [
    [":=", "eq", 1950],
    ["=", "eq", 1950],
    ["!=", "neq", 1950],
    [":>", "gt", 1950],
    [">", "gt", 1950],
    [":>=", "gte", 1950],
    [">=", "gte", 1950],
    [":<", "lt", 1950],
    ["<", "lt", 1950],
    [":<=", "lte", 1950],
    ["<=", "lte", 1950],
  ];
  for (const [syntax, op, value] of ops) {
    it(`prop:year${syntax}1950 → ${op}`, () => {
      expect(only(parse(`prop:year${syntax}1950`))).toEqual({
        type: "property",
        schemaId: SCHEMA_YEAR,
        op,
        value,
      });
    });
  }

  it("numeric values coerce to JSON numbers; ISO dates stay strings", () => {
    expect(only(parse("year:>2010"))).toMatchObject({ value: 2010 });
    const date = parse('prop:published:>=2024-01-01', {
      resolvers: { ...resolvers, resolvePropertySchema: (n) => (n === "published" ? SCHEMA_TITLE : undefined) },
    });
    expect(only(date)).toEqual({ type: "property", schemaId: SCHEMA_TITLE, op: "gte", value: "2024-01-01" });
  });

  it("values with colons/slashes survive whole (URLs, DOIs)", () => {
    const withColon = parse("text:https://example.com/x");
    expect(only(withColon)).toEqual({ type: "content", op: "contains", value: "https://example.com/x" });
    const doi = parse('prop:title:10.2307/2333763');
    expect(only(doi)).toEqual({
      type: "property",
      schemaId: SCHEMA_TITLE,
      op: "contains",
      value: "10.2307/2333763",
    });
  });
});

describe("parseQueryLanguage: composition", () => {
  it("multiple bare words AND implicitly", () => {
    expect(parse("capital france").root).toEqual({
      type: "group",
      logic: "and",
      children: [
        { type: "content", op: "contains", value: "capital" },
        { type: "content", op: "contains", value: "france" },
      ],
    });
  });

  it("AND / OR / NOT / parens compose exactly", () => {
    const ast = parse("class:paper AND year:>2010 OR NOT class:book");
    expect(ast.root).toEqual({
      type: "group",
      logic: "or",
      children: [
        {
          type: "group",
          logic: "and",
          children: [
            { type: "class", classId: CLASS_PAPER },
            { type: "property", schemaId: SCHEMA_YEAR, op: "gt", value: 2010 },
          ],
        },
        { type: "not", child: { type: "class", classId: CLASS_BOOK } },
      ],
    });
  });

  it("parenthesized groups nest", () => {
    const ast = parse("(class:paper OR class:book) AND text:revolution");
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [
        {
          type: "group",
          logic: "or",
          children: [
            { type: "class", classId: CLASS_PAPER },
            { type: "class", classId: CLASS_BOOK },
          ],
        },
        { type: "content", op: "contains", value: "revolution" },
      ],
    });
  });

  it("NOT negates a parenthesized group", () => {
    const ast = parse("NOT (class:paper OR class:book)");
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [
        {
          type: "not",
          child: {
            type: "group",
            logic: "or",
            children: [
              { type: "class", classId: CLASS_PAPER },
              { type: "class", classId: CLASS_BOOK },
            ],
          },
        },
      ],
    });
  });

  it("!= negates class, boolean and linked conditions", () => {
    expect(only(parse("class!=paper"))).toEqual({
      type: "not",
      child: { type: "class", classId: CLASS_PAPER },
    });
    expect(only(parse("isClass!=true"))).toEqual({
      type: "not",
      child: { type: "isClass", isClass: true },
    });
    expect(only(parse("presentAsMain!=false"))).toEqual({
      type: "not",
      child: { type: "presentAsMain", presentAsMain: false },
    });
    expect(only(parse("linked!=Paris"))).toEqual({
      type: "not",
      child: { type: "linkedTo", nodeId: NODE_PARIS },
    });
  });

  it("quoted phrases are content-contains terms (usable as field values too)", () => {
    expect(only(parse('"scientific revolutions"'))).toEqual({
      type: "content",
      op: "contains",
      value: "scientific revolutions",
    });
    expect(only(parse('prop:title:"The Structure of Scientific Revolutions"'))).toEqual({
      type: "property",
      schemaId: SCHEMA_TITLE,
      op: "contains",
      value: "The Structure of Scientific Revolutions",
    });
  });

  it("the emitted AST validates against the strict queryAstSchema", () => {
    expect(() => parseQueryAst(parse("class:paper AND year:>2010"))).not.toThrow();
  });
});

describe("parseQueryLanguage: errors (fail loud)", () => {
  it("unknown field lists the known fields", () => {
    try {
      parse("wobble:42");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueryLanguageError);
      expect((error as QueryLanguageError).message).toBe(
        "unknown field 'wobble' (known fields: class, isclass, presentasmain, prop, text, linked, coverasset, bannerasset, aliasednode, year, title)",
      );
    }
  });

  it("unknown class / schema / node names fail at resolution", () => {
    expect(() => parse("class:galaxy")).toThrow(/unknown class 'galaxy'/);
    expect(() => parse("prop:mass:>1")).toThrow(/unknown field 'mass'/);
    expect(() => parse("linked:Berlin")).toThrow(/unknown node 'Berlin'/);
    expect(() => parse("coverAsset:Berlin")).toThrow(/unknown node 'Berlin'/);
  });

  it("wire node-field predicates reject operators that don't fit uuid references", () => {
    expect(() => parse("coverAsset:>x")).toThrow(/not supported here/);
    expect(() => parse("bannerAsset:x contains y")).toThrow(/unknown node 'x'/);
  });

  it("unresolvable names surface the resolver miss even case-insensitively", () => {
    // Resolvers here are exact: 'PAPER' does not resolve.
    expect(() =>
      parseQueryLanguage("class:PAPER", {
        resolvers: { resolveClass: (n) => (n === "paper" ? CLASS_PAPER : undefined) },
      }),
    ).toThrow(/unknown class 'PAPER'/);
  });

  it("rejects unsupported operators per field", () => {
    expect(() => parse("class:paper>3")).toThrow(/unexpected '>'/);
    expect(() => parse("text!=foo")).toThrow(/not supported for text/);
    expect(() => parse("isClass:galaxy")).toThrow(/unknown isClass value 'galaxy'.*expected true or false/);
    expect(() => parse("presentAsMain:1")).toThrow(/unknown presentAsMain value '1'/);
  });

  it("rejects a comparison operator without a value", () => {
    expect(() => parse("year:>")).toThrow(/requires a value/);
  });

  it("rejects unterminated strings, stray parens and trailing tokens", () => {
    expect(() => parse('"unterminated')).toThrow(/unterminated string/);
    expect(() => parse("(class:paper")).toThrow(/expected '\)'/);
    expect(() => parse("class:paper)")).toThrow(/unexpected/);
    expect(() => parse("year!x")).toThrow(/unexpected character '!'/);
  });

  it("errors carry the source position", () => {
    try {
      parse("class:paper)");
      expect.unreachable();
    } catch (error) {
      expect((error as QueryLanguageError).position).toBe(11);
    }
  });
});

describe("looksLikeQueryLanguage", () => {
  it("detects field prefixes, boolean keywords and quoted phrases", () => {
    expect(looksLikeQueryLanguage("class:paper AND year:>2010")).toBe(true);
    expect(looksLikeQueryLanguage("year:1950")).toBe(true);
    expect(looksLikeQueryLanguage("notes AND reminders")).toBe(true);
    expect(looksLikeQueryLanguage('"exact phrase"')).toBe(true);
  });

  it("leaves plain text alone (incl. URL-scheme and clock-time colons)", () => {
    expect(looksLikeQueryLanguage("meeting notes")).toBe(false);
    expect(looksLikeQueryLanguage("https://example.com/docs")).toBe(false);
    expect(looksLikeQueryLanguage("12:30 lunch")).toBe(false);
    expect(looksLikeQueryLanguage("")).toBe(false);
  });
});
