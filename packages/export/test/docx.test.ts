/**
 * D1 specs: the ExportDocument → Word .docx projection — package shape,
 * document chrome (Title heading), properties table + options honoring,
 * token → run/paragraph mapping (marks, breaks, mentions, chips, typed and
 * external links, math), quote/asset/embed/query/whiteboard blocks, the
 * bullet-paragraph outline (levels + visible cuts), layout theming via
 * docDefaults, and the registry seam resolving to package bytes.
 *
 * The produced .docx is an OOXML zip; specs unzip it with fflate and assert
 * structurally on word/document.xml / word/styles.xml (text presence + run
 * and style properties), never on golden bytes.
 */

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  buildExportDocument,
  getExportFormat,
  renderExportDocumentToDocx,
  resolveExportOptions,
  type ExportContext,
  type ExportNode,
  type ExportOptions,
} from "../src/index.js";

const EMBED_ID = "66666666-6666-4666-8666-666666666666";
const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "88888888-8888-4888-8888-888888888888";

const NAMES = new Map<string, string>([
  [EMBED_ID, "Embedded target"],
  [PERSON_CLASS_ID, "person"],
]);

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return { nameOf: (id) => NAMES.get(id), childrenOf: () => [], ...overrides };
}

function page(
  id: string,
  text: string,
  contentAst: ContentAst = [],
  extra: Partial<ExportNode> = {},
): ExportNode {
  return {
    id,
    isClass: 0,
    presentAsMain: 1,
    parentId: null,
    name: null,
    contentAst: contentAst.length > 0 ? contentAst : [{ type: "text", text }],
    classIds: [],
    properties: [],
    ...extra,
  };
}

interface DocxParts {
  bytes: Uint8Array;
  document: string;
  styles: string;
  numbering: string;
}

async function toDocx(node: ExportNode, ctx: ExportContext, options?: ExportOptions): Promise<DocxParts> {
  const resolved = resolveExportOptions(options);
  const document = buildExportDocument(node, ctx, resolved);
  const bytes = await renderExportDocumentToDocx(document, resolved);
  const files = unzipSync(bytes);
  const decode = (path: string): string => new TextDecoder().decode(files[path] ?? new Uint8Array());
  return {
    bytes,
    document: decode("word/document.xml"),
    styles: decode("word/styles.xml"),
    numbering: decode("word/numbering.xml"),
  };
}

describe("package shape", () => {
  it("resolves to .docx package bytes (an OOXML zip with the expected parts)", async () => {
    const { bytes, document, styles } = await toDocx(
      page("aaaaaaaa-0000-4000-8000-000000000001", "Package"),
      makeCtx(),
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // Magic bytes: PK zip header (a .docx file is a zip package).
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(document).toContain("<w:document");
    expect(styles).toContain("<w:styles");
  });
});

describe("document chrome", () => {
  it("emits the title as a Title-style paragraph", async () => {
    const { document } = await toDocx(
      page("aaaaaaaa-0000-4000-8000-000000000002", "My Page"),
      makeCtx(),
    );
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).toContain('<w:t xml:space="preserve">My Page</w:t>');
  });

  it("falls back to the node id for the Title heading when the title is empty", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000003";
    const node: ExportNode = { ...page(id, "x"), contentAst: [] };
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:pStyle w:val="Title"/>');
    expect(document).toContain(`<w:t xml:space="preserve">${id}</w:t>`);
  });

  it("omits the Title heading for nodes without document chrome (inline blocks)", async () => {
    const inline: ExportNode = {
      id: "aaaaaaaa-0000-4000-8000-000000000004",
      isClass: 0,
      presentAsMain: 0,
      parentId: "bbbbbbbb-0000-4000-8000-000000000000",
      name: null,
      contentAst: [{ type: "text", text: "inline body" }],
      classIds: [],
      properties: [],
    };
    const { document } = await toDocx(inline, makeCtx());
    expect(document).not.toContain('w:val="Title"');
    expect(document).toContain('<w:t xml:space="preserve">inline body</w:t>');
  });
});

