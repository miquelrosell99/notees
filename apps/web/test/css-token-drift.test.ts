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
 *   6. font-size rides the rem scale; em only at the allowlisted adaptive
 *      sites (the sanctioned type-tracking pattern).
 *   7. the --md-sys-color-* namespace stays Material-only (definitions) and
 *      surface aliases are cited only on their own surface.
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

/**
 * 7. The `--md-sys-color-*` namespace is reserved for Material You roles.
 *    variables.css may only DEFINE canonical roles plus the registered
 *    fleet extensions below — a new custom token in the md-sys namespace
 *    fails (name it outside the namespace, or register it here with a
 *    reason). Separately, a SURFACE ALIAS — a token named for ONE surface —
 *    may only be CITED on that surface's home files. This is the
 *    "menu cites --md-sys-color-sidebar-card" failure (2026-10-16): an
 *    alias leaks one surface's semantics into another; the citation
 *    should be the Material role directly.
 */
const M3_COLOR_ROLES = new Set([
  "background", "on-background", "surface", "on-surface", "surface-variant",
  "on-surface-variant", "surface-dim", "surface-bright", "surface-container",
  "surface-container-low", "surface-container-lowest", "surface-container-high",
  "surface-container-highest", "surface-tint", "inverse-surface",
  "inverse-on-surface", "inverse-primary", "primary", "on-primary",
  "primary-container", "on-primary-container", "primary-fixed",
  "primary-fixed-dim", "on-primary-fixed", "on-primary-fixed-variant",
  "secondary", "on-secondary", "secondary-container", "on-secondary-container",
  "secondary-fixed", "secondary-fixed-dim", "on-secondary-fixed",
  "on-secondary-fixed-variant", "tertiary", "on-tertiary",
  "tertiary-container", "on-tertiary-container", "tertiary-fixed",
  "tertiary-fixed-dim", "on-tertiary-fixed", "on-tertiary-fixed-variant",
  "error", "on-error", "error-container", "on-error-container",
  "outline", "outline-variant", "shadow", "scrim",
]);

// Fleet extensions the palette already defines under --md-sys-color-*.
// Each was grandfathered from variables.css when this gate landed; new
// extensions need a reason here.
const REGISTERED_MD_SYS_EXTENSIONS = new Set([
  "black", "white", "disabled", "on-disabled",
  "hover-overlay", "pressed-overlay", "focus-overlay",
  "primary-hover", "primary-pressed", "secondary-hover", "secondary-pressed",
  "tertiary-hover", "tertiary-pressed", "error-hover", "error-pressed",
  "success", "on-success", "success-container", "on-success-container",
  "warning", "on-warning", "warning-container", "on-warning-container",
  "callout-danger", "callout-danger-bg", "callout-success", "callout-success-bg",
  "callout-tip", "callout-tip-bg", "callout-warning", "callout-warning-bg",
  "preset-red", "preset-orange", "preset-yellow", "preset-green",
  "preset-teal", "preset-sky", "preset-blue", "preset-purple",
  "preset-pink", "preset-gray", "swatch-monochrome", "node-default-rgb",
  "query-accent", "surface-container-active",
  "presentation-stage", "on-presentation-stage", "on-presentation-stage-muted",
  // Surface alias (named for ONE surface) — its citations are governed by
  // SURFACE_ALIAS_HOMES below, not free to roam.
  "sidebar-card",
]);

// Surface aliases and the only files allowed to cite them (basename
// regex). Homes are the surface's own stylesheets plus the token file.
const SURFACE_ALIAS_HOMES = new Map<string, RegExp>([
  ["--md-sys-color-sidebar-card", /^(variables|app)\.css$|^PageCard\.css$/],
]);

/**
 * font-size in em is reserved for the sanctioned adaptive pattern — sizes
 * that must track the parent's type metrics (a heading scale source, inline
 * code that can sit inside a heading, slide-density multipliers). Every
 * other font-size rides the rem-based --font-size-* scale; px is banned by
 * test 3 and unlisted em by test 6. Each entry: [selector, file, reason].
 */
