/**
 * E2 hardening specs: metacharacter escaping (closes the SCHEMA.md deferral),
 * full-closure default + explicit visible maxDepth, hideEmptyProperties /
 * showTypeLabels / includeEmbedded / includeOutline options.
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  escapeMarkdownText,
  nodeToMarkdown,
  type ExportContext,
  type ExportNode,
} from "../src/index.js";

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const REPUBLIC_ID = "22222222-2222-4222-8222-222222222222";
const EMBED_ID = "66666666-6666-4666-8666-666666666666";

const NAMES = new Map<string, string>([
  [AUTHOR_ID, "Ursula K. Le Guin"],
  [REPUBLIC_ID, "The Republic"],
  ["33333333-3333-4333-8333-333333333333", "person"],
]);

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    nameOf: (id) => NAMES.get(id),
    childrenOf: () => [],
    ...overrides,
  };
}

function page(id: string, name: string, contentAst: ContentAst = [], extra: Partial<ExportNode> = {}): ExportNode {
  return { id, isClass: 0, presentAsMain: 1, parentId: null, name, contentAst, classIds: [], properties: [], ...extra };
}

describe("metacharacter escaping", () => {
  it("escapes inline specials in text runs so emphasis cannot form", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000001", "escapes", [
      // A lead run keeps the payload in the body (single-title rule) — the
      // assertion below is about the content paragraph, not the `#` heading.
      { type: "text", text: "run: " },
      { type: "text", text: "a*b_c`d~e[f]g<h>i\\j" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    // The body escapes; the YAML frontmatter carries the raw title (YAML is
    // not Markdown and quotes it safely).
    const body = md.split("---\n").slice(2).join("---\n");
    expect(body).toContain("a\\*b\\_c\\`d\\~e\\[f\\]g\\<h\\>i\\\\j");
    expect(body).not.toContain("a*b_c");
  });

  it("escapes line-start block constructs after a hard break", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000002", "line starts", [
      { type: "text", text: "intro" },
      { type: "hard_break" },
      { type: "text", text: "# not a heading" },
      { type: "hard_break" },
      { type: "text", text: "- not a bullet" },
      { type: "hard_break" },
      { type: "text", text: "> not a quote" },
      { type: "hard_break" },
      { type: "text", text: "1. not a list" },
      { type: "hard_break" },
      { type: "text", text: "== not a highlight" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("\\# not a heading");
    expect(md).toContain("\\- not a bullet");
    expect(md).toContain("\\> not a quote");
    expect(md).toContain("1\\. not a list");
    expect(md).toContain("\\== not a highlight");
    // The paragraph still renders as one bullet-free body line per jump.
    expect(md).toContain("intro\n\\# not a heading");
  });

  it("escapes interior newlines of a single text run", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000003", "multi", [
      // A lead run keeps the payload in the body (single-title rule).
      { type: "text", text: "run: " },
      { type: "text", text: "first\n---\nsecond" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("first\n\\---\nsecond");
  });

  it("keeps deliberate syntax unescaped: marks wrap escaped text, code spans stay literal", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000004", "marks", [
      { type: "text", text: "a*b", marks: ["bold"] },
      { type: "text", text: " " },
      { type: "text", text: "x_y", marks: ["code"] },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("**a\\*b**");
    expect(md).toContain("`x_y`");
  });

  it("escapes ] and backslash inside mention names without touching the [[…]] convention", () => {
    const tricky = "99999999-9999-4999-8999-999999999999";
    const node = page("aaaaaaaa-0000-4000-8000-000000000005", "mentions", [
      { type: "mention", targetNodeId: tricky, displayText: "A] B\\C", text: "A] B\\C" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("[[A\\] B\\\\C]]");
    expect(md).not.toContain("[[A] B\\C]]");
  });

  it("escapes verb text inside **…** and the ) of a locator", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000006", "verbs", [
      { type: "typed_link", verb: "c*tes", text: "Le Guin", metadata: { locator: "p. 42) x" } },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("**c\\*tes** Le Guin (p. 42\\) x)");
  });

  it("escapes external-link text and wraps unsafe hrefs in angle brackets", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000007", "links", [
      { type: "external_link", href: "https://example.com/a(b)", text: "a ] b" },
      { type: "text", text: " and " },
      { type: "external_link", href: "https://example.com/x", text: "safe" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("[a \\] b](<https://example.com/a%28b%29>)");
    expect(md).toContain("[safe](https://example.com/x)");
  });

  it("escapes the heading title's specials while the marker stays intact", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000008", "title", [
      { type: "text", text: "#star*red" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    // `# ` marker + escaped title: the * cannot open emphasis, the title's #
    // is content after the marker (no ATX ambiguity).
    expect(md).toContain("# #star\\*red");
    expect(md).not.toContain("#star*red\n");
  });

  it("lengthens fences past backtick runs inside query/whiteboard payloads", () => {
    const layout = { note: "contains ``` inside" };
    const node = page("aaaaaaaa-0000-4000-8000-000000000009", "fences", [
      { type: "query", queryAst: { field: "code", match: "```" } },
      { type: "whiteboard", layout },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("````query\n");
    expect(md).toContain("````json\n");
    expect(md).toContain("``` inside");
  });

  it("exposes the escaping helper with documented coverage", () => {
    expect(escapeMarkdownText("a*b")).toBe("a\\*b");
    expect(escapeMarkdownText("# lead", true)).toBe("\\# lead");
    // Mid-paragraph runs are not line starts.
    expect(escapeMarkdownText("# mid", false)).toBe("# mid");
    expect(escapeMarkdownText("a\n- b", false)).toBe("a\n\\- b");
  });
});

describe("full closure and visible depth cuts", () => {
  /** Chain of `depth` blocks, each the single child of the previous. */
  function chain(depth: number): { root: ExportNode; ctx: ExportContext } {
    const ids = Array.from({ length: depth }, (_, i) => `dddddddd-0000-4000-8000-0000000000${String(i + 10).slice(-2)}`);
    const nodes = new Map<string, ExportNode>();
    const children = new Map<string, ExportNode[]>();
    ids.forEach((id, index) => {
      const node: ExportNode = {
        id,
        isClass: 0,
        presentAsMain: 0,
        parentId: index === 0 ? null : (ids[index - 1] ?? null),
        name: null,
        contentAst: [{ type: "text", text: `level ${index + 1}` }],
        classIds: [],
        properties: [],
      };
      nodes.set(id, node);
      if (index > 0) {
        const parent = ids[index - 1] ?? "";
        children.set(parent, [node]);
      }
    });
    const root = nodes.get(ids[0] ?? "");
    if (root === undefined) throw new Error("chain build failed");
    return {
      root,
      ctx: makeCtx({ childrenOf: (id) => children.get(id) ?? [] }),
    };
  }

  it("renders trees deeper than the retired MAX_CHILD_DEPTH cap (30 levels)", () => {
    const { root, ctx } = chain(30);
    const md = nodeToMarkdown(root, ctx);
    // No silent cut: the deepest level renders as a real bullet (level N
    // sits at outline depth N-2, i.e. indent 2·(N-2)).
    expect(md).toContain(`${"  ".repeat(28)}- level 30`);
    expect(md).not.toContain("![[dddddddd-");
  });

  it("renders an explicit maxDepth hit as visible ![[uuid]] bullets", () => {
    const { root, ctx } = chain(5);
    const md = nodeToMarkdown(root, ctx, { maxDepth: 2 });
    // Root body, then bullets: level 2 (depth 1), level 3 (depth 2), and
    // level 4 collapses to a visible reference at depth 3.
    expect(md).toContain("level 1");
    expect(md).toContain("- level 2");
    expect(md).toContain("  - level 3");
    expect(md).toContain("    - ![[dddddddd-0000-4000-8000-000000000013]]");
    expect(md).not.toContain("level 4");
    expect(md).not.toContain("level 5");
  });

  it("treats maxDepth 0 as cutting every child level, visibly", () => {
    const { root, ctx } = chain(2);
    const md = nodeToMarkdown(root, ctx, { maxDepth: 0 });
    expect(md).toContain("- ![[dddddddd-0000-4000-8000-000000000011]]");
    expect(md).not.toContain("level 2");
  });

  it("still breaks cycles with a visible reference", () => {
    const a = page("dddddddd-0000-4000-8000-000000000020", "A", [{ type: "text", text: "A" }]);
    const children = new Map([[a.id, [a]]]);
    const ctx = makeCtx({ childrenOf: (id) => children.get(id) ?? [] });
    expect(nodeToMarkdown(a, ctx)).toContain("- ![[dddddddd-0000-4000-8000-000000000020]]");
  });
});