describe("properties table", () => {
  const properties: ExportNode["properties"] = [
    { schemaId: "s1", schemaName: "status", value: "" },
    { schemaId: "s6", schemaName: "count", value: null },
    { schemaId: "s2", schemaName: "keep", value: 0 },
    { schemaId: "s3", schemaName: "label", value: "x" },
    { schemaId: "s4", schemaName: "label", value: "y", metadata: { since: 1962 } },
    { schemaId: "s5", schemaName: "ref", value: { nodeId: EMBED_ID } },
  ];

  it("renders one borderless row per schema: bold label, one paragraph per value, qualifiers inline", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000010", "props", [], { properties });
    const { document } = await toDocx(node, makeCtx(), { hideEmptyProperties: false });
    expect(document).toContain("<w:tbl>");
    // The docx library paints single borders on unspecified table edges; the
    // properties grid is deliberately borderless (labeled-grid layout).
    expect(document).toContain('<w:top w:val="none"/>');
    expect(document).toContain('<w:insideH w:val="none"/>');
    // Bold label run, then the visible "null" placeholder for a null value.
    expect(document).toContain('<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">status</w:t>');
    expect(document).toContain('<w:t xml:space="preserve">null</w:t>');
    expect(document).toContain('<w:t xml:space="preserve">keep</w:t>');
    expect(document).toContain('<w:t xml:space="preserve">0</w:t>');
    // One "label" label for the two-value schema; each value its own
    // paragraph with the qualifier appended inline.
    expect(document.match(/<w:t xml:space="preserve">label<\/w:t>/g)).toHaveLength(1);
    expect(document).toContain('<w:t xml:space="preserve">x</w:t>');
    expect(document).toContain('<w:t xml:space="preserve">y (since 1962)</w:t>');
    // Node-typed values resolve rename-free to the target's current name.
    expect(document).toContain('<w:t xml:space="preserve">Embedded target</w:t>');
  });

  it("hides empty values by default and shows them when hideEmptyProperties is off", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000011", "props", [], { properties });
    const hidden = await toDocx(node, makeCtx());
    expect(hidden.document).not.toContain('>status</w:t>');
    expect(hidden.document).not.toContain('>count</w:t>');
    expect(hidden.document).toContain('>keep</w:t>');
    const shown = await toDocx(node, makeCtx(), { hideEmptyProperties: false });
    expect(shown.document).toContain('<w:t xml:space="preserve">status</w:t>');
    expect(shown.document).toContain('<w:t xml:space="preserve">null</w:t>');
  });

  it("drops the table entirely when nothing survives the filter", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000012", "props", [], {
      properties: [{ schemaId: "s1", schemaName: "status", value: "" }],
    });
    const { document } = await toDocx(node, makeCtx());
    expect(document).not.toContain("<w:tbl>");
    // The document chrome (title) stays — only the properties rows go.
    expect(document).toContain('<w:pStyle w:val="Title"/>');
  });

  it("renders the classNames row when showTypeLabels is on, omitting it by default", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000013", "labels", [], {
      classIds: [PERSON_CLASS_ID],
    });
    const labeled = await toDocx(node, makeCtx(), { showTypeLabels: true });
    expect(labeled.document).toContain('<w:t xml:space="preserve">classNames</w:t>');
    expect(labeled.document).toContain('<w:t xml:space="preserve">person</w:t>');
    expect((await toDocx(node, makeCtx())).document).not.toContain("classNames");
  });
});

