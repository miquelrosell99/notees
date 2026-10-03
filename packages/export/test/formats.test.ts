/**
 * E1 specs: the format registry — markdown/html/docx/latex available, pdf
 * registered as an unavailable skeleton with its reason, per-format option
 * gating from the catalog, and the IR serializer seam.
 */

import { describe, expect, it } from "vitest";

import {
  availableExportFormats,
  buildExportDocument,
  EXPORT_FORMATS,
  EXPORT_OPTION_SPECS,
  getExportFormat,
  resolveExportOptions,
  type ExportContext,
  type ExportFormatId,
  type ExportNode,
} from "../src/index.js";

function makeNode(id: string, text: string): ExportNode {
  return {
    id,
    isClass: 0,
    presentAsMain: 1,
    parentId: null,
    name: text,
    contentAst: [{ type: "text", text }],
    classIds: [],
    properties: [],
  };
}

const CTX: ExportContext = { nameOf: () => undefined, childrenOf: () => [] };

describe("format registry", () => {
  it("registers the five export-redesign formats", () => {
    expect(EXPORT_FORMATS.map((format) => format.id)).toEqual([
      "markdown",
      "html",
      "pdf",
      "docx",
      "latex",
    ]);
  });

  it("marks markdown, html, docx, and latex available; the skeleton carries its landing task", () => {
    expect(availableExportFormats().map((format) => format.id)).toEqual([
      "markdown",
      "html",
      "docx",
      "latex",
    ]);
    const format = getExportFormat("pdf");
    expect(format).toBeDefined();
    expect(format?.availability.status).toBe("unavailable");
    const reason = format?.availability.status === "unavailable" ? format.availability.reason : "";
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toMatch(/task P1/);
  });

  it("unavailable formats throw loud from their serializer", () => {
    const document = buildExportDocument(makeNode("aaaaaaaa-0000-4000-8000-000000000001", "x"), CTX, resolveExportOptions());
    const format = getExportFormat("pdf");
    expect(() => format?.serialize(document)).toThrowError(/not implemented/);
  });

  it("markdown, html, and latex serializers render the IR through the registry", () => {
    const markdown = getExportFormat("markdown");
    expect(markdown?.availability.status).toBe("available");
    const document = buildExportDocument(
      makeNode("aaaaaaaa-0000-4000-8000-000000000002", "Registry render"),
      CTX,
      resolveExportOptions(),
    );
    const md = markdown?.serialize(document, { showTypeLabels: false });
    expect(md).toContain("# Registry render");
    expect(md).toContain("isClass: false");
    const html = getExportFormat("html");
    expect(html?.availability.status).toBe("available");
    const rendered = html?.serialize(document, { layout: "essay" });
    expect(rendered).toContain("<!DOCTYPE html>");
    expect(rendered).toContain("<title>Registry render</title>");
    expect(rendered).toContain('<body class="layout-essay">');
    const latex = getExportFormat("latex");
    expect(latex?.availability.status).toBe("available");
    const tex = latex?.serialize(document, { layout: "academic" });
    expect(tex).toContain("\\documentclass[11pt,twocolumn]{article}");
    expect(tex).toContain("\\section*{Registry render}");
  });

  it("hands each format its gated option specs", () => {
    const keysFor = (id: ExportFormatId): string[] =>
      (getExportFormat(id)?.options ?? []).map((spec) => spec.key);
    // §34.24 gating: pageFormat pdf only; includeAssets markdown only;
    // includeOutline pdf/docx/html (+ markdown by decision).
    expect(keysFor("pdf")).toContain("pageFormat");
    expect(keysFor("markdown")).not.toContain("pageFormat");
    expect(keysFor("markdown")).not.toContain("layout");
    expect(keysFor("markdown")).toContain("includeAssets");
    expect(keysFor("html")).not.toContain("includeAssets");
    // The layout theme gates to the four layout-aware formats.
    for (const id of ["html", "pdf", "docx", "latex"] as const) {
      expect(keysFor(id)).toContain("layout");
    }
    for (const id of ["markdown", "pdf", "docx", "html"] as const) {
      expect(keysFor(id)).toContain("includeOutline");
    }
    expect(keysFor("latex")).not.toContain("includeOutline");
    // Every format honors the IR-wide options.
    for (const id of ["markdown", "html", "pdf", "docx", "latex"] as const) {
      expect(keysFor(id)).toEqual(
        expect.arrayContaining(["includeEmbedded", "hideEmptyProperties", "showTypeLabels"]),
      );
    }
    // The registry specs are exactly the catalog subset (single source).
    for (const format of EXPORT_FORMATS) {
      expect(format.options.map((spec) => spec.key).sort()).toEqual(
        EXPORT_OPTION_SPECS.filter((spec) => spec.appliesTo.includes(format.id))
          .map((spec) => spec.key)
          .sort(),
      );
    }
  });

  it("documents defaults in the catalog (hideEmptyProperties on, embeds off, full closure)", () => {
    const byKey = new Map(EXPORT_OPTION_SPECS.map((spec) => [spec.key, spec]));
    expect(byKey.get("hideEmptyProperties")?.default).toBe(true);
    expect(byKey.get("includeEmbedded")?.default).toBe(false);
    expect(byKey.get("includeOutline")?.default).toBe(true);
    expect(byKey.get("maxDepth")?.default).toBe(null);
    expect(byKey.get("whiteboardMode")?.default).toBe("inline");
    expect(byKey.get("filenamePolicy")?.default).toBe("uuid");
    expect(byKey.get("pageFormat")?.default).toBe("a4");
    expect(byKey.get("layout")?.default).toBe("notes");
  });

  it("resolves the option bag defaults to the hardened E2 behavior", () => {
    const resolved = resolveExportOptions();
    expect(resolved).toEqual({
      includeEmbedded: false,
      includeOutline: true,
      hideEmptyProperties: true,
      showTypeLabels: false,
      pageFormat: "a4",
      layout: "notes",
      includeAssets: false,
      maxDepth: null,
      whiteboardMode: "inline",
      filenamePolicy: "uuid",
    });
    expect(resolveExportOptions({ pageFormat: "letter", maxDepth: 3 }).pageFormat).toBe("letter");
    expect(resolveExportOptions({ pageFormat: "letter", maxDepth: 3 }).maxDepth).toBe(3);
    expect(resolveExportOptions({ layout: "academic" }).layout).toBe("academic");
  });
});
