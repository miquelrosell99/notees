/**
 * Markdown-link fallback tests: a `text` token carrying `[label](href)`
 * syntax (the only form imports and external writers can put in a title —
 * rich tokens flatten on parentless creates) renders as a hyperlink, while
 * non-linkable syntax stays literal text. The retired `external_link`
 * token's replacement (SCHEMA.md render grammar — links are markdown spans
 * inside `text` tokens, parsed at render time). Bare `http(s)://` URLs in
 * the remaining text autolink too; the click gesture belongs to the block
 * row (a plain click never follows the href — Ctrl/Cmd+click does).
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { InlineTokens } from "../src/ui/InlineTokens.js";

describe("InlineTokens markdown-link fallback", () => {
  it("renders a whole-token markdown link as a hyperlink", () => {
    const { container } = render(
      <InlineTokens
        tokens={[
          {
            type: "text",
            text: "[Footballer Ian Wright Reunites With His Teacher](https://www.youtube.com/watch?v=Q9HSosZcVbc)",
          },
        ]}
      />,
    );
    const anchor = container.querySelector("a.nt-hyperlink");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://www.youtube.com/watch?v=Q9HSosZcVbc");
    expect(anchor!.getAttribute("target")).toBe("_blank");
    expect(anchor!.textContent).toBe("Footballer Ian Wright Reunites With His Teacher");
  });

  it("renders a markdown link between plain text as one anchor plus text", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "text", text: "see [the docs](https://example.com/path) now" }]}
      />,
    );
    const anchor = container.querySelector("a.nt-hyperlink");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://example.com/path");
    expect(anchor!.textContent).toBe("the docs");
    const span = container.querySelector("span")!;
    expect(span.textContent).toBe("see the docs now");
  });

  it("keeps the token's marks on the link label and the text segments", () => {
    const { container } = render(
      <InlineTokens
        tokens={[
          { type: "text", text: "read [more](https://example.com) here", marks: ["bold"] },
        ]}
      />,
    );
    const anchor = container.querySelector("a.nt-hyperlink")!;
    expect(anchor.firstElementChild!.tagName).toBe("STRONG");
    expect(container.querySelectorAll("strong")).toHaveLength(3);
  });

  it("renders multiple links in one token", () => {
    const { container } = render(
      <InlineTokens
        tokens={[
          {
            type: "text",
            text: "[one](https://a.example) and [two](https://b.example)",
          },
        ]}
      />,
    );
    const anchors = container.querySelectorAll("a.nt-hyperlink");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.getAttribute("href")).toBe("https://a.example");
    expect(anchors[1]!.getAttribute("href")).toBe("https://b.example");
  });

  it("leaves non-http schemes, relative paths, and unmatched brackets literal", () => {
    const { container } = render(
      <InlineTokens
        tokens={[
          {
            type: "text",
            text: "[x](javascript:alert) [y](/relative/path) [broken]( and [z](not a url)",
          },
        ]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(
      "[x](javascript:alert) [y](/relative/path) [broken]( and [z](not a url)",
    );
  });

  it("passes plain text through untouched when no link syntax is present", () => {
    const { container } = render(
      <InlineTokens tokens={[{ type: "text", text: "just words [with] brackets", marks: ["italic"] }]} />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("em")!.textContent).toBe("just words [with] brackets");
  });
});

describe("InlineTokens bare-URL autolinking", () => {
  it("renders a bare URL as a hyperlink with the URL as its label", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "text", text: "watch https://www.youtube.com/watch?v=Q9HSosZcVbc now" }]}
      />,
    );
    const anchor = container.querySelector("a.nt-hyperlink");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("https://www.youtube.com/watch?v=Q9HSosZcVbc");
    expect(anchor!.textContent).toBe("https://www.youtube.com/watch?v=Q9HSosZcVbc");
  });

  it("keeps trailing sentence punctuation outside the link", () => {
    const { container } = render(
      <InlineTokens tokens={[{ type: "text", text: "(see https://example.com/page)." }]} />,
    );
    const anchor = container.querySelector("a.nt-hyperlink")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/page");
    expect(container.textContent).toBe("(see https://example.com/page).");
  });

  it("renders a markdown link and a bare URL in one token", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "text", text: "[docs](https://example.com/d) and https://example.com/raw" }]}
      />,
    );
    const anchors = container.querySelectorAll("a.nt-hyperlink");
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.getAttribute("href")).toBe("https://example.com/d");
    expect(anchors[0]!.textContent).toBe("docs");
    expect(anchors[1]!.getAttribute("href")).toBe("https://example.com/raw");
    expect(anchors[1]!.textContent).toBe("https://example.com/raw");
  });

  it("leaves javascript: and other non-http schemes literal", () => {
    const { container } = render(
      <InlineTokens tokens={[{ type: "text", text: "run javascript:alert(1) at ftp://example.com/x" }]} />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("run javascript:alert(1) at ftp://example.com/x");
  });
});

describe("InlineTokens hyperlink click gesture", () => {
  const tokens = [{ type: "text", text: "[site](https://example.com/x)" }];

  it("preventDefaults a plain click (no navigation; the event still bubbles)", () => {
    const { container } = render(<InlineTokens tokens={tokens} />);
    const anchor = container.querySelector("a.nt-hyperlink")!;
    // fireEvent returns false when the event was canceled — the anchor must
    // cancel the default so the href is never followed…
    expect(fireEvent.click(anchor)).toBe(false);
    // …and the click must still reach a parent listener (no stopPropagation).
    let bubbled = false;
    container.firstElementChild!.addEventListener("click", () => {
      bubbled = true;
    });
    fireEvent.click(anchor);
    expect(bubbled).toBe(true);
  });

  it("allows a modified click to keep the browser default", () => {
    const { container } = render(<InlineTokens tokens={tokens} />);
    const anchor = container.querySelector("a.nt-hyperlink")!;
    expect(fireEvent.click(anchor, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(anchor, { metaKey: true })).toBe(true);
    expect(fireEvent.click(anchor, { shiftKey: true })).toBe(true);
  });

  it("carries a title hinting the Ctrl+click affordance", () => {
    const { container } = render(<InlineTokens tokens={tokens} />);
    expect(container.querySelector("a.nt-hyperlink")!.getAttribute("title")).toBe(
      "Ctrl+click to open link",
    );
  });
});