describe("inline spans", () => {
  it("maps marks to run properties (bold/italics/strike/highlight/code font)", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000020", "marks", [
      // A lead run keeps the marked run out of the title (single-title rule)
      // so the body paragraph carries it.
      { type: "text", text: "lead " },
      { type: "text", text: "all", marks: ["bold", "italic", "strike", "highlight", "code"] },
    ]);
    const { document } = await toDocx(node, makeCtx());
    // The content-derived Title heading does not carry the marked run; the
    // body run is the one carrying run properties.
    const runs = [...document.matchAll(/<w:r>.*?<\/w:r>/g)].map((match) => match[0]);
    const run = runs.find((candidate) => candidate.includes("<w:rPr>") && candidate.includes(">all</w:t>"));
    expect(run).toBeDefined();
    expect(run).toContain("<w:b/>");
    expect(run).toContain("<w:i/>");
    expect(run).toContain("<w:strike/>");
    expect(run).toContain('<w:highlight w:val="yellow"/>');
    expect(run).toContain('w:ascii="Courier New"');
  });

  it("maps each mark to its own run", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000021", "marks", [
      { type: "text", text: "b", marks: ["bold"] },
      { type: "text", text: "i", marks: ["italic"] },
      { type: "text", text: "s", marks: ["strike"] },
      { type: "text", text: "c", marks: ["code"] },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">b</w:t>');
    expect(document).toContain('<w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">i</w:t>');
    expect(document).toContain('<w:strike/></w:rPr><w:t xml:space="preserve">s</w:t>');
    expect(document).toContain('w:ascii="Courier New"');
  });

  it("XML-escapes text content (< and & ride as character data)", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000022", "escape", [
      { type: "text", text: "a < b & c" },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain("a &lt; b &amp; c");
  });

  it("maps hard_break to a real line break inside the paragraph", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000023", "break", [
      { type: "text", text: "one" },
      { type: "hard_break" },
      { type: "text", text: "two" },
    ]);
    const { document } = await toDocx(node, makeCtx());
    const paragraph = document.match(/<w:p>(?:(?!\/w:p>).)*one<\/w:t>(?:(?!\/w:p>).)*<\/w:p>/)?.[0] ?? "";
    expect(paragraph).toContain("<w:br/>");
    expect(paragraph.indexOf("one")).toBeLessThan(paragraph.indexOf("<w:br/>"));
    expect(paragraph.indexOf("<w:br/>")).toBeLessThan(paragraph.indexOf("two"));
  });

  it("maps mentions to plain resolved names (no link relationships)", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000024", "mention", [
      { type: "mention", targetNodeId: EMBED_ID, text: "Embedded target" },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:t xml:space="preserve">Embedded target</w:t>');
  });

  it("maps class chips to #name runs", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000025", "chip", [
      { type: "class_chip", classId: PERSON_CLASS_ID },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:t xml:space="preserve">#person</w:t>');
  });

  it("maps typed links to a bold verb run plus text and locator runs", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000026", "typed", [
      { type: "typed_link", verb: "authored", text: "Le Guin", metadata: { locator: "p. 42" } },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">authored</w:t>');
    expect(document).toContain('<w:t xml:space="preserve"> Le Guin</w:t>');
    expect(document).toContain('<w:t xml:space="preserve"> (p. 42)</w:t>');
  });

  it("maps external links to text followed by the href in parentheses", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000027", "link", [
      { type: "external_link", href: "https://example.com/a?b=1&c=2", text: "a site" },
    ]);
    const { document } = await toDocx(node, makeCtx());
    // v1 link convention: plain text + (href) — a real docx Hyperlink would
    // need a relationship id; the & rides as &amp; character data.
    expect(document).toContain("a site (https://example.com/a?b=1&amp;c=2)");
  });

  it("maps math to the $expression$ text", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000028", "math", [
      { type: "math", expression: "a<b" },
    ]);
    const { document } = await toDocx(node, makeCtx());
    expect(document).toContain("$a&lt;b$");
  });
});

