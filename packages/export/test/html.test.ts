/**
 * H1 specs: the ExportDocument → standalone HTML projection — complete
 * document structure, token → element mapping, escaping coverage,
 * properties/options honoring (hideEmptyProperties, showTypeLabels,
 * includeOutline, layout), embed recursion, print rules, and the
 * privacy-first no-external-resources guarantee.
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  buildExportDocument,
  renderExportDocumentToHtml,
  resolveExportOptions,
  type ExportContext,
  type ExportNode,
  type ExportOptions,
} from "../src/index.js";

const EMBED_ID = "66666666-6666-4666-8666-666666666666";
const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";

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

function toHtml(node: ExportNode, ctx: ExportContext, options?: ExportOptions): string {
  const resolved = resolveExportOptions(options);
  return renderExportDocumentToHtml(buildExportDocument(node, ctx, resolved), resolved);
}

describe("document structure", () => {
  it("emits a complete standalone document: doctype, head, meta, title, style, body", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000001", "Structure"), makeCtx());
    expect(html.startsWith("<!DOCTYPE html>\n")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<head>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
    expect(html).toContain('<body class="layout-notes">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("puts the document title in <title> and <h1>", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000002", "My Page"), makeCtx());
    expect(html).toContain("<title>My Page</title>");
    expect(html).toContain('<header class="doc-header">');
    expect(html).toContain("<h1>My Page</h1>");
  });

  it("escapes the title in both <title> and <h1>", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000003", 'A <b> & "quoted"'), makeCtx());
    expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;quoted&quot;</title>");
    expect(html).toContain("<h1>A &lt;b&gt; &amp; &quot;quoted&quot;</h1>");
    expect(html).not.toContain("<h1>A <b>");
  });

  it("omits the <h1> for nodes without document chrome (inline blocks)", () => {
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
    const html = toHtml(inline, makeCtx());
    expect(html).not.toContain("<h1>");
    expect(html).toContain("<title>inline body</title>");
    expect(html).toContain("<main class=\"content\">");
  });

  it("renders content blocks inside <main class=\"content\">", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000005", "Body", [
      { type: "text", text: "First" },
      { type: "text", text: " second" },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain('<main class="content">');
    expect(html).toContain("<p>First second</p>");
    expect(html).toContain("</main>");
  });
});

describe("properties section", () => {
  const properties: ExportNode["properties"] = [
    { schemaId: "s1", schemaName: "status", value: "" },
    { schemaId: "s6", schemaName: "count", value: null },
    { schemaId: "s2", schemaName: "keep", value: 0 },
    { schemaId: "s3", schemaName: "label", value: "x" },
    { schemaId: "s4", schemaName: "label", value: "y", metadata: { since: 1962 } },
    { schemaId: "s5", schemaName: "ref", value: { nodeId: EMBED_ID } },
  ];

  it("renders a dl with schemaName terms and per-value dds (multi-value grouped, qualifiers inline)", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000010", "props", [], { properties });
    const html = toHtml(node, makeCtx(), { hideEmptyProperties: false });
    expect(html).toContain('<dl class="properties">');
    expect(html).toContain("<dt>status</dt>");
    expect(html).toContain("<dd></dd>");
    // null/undefined values keep the visible "null" placeholder (like the
    // markdown frontmatter) when empty-hiding is off.
    expect(html).toContain("<dt>count</dt>");
    expect(html).toContain("<dd>null</dd>");
    expect(html).toContain("<dt>keep</dt>");
    expect(html).toContain("<dd>0</dd>");
    // One dt for the two-value schema, one dd per value, qualifier appended.
    expect(html.match(/<dt>label<\/dt>/g)).toHaveLength(1);
    expect(html).toContain("<dd>x</dd>");
    expect(html).toContain("<dd>y (since 1962)</dd>");
    // Node-typed values resolve rename-free to the target's current name.
    expect(html).toContain("<dd>Embedded target</dd>");
  });

  it("hides empty values by default and shows them when hideEmptyProperties is off", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000011", "props", [], { properties });
    const hidden = toHtml(node, makeCtx());
    expect(hidden).not.toContain("<dt>status</dt>");
    expect(hidden).not.toContain("<dt>count</dt>");
    expect(hidden).toContain("<dt>keep</dt>");
    const shown = toHtml(node, makeCtx(), { hideEmptyProperties: false });
    expect(shown).toContain("<dt>status</dt>");
    expect(shown).toContain("<dd></dd>");
    expect(shown).toContain("<dd>null</dd>");
  });

  it("drops the properties dl entirely when nothing survives the filter", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000012", "props", [], {
      properties: [{ schemaId: "s1", schemaName: "status", value: "" }],
    });
    const html = toHtml(node, makeCtx());
    expect(html).not.toContain("<dl");
    // The document chrome (title) stays — only the properties rows go.
    expect(html).toContain("<h1>props</h1>");
  });

  it("renders the classNames line when showTypeLabels is on, omitting it by default", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000013", "labels", [], {
      classIds: [PERSON_CLASS_ID],
    });
    const labeled = toHtml(node, makeCtx(), { showTypeLabels: true });
    expect(labeled).toContain("<dt>classNames</dt>");
    expect(labeled).toContain("<dd>person</dd>");
    expect(toHtml(node, makeCtx())).not.toContain("classNames");
  });
});

describe("inline spans", () => {
  it("maps marks to elements in the fixed nesting order (bold outer, code innermost)", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000020", "marks", [
      // A lead run keeps the marked run out of the title (single-title rule)
      // so the body paragraph carries it.
      { type: "text", text: "lead " },
      { type: "text", text: "all", marks: ["bold", "italic", "strike", "highlight", "code"] },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain("<strong><em><del><mark><code>all</code></mark></del></em></strong>");
  });

  it("maps each mark to its own element", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000021", "marks", [
      { type: "text", text: "b", marks: ["bold"] },
      { type: "text", text: "i", marks: ["italic"] },
      { type: "text", text: "s", marks: ["strike"] },
      { type: "text", text: "h", marks: ["highlight"] },
      { type: "text", text: "c", marks: ["code"] },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<del>s</del>");
    expect(html).toContain("<mark>h</mark>");
    expect(html).toContain("<code>c</code>");
  });

  it("escapes special characters in text runs, including inside code", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000022", "escape", [
      // A lead run keeps the payload in the body (single-title rule) — the
      // assertion below is about the content paragraph, not the <h1>.
      { type: "text", text: "run: " },
      { type: "text", text: "<script>alert(1)</script> & 'q' \"d\"" },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;q&#39; &quot;d&quot;");
    expect(html).not.toContain("<script>");
    const code = toHtml(page("aaaaaaaa-0000-4000-8000-000000000023", "code", [
      { type: "text", text: "c=" },
      { type: "text", text: "a<b", marks: ["code"] },
    ]), makeCtx());
    expect(code).toContain("<code>a&lt;b</code>");
  });

  it("maps hard_break to <br>", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000024", "break", [
      { type: "text", text: "one" },
      { type: "hard_break" },
      { type: "text", text: "two" },
    ]);
    expect(toHtml(node, makeCtx())).toContain("<p>one<br>two</p>");
  });

  it("maps mentions to pills, escaping the name", () => {
    const tricky = "99999999-9999-4999-8999-999999999999";
    const node = page("aaaaaaaa-0000-4000-8000-000000000025", "mention", [
      { type: "mention", targetNodeId: tricky, displayText: "A <b> & C", text: "A <b> & C" },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain('<span class="mention">A &lt;b&gt; &amp; C</span>');
  });

  it("links the mention when the IR resolved a bundle path (E5)", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000026", "mention", [
      { type: "mention", targetNodeId: EMBED_ID, text: "Embedded target" },
    ]);
    const html = toHtml(node, makeCtx({ linkTarget: () => ({ path: "pages/embedded-target.md" }) }));
    expect(html).toContain('<a class="mention" href="pages/embedded-target.md">Embedded target</a>');
  });

  it("maps class chips to #name pills", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000027", "chip", [
      { type: "class_chip", classId: PERSON_CLASS_ID },
    ]);
    expect(toHtml(node, makeCtx())).toContain('<span class="chip">#person</span>');
  });

  it("maps typed links to verb-strong + text + locator, escaped", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000028", "typed", [
      { type: "typed_link", verb: "auth*red", text: "Le <Guin>", metadata: { locator: "p. 42" } },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain('<strong class="verb">auth*red</strong> Le &lt;Guin&gt; (p. 42)');
  });

  it("maps external links to anchors with escaped href and text", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000029", "link", [
      { type: "external_link", href: "https://example.com/a?b=1&c=2", text: "a <site>" },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">a &lt;site&gt;</a>');
  });

  it("maps math to a math code span, escaped", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000030", "math", [
      { type: "math", expression: "a<b" },
    ]);
    expect(toHtml(node, makeCtx())).toContain('<code class="math">$a&lt;b$</code>');
  });
});

describe("block-scale content", () => {
  it("renders quotes as blockquotes with inline children", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000040", "quote", [
      { type: "text", text: "said " },
      { type: "quote", children: [{ type: "text", text: "to be <or> not" }] },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain("<blockquote>to be &lt;or&gt; not</blockquote>");
  });

  it("renders an inlined embed recursively (includeEmbedded)", () => {
    const target = page(EMBED_ID, "Embedded target", [
      { type: "text", text: "the embedded body" },
      { type: "quote", children: [{ type: "text", text: "embedded quote" }] },
    ]);
    const host = page("aaaaaaaa-0000-4000-8000-000000000041", "host", [
      { type: "text", text: "before " },
      { type: "embed_ref", nodeId: EMBED_ID },
      { type: "text", text: " after" },
    ]);
    const html = toHtml(host, makeCtx({ nodeOf: () => target }), { includeEmbedded: true });
    expect(html).toContain('<div class="embed">');
    expect(html).toContain("<p>the embedded body</p>");
    expect(html).toContain("<blockquote>embedded quote</blockquote>");
    expect(html).not.toContain(`![[${EMBED_ID}]]`);
  });

  it("falls back to the ![[uuid]] reference when the embed is unresolved", () => {
    const host = page("aaaaaaaa-0000-4000-8000-000000000042", "host", [
      { type: "embed_ref", nodeId: EMBED_ID },
    ]);
    const html = toHtml(host, makeCtx(), { includeEmbedded: true });
    expect(html).toContain(`<p class="embed-ref">![[${EMBED_ID}]]</p>`);
  });

  it("links an unresolved embed when the IR resolved a bundle path (E5)", () => {
    const host = page("aaaaaaaa-0000-4000-8000-000000000043", "host", [
      { type: "embed_ref", nodeId: EMBED_ID },
    ]);
    const html = toHtml(host, makeCtx({ linkTarget: () => ({ path: "pages/embedded-target.md" }) }));
    expect(html).toContain(
      '<p class="embed-ref"><a href="pages/embedded-target.md">Embedded target</a></p>',
    );
  });

  it("renders an asset placeholder figure, with the bundle path as caption when resolved", () => {
    const ASSET_ID = "88888888-8888-4888-8888-888888888888";
    const node = page("aaaaaaaa-0000-4000-8000-000000000044", "asset", [
      { type: "asset_ref", assetId: ASSET_ID },
    ]);
    const bare = toHtml(node, makeCtx());
    expect(bare).toContain('<figure class="asset">');
    expect(bare).toContain(`<div class="asset-box">asset · ${ASSET_ID}</div>`);
    expect(bare).not.toContain("<figcaption>");
    const linked = toHtml(node, makeCtx({ assetPath: () => "assets/photo.png" }));
    expect(linked).toContain("<figcaption>assets/photo.png</figcaption>");
  });

  it("renders query and whiteboard blocks as escaped pretty-printed JSON pres", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000045", "widgets", [
      { type: "query", queryAst: { field: "tag", match: "<draft>" } },
      { type: "whiteboard", layout: { nodes: [{ text: "a & b" }] } },
    ]);
    const html = toHtml(node, makeCtx());
    expect(html).toContain('<pre class="query">');
    expect(html).toContain("&lt;draft&gt;");
    expect(html).toContain('<pre class="whiteboard">');
    expect(html).toContain("a &amp; b");
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

  it("renders the children tree as a nested list under an Outline section", () => {
    const { root, ctx } = tree();
    const html = toHtml(root, ctx);
    expect(html).toContain('<section class="outline">');
    expect(html).toContain("<h2>Outline</h2>");
    expect(html).toContain('<ul class="outline-list">');
    expect(html).toContain("<p>child body</p>");
    expect(html).toContain("<p>grandchild body</p>");
    // The grandchild list nests inside the child item.
    expect(html.indexOf("<p>child body</p>")).toBeLessThan(html.indexOf("<p>grandchild body</p>"));
  });

  it("omits the outline when includeOutline is off", () => {
    const { root, ctx } = tree();
    const html = toHtml(root, ctx, { includeOutline: false });
    expect(html).not.toContain('<section class="outline">');
    expect(html).not.toContain("child body");
  });

  it("renders cycle and depth cuts as visible ![[uuid]] items", () => {
    const cyclic = page("dddddddd-0000-4000-8000-000000000060", "cyclic", [
      { type: "text", text: "cycle" },
    ]);
    const selfChildren = new Map<string, ExportNode[]>([[cyclic.id, [cyclic]]]);
    const cyclicHtml = toHtml(cyclic, makeCtx({ childrenOf: (id) => selfChildren.get(id) ?? [] }));
    expect(cyclicHtml).toContain('<li class="cut">![[dddddddd-0000-4000-8000-000000000060]]</li>');

    const { root, ctx } = tree();
    const depthHtml = toHtml(root, ctx, { maxDepth: 1 });
    expect(depthHtml).toContain('<li class="cut">![[cccccccc-0000-4000-8000-000000000001]]</li>');
    expect(depthHtml).not.toContain("grandchild body");
  });
});

describe("layouts and print", () => {
  it("defaults to the notes body class and honors essay/academic layouts", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000070", "layout");
    expect(toHtml(node, makeCtx())).toContain('<body class="layout-notes">');
    expect(toHtml(node, makeCtx(), { layout: "essay" })).toContain('<body class="layout-essay">');
    expect(toHtml(node, makeCtx(), { layout: "academic" })).toContain(
      '<body class="layout-academic">',
    );
  });

  it("defines essay (serif) and academic (two-column) stylesheet variants", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000071", "layout"), makeCtx());
    expect(html).toContain("body.layout-essay .content");
    expect(html).toContain("body.layout-academic .content { columns: 2;");
  });

  it("embeds a print stylesheet: page margins, break-inside avoidance", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000072", "print"), makeCtx());
    expect(html).toContain("@media print");
    expect(html).toContain("@page { margin: 2cm; }");
    expect(html).toContain("break-inside: avoid");
  });

  it("styles app-token custom properties in an inlined stylesheet", () => {
    const html = toHtml(page("aaaaaaaa-0000-4000-8000-000000000073", "tokens"), makeCtx());
    // The stylesheet is inlined, token-driven, and mirrors the app values.
    expect(html).toContain("--nt-background: #f5f3ef;");
    expect(html).toContain("--nt-text: #1a1a1a;");
    expect(html).toContain("--nt-accent: #404040;");
    expect(html).toContain("max-width: var(--nt-content-width);");
  });
});

describe("privacy: no external resources", () => {
  it("references no link/script/img tags and only the authored external href", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000080", "privacy", [
      { type: "text", text: "home " },
      { type: "external_link", href: "https://example.com/only-external", text: "site" },
      { type: "mention", targetNodeId: EMBED_ID, text: "Embedded target" },
      { type: "embed_ref", nodeId: EMBED_ID },
    ]);
    const html = toHtml(node, makeCtx({ linkTarget: () => ({ path: "pages/embedded-target.md" }) }));
    expect(html).not.toMatch(/<link[\s>]/);
    expect(html).not.toMatch(/<script[\s>]/);
    expect(html).not.toMatch(/<img[\s>]/);
    expect(html).not.toMatch(/\bsrc="/);
    // Every href is either relative (bundle path) or the authored external URL.
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href === "pages/embedded-target.md" || href === "https://example.com/only-external").toBe(
        true,
      );
    }
  });
});