describe("hideEmptyProperties", () => {
  const properties: ExportNode["properties"] = [
    { schemaId: "s1", schemaName: "status", value: "" },
    { schemaId: "s2", schemaName: "draft", value: "  " },
    { schemaId: "s3", schemaName: "count", value: null },
    { schemaId: "s4", schemaName: "tags", value: [] },
    { schemaId: "s5", schemaName: "keep", value: 0 },
    { schemaId: "s6", schemaName: "label", value: "x" },
  ];

  it("hides empty values from the frontmatter by default (but keeps 0 and false)", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000010", "props", [
      { type: "text", text: "props" },
    ], { properties });
    const fm = nodeToMarkdown(node, makeCtx()).split("---\n")[1] ?? "";
    expect(fm).not.toContain("status:");
    expect(fm).not.toContain("draft:");
    expect(fm).not.toContain("count:");
    expect(fm).not.toContain("tags:");
    expect(fm).toContain("  keep: 0");
    expect(fm).toContain("  label: x");
  });

  it("renders empty values when hideEmptyProperties is off", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000011", "props", [
      { type: "text", text: "props" },
    ], { properties });
    const fm = nodeToMarkdown(node, makeCtx(), { hideEmptyProperties: false }).split("---\n")[1] ?? "";
    expect(fm).toContain('  status: ""');
    expect(fm).toContain('  draft: "  "');
    expect(fm).toContain('  count: "null"');
    expect(fm).toContain('  tags: "[]"');
  });

  it("drops a multi-value key entirely when all its values are empty", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000012", "props", [
      { type: "text", text: "props" },
    ], {
      properties: [
        { schemaId: "s1", schemaName: "alias", value: "" },
        { schemaId: "s1", schemaName: "alias", value: "   " },
      ],
    });
    const fm = nodeToMarkdown(node, makeCtx()).split("---\n")[1] ?? "";
    expect(fm).not.toContain("alias:");
  });
});

