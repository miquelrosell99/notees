/**
 * Mobile layout contract tests: the responsive pass lives in
 * app.css as additive media queries — this file pins the contract so the
 * block cannot silently rot: the 768px step (tablet chrome + the panelled
 * editor's compact stacking), the drawer-surface + touch-target adaptations,
 * and token-only values inside the block (no hex literals / no raw px).
 * The panelled stacking itself moved to MainContentFrame.css 2026-10-23
 * (the composition generalized into the shared frame) — its pin reads that
 * file directly below.
 *
 * The retired 480px bottom-sheet step stays pinned as ABSENT (owner ruling
 * 2026-10-19): the rule it carried targeted an element React never mounts —
 * at phone widths the panelled layout stacks instead (asserted below).
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
const frameCss = readFile(`${process.cwd()}/src/ui/MainContentFrame.css`, "utf8");

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
  it("keeps the 768px step and the retired 480px step absent", () => {
    const block = responsiveBlock();
    expect(block).toContain("@media (width <= 768px)");
    // Retired with the dead bottom-sheet rule (audit 2026-10-19) — the
    // 480px step must not creep back in.
    expect(block).not.toContain("@media (width <= 480px)");
  });

  it("adapts the sidebar drawer, touch targets, and the page chrome", () => {
    const block = responsiveBlock();
    // The drawer gets a real surface above the page beneath.
    expect(block).toContain(".nt-sidebar-open .nt-sidebar");
    expect(block).toContain("--md-sys-color-surface-container-low");
    // Touch targets: sidebar rows and the favorite star grow to the button
    // height token (the sidebar is an exception surface — the 48dp touch
    // floor does not apply there). The shell icon buttons ride the fleet
    // catalog Button since 2026-10-20 — their 48dp hit area is the
    // invisible min-touch overlay inside every icon-only button, present
    // at every width, so the responsive pass no longer enlarges them.
    expect(block).toContain("--height-button-lg");
    expect(block).toMatch(/\.nt-side-item\s*\{[^}]*min-height/s);
    expect(block).toMatch(/\.nt-side-star\s*\{[^}]*height/s);
    // The wordmark yields its space in the topbar.
    expect(block).toContain(".nt-wordmark");
  });

  it("stacks the panelled editor at compact widths (the 390px adaptation)", () => {
    // The audit-2026-10-19 Critical: the two panel cards' minima outran the
    // content card and the document column vanished at 390px. The page now
    // stacks — content first, panels full-width below. The rule lives in
    // MainContentFrame.css since 2026-10-23 (the composition generalized
    // into the shared frame).
    expect(frameCss).toContain(".nt-main-frame__body");
    expect(frameCss).toMatch(/@media \(width <= 768px\)\s*\{[^]*?\.nt-main-frame__body\s*\{[^}]*flex-direction:\s*column/s);
    expect(frameCss).toContain("order: -1"); // the content column leads
    // The retired right-rail bottom sheet stays retired.
    expect(css).not.toContain(".nt-body .nt-right-card");
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
