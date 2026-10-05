/**
 * L1 specs: the ExportDocument → LaTeX projection — escaping correctness
 * (every LaTeX special, direct unit cases on escapeLatex), the complete
 * compilable document shape (preamble, class variants per layout),
 * document chrome, spans and marks, quote/asset/embed/query/whiteboard
 * blocks, property rows + options honoring, the nested-itemize outline with
 * visible cuts, math verbatim pass-through, and the source-node
 * bibliography (thebibliography + citekeys via the csl.ts predicate).
 *
 * Golden fixtures: every render spec asserts EXACT full-document equality
 * against an expected `.tex` string, so any serializer change diffs the
 * output directly. The expected strings are hand-verified compilable
 * LaTeX (kernel + geometry/amsmath/xcolor/ulem/hyperref constructs only).
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";
import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import {
  buildExportDocument,
  escapeLatex,
  renderExportDocumentToLatex,
  resolveExportOptions,
  SOURCE_CLASS_IDS,
  type ExportContext,
  type ExportNode,
  type ExportOptions,
} from "../src/index.js";

const EMBED_ID = "66666666-6666-4666-8666-666666666666";
const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "88888888-8888-4888-8888-888888888888";
const PERSON_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_ID = "dddddddd-0000-4000-8000-0000000000dd";
const BOOK_CLASS_ID = SOURCE_CLASS_IDS.book;

const NAMES = new Map<string, string>([
  [EMBED_ID, "Embedded target"],
  [PERSON_CLASS_ID, "person"],
  [PERSON_ID, "Kuhn, Thomas"],
  [AGENT_ID, "Doe, Jane"],
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

function toLatex(node: ExportNode, ctx: ExportContext, options?: ExportOptions): string {
  const resolved = resolveExportOptions(options);
  return renderExportDocumentToLatex(buildExportDocument(node, ctx, resolved), resolved);
}

// --- golden document wrapper ------------------------------------------------
// One helper assembles the fixed preamble/body wrapper so each spec's golden
// string carries only its body; equality is asserted on the FULL document.

const NOTES_CLASS = "\\documentclass[11pt]{article}";
const ACADEMIC_CLASS = "\\documentclass[11pt,twocolumn]{article}";

function expectedDocument(documentClass: string, body: string): string {
  return [
    documentClass,
    "\\usepackage[T1]{fontenc}",
    "\\usepackage[a4paper,margin=2.5cm]{geometry}",
    "\\usepackage{amsmath}",
    "\\usepackage{xcolor}",
    "\\definecolor{noteeshighlight}{HTML}{ECE4B8}",
    "\\usepackage[normalem]{ulem}",
    "\\usepackage[hidelinks]{hyperref}",
    "",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{6pt plus 2pt}",
    "",
    "\\begin{document}",
    "",
    body,
    "",
    "\\end{document}",
  ].join("\n") + "\n";
}

describe("escapeLatex", () => {
  it("escapes every LaTeX special character", () => {
    expect(escapeLatex("\\ % & _ # $ { } ~ ^")).toBe(
      "\\textbackslash{} \\% \\& \\_ \\# \\$ \\{ \\} \\textasciitilde{} \\textasciicircum{}",
    );
  });

  it("escapes specials anywhere in the string, repeatedly", () => {
    expect(escapeLatex("100%_sure & sound")).toBe("100\\%\\_sure \\& sound");
  });

  it("swaps backslashes first so introduced macros are never re-escaped", () => {
    expect(escapeLatex("a\\_b")).toBe("a\\textbackslash{}\\_b");
  });

  it("leaves plain text and newlines untouched", () => {
    expect(escapeLatex("Hello, world!\nline two")).toBe("Hello, world!\nline two");
    expect(escapeLatex("")).toBe("");
  });
});

describe("document shape", () => {
  it("emits a complete compilable document (golden)", () => {
    const tex = toLatex(page("aaaaaaaa-0000-4000-8000-000000000001", "Hello world"), makeCtx());
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        // Single-title rule: the content IS the title (title-is-content), so
        // the body rides in the \section* heading alone — no second paragraph.
        "\\section*{Hello world}",
      ),
    );
    expect(tex).not.toContain("thebibliography");
  });

  it("emits the two-column class variant for the academic layout (golden)", () => {
    const tex = toLatex(
      page("aaaaaaaa-0000-4000-8000-000000000002", "Hello world"),
      makeCtx(),
      { layout: "academic" },
    );
    expect(tex).toBe(
      expectedDocument(
        ACADEMIC_CLASS,
        "\\section*{Hello world}",
      ),
    );
  });

  it("falls back to the node id for the title when the node has no content", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000003";
    const node: ExportNode = { ...page(id, "x"), contentAst: [] };
    const tex = toLatex(node, makeCtx());
    expect(tex).toContain(`\\section*{${id}}`);
  });

  it("omits the section heading for nodes without document chrome (inline blocks)", () => {
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
    const tex = toLatex(inline, makeCtx());
    expect(tex).not.toContain("\\section*");
    expect(tex).toContain("\n\ninline body\n\n\\end{document}");
  });
});

describe("spans and marks", () => {
  it("escapes every special character and wraps every mark (golden)", () => {
    const inline: ExportNode = {
      id: "aaaaaaaa-0000-4000-8000-000000000010",
      isClass: 0,
      presentAsMain: 0,
      parentId: "bbbbbbbb-0000-4000-8000-000000000000",
      name: null,
      contentAst: [
        { type: "text", text: "\\ % & _ # $ { } ~ ^" },
        { type: "text", text: "bold", marks: ["bold"] },
        { type: "text", text: "ital", marks: ["italic"] },
        { type: "text", text: "strike", marks: ["strike"] },
        { type: "text", text: "hl", marks: ["highlight"] },
        { type: "text", text: "code_x", marks: ["code"] },
        { type: "text", text: "all", marks: ["bold", "italic", "strike", "highlight", "code"] },
      ],
      classIds: [],
      properties: [],
    };
    const tex = toLatex(inline, makeCtx());
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "\\textbackslash{} \\% \\& \\_ \\# \\$ \\{ \\} \\textasciitilde{} \\textasciicircum{}" +
            "\\textbf{bold}\\emph{ital}\\sout{strike}\\colorbox{noteeshighlight}{hl}\\texttt{code\\_x}" +
            "\\textbf{\\emph{\\sout{\\colorbox{noteeshighlight}{\\texttt{all}}}}}",
        ].join("\n"),
      ),
    );
  });

  it("renders mention, chip, typed link, external link, hard break, and verbatim math (golden)", () => {
    const inline: ExportNode = {
      id: "aaaaaaaa-0000-4000-8000-000000000011",
      isClass: 0,
      presentAsMain: 0,
      parentId: "bbbbbbbb-0000-4000-8000-000000000000",
      name: null,
      contentAst: [
        { type: "text", text: "See " },
        { type: "mention", targetNodeId: EMBED_ID, text: "Embedded target" },
        { type: "text", text: " and " },
        { type: "class_chip", classId: PERSON_CLASS_ID },
        { type: "text", text: " per " },
        { type: "typed_link", verb: "cites", text: "page 12", metadata: { locator: "ch. 3" } },
        { type: "external_link", text: "Example Site", href: "https://example.com/a_b" },
        { type: "hard_break" },
        { type: "math", expression: "E = mc^2" },
      ],
      classIds: [],
      properties: [],
    };
    const tex = toLatex(inline, makeCtx());
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "See Embedded target and #person per \\textbf{cites} page 12 (ch. 3)" +
            "\\href{https://example.com/a\\_b}{Example Site}\\\\",
          "$E = mc^2$",
        ].join("\n"),
      ),
    );
  });

  it("passes math expressions through verbatim, without escaping", () => {
    const inline: ExportNode = {
      id: "aaaaaaaa-0000-4000-8000-000000000012",
      isClass: 0,
      presentAsMain: 0,
      parentId: "bbbbbbbb-0000-4000-8000-000000000000",
      name: null,
      contentAst: [{ type: "math", expression: "x_1 \\oplus %raw&" }],
      classIds: [],
      properties: [],
    };
    const tex = toLatex(inline, makeCtx());
    expect(tex).toContain("\n\n$x_1 \\oplus %raw&$\n\n");
  });
});

describe("blocks", () => {
  it("renders quote, asset placeholder, unresolved embed, and verbatim JSON blocks (golden)", () => {
    const node = page(
      "aaaaaaaa-0000-4000-8000-000000000020",
      "Blocks",
      [
        { type: "quote", children: [{ type: "text", text: "Quoted words" }] },
        { type: "asset_ref", assetId: ASSET_ID },
        { type: "embed_ref", nodeId: EMBED_ID },
        { type: "query", queryAst: { op: "all" } },
        { type: "whiteboard", layout: { shapes: [1, 2] } },
      ],
    );
    const tex = toLatex(node, makeCtx());
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          // The title flattens the quote's inner text (title-is-content).
          "\\section*{Quoted words}",
          "",
          [
            "\\begin{quote}",
            "Quoted words",
            "\\end{quote}",
            "",
            "\\fbox{\\parbox{0.9\\linewidth}{Asset: \\texttt{88888888-8888-4888-8888-888888888888}}}",
            "",
            "![[66666666-6666-4666-8666-666666666666]]",
            "",
            "\\begin{verbatim}",
            "{",
            '  "op": "all"',
            "}",
            "\\end{verbatim}",
            "",
            "\\begin{verbatim}",
            "{",
            '  "shapes": [',
            "    1,",
            "    2",
            "  ]",
            "}",
            "\\end{verbatim}",
          ].join("\n"),
        ].join("\n"),
      ),
    );
  });

  it("prints the resolved asset path inside the placeholder box", () => {
    const ctx = makeCtx({ assetPath: () => "assets/photo-abc123.png" });
    const tex = toLatex(
      page("aaaaaaaa-0000-4000-8000-000000000021", "Asset", [
        { type: "asset_ref", assetId: ASSET_ID },
      ]),
      ctx,
    );
    expect(tex).toContain(
      "\\fbox{\\parbox{0.9\\linewidth}{Asset: \\texttt{88888888-8888-4888-8888-888888888888}\\\\\n\\texttt{assets/photo-abc123.png}}}",
    );
  });

  it("inlines resolved embeds recursively (includeEmbedded)", () => {
    const ctx = makeCtx({
      nodeOf: (id) =>
        id === EMBED_ID
          ? page(EMBED_ID, "Embedded body")
          : undefined,
    });
    const tex = toLatex(
      page("aaaaaaaa-0000-4000-8000-000000000022", "Host", [
        { type: "text", text: "Host" },
        { type: "embed_ref", nodeId: EMBED_ID },
      ]),
      ctx,
      { includeEmbedded: true },
    );
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        // The host's own "Host" line rides in the heading (single-title
        // rule); the inlined embed renders its full content — no heading.
        ["\\section*{Host}", "", "Embedded body"].join("\n"),
      ),
    );
  });

  it("renders the [name](path) convention when the link hook resolved the target file", () => {
    const ctx = makeCtx({
      linkTarget: (id) => (id === EMBED_ID ? { path: "embedded-target-a1b2.md" } : undefined),
    });
    const tex = toLatex(
      page("aaaaaaaa-0000-4000-8000-000000000023", "Links", [
        { type: "embed_ref", nodeId: EMBED_ID },
        { type: "mention", targetNodeId: EMBED_ID, text: "Embedded target" },
      ]),
      ctx,
    );
    expect(tex).toContain("\n\n[Embedded target](embedded-target-a1b2.md)\n\n");
    expect(tex).toContain("Embedded target");
  });
});

describe("properties", () => {
  const properties: ExportNode["properties"] = [
    { schemaId: "s1", schemaName: "status", value: "" },
    { schemaId: "s2", schemaName: "label", value: "x" },
    { schemaId: "s3", schemaName: "label", value: "y", metadata: { since: 1962 } },
    { schemaId: "s4", schemaName: "ref", value: { nodeId: EMBED_ID } },
  ];

  it("renders run-in property paragraphs with qualifiers and type labels (golden)", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000030", "props", [], {
      classIds: [PERSON_CLASS_ID],
      properties,
    });
    const tex = toLatex(node, makeCtx(), { showTypeLabels: true });
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "\\section*{props}",
          "",
          "\\paragraph*{classNames} person",
          "",
          "\\paragraph*{label} x; y (since 1962)",
          "",
          "\\paragraph*{ref} Embedded target",
        ].join("\n"),
      ),
    );
  });

  it("honors hideEmptyProperties off with the visible null placeholder", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000031", "props", [], {
      properties: [...properties, { schemaId: "s5", schemaName: "count", value: null }],
    });
    const tex = toLatex(node, makeCtx(), { hideEmptyProperties: false });
    expect(tex).toContain("\\paragraph*{count} null");
    expect(tex).toContain("\\paragraph*{status} ");
  });
});

describe("outline", () => {
  it("renders the nested itemize tree with a visible depth cut (golden)", () => {
    const rootId = "aaaaaaaa-0000-4000-8000-000000000040";
    const child1 = "bbbbbbbb-0000-4000-8000-000000000001";
    const child2 = "bbbbbbbb-0000-4000-8000-000000000002";
    const child3 = "bbbbbbbb-0000-4000-8000-000000000003";
    const rows = new Map<string, ExportNode[]>([
      [
        rootId,
        [page(child1, "First", [], { parentId: rootId })],
      ],
      [child1, [page(child2, "Second", [], { parentId: child1 })]],
      [child2, [page(child3, "Third", [], { parentId: child2 })]],
    ]);
    const ctx = makeCtx({ childrenOf: (id) => rows.get(id) ?? [] });
    const tex = toLatex(page(rootId, "Root"), ctx, { maxDepth: 2 });
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "\\section*{Root}",
          "",
          "\\section*{Outline}",
          "",
          "\\begin{itemize}",
          "\\item First",
          "",
          "\\begin{itemize}",
          "\\item Second",
          "",
          "\\begin{itemize}",
          `\\item ![[${child3}]]`,
          "\\end{itemize}",
          "\\end{itemize}",
          "\\end{itemize}",
        ].join("\n"),
      ),
    );
  });
});

describe("bibliography", () => {
  const bookProperties: ExportNode["properties"] = [
    { schemaId: SYSTEM_PROPERTY_UUIDS.citekey, schemaName: "citekey", value: "kuhn1962" },
    { schemaId: SYSTEM_PROPERTY_UUIDS.publicationDate, schemaName: "publicationDate", value: "1962" },
    { schemaId: SYSTEM_PROPERTY_UUIDS.authors, schemaName: "authors", value: { nodeId: PERSON_ID } },
  ];

  it("emits thebibliography with a citekey-keyed entry for a source root (golden)", () => {
    const node = page(
      "bbbbbbbb-0000-4000-8000-000000000099",
      "The Structure of Scientific Revolutions",
      [],
      { classIds: [BOOK_CLASS_ID], properties: bookProperties },
    );
    const tex = toLatex(node, makeCtx());
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "\\section*{The Structure of Scientific Revolutions}",
          "",
          "\\paragraph*{citekey} kuhn1962",
          "",
          "\\paragraph*{publicationDate} 1962",
          "",
          "\\paragraph*{authors} Kuhn, Thomas",
          "",
          "\\begin{thebibliography}{99}",
          "\\bibitem{kuhn1962} Kuhn, Thomas (1962). \\emph{The Structure of Scientific Revolutions}.",
          "\\end{thebibliography}",
        ].join("\n"),
      ),
    );
  });

  it("collects source children via the CSL predicate and skips non-sources (golden)", () => {
    const rootId = "aaaaaaaa-0000-4000-8000-000000000050";
    const bookChild = "bbbbbbbb-0000-4000-8000-000000000001";
    const plainChild = "bbbbbbbb-0000-4000-8000-000000000002";
    const rows = new Map<string, ExportNode[]>([
      [
        rootId,
        [
          page(bookChild, "A Book Title", [], {
            parentId: rootId,
            classIds: [BOOK_CLASS_ID],
            properties: [
              { schemaId: SYSTEM_PROPERTY_UUIDS.citekey, schemaName: "citekey", value: "doe2024" },
              {
                schemaId: SYSTEM_PROPERTY_UUIDS.publicationDate,
                schemaName: "publicationDate",
                value: "2024",
              },
              {
                schemaId: SYSTEM_PROPERTY_UUIDS.authors,
                schemaName: "authors",
                value: { nodeId: AGENT_ID },
              },
            ],
          }),
          page(plainChild, "Notes", [], { parentId: rootId }),
        ],
      ],
    ]);
    const ctx = makeCtx({ childrenOf: (id) => rows.get(id) ?? [] });
    const tex = toLatex(page(rootId, "Reading list"), ctx);
    expect(tex).toBe(
      expectedDocument(
        NOTES_CLASS,
        [
          "\\section*{Reading list}",
          "",
          "\\section*{Outline}",
          "",
          "\\begin{itemize}",
          "\\item A Book Title",
          "\\item Notes",
          "\\end{itemize}",
          "",
          "\\begin{thebibliography}{99}",
          "\\bibitem{doe2024} Doe, Jane (2024). \\emph{A Book Title}.",
          "\\end{thebibliography}",
        ].join("\n"),
      ),
    );
  });

  it("falls back to the node id as the bibitem key when no citekey is set", () => {
    const node = page("bbbbbbbb-0000-4000-8000-000000000098", "Untitled Source", [], {
      classIds: [BOOK_CLASS_ID],
    });
    const tex = toLatex(node, makeCtx());
    expect(tex).toContain("\\bibitem{bbbbbbbb-0000-4000-8000-000000000098}");
  });

  it("emits no bibliography environment when no exported node is a source", () => {
    const tex = toLatex(
      page("aaaaaaaa-0000-4000-8000-000000000051", "Plain page"),
      makeCtx(),
    );
    expect(tex).not.toContain("thebibliography");
  });

  it("keeps the bibliography under the two-column academic class variant (golden)", () => {
    const node = page(
      "bbbbbbbb-0000-4000-8000-000000000097",
      "The Structure of Scientific Revolutions",
      [],
      { classIds: [BOOK_CLASS_ID], properties: bookProperties },
    );
    const tex = toLatex(node, makeCtx(), { layout: "academic" });
    expect(tex).toBe(
      expectedDocument(
        ACADEMIC_CLASS,
        [
          "\\section*{The Structure of Scientific Revolutions}",
          "",
          "\\paragraph*{citekey} kuhn1962",
          "",
          "\\paragraph*{publicationDate} 1962",
          "",
          "\\paragraph*{authors} Kuhn, Thomas",
          "",
          "\\begin{thebibliography}{99}",
          "\\bibitem{kuhn1962} Kuhn, Thomas (1962). \\emph{The Structure of Scientific Revolutions}.",
          "\\end{thebibliography}",
        ].join("\n"),
      ),
    );
  });
});
