/**
 * Color preset layer tests: the wire grammar helpers (canonicalColor /
 * cssColorFor / resolveCssColor) and the PRESET_HEX ↔ variables.css parity
 * guard — the static token→hex map used for contrast/canvas math MUST
 * mirror the themed CSS table, or pills compute text contrast against the
 * wrong color.
 */

import { describe, expect, it } from "vitest";

import { COLOR_PRESET_TOKENS } from "@notees/protocol";

import {
  PRESET_COLOR_ENTRIES,
  PRESET_HEX,
  canonicalColor,
  cssColorFor,
  resolveCssColor,
} from "../src/ui/components/ui/colorPresets.js";

// The web vitest config aliases node:fs to a browser shim, and jsdom makes
// import.meta.url non-file — so the parity read escapes through Node 22's
// process.getBuiltinModule (which bypasses module resolution entirely) with
// a cwd-relative path (pnpm runs each package's tests from its root).
const readFile = (
  process as unknown as {
    getBuiltinModule(name: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
  }
).getBuiltinModule("node:fs").readFileSync;
const variablesCss = readFile(`${process.cwd()}/src/ui/variables.css`, "utf8");

describe("colorPresets", () => {
  it("PRESET_HEX mirrors variables.css --color-preset-* exactly (drift guard)", () => {
    for (const token of COLOR_PRESET_TOKENS) {
      const match = new RegExp(`--color-preset-${token}:\\s*(#[0-9a-fA-F]{6})`).exec(variablesCss);
      expect(match, `variables.css lacks --color-preset-${token}`).not.toBeNull();
      expect(PRESET_HEX[token]).toBe(match![1]!.toLowerCase());
    }
    // No stray preset vars in CSS that the TS map doesn't know.
    const cssVars = [...variablesCss.matchAll(/--color-preset-([a-z]+):/g)].map((m) => m[1]);
    expect(cssVars.sort()).toEqual([...COLOR_PRESET_TOKENS].sort());
  });

  it("entries cover every token in hue order + gray, labels human-readable", () => {
    expect(PRESET_COLOR_ENTRIES.map((e) => e.value)).toEqual([...COLOR_PRESET_TOKENS]);
    expect(PRESET_COLOR_ENTRIES.every((e) => e.label.length > 0)).toBe(true);
  });

  it("cssColorFor maps tokens to themed vars and passes hex through", () => {
    expect(cssColorFor("sky")).toBe("var(--color-preset-sky)");
    expect(cssColorFor("#123abc")).toBe("#123abc");
  });

  it("resolveCssColor maps tokens to concrete hex and passes hex through", () => {
    expect(resolveCssColor("sky")).toBe(PRESET_HEX.sky);
    expect(resolveCssColor("#123abc")).toBe("#123abc");
  });

  it("canonicalColor folds the retired var() encoding to its token", () => {
    expect(canonicalColor("var(--color-preset-red)")).toBe("red");
    expect(canonicalColor("var(--color-preset-sky)")).toBe("sky");
    // Unknown var names and everything else pass through untouched.
    expect(canonicalColor("var(--color-preset-nope)")).toBe("var(--color-preset-nope)");
    expect(canonicalColor("teal")).toBe("teal");
    expect(canonicalColor("#abcdef")).toBe("#abcdef");
  });

  it("helpers agree: cssColorFor(resolveCssColor(x)) never throws and hex is stable", () => {
    for (const token of COLOR_PRESET_TOKENS) {
      expect(cssColorFor(token)).toBe(`var(--color-preset-${token})`);
      expect(resolveCssColor(token)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
