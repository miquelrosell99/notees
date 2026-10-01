/**
 * Fixture-style tests for the export engine: every content token type, the
 * frontmatter mapping, nested children bullets, and the bundle manifest.
 */

import { describe, expect, it } from "vitest";

import type { ContentAst } from "@notees/protocol";

import {
  bundleMarkdown,
  concatBundleMarkdown,
  nodeToMarkdown,
  type ExportContext,
  type ExportNode,
} from "../src/index.js";

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const REPUBLIC_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_CLASS_ID = "33333333-3333-4333-8333-333333333333";
const PUBLISHED_SCHEMA_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const EMBED_ID = "66666666-6666-4666-8666-666666666666";

const NAMES = new Map<string, string>([
  [AUTHOR_ID, "Ursula K. Le Guin"],
  [REPUBLIC_ID, "The Republic"],
  [PERSON_CLASS_ID, "person"],
  [PUBLISHED_SCHEMA_ID, "published in"],
]);

function makeCtx(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    nameOf: (id) => NAMES.get(id),
    childrenOf: () => [],
    ...overrides,
  };
}

function page(id: string, name: string, contentAst: ContentAst = [], extra: Partial<ExportNode> = {}): ExportNode {
  return { id, nodeType: "page", name, contentAst, classIds: [], properties: [], ...extra };
}

function block(id: string, contentAst: ContentAst, extra: Partial<ExportNode> = {}): ExportNode {
  return { id, nodeType: "block", name: null, contentAst, classIds: [], properties: [], ...extra };
}

