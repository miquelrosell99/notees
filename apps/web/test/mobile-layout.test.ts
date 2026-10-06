/**
 * Mobile layout contract tests: the responsive pass lives in
 * app.css as additive media queries — this file pins the contract so the
 * block cannot silently rot: two breakpoint steps (768px tablet chrome, 480px
 * phone bottom sheet), the drawer-surface + touch-target adaptations, the
 * peek card's full-width sheet override, and token-only values inside the
 * block (no hex literals / no raw px).
 */

import { describe, expect, it } from "vitest";

// The web vitest config aliases node:fs to a browser shim, and jsdom makes
// import.meta.url non-file — so the CSS read escapes through Node 22's
// process.getBuiltinModule (the color-presets parity guard's pattern), with
// a cwd-relative path (pnpm runs each package's tests from its root).
const readFile = (
  process as unknown as {
    getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
  }
).getBuiltinModule("node:fs").readFileSync;
const css = readFile(`${process.cwd()}/src/ui/app.css`, "utf8");

/** The responsive block: from its banner comment to the next top-level rule. */
function responsiveBlock(): string {
  const marker = css.indexOf("responsive pass (MobileLayout)");
  if (marker === -1) throw new Error("responsive pass banner missing from app.css");
  const start = css.lastIndexOf("/*", marker);
  const rest = css.slice(start === -1 ? marker : start);
  const end = rest.indexOf("\n/* ---", 10);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("mobile layout (app.css responsive pass)", () => {
  it("keeps the two breakpoint steps", () => {
    const block = responsiveBlock();
    expect(block).toContain("@media (max-width: 768px)");
    expect(block).toContain("@media (max-width: 480px)");
  });

  it("adapts the sidebar drawer, touch targets, and the page chrome", () => {
    const block = responsiveBlock();
    // The drawer gets a real surface above the page beneath.
    expect(block).toContain(".nt-sidebar-open .nt-sidebar");
    expect(block).toContain("--color-surface-container-low");
    // Touch targets: sidebar rows, the favorite star, and the shell icon
    // buttons all reach the 44px button token floor.
    expect(block).toContain("--height-button-lg");
    expect(block).toMatch(/\.nt-side-item\s*\{[^}]*min-height/s);
    expect(block).toMatch(/\.nt-icon-btn\s*\{[^}]*height/s);
    // The wordmark yields its space in the topbar.
    expect(block).toContain(".nt-wordmark");
  });

  it("makes the peek card a full-width bottom sheet at phone widths", () => {
    const block = responsiveBlock();
    expect(block).toContain(".nt-body .nt-right-card");
    expect(block).toContain("position: fixed");
    expect(block).toContain("width: 100%");
    expect(block).toContain("bottom: 0");
  });

  it("surfaces the quick-create FAB at narrow widths only (hidden on desktop)", () => {
    const block = responsiveBlock();
    // The FAB renders inside the tablet step…
    expect(block).toContain(".nt-quick-fab");
    expect(block).toContain("position: fixed");
    expect(block).toContain("safe-area-inset-bottom");
    // …and the base (desktop) rule keeps it out of the way.
    const baseRule = css.match(/\.nt-quick-fab\s*\{[^}]*\}/);
    expect(baseRule).not.toBeNull();
    expect(baseRule![0]).toContain("display: none");
  });

  it("uses token-only values inside the block (no hex, no bare px)", () => {
    const block = responsiveBlock();
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // Raw numbers may appear only inside function arguments (min/max/env/calc
    // layout math), media-query syntax (custom properties cannot parameterize
    // @media — variables.css says so), and comments; bare declaration values
    // resolve to tokens. rgba() nests inside var() fallbacks, so strip it
    // first; then repeat the function strip to a fixpoint.
    let cleaned = responsiveBlock().replace(/\/\*[\s\S]*?\*\//g, "");
    cleaned = cleaned.replace(/@media[^{]*\{/g, "@media{");
    // Function arguments (layout math + rgba fallbacks nested in var()).
    // Repeat to a fixpoint: each pass strips the innermost layer.
    let previous: string;
    do {
      previous = cleaned;
      cleaned = cleaned.replace(
        /\b(?:min|max|clamp|env|calc|var|rgba|hsla?)\([^()]*\)/g,
        "",
      );
    } while (cleaned !== previous);
    expect(cleaned).not.toMatch(/(?<!-)\b\d+(?:\.\d+)?px\b/);
  });
});
