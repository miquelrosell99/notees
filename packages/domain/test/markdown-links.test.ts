/**
 * splitMarkdownLinks — the shared linkify grammar (SCHEMA.md render
 * grammar): markdown `[label](href)` spans inside text tokens, plus
 * bare-URL autolinking of the text left over between them. Non-http(s)
 * schemes stay literal text, never anchors.
 */

import { describe, expect, it } from "vitest";

import { flattenMarkdownLinks, splitMarkdownLinks } from "../src/markdownLinks.js";

describe("splitMarkdownLinks: markdown spans", () => {
  it("splits a markdown link out of surrounding text", () => {
    expect(splitMarkdownLinks("see [the docs](https://example.com/path) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the docs", href: "https://example.com/path" },
      { kind: "text", text: " now" },
    ]);
  });

  it("keeps non-linkable hrefs (javascript:, relative) as literal text", () => {
    expect(splitMarkdownLinks("[x](javascript:alert) [y](/relative/path)")).toEqual([
      { kind: "text", text: "[x](javascript:alert)" },
      { kind: "text", text: " " },
      { kind: "text", text: "[y](/relative/path)" },
    ]);
  });

  it("returns the whole string as one text segment when nothing linkifies", () => {
    expect(splitMarkdownLinks("just words [with] brackets")).toEqual([
      { kind: "text", text: "just words [with] brackets" },
    ]);
  });
});

describe("splitMarkdownLinks: bare URLs", () => {
  it("linkifies a bare http(s) URL", () => {
    expect(splitMarkdownLinks("watch https://www.youtube.com/watch?v=Q9HSosZcVbc later")).toEqual([
      { kind: "text", text: "watch " },
      {
        kind: "link",
        text: "https://www.youtube.com/watch?v=Q9HSosZcVbc",
        href: "https://www.youtube.com/watch?v=Q9HSosZcVbc",
      },
      { kind: "text", text: " later" },
    ]);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    expect(splitMarkdownLinks("(see https://example.com/page).")).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", text: "https://example.com/page", href: "https://example.com/page" },
      { kind: "text", text: ")." },
    ]);
    expect(splitMarkdownLinks("go https://example.com/a, then https://example.com/b; end")).toEqual([
      { kind: "text", text: "go " },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: ", then " },
      { kind: "link", text: "https://example.com/b", href: "https://example.com/b" },
      { kind: "text", text: "; end" },
    ]);
  });

  it("keeps balanced parens in the URL but drops unbalanced closers", () => {
    expect(splitMarkdownLinks("https://x.com/a(b)")).toEqual([
      { kind: "link", text: "https://x.com/a(b)", href: "https://x.com/a(b)" },
    ]);
    expect(splitMarkdownLinks("(https://x.com)")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", text: "https://x.com", href: "https://x.com" },
      { kind: "text", text: ")" },
    ]);
    expect(splitMarkdownLinks("https://x.com/a(b))")).toEqual([
      { kind: "link", text: "https://x.com/a(b)", href: "https://x.com/a(b)" },
      { kind: "text", text: ")" },
    ]);
  });

  it("does not autolink inside a markdown link label or href", () => {
    expect(splitMarkdownLinks("[see https://a.example/x](https://b.example/y)")).toEqual([
      { kind: "link", text: "see https://a.example/x", href: "https://b.example/y" },
    ]);
  });

  it("splits a markdown link and a bare URL in one string", () => {
    expect(splitMarkdownLinks("[docs](https://example.com/d) and https://example.com/raw")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com/d" },
      { kind: "text", text: " and " },
      { kind: "link", text: "https://example.com/raw", href: "https://example.com/raw" },
    ]);
  });

  it("never linkifies non-http(s) schemes (javascript:, ftp:)", () => {
    expect(splitMarkdownLinks("run javascript:alert(1) now")).toEqual([
      { kind: "text", text: "run javascript:alert(1) now" },
    ]);
    expect(splitMarkdownLinks("grab ftp://example.com/file")).toEqual([
      { kind: "text", text: "grab ftp://example.com/file" },
    ]);
  });

  it("does not linkify a bare scheme with no host", () => {
    expect(splitMarkdownLinks("type https:// then rest")).toEqual([
      { kind: "text", text: "type https:// then rest" },
    ]);
  });
});

/**
 * flattenMarkdownLinks — the display-name flatten (title-is-content): a
 * title authored as a markdown span reads as its visible text everywhere
 * the display name goes (the hub's Title column, breadcrumbs, pickers) —
 * `[label](href)` → `label`, `![alt](src)` → `alt`. The same conservative
 * grammar as splitMarkdownLinks: non-linkable hrefs stay literal, plain
 * text and bare URLs pass through untouched.
 */
describe("flattenMarkdownLinks", () => {
  it("reduces a markdown link to its label text", () => {
    expect(
      flattenMarkdownLinks("[¡Imprime en 3D tu propia...](https://makerworld.com/models/1) review"),
    ).toBe("¡Imprime en 3D tu propia... review");
  });

  it("reduces a markdown image to its alt text", () => {
    expect(flattenMarkdownLinks("![A hand-drawn chart](https://example.com/chart.png) notes")).toBe(
      "A hand-drawn chart notes",
    );
  });

  it("drops an image with empty alt text", () => {
    expect(flattenMarkdownLinks("![](https://example.com/chart.png) notes")).toBe(" notes");
  });

  it("keeps non-linkable hrefs (javascript:, relative) as literal text", () => {
    expect(flattenMarkdownLinks("[x](javascript:alert) [y](/relative/path)")).toBe(
      "[x](javascript:alert) [y](/relative/path)",
    );
  });

  it("leaves plain text with brackets and parens untouched", () => {
    expect(flattenMarkdownLinks("just [brackets] and (parens) [unclosed]( nope")).toBe(
      "just [brackets] and (parens) [unclosed]( nope",
    );
  });

  it("keeps bare URLs as text", () => {
    expect(flattenMarkdownLinks("see https://example.com/page now")).toBe(
      "see https://example.com/page now",
    );
  });

  it("flattens a link and an image in one string", () => {
    expect(
      flattenMarkdownLinks("[docs](https://example.com/d) and ![pic](https://example.com/p.png) end"),
    ).toBe("docs and pic end");
  });
});
