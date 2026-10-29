/**
 * displayTemplate render tests: a node whose class carries a displayTemplate
 * (sources → "@{{citekey}}") renders the RESOLVED template at the unified
 * title seam everywhere it is referenced, while its own page header opts out
 * (template: "off") and keeps the editable content title (title-is-content
 * stays the authority). Resolution rule: for a non-date, non-class node the
 * FIRST class in classIds order whose effective template resolves wins;
 * placeholders flatten through propertyDisplayText; a fully-empty result
 * falls back to the content title; class and date-chain nodes are never
 * templated.
 */

import { describe, expect, it } from "vitest";

import type { NodeLike } from "@notees/domain";

import type { EffectiveProperty } from "../src/core/workspace-client/index.js";
import { titleOfNode, titleOf, type TitleClient } from "../src/ui/dateDisplay.js";

const SOURCE_CLASS = "11111111-1111-1111-1111-111111111111";
const VIDEO_CLASS = "22222222-2222-2222-2222-222222222222";
const BOOK_CLASS = "33333333-3333-3333-3333-333333333333";
const DAY_CLASS = "00000000-0000-0000-0001-000000000005";
const DAY_ID = "00000000-0000-0000-00dd-202906270000";

function textProp(name: string, value: unknown, multi = false): EffectiveProperty {
  return {
    propertySchemaId: `schema-${name}`,
    idx: 0,
    elementId: `element-${name}`,
    schema: {
      id: `schema-${name}`,
      name,
      type: "text",
      multi,
      datePrecision: null,
      dateQualified: null,
    },
    value,
    metadata: null,
    source: "authored",
    boundBy: null,
    eligible: true,
    hideWhenEmpty: null,
    display: null,
  };
}

type TemplateClient = TitleClient;

/** The minimal title client + the three template reads, with per-class
 *  templates and per-node effective properties supplied by the test. */
function makeClient(opts: {
  nodes: Map<string, Record<string, unknown>>;
  templates?: Map<string, string | null>;
  props?: Map<string, EffectiveProperty[]>;
}): TemplateClient {
  return {
    getNode: (id) => opts.nodes.get(id) as NodeLike | undefined,
    getDisplayName: () => null,
    resolveEffectiveDisplayTemplate: (classId) => opts.templates?.get(classId) ?? null,
    getEffectiveProperties: (id) => opts.props?.get(id) ?? [],
    listPropertySchemas: () => [],
  };
}

function sourceNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    isClass: false as const,
    isEmbedded: false as const,
    name: null,
    classIds: [SOURCE_CLASS],
    contentAst: [{ type: "text", text: "The Long Way to a Small Angry Planet" } as const],
    ...overrides,
  };
}

describe("titleOf — class displayTemplate at the seam", () => {
  it("renders the resolved template for a templated class (citekey)", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode()]]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}}"]]),
      props: new Map([["n1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "n1")).toBe("@doe2024");
  });

  it("joins multi values inside the template via propertyDisplayText", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode()]]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}} — {{authors}}"]]),
      props: new Map([
        ["n1", [textProp("citekey", "doe2024"), textProp("authors", ["J. Doe", "K. Roe"], true)]],
      ]),
    });
    expect(titleOf(client, "n1")).toBe("@doe2024 — J. Doe, K. Roe");
  });

  it("applies the DISPLAY_NAME_MAX cap on the capped budget (full renders whole)", () => {
    const longCitekey = "x".repeat(100);
    const client = makeClient({
      nodes: new Map([["n1", sourceNode()]]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}}"]]),
      props: new Map([["n1", [textProp("citekey", longCitekey)]]]),
    });
    const capped = titleOf(client, "n1");
    expect(capped).toHaveLength(80);
    const full = titleOf(client, "n1", { budget: "full" });
    expect(full).toBe(`@${longCitekey}`);
  });

  it("falls back to the content title when the placeholder is unvalued", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode()]]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}}"]]),
      props: new Map([["n1", [textProp("citekey", "")]]]),
    });
    expect(titleOf(client, "n1")).toBe("The Long Way to a Small Angry Planet");
  });

  it("falls back to the content title when the node's class opted out (no template)", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode({ classIds: [VIDEO_CLASS] })]]),
      templates: new Map([[VIDEO_CLASS, null]]),
      props: new Map([["n1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "n1")).toBe("The Long Way to a Small Angry Planet");
  });

  it("first templated class in classIds order wins", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode({ classIds: [VIDEO_CLASS, SOURCE_CLASS, BOOK_CLASS] })]]),
      templates: new Map([
        [VIDEO_CLASS, null],
        [SOURCE_CLASS, "@{{citekey}}"],
        [BOOK_CLASS, "{{citekey}} (book)"],
      ]),
      props: new Map([["n1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "n1")).toBe("@doe2024");
  });

  it("skips an untemplated earlier class and uses the later templated one", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode({ classIds: [VIDEO_CLASS, BOOK_CLASS] })]]),
      templates: new Map([
        [VIDEO_CLASS, null],
        [BOOK_CLASS, "{{citekey}} (book)"],
      ]),
      props: new Map([["n1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "n1")).toBe("doe2024 (book)");
  });

  it("template: 'off' returns the content title (the page-header opt-out)", () => {
    const client = makeClient({
      nodes: new Map([["n1", sourceNode()]]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}}"]]),
      props: new Map([["n1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "n1", { template: "off" })).toBe(
      "The Long Way to a Small Angry Planet",
    );
    expect(titleOfNode(sourceNode(), { template: "off" })).toBe(
      "The Long Way to a Small Angry Planet",
    );
  });

  it("never templates a class node (a class has its own name)", () => {
    const client = makeClient({
      nodes: new Map([
        [
          "c1",
          {
            id: "c1",
            isClass: true as const,
            name: null,
            classIds: [SOURCE_CLASS],
            contentAst: [{ type: "text", text: "source" } as const],
          },
        ],
      ]),
      templates: new Map([[SOURCE_CLASS, "@{{citekey}}"]]),
      props: new Map([["c1", [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, "c1")).toBe("source");
  });

  it("never templates a date-chain node (date formatting is frozen platform behavior)", () => {
    const client = makeClient({
      nodes: new Map([
        [
          DAY_ID,
          {
            id: DAY_ID,
            isClass: false as const,
            isEmbedded: false as const,
            name: null,
            classIds: [DAY_CLASS],
            contentAst: [{ type: "text", text: "20290627" } as const],
          },
        ],
      ]),
      templates: new Map([[DAY_CLASS, "@{{citekey}}"]]),
      props: new Map([[DAY_ID, [textProp("citekey", "doe2024")]]]),
    });
    expect(titleOf(client, DAY_ID)).toBe("2029-06-27");
  });
});
