/**
 * Icon resolver tests: mdi-prefixed camelCase, kebab, and "mdi mdi-" class
 * strings resolve to the sprite id; emoji/text values pass through as text;
 * the never-real legacy name "mdiFormatHighlight" (a bad system-class seed
 * still present in stored rows) aliases to mdi-format-color-highlight.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Icon } from "../src/ui/Icon.js";

function spriteHref(path: string): string | null {
  const { container } = render(<Icon path={path} />);
  return container.querySelector("use")?.getAttribute("href") ?? null;
}

describe("Icon resolution", () => {
  it("resolves camelCase mdi names to kebab sprite ids", () => {
    expect(spriteHref("mdiFormatColorHighlight")).toBe("/mdi-sprite.svg#mdi-format-color-highlight");
    expect(spriteHref("mdiHeart")).toBe("/mdi-sprite.svg#mdi-heart");
  });

  it("accepts kebab and mdi-prefixed class strings", () => {
    expect(spriteHref("mdi-heart-outline")).toBe("/mdi-sprite.svg#mdi-heart-outline");
    expect(spriteHref("mdi mdi-heart-outline")).toBe("/mdi-sprite.svg#mdi-heart-outline");
  });

  it("aliases the never-real legacy name to its real MDI icon", () => {
    expect(spriteHref("mdiFormatHighlight")).toBe("/mdi-sprite.svg#mdi-format-color-highlight");
    expect(spriteHref("mdi-format-highlight")).toBe("/mdi-sprite.svg#mdi-format-color-highlight");
  });

  it("passes non-MDI values through as text glyphs", () => {
    const { container } = render(<Icon path="🔥" />);
    expect(container.querySelector("use")).toBeNull();
    expect(container.textContent).toBe("🔥");
  });

  it("unwrapping JSON-wrapped legacy icon rows", () => {
    expect(spriteHref('{"icon":"mdiFormatHighlight","color":"sky"}')).toBe(
      "/mdi-sprite.svg#mdi-format-color-highlight",
    );
    expect(spriteHref('{"icon":"mdiStar"}')).toBe("/mdi-sprite.svg#mdi-star");
  });

  it("renders nothing for an empty value", () => {
    const { container } = render(<Icon path="" />);
    expect(container.innerHTML).toBe("");
  });
});