describe("showTypeLabels", () => {
  const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";

  it("adds a classNames frontmatter line with resolved class display names when on", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000013", "labels", [
      { type: "text", text: "labels" },
    ], { classIds: [PERSON_CLASS_ID] });
    const fm = nodeToMarkdown(node, makeCtx(), { showTypeLabels: true }).split("---\n")[1] ?? "";
    expect(fm).toContain(`  - ${PERSON_CLASS_ID}`);
    expect(fm).toContain("classNames:");
    expect(fm).toContain("  - person");
  });

  it("omits classNames by default", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000014", "labels", [
      { type: "text", text: "labels" },
    ], { classIds: [PERSON_CLASS_ID] });
    const fm = nodeToMarkdown(node, makeCtx()).split("---\n")[1] ?? "";
    expect(fm).not.toContain("classNames:");
  });
});

describe("includeEmbedded", () => {
  const target: ExportNode = page(EMBED_ID, "Embedded target", [
    { type: "text", text: "the embedded body" },
  ]);

  function host(embedId: string): ExportNode {
    return page("aaaaaaaa-0000-4000-8000-000000000015", "host", [
      { type: "text", text: "before " },
      { type: "embed_ref", nodeId: embedId },
      { type: "text", text: " after" },
    ]);
  }

  it("keeps ![[uuid]] references by default", () => {
    const md = nodeToMarkdown(host(EMBED_ID), makeCtx({ nodeOf: () => target }));
    expect(md).toContain(`![[${EMBED_ID}]]`);
    expect(md).not.toContain("the embedded body");
  });

  it("inlines the target's rendered content when resolvable", () => {
    const md = nodeToMarkdown(host(EMBED_ID), makeCtx({ nodeOf: () => target }), {
      includeEmbedded: true,
    });
    expect(md).toContain("the embedded body");
    expect(md).not.toContain(`![[${EMBED_ID}]]`);
  });

  it("falls back to ![[uuid]] when nodeOf is not injected or misses", () => {
    const md = nodeToMarkdown(host(EMBED_ID), makeCtx(), { includeEmbedded: true });
    expect(md).toContain(`![[${EMBED_ID}]]`);
    const mdMiss = nodeToMarkdown(host(EMBED_ID), makeCtx({ nodeOf: () => undefined }), {
      includeEmbedded: true,
    });
    expect(mdMiss).toContain(`![[${EMBED_ID}]]`);
  });

  it("does not inline an embed cycle (A embeds itself)", () => {
    const cyclic = page("aaaaaaaa-0000-4000-8000-000000000016", "cyclic", [
      { type: "embed_ref", nodeId: "aaaaaaaa-0000-4000-8000-000000000016" },
    ]);
    const md = nodeToMarkdown(cyclic, makeCtx({ nodeOf: () => cyclic }), {
      includeEmbedded: true,
    });
    expect(md).toContain("![[aaaaaaaa-0000-4000-8000-000000000016]]");
  });

  it("inlines the target's outline one level under the embed point", () => {
    const child: ExportNode = {
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      isClass: 0,
      presentAsMain: 0,
      parentId: EMBED_ID,
      name: null,
      contentAst: [{ type: "text", text: "child bullet" }],
      classIds: [],
      properties: [],
    };
    const withChild: ExportNode = { ...target };
    const ctx = makeCtx({
      nodeOf: () => withChild,
      childrenOf: (id) => (id === EMBED_ID ? [child] : []),
    });
    const md = nodeToMarkdown(host(EMBED_ID), ctx, { includeEmbedded: true });
    expect(md).toContain("the embedded body\n  - child bullet");
  });
});

describe("includeOutline", () => {
  it("omits the child-bullets section when off, keeps it by default", () => {
    const child: ExportNode = {
      id: "bbbbbbbb-0000-4000-8000-000000000002",
      isClass: 0,
      presentAsMain: 0,
      parentId: "aaaaaaaa-0000-4000-8000-000000000017",
      name: null,
      contentAst: [{ type: "text", text: "child body" }],
      classIds: [],
      properties: [],
    };
    const root = page("aaaaaaaa-0000-4000-8000-000000000017", "root", [
      { type: "text", text: "root" },
    ]);
    const ctx = makeCtx({ childrenOf: (id) => (id === root.id ? [child] : []) });
    expect(nodeToMarkdown(root, ctx)).toContain("- child body");
    const without = nodeToMarkdown(root, ctx, { includeOutline: false });
    expect(without).not.toContain("- child body");
    expect(without).toContain("root");
  });
});