describe("token → markdown mapping", () => {
  it("renders text runs with every mark in the documented nesting order", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000001", "marks", [
      { type: "text", text: "bold", marks: ["bold"] },
      { type: "text", text: " " },
      { type: "text", text: "italic", marks: ["italic"] },
      { type: "text", text: " " },
      { type: "text", text: "strike", marks: ["strike"] },
      { type: "text", text: " " },
      { type: "text", text: "high", marks: ["highlight"] },
      { type: "text", text: " " },
      { type: "text", text: "code", marks: ["code"] },
      { type: "text", text: " " },
      { type: "text", text: "all", marks: ["bold", "italic", "strike", "highlight", "code"] },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("**bold**");
    expect(md).toContain("*italic*");
    expect(md).toContain("~~strike~~");
    expect(md).toContain("==high==");
    expect(md).toContain("`code`");
    // code innermost → highlight → strike → italic → bold outermost.
    expect(md).toContain("***~~==`all`==~~***");
  });

  it("renders hard_break as a line jump inside a block", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000002", "breaks", [
      { type: "text", text: "line one" },
      { type: "hard_break" },
      { type: "text", text: "line two" },
    ]);
    expect(nodeToMarkdown(node, makeCtx())).toContain("line one\nline two");
  });

  it("renders mentions from displayText, resolved name, then raw id for broken targets", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000003", "mentions", [
      { type: "mention", targetNodeId: REPUBLIC_ID, text: "the Republic", displayText: "the Republic" },
      { type: "text", text: " by " },
      { type: "mention", targetNodeId: AUTHOR_ID, text: "Le Guin" },
      { type: "text", text: " and " },
      // Broken target (no displayText, nameOf misses) → raw id (SCHEMA Fork 4).
      { type: "mention", targetNodeId: "88888888-8888-4888-8888-888888888888", text: "captured" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("[[the Republic]]");
    expect(md).toContain("[[Ursula K. Le Guin]]");
    expect(md).toContain("[[88888888-8888-4888-8888-888888888888]]");
    expect(md).not.toContain("[[captured]]");
  });

  it("renders class chips as #name with displayText override and whitespace folding", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000004", "chips", [
      { type: "class_chip", classId: PERSON_CLASS_ID },
      { type: "text", text: " " },
      { type: "class_chip", classId: PERSON_CLASS_ID, displayText: "human being" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("#person");
    expect(md).toContain("#human-being");
  });

  it("renders typed links as **verb** text with locator, resolving bound schema verbs", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000005", "links", [
      { type: "typed_link", verb: "cites", text: "Le Guin", metadata: { locator: "p. 42" } },
      { type: "text", text: " and " },
      {
        type: "typed_link",
        verb: { propertySchemaId: PUBLISHED_SCHEMA_ID },
        text: "1962",
        metadata: { locator: "ch. 3" },
      },
      { type: "text", text: " and " },
      { type: "typed_link", verb: "glosses", text: "plain" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("**cites** Le Guin (p. 42)");
    expect(md).toContain("**published in** 1962 (ch. 3)");
    expect(md).toContain("**glosses** plain");
  });

  it("renders asset_ref, embed_ref, external_link, and math", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000006", "refs", [
      { type: "text", text: "see " },
      { type: "asset_ref", assetId: ASSET_ID },
      { type: "text", text: " and " },
      { type: "embed_ref", nodeId: EMBED_ID },
      { type: "text", text: " and " },
      { type: "external_link", href: "https://example.com/x", text: "an example" },
      { type: "text", text: " and " },
      { type: "math", expression: "e = mc^2" },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain(`![asset](<${ASSET_ID}>)`);
    expect(md).toContain(`![[${EMBED_ID}]]`);
    expect(md).toContain("[an example](https://example.com/x)");
    expect(md).toContain("$e = mc^2$");
  });

  it("renders quotes as > lines, recursing inline children", () => {
    const node = page("aaaaaaaa-0000-4000-8000-000000000007", "quotes", [
      {
        type: "quote",
        children: [
          { type: "text", text: "first line" },
          { type: "hard_break" },
          { type: "text", text: "second " },
          { type: "mention", targetNodeId: AUTHOR_ID, text: "Le Guin" },
        ],
      },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("> first line");
    expect(md).toContain("> second [[Ursula K. Le Guin]]");
  });

  it("renders query tokens as fenced ```query blocks and whiteboards as fenced ```json", () => {
    const queryAst = { version: 1, op: "and", clauses: [{ field: "name", match: "x" }] };
    const layout = { viewport: { x: 0, y: 0 }, cards: { [EMBED_ID]: { x: 1, y: 2, w: 3, h: 4 } } };
    const node = page("aaaaaaaa-0000-4000-8000-000000000008", "islands", [
      { type: "query", queryAst },
      { type: "whiteboard", layout },
    ]);
    const md = nodeToMarkdown(node, makeCtx());
    expect(md).toContain("```query\n" + JSON.stringify(queryAst, null, 2) + "\n```");
    expect(md).toContain("```json\n" + JSON.stringify(layout, null, 2) + "\n```");
  });
});

describe("frontmatter", () => {
  it("carries name, nodeType, classIds, and properties with metadata qualifiers", () => {
    // Title-is-content: the page's display name IS its text content.
    const node = page("aaaaaaaa-0000-4000-8000-000000000009", "The Left Hand", [
      { type: "text", text: "The Left Hand" },
    ], {
      classIds: [PERSON_CLASS_ID],
      properties: [
        { schemaId: "aaaaaaaa-1111-4111-8111-111111111111", schemaName: "status", value: "active" },
        { schemaId: "aaaaaaaa-2222-4222-8222-222222222222", schemaName: "year", value: 1962, metadata: { since: 1962 } },
        { schemaId: "aaaaaaaa-3333-4333-8333-333333333333", schemaName: "author", value: { nodeId: AUTHOR_ID } },
        { schemaId: "aaaaaaaa-3333-4333-8333-333333333333", schemaName: "alias", value: "Rocannon" },
        { schemaId: "aaaaaaaa-3333-4333-8333-333333333333", schemaName: "alias", value: "Genly", metadata: { since: "1974" } },
      ],
    });
    const fm = nodeToMarkdown(node, makeCtx()).split("---\n")[1] ?? "";
    expect(fm).toContain("name: The Left Hand");
    expect(fm).toContain("nodeType: page");
    expect(fm).toContain(`  - ${PERSON_CLASS_ID}`);
    expect(fm).toContain('  status: active');
    expect(fm).toContain("  year: 1962 (since 1962)");
    expect(fm).toContain("  author: Ursula K. Le Guin");
    expect(fm).toContain("  alias:");
    expect(fm).toContain("    - Rocannon");
    expect(fm).toContain("    - Genly (since 1974)");
  });

  it("quotes values that are unsafe YAML scalars", () => {
    // Title-is-content: the "yes: no" display name lives in the content.
    const node = page("aaaaaaaa-0000-4000-8000-000000000010", "yes: no", [
      { type: "text", text: "yes: no" },
    ], {
      properties: [{ schemaId: "s", schemaName: "tricky: key", value: "true" }],
    });
    const fm = nodeToMarkdown(node, makeCtx()).split("---\n")[1] ?? "";
    expect(fm).toContain('name: "yes: no"');
    expect(fm).toContain('"tricky: key": "true"');
  });
});

