// Token-value pinning: the CSS-source tests (view-modes, condensed, …) assert
// token NAMES after the sweep — revaluing a token in variables.css would pass
// them and silently break the pixel-identity the sweep guaranteed. This spec
// pins the VALUES: every custom property declared in variables.css is hashed
// (any edit to any value fails the hash, and vitest -u cannot touch it), and
// the law-critical scales are pinned by name so a failure names the revalued
// token. The hash is computed over the full ordered declaration list, so
// theme-block redefinitions are covered too.
import { describe, expect, it } from "vitest";

// jsdom + the vite node: shim: builtins come through process.getBuiltinModule
// (the css-source idiom — see condensed.test.tsx).
const process_ = process as unknown as {
  getBuiltinModule(name: string): never;
};
const { createHash, readFileSync, join } = (() => {
  const crypto_ = process_.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  const fs_ = process_.getBuiltinModule("node:fs") as typeof import("node:fs");
  const path_ = process_.getBuiltinModule("node:path") as typeof import("node:path");
  return { createHash: crypto_.createHash, readFileSync: fs_.readFileSync, join: path_.join };
})();

// vitest runs with cwd = apps/web (house idiom — see condensed.test.tsx).
const css = readFileSync(join(process.cwd(), "src", "ui", "variables.css"), "utf8");

const declarations = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gi)].map((m) => [
  m[1]!,
  m[2]!.trim(),
] as const);

const once = new Map<string, string>();
for (const [name, value] of declarations) {
  if (!once.has(name)) once.set(name, value);
}

// The full-map hash: any value change, addition, or removal lands here.
const HASH = "1ee5f9d562a69ed319ef1b2b27ea39a83b16b385ee9bc7d9a9bcade9f757f4f3";

describe("variables.css token values are pinned", () => {
  it("the full declaration set is unchanged (sha256)", () => {
    const digest = createHash("sha256")
      .update(declarations.map(([n, v]) => `${n}:${v}`).join("\n"))
      .digest("hex");
    expect(digest).toBe(HASH);
  });

  it.each([
    // spacing scale (the sweep's workhorse)
    ["--spacing-micro", "2px"],
    ["--spacing-tiny", "3px"],
    ["--spacing-xxs", "5px"],
    ["--spacing-1", "0.25rem"],
    ["--spacing-1-5", "0.375rem"],
    ["--spacing-2", "0.5rem"],
    ["--spacing-2-5", "0.625rem"],
    ["--spacing-3", "0.75rem"],
    ["--spacing-3-5", "0.875rem"],
    ["--spacing-4", "1rem"],
    ["--spacing-4-5", "1.125rem"],
    ["--spacing-5", "1.25rem"],
    ["--spacing-5-5", "1.375rem"],
    ["--spacing-6", "1.5rem"],
    ["--spacing-7", "1.75rem"],
    ["--spacing-7-5", "1.875rem"],
    ["--spacing-8", "2rem"],
    ["--spacing-9", "2.25rem"],
    ["--spacing-10", "2.5rem"],
    ["--spacing-12", "3rem"],
    ["--spacing-hairline", "1px"],
    // border ladder
    ["--border-width-default", "1px"],
    ["--border-width-medium", "1.5px"],
    ["--border-width-thick", "2px"],
    ["--border-width-extra-thick", "3px"],
    // motion scale
    ["--motion-duration-reduced-motion", "0.01ms"],
    ["--motion-duration-instant", "50ms"],
    ["--motion-duration-caret-move", "80ms"],
    ["--motion-duration-short", "100ms"],
    ["--motion-duration-shorter", "150ms"],
    ["--motion-duration-medium-fast", "200ms"],
    ["--motion-duration-medium", "250ms"],
    ["--motion-duration-long", "300ms"],
    ["--motion-duration-extra-long", "500ms"],
    ["--motion-duration-pulse", "1.2s"],
    ["--motion-duration-cover-pulse", "1.6s"],
    // breakpoints
    ["--breakpoint-phone", "480px"],
    ["--breakpoint-tablet", "768px"],
    ["--breakpoint-desktop", "1024px"],
    // sweep-added z tiers (exact values — stacking order depends on them)
    ["--z-6", "6"],
    ["--z-neg-1", "-1"],
    ["--z-60", "60"],
    ["--z-70", "70"],
    ["--z-80", "80"],
    // shape cornerstones
    ["--shape-small", "4px"],
    ["--shape-full", "9999px"],
    // sweep-added role widths
    ["--width-sidebar", "260px"],
    ["--width-sidebar-drawer", "280px"],
    ["--width-col-min", "80px"],
    ["--import-list-max-height", "12rem"],
  ])("%s is %s", (name, value) => {
    expect(once.get(name), `token ${name} must be declared`).toBe(value);
  });
});
