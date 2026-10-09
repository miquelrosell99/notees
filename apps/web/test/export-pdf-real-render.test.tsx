/**
 * Real-render PDF specs — the one harness that drives the actual
 * react-pdf renderer end to end: real layout pass, real fontkit parsing of
 * the bundled Gentium TTFs, real pdfkit byte emission. Style values and font
 * files only surface errors at layout time, so this file is the regression
 * net for both (export-pdf.test.tsx mocks pdf() and cannot catch them).
 *
 * The component module registers "Gentium" with the vite `?url` paths, which
 * jsdom cannot fetch — drop just that family and re-register the same four
 * faces from disk (Font.clear() would wipe the built-in Helvetica/Courier).
 * Test files run in isolated module graphs, so the store surgery stays
 * file-local.
 */

import { describe, expect, it } from "vitest";
import { Font, pdf } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { resolveExportOptions, type ExportDocument } from "@notees/export";

import { ExportPdfDocument } from "../src/ui/export-pdf/pdfDocument.js";

// The component module registers "Gentium" with the vite `?url` paths, which
// jsdom cannot fetch — drop just that family and re-register the same four
// faces from disk (Font.clear() would wipe the built-in Helvetica/Courier).
// Plain string resolution: vite rewrites `new URL("...", import.meta.url)`
// as an asset reference, which would defeat the file path here.
const TEST_DIR = import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]+$/, "");
const FONTS = `${TEST_DIR}/../src/assets/fonts`;

delete (Font as unknown as { fontFamilies: Record<string, unknown> }).fontFamilies["Gentium"];
Font.register({
  family: "Gentium",
  fonts: [
    { src: `${FONTS}/Gentium-Regular.ttf` },
    { src: `${FONTS}/Gentium-Bold.ttf`, fontWeight: 700 },
    { src: `${FONTS}/Gentium-Italic.ttf`, fontStyle: "italic" },
    { src: `${FONTS}/Gentium-BoldItalic.ttf`, fontWeight: 700, fontStyle: "italic" },
  ],
});

/** An IR exercising every block/span kind (the missing asset renders the placeholder). */
function doc(): ExportDocument {
  return {
    nodeId: "n1",
    title: "Real Render",
    rendersDocumentChrome: true,
    isClass: false,
    presentAsMain: true,
    parentId: null,
    blocks: [
      {
        kind: "paragraph",
        spans: [
          { kind: "text", text: "Body with ", marks: [] },
          { kind: "text", text: "bold", marks: ["bold"] },
          { kind: "text", text: " italic", marks: ["italic"] },
          { kind: "text", text: " code", marks: ["code"] },
          { kind: "mention", targetNodeId: "n2", name: "Mention" },
          { kind: "classChip", classId: "c1", name: "chip" },
          { kind: "typedLink", verb: "by", text: "Author", locator: "p. 1" },
          { kind: "externalLink", text: "link", href: "https://example.com" },
          { kind: "math", expression: "x^2" },
        ],
      },
      { kind: "quote", spans: [{ kind: "text", text: "quoted", marks: [] }] },
      { kind: "asset", assetId: "missing-asset" },
      { kind: "query", queryAst: { op: "and", args: [] } },
      { kind: "whiteboard", layout: { nodes: [] } },
    ],
    properties: [{ schemaId: "s1", schemaName: "Status", value: "planned", display: "planned" }],
    classIds: [],
    classNames: [],
    children: [
      {
        id: "child-1",
        title: "Child",
        presentAsMain: true,
        classIds: [],
        properties: [],
        blocks: [{ kind: "paragraph", spans: [{ kind: "text", text: "child body", marks: [] }] }],
        children: [],
      },
    ],
    assetRefs: [],
  };
}

/** Drain the browser build's toBuffer (the live pdfkit stream) to bytes. */
async function streamBytes(stream: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

describe("ExportPdfDocument real render", () => {
  for (const layout of ["notes", "essay", "academic"] as const) {
    it(`renders a real PDF with the ${layout} layout`, async () => {
      const element = ExportPdfDocument({
        document: doc(),
        options: resolveExportOptions({ layout, pageFormat: layout === "essay" ? "letter" : "a4" }),
      });
      const bytes = await streamBytes(await pdf(element as ReactElement<never>).toBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
      // Embedded TrueType subsets mean the fonts really parsed and shaped.
      expect(bytes.length).toBeGreaterThan(1000);
    }, 30000);
  }
});