const EM_FONT_SIZE_ALLOWLIST: Array<[string, string, string]> = [
  [".nt-heading", "app.css", "heading scale source — the block content sizes relative to it"],
  ["code", "app.css", "inline code tracks the surrounding content size (headings included)"],
  [".nt-deck-slide--sparse .nt-deck-body", "deck.css", "slide density multiplier (P4)"],
  [".nt-deck-slide--dense .nt-deck-body", "deck.css", "slide density multiplier (P4)"],
];

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

  it("6. no em font-size outside the defining files except allowlisted adaptive sites", () => {
    // Collect every rule that sets an em font-size: one entry per selector
    // in the rule's selector list. Nested (media) preludes are stripped so
    // the selector compares clean.
    const emRules: Array<{ selector: string; file: string }> = [];
    for (const file of cssFiles) {
      if (DEFINING_FILES.has(path.basename(file))) continue;
      const css = stripComments(fs.readFileSync(file, "utf8"));
      for (const match of css.matchAll(/font-size\s*:\s*[0-9.]+em\b/g)) {
        const afterLastClose = css.lastIndexOf("}", match.index!) + 1;
        const between = css.slice(afterLastClose, match.index!);
        const openBrace = between.lastIndexOf("{");
        let selPart = openBrace === -1 ? between : between.slice(0, openBrace);
        const mediaCut = selPart.lastIndexOf("{");
        if (mediaCut !== -1) selPart = selPart.slice(mediaCut + 1);
        for (const selector of selPart.split(",").map((s) => s.trim()).filter(Boolean)) {
          emRules.push({ selector, file: path.basename(file) });
        }
      }
    }
    const allowed = new Set(EM_FONT_SIZE_ALLOWLIST.map(([sel, file]) => `${file}::${sel}`));
    for (const rule of emRules) {
      if (allowed.has(`${rule.file}::${rule.selector}`)) continue;
      expect.fail(
        `${rule.file} sets font-size in em on "${rule.selector}" — use the --font-size-* scale, or add an adaptive entry to EM_FONT_SIZE_ALLOWLIST with a reason`,
      );
    }
    // Rot check: every allowlisted site must still declare an em font-size.
    const declared = new Set(emRules.map((r) => `${r.file}::${r.selector}`));
    for (const [sel, file, reason] of EM_FONT_SIZE_ALLOWLIST) {
      expect(
        declared.has(`${file}::${sel}`),
        `EM_FONT_SIZE_ALLOWLIST entry ${sel} (${file}) no longer uses em — remove it (${reason})`,
      ).toBe(true);
    }
  });

  it("7. the --md-sys-color-* namespace stays Material-only; surface aliases stay on their surface", () => {
    const variablesFile = cssFiles.find((file) => path.basename(file) === "variables.css")!;
    const defined = definedTokens(stripComments(fs.readFileSync(variablesFile, "utf8")));

    // 7a. Nothing new may be DEFINED in the md-sys color namespace: every
    // definition must be a canonical Material role or a registered
    // extension. A new custom token here is namespace pollution — define
    // it outside --md-sys-* (or register it above with a reason).
    for (const token of defined) {
      if (!token.startsWith("--md-sys-color-")) continue;
      const role = token.slice("--md-sys-color-".length);
      if (M3_COLOR_ROLES.has(role)) continue;
      if (REGISTERED_MD_SYS_EXTENSIONS.has(role)) continue;
      expect.fail(
        `variables.css defines ${token} — the md-sys color namespace is reserved for Material You roles; ` +
          "use a fleet token outside the namespace or add the extension to REGISTERED_MD_SYS_EXTENSIONS with a reason",
      );
    }

    // 7b. A surface alias may only be CITED on its home files — citing
    // --md-sys-color-sidebar-card from a menu stylesheet was the
    // 2026-10-16 failure. Cite the Material role directly instead.
    for (const file of cssFiles) {
      const css = stripComments(fs.readFileSync(file, "utf8"));
      for (const match of css.matchAll(/var\((--md-sys-color-[a-zA-Z0-9-]+)/g)) {
        const token = match[1]!;
        const homes = SURFACE_ALIAS_HOMES.get(token);
        if (homes === undefined) continue;
        const base = path.basename(file);
        if (homes.test(base)) continue;
        expect.fail(
          `${path.relative(UI_DIR, file)} cites ${token} — a surface alias is named for ONE surface; ` +
            "cite the Material role directly (e.g. --md-sys-color-surface-container-high) or extend the alias's homes deliberately",
        );
      }
    }
  });
});
