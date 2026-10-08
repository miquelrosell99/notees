/**
 * css-token-drift — the design-token gate.
 *
 * The audit batch emptied component CSS of hex/rgb
 * color literals, bare box-shadows, and px font-size/radius literals;
 * everything resolves to a custom property from variables.css. This gate
 * fails the build if a future change drifts any of those classes back in:
 *
 *   1. every `var(--token)` reference names a token that variables.css
 *      actually defines (or an explicit JS-scoped allowlist entry);
 *   2. no bare color literal outside variables.css/fonts.css — a literal
 *      is allowed only inside a var(...) fallback span;
 *   3. no px font-size literal outside variables.css/fonts.css (any size —
 *      the scale is rem-token based);
 *   4. no px border-radius literal outside variables.css/fonts.css (the
 *      --shape-* scale owns corners);
 *   5. no color literal inside a var(...) fallback outside the defining
 *      files — a fallback that always wins is a hardcoded color (fallbacks
 *      must only fire in tests; legitimate defaults are var() chains or
 *      unitless numbers like 0/1).
 *
 * House rule (AGENTS.md): the library's CSS is token-only.
 */
import { describe, expect, it } from "vitest";

const process_ = process as unknown as { getBuiltinModule(name: string): typeof import("node:fs") };
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

const UI_DIR = path.join(process.cwd(), "src", "ui");
const DEFINING_FILES = new Set(["variables.css", "fonts.css"]);
// Custom properties set from JS (style.setProperty) rather than CSS — each
// entry names the file that owns it.
const JS_SCOPED = new Map<string, string>([
  ["--color-accent-custom", "deviceSettings.ts"],
  ["--color-on-accent-custom", "deviceSettings.ts"],
  ["--sheet-drag-offset", "Modal.tsx"],
  ["--sheet-scrim-opacity", "Modal.tsx"],
  ["--nt-float-raise", "FloatingEditor.tsx"],
  ["--nt-fb-depth", "FilterBlockBuilder.tsx"],
]);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function walkCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkCssFiles(full, out);
    } else if (entry.name.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

/** Collect the custom properties a stylesheet DEFINES (`--x:` at rule start). */
function definedTokens(css: string): Set<string> {
  const found = new Set<string>();
  for (const match of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    found.add(match[1]!);
  }
  return found;
}

/** Strip C comments so an unbalanced "(" in prose cannot break the paren walk. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The spans of a balanced-paren walk: returns the char ranges that sit
 * INSIDE any (...), so a color literal is exempt when (and only when) it
 * is a var(...) fallback.
 */
function parenSpans(css: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const stack: number[] = [];
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "(") stack.push(i);
    else if (css[i] === ")" && stack.length > 0) {
      const start = stack.pop()!;
      if (stack.length === 0) spans.push([start, i]);
    }
  }
  return spans;
}

function inSpans(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => index > a && index < b);
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;

describe("css token drift gate", () => {
  const cssFiles = walkCssFiles(UI_DIR);

  it("1. every var(--token) names a defined token (or an allowlisted JS-scoped one)", () => {
    // Tokens may be defined in variables.css OR scoped locally in a component
    // stylesheet (e.g. PageCard.css defines --breadcrumb-clip-bg for its subtree).
    const defined = new Set<string>();
    for (const file of cssFiles) {
      for (const token of definedTokens(stripComments(fs.readFileSync(file, "utf8")))) {
        defined.add(token);
      }
    }
    for (const file of cssFiles) {
      const css = stripComments(fs.readFileSync(file, "utf8"));
      for (const match of css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
        const token = match[1]!;
        if (defined.has(token)) continue;
        if (JS_SCOPED.has(token)) continue;
        expect.fail(`${path.relative(UI_DIR, file)} references undefined token var(${token})`);
      }
    }
    // The allowlist must not rot: every entry's owner file must still set it.
    const uiFiles = walkFiles(UI_DIR);
    for (const [token, owner] of JS_SCOPED) {
      const src = uiFiles
        .filter((file) => path.basename(file) === owner)
        .map((file) => fs.readFileSync(file, "utf8"))
        .join("\n");
      // Tolerate multi-line setProperty( calls: token must be the first
      // argument; also accept the React inline-style object form
      // ("--token": value) that FloatingEditor uses for its raise counter.
      const setter = new RegExp(
        `setProperty\\(\\s*["']${token}["']|["']${token}["']\\s*:`,
      );
      expect(setter.test(src), `JS_SCOPED ${token} is no longer set in ${owner} — remove it`).toBe(true);
    }
  });

  it("2. no bare color literal outside the defining files", () => {
    for (const file of cssFiles) {
      if (DEFINING_FILES.has(path.basename(file))) continue;
      const css = stripComments(fs.readFileSync(file, "utf8"));
      const spans = parenSpans(css);
      for (const match of css.matchAll(COLOR_LITERAL)) {
        if (inSpans(match.index!, spans)) continue; // a var(...) fallback
        expect.fail(`${path.relative(UI_DIR, file)} has a bare color literal at offset ${match.index!}: ${match[0]}`);
      }
    }
  });

  it("3. no px font-size literal outside the defining files", () => {
    for (const file of cssFiles) {
      if (DEFINING_FILES.has(path.basename(file))) continue;
      const css = fs.readFileSync(file, "utf8");
      for (const match of css.matchAll(/font-size\s*:\s*([0-9.]+)px/g)) {
        expect.fail(
          `${path.relative(UI_DIR, file)} sets a ${match[1]}px font-size at offset ${match.index!} — use the --font-size-* scale`,
        );
      }
    }
  });

  it("4. no px border-radius literal outside the defining files", () => {
    for (const file of cssFiles) {
      if (DEFINING_FILES.has(path.basename(file))) continue;
      const css = fs.readFileSync(file, "utf8");
      for (const match of css.matchAll(/border-radius\s*:\s*([0-9.]+)px/g)) {
        expect.fail(
          `${path.relative(UI_DIR, file)} sets a ${match[1]}px border-radius at offset ${match.index!} — use the --shape-* scale`,
        );
      }
    }
  });

  it("5. no color literal inside a var(...) fallback outside the defining files", () => {
    for (const file of cssFiles) {
      if (DEFINING_FILES.has(path.basename(file))) continue;
      const css = stripComments(fs.readFileSync(file, "utf8"));
      const spans = parenSpans(css);
      for (const match of css.matchAll(COLOR_LITERAL)) {
        if (!inSpans(match.index!, spans)) continue; // bare literals are test 2
        // Inside var(...): only var() chains and unitless numeric defaults
        // (0/1) are honest fallbacks — a color literal fallback would win
        // whenever the token is unset.
        const lineStart = css.lastIndexOf("\n", match.index!) + 1;
        const line = css.slice(lineStart, css.indexOf("\n", match.index!));
        if (/var\([^)]*var\(/.test(line) || /var\([^)]*,\s*-?[01]\s*\)/.test(line)) continue;
        expect.fail(
          `${path.relative(UI_DIR, file)} has a color literal inside a var() fallback: ${line.trim()}`,
        );
      }
    }
  });
});