describe("block-scale content", () => {
  it("renders quotes with the Quote style (italics + left indent)", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000040", "quote", [
      { type: "text", text: "intro" },
      { type: "quote", children: [{ type: "text", text: "quoted words" }] },
    ]);
    const { document, styles } = await toDocx(node, makeCtx());
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
    expect(document).toContain('<w:t xml:space="preserve">quoted words</w:t>');
    // The Quote style is ours (the library ships no default): italics + indent.
    const quoteStyle = styles.match(/<w:style w:type="paragraph" w:styleId="Quote">.*?(?=<\/w:style>)/)?.[0] ?? "";
    expect(quoteStyle).toContain("<w:i/>");
    expect(quoteStyle).toContain('<w:ind w:left="480"/>');
  });

  it("renders an asset as a bordered Asset: placeholder, printing the path when resolved", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000041", "asset", [
      { type: "asset_ref", assetId: ASSET_ID },
    ]);
    const bare = await toDocx(node, makeCtx());
    expect(bare.document).toContain("<w:pBdr>");
    expect(bare.document).toContain('<w:t xml:space="preserve">Asset: </w:t>');
    expect(bare.document).toContain(`<w:t xml:space="preserve">${ASSET_ID}</w:t>`);
    const linked = await toDocx(node, makeCtx({ assetPath: () => "assets/photo.png" }));
    const placeholder =
      linked.document.match(/<w:p>(?:(?!\/w:p>).)*Asset:(?:(?!\/w:p>).)*<\/w:p>/)?.[0] ?? "";
    expect(placeholder).toContain("<w:pBdr>");
    expect(placeholder).toContain('w:ascii="Courier New"');
    expect(placeholder).toContain("assets/photo.png");
  });

  it("renders query and whiteboard blocks as monospace line-broken JSON", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000042", "widgets", [
      { type: "query", queryAst: { field: "tag" } },
      { type: "whiteboard", layout: { nodes: [] } },
    ]);
    const { document } = await toDocx(node, makeCtx());
    // Pretty-printed JSON, one line per run with real <w:br/> jumps, in
    // Courier New; the quote characters ride as &quot; character data.
    expect(document).toContain('w:ascii="Courier New"');
    expect(document).toContain("&quot;field&quot;: &quot;tag&quot;");
    expect(document).toContain("&quot;nodes&quot;: []");
    expect(document.match(/<w:br\/>/g)).not.toHaveLength(0);
  });

  it("falls back to the ![[uuid]] reference when the embed is unresolved", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000043", "host", [
      { type: "embed_ref", nodeId: EMBED_ID },
    ]);
    const { document } = await toDocx(node, makeCtx(), { includeEmbedded: true });
    expect(document).toContain(`<w:t xml:space="preserve">![[${EMBED_ID}]]</w:t>`);
  });

  it("renders an unresolved embed as name (path) when the IR resolved a bundle path", async () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000044", "host", [
      { type: "embed_ref", nodeId: EMBED_ID },
    ]);
    const { document } = await toDocx(
      node,
      makeCtx({ linkTarget: () => ({ path: "pages/embedded-target.md" }) }),
    );
    expect(document).toContain("Embedded target (pages/embedded-target.md)");
  });

  it("renders an inlined embed recursively (includeEmbedded)", async () => {
    const target = page(EMBED_ID, "Embedded target", [
      { type: "text", text: "the embedded body" },
      { type: "quote", children: [{ type: "text", text: "embedded quote" }] },
    ]);
    const host = page("aaaaaaaa-0000-4000-8000-000000000045", "host", [
      { type: "text", text: "before " },
      { type: "embed_ref", nodeId: EMBED_ID },
      { type: "text", text: " after" },
    ]);
    const { document } = await toDocx(host, makeCtx({ nodeOf: () => target }), {
      includeEmbedded: true,
    });
    expect(document).toContain('<w:t xml:space="preserve">the embedded body</w:t>');
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
    expect(document).not.toContain(`![[${EMBED_ID}]]`);
  });
});

