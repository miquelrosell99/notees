/**
 * JSON archive specs (§34.12 Tier-1 + §34.24 parked row "JSON archive",
 * 2026-10-04): the versioned envelope, verbatim node payloads, the edges
 * metadata mined from streams and property values, id de-duplication, and a
 * parse-back sanity of the rendered document.
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  buildJsonArchive,
  JSON_ARCHIVE_FORMAT,
  JSON_ARCHIVE_VERSION,
  renderJsonArchive,
  type ExportContext,
  type ExportNode,
} from "../src/index.js";

const PAGE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";
const PUBLISHED_SCHEMA_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const EMBED_ID = "66666666-6666-4666-8666-666666666666";
const AUTHOR_ID = "77777777-7777-4777-8777-777777777777";
const DATE_NODE_ID = "00000000-0000-0000-00bb-2020010200000";

const NOW = "2026-10-04T12:00:00.000Z";

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    nameOf: () => undefined,
    childrenOf: () => [],
    ...overrides,
  };
}

function page(id: string, contentAst: ContentAst = [], extra: Partial<ExportNode> = {}): ExportNode {
  return {
    id,
    isClass: 0,
    presentAsMain: 1,
    parentId: null,
    name: null,
    contentAst,
    classIds: [],
    properties: [],
    ...extra,
  };
}

describe("buildJsonArchive", () => {
  it("emits the versioned envelope with a stable format discriminator", () => {
    expect(JSON_ARCHIVE_FORMAT).toBe("notees-json-archive");
    expect(JSON_ARCHIVE_VERSION).toBe(1);
    const archive = buildJsonArchive([page(PAGE_ID)], makeCtx(), { now: NOW });
    expect(archive.format).toBe("notees-json-archive");
    expect(archive.version).toBe(1);
    expect(archive.generatedAt).toBe(NOW);
    expect(archive.nodes).toHaveLength(1);
  });

  it("carries verbatim contentAst, classIds, properties, and the render-state bits", () => {
    const contentAst: ContentAst = [
      { type: "text", text: "Bold", marks: ["bold"] },
      { type: "mention", targetNodeId: AUTHOR_ID, text: "Le Guin" },
    ];
    const properties = [
      {
        schemaId: PUBLISHED_SCHEMA_ID,
        schemaName: "published in",
        schemaType: "date",
        value: { nodeId: DATE_NODE_ID },
        metadata: { startDate: { nodeId: DATE_NODE_ID } },
      },
    ];
    const node = page(PAGE_ID, contentAst, {
      classIds: [PERSON_CLASS_ID],
      properties,
      name: "display name",
    });
    const archive = buildJsonArchive([node], makeCtx(), { now: NOW });
    expect(archive.nodes[0]).toMatchObject({
      id: PAGE_ID,
      isClass: false,
      presentAsMain: true,
      parentId: null,
      // Title-is-content: the display name derives from the content excerpt.
      displayName: "Bold Le Guin",
      contentAst,
      classIds: [PERSON_CLASS_ID],
      properties,
    });
  });

  it("records position-ordered child ids without recursing into the child", () => {
    const ctx = makeCtx({
      childrenOf: (id) =>
        id === PAGE_ID
          ? [
              page(CHILD_ID, [{ type: "text", text: "child" }]),
              page("cccccccc-0000-4000-8000-000000000003"),
            ]
          : [],
    });
    const archive = buildJsonArchive([page(PAGE_ID)], ctx, { now: NOW });
    expect(archive.nodes).toHaveLength(1);
    expect(archive.nodes[0]!.children).toEqual([
      CHILD_ID,
      "cccccccc-0000-4000-8000-000000000003",
    ]);
  });

  it("mines edges from the content stream (mention, embed, chip, typed links, asset) and quote nesting", () => {
    const node = page(PAGE_ID, [
      { type: "mention", targetNodeId: AUTHOR_ID, text: "Le Guin" },
      { type: "embed_ref", nodeId: EMBED_ID },
      { type: "class_chip", classId: PERSON_CLASS_ID },
      { type: "typed_link", verb: "cites", text: "claim" },
      { type: "typed_link", verb: { propertySchemaId: PUBLISHED_SCHEMA_ID }, text: "journal" },
      { type: "asset_ref", assetId: ASSET_ID },
      { type: "quote", children: [{ type: "mention", targetNodeId: AUTHOR_ID, text: "again" }] },
    ]);
    const archive = buildJsonArchive([node], makeCtx(), { now: NOW });
    expect(archive.nodes[0]!.edges).toEqual([
      { kind: "mention", targetNodeId: AUTHOR_ID },
      { kind: "embed", targetNodeId: EMBED_ID },
      { kind: "class", classId: PERSON_CLASS_ID },
      { kind: "typedLink", verb: "cites", schemaId: null },
      { kind: "typedLink", verb: null, schemaId: PUBLISHED_SCHEMA_ID },
      { kind: "asset", assetId: ASSET_ID },
      // The quote-nested mention rides as the last edge.
      { kind: "mention", targetNodeId: AUTHOR_ID },
    ]);
  });

  it("mines property edges from node-typed values, including arrays and date ranges", () => {
    const node = page(PAGE_ID, [], {
      properties: [
        {
          schemaId: PUBLISHED_SCHEMA_ID,
          schemaName: "published in",
          value: { start: { nodeId: DATE_NODE_ID }, end: null },
        },
        {
          schemaId: "99999999-9999-4999-8999-999999999999",
          schemaName: "authors",
          value: [{ nodeId: AUTHOR_ID }, { nodeId: EMBED_ID }],
        },
      ],
    });
    const archive = buildJsonArchive([node], makeCtx(), { now: NOW });
    expect(archive.nodes[0]!.edges).toEqual([
      { kind: "property", schemaId: PUBLISHED_SCHEMA_ID, targetNodeId: DATE_NODE_ID },
      { kind: "property", schemaId: "99999999-9999-4999-8999-999999999999", targetNodeId: AUTHOR_ID },
      { kind: "property", schemaId: "99999999-9999-4999-8999-999999999999", targetNodeId: EMBED_ID },
    ]);
  });

  it("collapses duplicate ids to the first occurrence (overlapping slices)", () => {
    const archive = buildJsonArchive(
      [page(PAGE_ID, [{ type: "text", text: "first" }]), page(PAGE_ID, [{ type: "text", text: "second" }])],
      makeCtx(),
      { now: NOW },
    );
    expect(archive.nodes).toHaveLength(1);
    expect(archive.nodes[0]!.contentAst).toEqual([{ type: "text", text: "first" }]);
  });

  it("derives the redundant displayName from content (title-is-content)", () => {
    const node = page(PAGE_ID, [{ type: "text", text: "The Left Hand of Darkness" }]);
    expect(buildJsonArchive([node], makeCtx(), { now: NOW }).nodes[0]!.displayName).toBe(
      "The Left Hand of Darkness",
    );
  });
});

describe("renderJsonArchive", () => {
  it("parse-back sanity: the rendered document re-parses to an identical envelope", () => {
    const node = page(PAGE_ID, [{ type: "text", text: "body" }], {
      classIds: [PERSON_CLASS_ID],
      properties: [
        {
          schemaId: PUBLISHED_SCHEMA_ID,
          schemaName: "published in",
          value: { nodeId: DATE_NODE_ID },
        },
      ],
    });
    const archive = buildJsonArchive([node], makeCtx(), { now: NOW });
    const rendered = renderJsonArchive(archive);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(archive);
    const parsed = JSON.parse(rendered) as { format: string; version: number; nodes: unknown[] };
    expect(parsed.format).toBe("notees-json-archive");
    expect(parsed.version).toBe(1);
    expect(parsed.nodes).toHaveLength(1);
  });
});
