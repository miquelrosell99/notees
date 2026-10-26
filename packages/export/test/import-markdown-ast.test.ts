/**
 * Markdown → content-AST specs — the minimal inline subset for the v1
 * "body as one child block" semantics: bold/italic/strike/highlight/code
 * marks, `**`/`__` and `*`/`_` pairs, nested mark splitting, ATX headings as
 * heading tokens, hard breaks between lines. External links stay literal
 * `[label](href)` text per the fleet `@notees/domain` markdownLinks
 * convention (the block row renders them as link pills).
 */

import { describe, expect, it } from "vitest";

import { markdownBlockAst, markdownInlineToAst } from "../src/index.js";

describe("markdownInlineToAst", () => {
  it("passes plain text through as a single token", () => {
    expect(markdownInlineToAst("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("parses **bold** and __bold__", () => {
    expect(markdownInlineToAst("a **bold** b")).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "bold", marks: ["bold"] },
      { type: "text", text: " b" },
    ]);
    expect(markdownInlineToAst("__x__")).toEqual([
      { type: "text", text: "x", marks: ["bold"] },
    ]);
  });

  it("parses *italic* and _italic_", () => {
    expect(markdownInlineToAst("*it*")).toEqual([
      { type: "text", text: "it", marks: ["italic"] },
    ]);
    expect(markdownInlineToAst("_it_")).toEqual([
      { type: "text", text: "it", marks: ["italic"] },
    ]);
  });

  it("parses ~~strike~~, ==highlight== and `code`", () => {
    expect(markdownInlineToAst("~~gone~~")).toEqual([
      { type: "text", text: "gone", marks: ["strike"] },
    ]);
    expect(markdownInlineToAst("==mark==")).toEqual([
      { type: "text", text: "mark", marks: ["highlight"] },
    ]);
    expect(markdownInlineToAst("`x = 1`")).toEqual([
      { type: "text", text: "x = 1", marks: ["code"] },
    ]);
  });

  it("splits nested marks into adjacent tokens", () => {
    expect(markdownInlineToAst("**bold ~~strike~~**")).toEqual([
      { type: "text", text: "bold ", marks: ["bold"] },
      { type: "text", text: "strike", marks: ["bold", "strike"] },
    ]);
  });

  it("keeps [label](href) links as literal text", () => {
    expect(markdownInlineToAst("see [docs](https://example.com) now")).toEqual([
      { type: "text", text: "see [docs](https://example.com) now" },
    ]);
  });

  it("leaves unmatched markers as literal text", () => {
    expect(markdownInlineToAst("a * b")).toEqual([{ type: "text", text: "a * b" }]);
  });
});

describe("markdownBlockAst", () => {
  it("emits an ATX heading token with inline children", () => {
    expect(markdownBlockAst("## Section *one*")).toEqual([
      {
        type: "heading",
        children: [
          { type: "text", text: "Section " },
          { type: "text", text: "one", marks: ["italic"] },
        ],
      },
    ]);
  });

  it("joins consecutive non-empty lines with hard breaks", () => {
    expect(markdownBlockAst("line one\nline two")).toEqual([
      { type: "text", text: "line one" },
      { type: "hard_break" },
      { type: "text", text: "line two" },
    ]);
  });

  it("separates paragraphs on blank lines", () => {
    const ast = markdownBlockAst("para one\n\npara two");
    expect(ast).toEqual([
      { type: "text", text: "para one" },
      { type: "text", text: "para two" },
    ]);
  });
});
