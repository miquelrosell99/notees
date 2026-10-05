/**
 * Single-title rule (owner 2026-10-05): title-is-content means a page's
 * display name IS its own text content — the export used to render that
 * text twice, once as the document-chrome title heading and again as the
 * body's first line. These specs pin the fixed behavior for every
 * chrome-emitting serializer: the frontmatter/core name stays, ONE title
 * heading is emitted, and the body does not repeat the title line. Nodes
 * without chrome (inline blocks) and outline children keep their content
 * verbatim — the rule only drops the span that rides in the heading.
 */

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  buildExportDocument,
  nodeToMarkdown,
  renderExportDocumentToDocx,
  renderExportDocumentToHtml,
  renderExportDocumentToLatex,
  resolveExportOptions,
  type ExportContext,
  type ExportNode,
} from "../src/index.js";

const TITLE = "El arte de la guerra, de Sun Tzu";

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return { nameOf: () => undefined, childrenOf: () => [], ...overrides };
}

function page(id: string, contentAst: ContentAst, extra: Partial<ExportNode> = {}): ExportNode {
  // A parentless non-class node: document chrome, title derived from content.
  return { id, isClass: 0, presentAsMain: 1, parentId: null, name: null, contentAst, classIds: [], properties: [], ...extra };
}

function block(id: string, contentAst: ContentAst): ExportNode {
  // A parented node with the render bit unset: no document chrome.
  return { id, isClass: 0, presentAsMain: 0, parentId: "ffffffff-0000-4000-8000-000000000000", name: null, contentAst, classIds: [], properties: [] };
}

describe("single-title rule (markdown)", () => {
  it("emits the frontmatter name and ONE H1, with no title line in the body", () => {
    const md = nodeToMarkdown(
      page("aaaaaaaa-0000-4000-8000-000000000001", [{ type: "text", text: TITLE }]),
      makeCtx(),
    );
    expect(md).toBe(
      [
        "---",
        `name: ${JSON.stringify(TITLE)}`,
        "isClass: false",
        "presentAsMain: true",
        "---",
        "",
        `# ${TITLE}`,
        "",
      ].join("\n"),
    );
    // The title appears exactly once outside the frontmatter.
    expect(md.split(`# ${TITLE}`)).toHaveLength(2);
    expect(md).not.toContain(`\n\n${TITLE}\n`);
  });

  it("drops a marked title span wholesale — marks do not shield it from the rule", () => {
    const md = nodeToMarkdown(
      page("aaaaaaaa-0000-4000-8000-000000000002", [
        { type: "text", text: TITLE, marks: ["bold"] },
      ]),
      makeCtx(),
    );
    expect(md).toContain(`# ${TITLE}`);
    // The marked run does NOT resurface as the body's first line.
    expect(md).not.toContain(`**${TITLE}**`);
    expect(md).not.toContain(`\n\n${TITLE}\n`);
  });

  it("keeps a leading title line that is only the excerpt's prefix", () => {
    const md = nodeToMarkdown(
      page("aaaaaaaa-0000-4000-8000-000000000003", [
        { type: "text", text: "Prefacio" },
        { type: "text", text: " y notas" },
      ]),
      makeCtx(),
    );
    // Title is "Prefacio y notas" — the first span is NOT the whole title,
    // so nothing is dropped: the body still opens with the full line.
    expect(md).toContain("# Prefacio y notas");
    expect(md).toContain("\n\nPrefacio y notas\n");
  });

  it("drops the title span but keeps a following structural block", () => {
    const md = nodeToMarkdown(
      page("aaaaaaaa-0000-4000-8000-000000000004", [
        { type: "text", text: "Mi pizarra" },
        { type: "whiteboard", layout: { shapes: [] } },
      ]),
      makeCtx(),
    );
    expect(md).toContain("# Mi pizarra");
    expect(md).not.toContain("\n\nMi pizarra\n");
    expect(md).toContain('```json\n{\n  "shapes": []\n}\n```');
  });

  it("leaves inline blocks (no chrome) untouched — their title never surfaces as a heading", () => {
    const md = nodeToMarkdown(
      block("aaaaaaaa-0000-4000-8000-000000000005", [{ type: "text", text: "block body" }]),
      makeCtx(),
    );
    expect(md).not.toContain("# ");
    expect(md).toContain("block body");
  });

  it("leaves outline children untouched — their first line is their bullet", () => {
    const child = block("bbbbbbbb-0000-4000-8000-000000000001", [
      { type: "text", text: "child title" },
    ]);
    const md = nodeToMarkdown(
      page("aaaaaaaa-0000-4000-8000-000000000006", [{ type: "text", text: "Root" }]),
      makeCtx({ childrenOf: () => [child] }),
    );
    expect(md).toContain("# Root");
    expect(md).toContain("- child title");
  });
});

describe("single-title rule (html / latex / docx)", () => {
  const node = page("aaaaaaaa-0000-4000-8000-000000000010", [{ type: "text", text: TITLE }]);

  it("html: <title> and <h1> carry the title; <main> does not repeat it", () => {
    const resolved = resolveExportOptions();
    const html = renderExportDocumentToHtml(buildExportDocument(node, makeCtx(), resolved), resolved);
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain(`<h1>${TITLE}</h1>`);
    expect(html).not.toContain(`<p>${TITLE}</p>`);
  });

  it("latex: the section heading carries the title; no second paragraph repeats it", () => {
    const resolved = resolveExportOptions();
    const tex = renderExportDocumentToLatex(buildExportDocument(node, makeCtx(), resolved), resolved);
    expect(tex).toContain(`\\section*{${TITLE}}`);
    expect(tex.split(TITLE)).toHaveLength(2);
  });

  it("docx: the Title heading carries the title; the body has no second copy", async () => {
    const resolved = resolveExportOptions();
    const bytes = await renderExportDocumentToDocx(buildExportDocument(node, makeCtx(), resolved), resolved);
    const documentXml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"] ?? new Uint8Array());
    expect(documentXml).toContain('<w:pStyle w:val="Title"/>');
    expect(documentXml).toContain(`>${TITLE}</w:t>`);
    expect(documentXml.split(`>${TITLE}</w:t>`)).toHaveLength(2);
  });
});
