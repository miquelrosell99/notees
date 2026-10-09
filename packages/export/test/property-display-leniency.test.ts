/**
 * Property display leniency + the child-page zone bit (owner 2026-10-09).
 *
 * v1-migrated data rides the log with BARE uuid strings where the v2 model
 * wants `{ nodeId }` refs (verified against the live relay: a v1-imported
 * date property stores `"00000000-0000-0000-00dd-202506240000"` bare, and
 * the exports used to print that uuid verbatim). These specs pin the
 * read-leniency: node-typed schemas (datetime/object/asset) resolve bare
 * strings through ctx.nameOf exactly like canonical refs; scalar schemas
 * never do.
 * Also pinned: booleans render as checkbox glyphs (never literal
 * "true"/"false"), metadata qualifiers resolve to display strings (never a
 * raw uuid or `[object Object]`), and the IR outline children carry the
 * main-zone bit so serializers can split child pages from inline blocks.
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  buildExportDocument,
  qualifierTail,
  resolveExportOptions,
  withoutLeadingTitleBlocks,
  type ExportBlock,
  type ExportContext,
  type ExportNode,
} from "../src/index.js";

const DATE_UUID = "00000000-0000-0000-00dd-202506240000";

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    // Simulates the web's settings-aware resolver: known nodes resolve to
    // display names (date nodes formatted per the user's dateFormat).
    nameOf: (id) =>
      id === "11111111-0000-4000-8000-00000000000a"
        ? "Ada Lovelace"
        : id === DATE_UUID
          ? "2025-06-24"
          : undefined,
    childrenOf: () => [],
    ...overrides,
  };
}

function node(id: string, properties: ExportNode["properties"], extra: Partial<ExportNode> = {}): ExportNode {
  return {
    id,
    isClass: 0,
    presentAsMain: 1,
    parentId: null,
    name: null,
    contentAst: [{ type: "text", text: "Root" }] as ContentAst,
    classIds: [],
    properties,
    ...extra,
  };
}

function docFor(properties: ExportNode["properties"], ctx: ExportContext = makeCtx()) {
  return buildExportDocument(node("aaaaaaaa-0000-4000-8000-000000000001", properties), ctx, resolveExportOptions({}));
}

describe("bare-string node-ref leniency (v1-migrated values)", () => {
  it("resolves a bare uuid string on a datetime schema through nameOf (the settings-aware path)", () => {
    const document = docFor([
      { schemaId: "s-date", schemaName: "Última consulta", schemaType: "datetime", value: DATE_UUID },
    ]);
    expect(document.properties[0]?.display).toBe("2025-06-24");
  });

  it("resolves a bare uuid string through nameOf when the target is known", () => {
    const document = docFor([
      { schemaId: "s-obj", schemaName: "Autor", schemaType: "object", value: "11111111-0000-4000-8000-00000000000a" },
    ]);
    expect(document.properties[0]?.display).toBe("Ada Lovelace");
  });

  it("resolves a canonical { nodeId } ref the same way as before", () => {
    const document = docFor([
      { schemaId: "s-obj", schemaName: "Autor", schemaType: "object", value: { nodeId: "11111111-0000-4000-8000-00000000000a" } },
    ]);
    expect(document.properties[0]?.display).toBe("Ada Lovelace");
  });

  it("keeps bare strings verbatim on scalar schemas (text/url/email/select)", () => {
    const document = docFor([
      { schemaId: "s-text", schemaName: "Nota", schemaType: "text", value: "00000000-0000-0000-00dd-202506240000" },
    ]);
    expect(document.properties[0]?.display).toBe(DATE_UUID);
  });

  it("resolves bare strings inside multi arrays on node-typed schemas", () => {
    const document = docFor([
      {
        schemaId: "s-multi",
        schemaName: "Personas",
        schemaType: "object",
        value: ["11111111-0000-4000-8000-00000000000a", "22222222-0000-4000-8000-00000000000b"],
      },
    ]);
    expect(document.properties[0]?.display).toBe("Ada Lovelace, 22222222-0000-4000-8000-00000000000b");
  });

  it("falls back to the raw uuid when the target is unknown", () => {
    const document = docFor([
      { schemaId: "s-date", schemaName: "Fecha", schemaType: "datetime", value: { nodeId: "33333333-0000-4000-8000-00000000000c" } },
    ]);
    expect(document.properties[0]?.display).toBe("33333333-0000-4000-8000-00000000000c");
  });
});

describe("boolean display", () => {
  it("renders true/false as checkbox glyphs on the IR display", () => {
    const document = docFor([
      { schemaId: "s-b1", schemaName: "Consumido", schemaType: "boolean", value: true },
      { schemaId: "s-b2", schemaName: "Pendiente", schemaType: "boolean", value: false },
    ]);
    expect(document.properties[0]?.display).toBe("☑");
    expect(document.properties[1]?.display).toBe("☐");
  });
});

describe("resolved qualifiers", () => {
  it("resolves a { nodeId } date qualifier through nameOf", () => {
    const document = docFor([
      {
        schemaId: "s-q",
        schemaName: "Cargo",
        schemaType: "object",
        value: { nodeId: "11111111-0000-4000-8000-00000000000a" },
        metadata: { startDate: { nodeId: "11111111-0000-4000-8000-00000000000a" } },
      },
    ]);
    expect(document.properties[0]?.resolvedQualifiers).toEqual([{ key: "startDate", display: "Ada Lovelace" }]);
    expect(qualifierTail(document.properties[0]!)).toBe(" (startDate Ada Lovelace)");
  });

  it("formats an unknown date-node qualifier from the deterministic id (no raw uuid)", () => {
    // nameOf misses the date node here, so the deterministic label rides —
    // in the web the settings-aware resolver answers first (see above).
    const document = docFor(
      [
        {
          schemaId: "s-q",
          schemaName: "Cargo",
          schemaType: "object",
          value: { nodeId: "11111111-0000-4000-8000-00000000000a" },
          metadata: { startDate: DATE_UUID },
        },
      ],
      makeCtx({ nameOf: (id) => (id === "11111111-0000-4000-8000-00000000000a" ? "Ada Lovelace" : undefined) }),
    );
    expect(document.properties[0]?.resolvedQualifiers).toEqual([{ key: "startDate", display: "2025/06/24" }]);
  });

  it("keeps legacy scalar qualifiers as-is", () => {
    const document = docFor([
      {
        schemaId: "s-q",
        schemaName: "Edición",
        schemaType: "text",
        value: "primera",
        metadata: { since: "1962" },
      },
    ]);
    expect(document.properties[0]?.resolvedQualifiers).toEqual([{ key: "since", display: "1962" }]);
  });

  it("renders an odd qualifier value via String(), never [object Object]", () => {
    const document = docFor([
      {
        schemaId: "s-q",
        schemaName: "Nota",
        schemaType: "text",
        value: "x",
        metadata: { repeat: { weekly: 2 } },
      },
    ]);
    expect(document.properties[0]?.resolvedQualifiers).toEqual([{ key: "repeat", display: "[object Object]" }]);
  });

  it("falls back to metadata-based rendering for rows built outside buildExportDocument", () => {
    expect(
      qualifierTail({
        schemaId: "s-q",
        schemaName: "Cargo",
        schemaType: "object",
        value: "x",
        metadata: { startDate: "1962" },
      }),
    ).toBe(" (startDate 1962)");
    expect(qualifierTail({ schemaId: "s-q", schemaName: "Cargo", value: "x" })).toBe("");
  });
});

describe("withoutLeadingTitleBlocks (outline children)", () => {
  const para = (text: string): ExportBlock => ({
    kind: "paragraph",
    spans: [{ kind: "text", text, marks: [] }],
  });

  it("drops the leading paragraph that duplicates the child's title", () => {
    const blocks: ExportBlock[] = [para("El sentido del misterio"), para("cuerpo")];
    expect(withoutLeadingTitleBlocks("El sentido del misterio", blocks)).toEqual([para("cuerpo")]);
  });

  it("drops only the matching span when the paragraph continues", () => {
    const blocks: ExportBlock[] = [
      { kind: "paragraph", spans: [{ kind: "text", text: "Título", marks: [] }, { kind: "hardBreak" }] },
    ];
    expect(withoutLeadingTitleBlocks("Título", blocks)).toEqual([
      { kind: "paragraph", spans: [{ kind: "hardBreak" }] },
    ]);
  });

  it("leaves non-matching and non-paragraph openings untouched", () => {
    const blocks: ExportBlock[] = [para("otro texto")];
    expect(withoutLeadingTitleBlocks("Título", blocks)).toEqual(blocks);
    expect(withoutLeadingTitleBlocks("", blocks)).toEqual(blocks);
  });
});

describe("outline children carry the main-zone bit", () => {
  it("presentAsMain mirrors the child's render bit", () => {
    const ctx = makeCtx({
      childrenOf: (id) =>
        id === "aaaaaaaa-0000-4000-8000-000000000001"
          ? [
              node("bbbbbbbb-0000-4000-8000-000000000002", [], { presentAsMain: 1, parentId: "aaaaaaaa-0000-4000-8000-000000000001" }),
              node("cccccccc-0000-4000-8000-000000000003", [], { presentAsMain: 0, parentId: "aaaaaaaa-0000-4000-8000-000000000001" }),
            ]
          : [],
    });
    const document = docFor([], ctx);
    expect(document.children.map((child) => child.presentAsMain)).toEqual([true, false]);
  });
});
