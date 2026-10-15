import { describe, expect, it } from "vitest";

import { DISPLAY_NAME_MAX, excerptOf } from "../src/index.js";
import type { ContentAst } from "@notees/protocol";

describe("excerptOf", () => {
  it("flattens a plain single-line block without truncating", () => {
    expect(excerptOf([{ type: "text", text: "one line" }])).toEqual({
      text: "one line",
      truncated: false,
      cutOffset: 0,
    });
  });

  it("returns an empty, untruncated excerpt for prose-less content", () => {
    expect(excerptOf([])).toEqual({ text: "", truncated: false, cutOffset: 0 });
    expect(excerptOf(undefined)).toEqual({ text: "", truncated: false, cutOffset: 0 });
    // Structural tokens carry no prose: an image block is prose-less.
    expect(
      excerptOf([{ type: "asset_ref", assetId: "a", fullBleed: false } as never]),
    ).toEqual({ text: "", truncated: false, cutOffset: 0 });
  });

  it("cuts at the first hard_break and reports the break's offset", () => {
    const ast: ContentAst = [
      { type: "text", text: "first line" },
      { type: "hard_break" },
      { type: "text", text: "second line" },
    ];
    expect(excerptOf(ast)).toEqual({
      text: "first line",
      truncated: true,
      cutOffset: "first line".length,
    });
  });

  it("a hard_break inside a quote recurses — the cut still fires", () => {
    const ast: ContentAst = [
      {
        type: "quote",
        children: [
          { type: "text", text: "quoted" },
          { type: "hard_break" },
          { type: "text", text: "rest" },
        ],
      },
    ];
    expect(excerptOf(ast)).toEqual({
      text: "quoted",
      truncated: true,
      cutOffset: "quoted".length,
    });
  });

  it("cuts at DISPLAY_NAME_MAX when no break comes first", () => {
    const long = "x".repeat(DISPLAY_NAME_MAX + 20);
    const result = excerptOf([{ type: "text", text: long }]);
    expect(result.truncated).toBe(true);
    expect(result.cutOffset).toBe(DISPLAY_NAME_MAX);
    expect(result.text).toBe("x".repeat(DISPLAY_NAME_MAX));
  });

  it("the budget wins over a later hard_break (whichever comes first)", () => {
    const ast: ContentAst = [
      { type: "text", text: "y".repeat(DISPLAY_NAME_MAX + 5) },
      { type: "hard_break" },
      { type: "text", text: "tail" },
    ];
    const result = excerptOf(ast);
    expect(result.cutOffset).toBe(DISPLAY_NAME_MAX);
    expect(result.text).toBe("y".repeat(DISPLAY_NAME_MAX));
  });

  it("keeps the raw concatenation — no inserted separators between runs", () => {
    const ast: ContentAst = [
      { type: "text", text: "foo" },
      { type: "text", text: "bar" },
    ];
    expect(excerptOf(ast).text).toBe("foobar");
  });

  it("mentions, typed links and math count their text/expression", () => {
    const ast: ContentAst = [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: "00000000-0000-0000-0000-0000000000aa", text: "Alpha" },
      { type: "typed_link", verb: "supports", text: "beta" },
      { type: "math", expression: "x+y" },
    ];
    expect(excerptOf(ast)).toEqual({
      text: "see Alphabetax+y",
      truncated: false,
      cutOffset: 0,
    });
  });

  it("class chips count their resolved label via the resolver", () => {
    const ast: ContentAst = [
      { type: "text", text: "meet " },
      { type: "class_link", classId: "cls-1" },
    ];
    expect(excerptOf(ast, () => "Correo").text).toBe("meet Correo");
    // Unresolved and unlabeled: prose-invisible (the prose projection rule).
    expect(excerptOf(ast).text).toBe("meet ");
    // A one-off displayText wins over the resolver.
    const labeled: ContentAst = [
      { type: "class_link", classId: "cls-1", displayText: "the class" },
    ];
    expect(excerptOf(labeled, () => "Correo").text).toBe("the class");
  });

  it("headings recurse into their children", () => {
    const ast: ContentAst = [
      {
        type: "heading",
        level: 2,
        children: [{ type: "text", text: "Heading text" }],
      } as never,
    ];
    expect(excerptOf(ast).text).toBe("Heading text");
  });
});