describe("outline", () => {
  function tree(): { root: ExportNode; ctx: ExportContext } {
    const root = page("aaaaaaaa-0000-4000-8000-000000000050", "root");
    const child = page("bbbbbbbb-0000-4000-8000-000000000001", "child", [
      { type: "text", text: "child body" },
    ]);
    const grandchild = page("cccccccc-0000-4000-8000-000000000001", "grandchild", [
      { type: "text", text: "grandchild body" },
    ]);
    const children = new Map<string, ExportNode[]>([
      [root.id, [child]],
      [child.id, [grandchild]],
    ]);
    return { root, ctx: makeCtx({ childrenOf: (id) => children.get(id) ?? [] }) };
  }

  it("renders the children tree as bullet paragraphs whose level follows depth", async () => {
    const { root, ctx } = tree();
    const { document, numbering } = await toDocx(root, ctx);
    // The child rides at bullet level 0, the grandchild at level 1.
    const childParagraph =
      document.match(/<w:p>(?:(?!\/w:p>).)*child body<\/w:t><\/w:r><\/w:p>/)?.[0] ?? "";
    expect(childParagraph).toContain('<w:ilvl w:val="0"/>');
    expect(childParagraph).toContain("<w:numPr>");
    const grandchildParagraph =
      document.match(/<w:p>(?:(?!\/w:p>).)*grandchild body<\/w:t><\/w:r><\/w:p>/)?.[0] ?? "";
    expect(grandchildParagraph).toContain('<w:ilvl w:val="1"/>');
    // The numbering definition the paragraphs reference exists in the package.
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
  });

  it("omits the outline when includeOutline is off", async () => {
    const { root, ctx } = tree();
    const { document } = await toDocx(root, ctx, { includeOutline: false });
    expect(document).not.toContain("child body");
    // No paragraph references the numbering definition (the library ships a
    // default numbering part in every package — it is simply unreferenced).
    expect(document).not.toContain("<w:numPr>");
  });

  it("renders cycle and depth cuts as visible ![[uuid]] bullets", async () => {
    const cyclic = page("dddddddd-0000-4000-8000-000000000060", "cyclic", [
      { type: "text", text: "cycle" },
    ]);
    const selfChildren = new Map<string, ExportNode[]>([[cyclic.id, [cyclic]]]);
    const cyclicDocx = await toDocx(cyclic, makeCtx({ childrenOf: (id) => selfChildren.get(id) ?? [] }));
    expect(cyclicDocx.document).toContain(`![[dddddddd-0000-4000-8000-000000000060]]`);

    const { root, ctx } = tree();
    const depthDocx = await toDocx(root, ctx, { maxDepth: 1 });
    expect(depthDocx.document).toContain(`![[cccccccc-0000-4000-8000-000000000001]]`);
    expect(depthDocx.document).not.toContain("grandchild body");
  });
});

describe("layouts and page", () => {
  it("defaults to the Calibri/1.15 docDefaults and themes essay/academic as Georgia/1.5", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000070";
    const notes = await toDocx(page(id, "layout"), makeCtx());
    expect(notes.styles).toContain('w:ascii="Calibri"');
    expect(notes.styles).toContain('<w:spacing w:line="276" w:lineRule="auto"/>');
    const essay = await toDocx(page(id, "layout"), makeCtx(), { layout: "essay" });
    expect(essay.styles).toContain('w:ascii="Georgia"');
    expect(essay.styles).toContain('<w:spacing w:line="360" w:lineRule="auto"/>');
    const academic = await toDocx(page(id, "layout"), makeCtx(), { layout: "academic" });
    expect(academic.styles).toContain('w:ascii="Georgia"');
    expect(academic.styles).toContain('<w:spacing w:line="360" w:lineRule="auto"/>');
  });

  it("fixes the section to A4 portrait with 1-inch margins (pageFormat stays pdf-gated)", async () => {
    const { document } = await toDocx(
      page("aaaaaaaa-0000-4000-8000-000000000071", "page"),
      makeCtx(),
      { pageFormat: "letter" },
    );
    // The pdf-only pageFormat option is deliberately NOT consumed: docx
    // sections are A4 regardless.
    expect(document).toContain('<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>');
    expect(document).toContain('<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"');
  });
});

describe("registry seam", () => {
  it("serializes the IR to .docx bytes through the widened registry signature", async () => {
    const format = getExportFormat("docx");
    expect(format?.availability.status).toBe("available");
    const document = buildExportDocument(
      page("aaaaaaaa-0000-4000-8000-000000000080", "Registry render"),
      makeCtx(),
      resolveExportOptions(),
    );
    const result = format?.serialize(document);
    // docx resolves asynchronously (the packer assembles the zip off the
    // call stack); markdown/html stay synchronous text.
    const bytes = await result;
    expect(bytes).toBeInstanceOf(Uint8Array);
    const xml = new TextDecoder().decode(unzipSync(bytes as Uint8Array)["word/document.xml"]);
    expect(xml).toContain('<w:t xml:space="preserve">Registry render</w:t>');
  });
});