describe("children as nested bullets", () => {
  it("renders children under the page via the injected resolver, recursing", () => {
    const grandchild = block("bbbbbbbb-0000-4000-8000-000000000002", [
      { type: "text", text: "grandchild line" },
    ]);
    const child = block("bbbbbbbb-0000-4000-8000-000000000001", [
      { type: "text", text: "child line one" },
      { type: "hard_break" },
      { type: "text", text: "child line two" },
    ]);
    const parent = page("bbbbbbbb-0000-4000-8000-000000000000", "parent", [
      { type: "text", text: "own body" },
    ]);
    const children = new Map([
      [parent.id, [child]],
      [child.id, [grandchild]],
    ]);
    const ctx = makeCtx({ childrenOf: (id) => children.get(id) ?? [] });
    const md = nodeToMarkdown(parent, ctx);
    expect(md).toContain("own body");
    expect(md).toContain("- child line one\n  child line two");
    expect(md).toContain("  - grandchild line");
  });

  it("breaks embed-style cycles with a ![[id]] reference instead of recursing", () => {
    const a = block("bbbbbbbb-0000-4000-8000-000000000010", [{ type: "text", text: "A" }]);
    const children = new Map([[a.id, [a]]]);
    const ctx = makeCtx({ childrenOf: (id) => children.get(id) ?? [] });
    const md = nodeToMarkdown(a, ctx);
    expect(md).toContain("- ![[bbbbbbbb-0000-4000-8000-000000000010]]");
  });
});

describe("bundle", () => {
  it("emits <uuid>.md files and a UUID↔name↔type manifest", () => {
    // Title-is-content: each page's display name is its own text content.
    const nodes = [
      page("cccccccc-0000-4000-8000-000000000001", "Alpha", [{ type: "text", text: "Alpha" }]),
      page("cccccccc-0000-4000-8000-000000000002", "Beta", [{ type: "text", text: "Beta" }]),
    ];
    const bundle = bundleMarkdown(nodes, makeCtx());
    expect(bundle.files.map((f) => f.path)).toEqual([
      "cccccccc-0000-4000-8000-000000000001.md",
      "cccccccc-0000-4000-8000-000000000002.md",
    ]);
    expect(bundle.files[0]?.content).toContain("# Alpha");
    expect(bundle.manifest.format).toBe("notees-markdown");
    expect(bundle.manifest.version).toBe(1);
    expect(bundle.manifest.nodes).toEqual([
      { id: "cccccccc-0000-4000-8000-000000000001", name: "Alpha", nodeType: "page" },
      { id: "cccccccc-0000-4000-8000-000000000002", name: "Beta", nodeType: "page" },
    ]);
  });

  it("concatenates the bundle with thematic breaks for --stdout", () => {
    const nodes = [
      page("cccccccc-0000-4000-8000-000000000003", "One", [{ type: "text", text: "One" }]),
      page("cccccccc-0000-4000-8000-000000000004", "Two", [{ type: "text", text: "Two" }]),
    ];
    const text = concatBundleMarkdown(bundleMarkdown(nodes, makeCtx()));
    expect(text).toContain("# One");
    expect(text).toContain("# Two");
    expect(text).toContain("\n\n---\n\n");
  });
});
