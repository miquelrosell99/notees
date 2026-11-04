/**
 * cn merge rules — the classGroups the joiner registers beyond
 * tailwind-merge's defaults.
 *
 * The regression this guards: the Spinner's arc ring cites
 * `border-thick border-solid border-outline-variant
 * border-t-on-surface-variant`, and an unregistered custom width name is
 * parsed as a border COLOR — so the later color utilities made tailwind-merge
 * DROP the width, the ring rendered with border-width 0 (invisible: the
 * button widened by the empty span, no arc), and the loading button showed
 * no animation. The custom width names must sit in the border-width group.
 */
import { describe, expect, it } from "vitest";

import { cn } from "../src/utils/cn.js";

describe("cn custom scale registration", () => {
  it("keeps border-thick alongside the border color utilities (the Spinner arc)", () => {
    const out = cn(
      "inline-block rounded-full border-thick border-solid border-outline-variant border-t-on-surface-variant",
    );
    expect(out).toContain("border-thick");
    expect(out).toContain("border-outline-variant");
    expect(out).toContain("border-t-on-surface-variant");
  });

  it("keeps border-extra-thick alongside border color utilities (the lg Spinner)", () => {
    const out = cn("border-extra-thick border-dashed border-outline-variant");
    expect(out).toContain("border-extra-thick");
    expect(out).toContain("border-outline-variant");
  });

  it("keeps the Card dashed shell's border-thick with its color", () => {
    const out = cn("bg-transparent border-thick border-dashed border-outline-variant");
    expect(out).toContain("border-thick");
    expect(out).toContain("border-dashed");
  });

  it("still resolves true conflicts: a later width replaces an earlier width", () => {
    const out = cn("border-thick border-extra-thick");
    expect(out).not.toContain("border-thick");
    expect(out).toContain("border-extra-thick");
  });

  it("still resolves true conflicts: a later color replaces an earlier color", () => {
    const out = cn("border-outline-variant border-on-surface");
    expect(out).not.toContain("border-outline-variant");
    expect(out).toContain("border-on-surface");
  });

  it("keeps the font-size registrations working (text-button is a size, not a color)", () => {
    const out = cn("text-button text-on-error");
    expect(out).toContain("text-button");
    expect(out).toContain("text-on-error");
  });
});
