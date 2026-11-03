#!/usr/bin/env node
/**
 * check-css-tokens.mjs — the app-level CSS token-drift gate.
 *
 * The law (docs/developers/ui-primitives.md + the RosellRamos design
 * skill): every value in app CSS resolves to a custom property from
 * src/ui/variables.css. Hard-coded values the law owns are drift.
 *
 * Scans apps/web/src/**\/*.css and rejects, per line:
 *   COLOR — #hex and rgb()/rgba() literals (color-mix whose args are all
 *           tokens carries no literals and is clean)
 *   MOTION — ms/s durations and literal cubic-bezier() (must be
 *           var(--motion-duration-*) / var(--motion-easing-*))
 *   PX — px literals, except the allowlist below
 *   REM — rem literals (the spacing scale's unit; duplicates a token)
 *   Z — bare z-index numbers (must be a --z-* tier token)
 *
 * Allowlist (exhaustive — a deviation not on this list fails):
 *   - 0px and 1px (hairlines)
 *   - 48px inside a min-width/min-height/min-block-size/min-inline-size
 *     declaration (the 48px touch-floor ruling; declaration-scoped, not
 *     line-scoped)
 *   - px inside an @media / @supports / @container condition (custom
 *     properties are not allowed there by CSS; conditions may span lines)
 *   - a line carrying /* token-gate: constant <reason> *\/ — reserved for
 *     JS-contract dimensions; the reason is mandatory (enforced)
 *
 * The token definition file (ui/variables.css) is never scanned.
 * Exit 0 = clean, exit 1 = drift (file:line report + summary).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPT_OUT_RE = /\/\*\s*token-gate:\s*constant\s+\w+/;
// Condition rules that cannot take var() — their condition text is blanked
// (px allowed there), their bodies stay scannable. The `s` flag lets a
// condition span lines without its px leaking into the scan.
const CONDITION_RE = /@(?:media|supports|container)[^{]*\{/gs;
const TOKEN_SOURCE = join('apps', 'web', 'src', 'ui', 'variables.css');
const MIN_PROPS = ['min-width', 'min-height', 'min-block-size', 'min-inline-size'];

// Blank each comment with spaces but PRESERVE newlines, so line numbers
// after a multi-line comment stay correct and opt-out lines still align.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// Declaration context of a match: the text from the nearest '{', ';', or '}'
// boundary up to idx; the declaration's property name opens it, if present.
const declPropAt = (line, idx) => {
  const before = line.slice(0, idx);
  const boundary = Math.max(before.lastIndexOf('{'), before.lastIndexOf(';'), before.lastIndexOf('}'));
  const prop = line.slice(boundary + 1, idx).match(/^\s*([a-z-]+)\s*:/i);
  return prop ? prop[1].toLowerCase() : null;
};
const minDeclAt = (line, idx) => MIN_PROPS.includes(declPropAt(line, idx));

export function scanCss(rawContent) {
  const rawLines = rawContent.split('\n');
  const optOut = new Set(rawLines.map((l, i) => (OPT_OUT_RE.test(l) ? i + 1 : 0)).filter(Boolean));
  // Blank condition rules (media/supports/container conditions cannot take
  // var(); keep their bodies scannable). Newlines inside a multiline
  // condition are preserved so line numbers after it stay correct.
  let content = stripComments(rawContent);
  content = content.replace(CONDITION_RE, (m) => m.slice(0, -1).replace(/[^\n]/g, ' ') + '{');
  const lines = content.split('\n');
  const violations = [];

  // Declaration context is tracked ACROSS lines: a declaration opened by a
  // ':' inside a block and not yet closed by ';' or '}' continues on the
  // following lines, so a #hex on a continuation line is a color VALUE and
  // must flag (the old line-scoped "no ':' before it" suppression let
  // `color:\n  #a1b2c3;` sail through). Brace depth locates the ':' inside a
  // block, so a selector pseudo-class (`.x:hover {`) does not open one.
  let depth = 0;
  let declContinuation = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();
    const skipped = optOut.has(lineNo) || trimmed === '' || trimmed.startsWith('@');

    if (!skipped) {
      // COLOR — a #hex literal flags unless it is unambiguously NOT a color
      // value:
      //   (a) inside url(...) — an SVG fragment reference, never a color;
      //   (b) in selector position — preceded (ignoring whitespace) by
      //       nothing/start or one of '{', '/', ',', '(' — an id selector
      //       like `#abc {`, `.x #abc {`, `, #abc`, `:not(#abc)`;
      //   (c) on a line with no ':' before it and not in declaration
      //       continuation — a selector fragment (`#abc {`, `.x #abc`).
      // Anything else — a ':' before it on the line, or a declaration open
      // from a previous line — is a color value and flags.
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/gi)) {
        const before = line.slice(0, m.index);
        if (/\burl\s*\([^)]*$/.test(before)) continue;                       // (a)
        if (!declContinuation) {
          const tail = before.replace(/\s+$/, '');
          if (tail === '' || /[{/,/(]$/.test(tail)) continue;                // (b)
          if (!before.includes(':')) continue;                               // (c)
        }
        violations.push({ line: lineNo, kind: 'COLOR', match: m[0] });
      }
      for (const m of line.matchAll(/\brgba?\([^)]*\)/gi)) {
        violations.push({ line: lineNo, kind: 'COLOR', match: m[0] });
      }
      // MOTION (units are case-insensitive in CSS — PX/REM/MS flag too)
      for (const m of line.matchAll(/(?<![-\w.])(\d+(?:\.\d+)?)(ms|s)\b/gi)) {
        violations.push({ line: lineNo, kind: 'MOTION', match: m[0] });
      }
      for (const m of line.matchAll(/cubic-bezier\([^)]*\)/g)) {
        violations.push({ line: lineNo, kind: 'MOTION', match: m[0] });
      }
      // PX (allowlist: 0px, 1px, 48px in a min-* declaration, media conditions already blanked)
      for (const m of line.matchAll(/(?<![-\w.])(-?\d+(?:\.\d+)?)px\b/gi)) {
        const px = parseFloat(m[0]);
        if (px === 0 || px === 1) continue;
        // The 48px exemption is declaration-scoped: the match is exempt only
        // when the declaration it sits in — the text back to the nearest '{',
        // ';', or '}' — opens with a min-* property; a 48px in any other
        // declaration on the same line still flags.
        if (px === 48 && minDeclAt(line, m.index)) continue;
        violations.push({ line: lineNo, kind: 'PX', match: m[0] });
      }
      // REM (all hardcoded rem duplicates a scale step or needs an opt-out;
      // negative rem drifts exactly like negative px)
      for (const m of line.matchAll(/(?<![-\w.])(-?\d+(?:\.\d+)?)rem\b/gi)) {
        violations.push({ line: lineNo, kind: 'REM', match: m[0] });
      }
      // Z (property names are case-insensitive in CSS — Z-INDEX flags too)
      for (const m of line.matchAll(/z-index\s*:\s*(-?\d+)\b/gi)) {
        violations.push({ line: lineNo, kind: 'Z', match: m[0] });
      }
    }

    // Advance the declaration-continuation state from this line's text. An
    // open declaration runs until its ';' or '}' closes it; otherwise a
    // ':' inside a block (brace depth > 0, after the last '{', ';', or
    // '}' boundary — or anywhere on a boundary-less line, which by
    // definition sits inside the block) opens one. A selector pseudo-class
    // (`.x:hover {`) or a media condition never passes the boundary test.
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (declContinuation && (line.includes(';') || line.includes('}'))) {
      declContinuation = false;
    }
    if (!declContinuation) {
      const b = Math.max(line.lastIndexOf('{'), line.lastIndexOf(';'), line.lastIndexOf('}'));
      declContinuation = depth > 0 && line.slice(b + 1).includes(':');
    }
  }
  return violations;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.css')) yield full;
  }
}

export function run(root = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const srcRoot = join(root, 'apps', 'web', 'src');
  const skip = join(root, TOKEN_SOURCE);
  const all = [];
  for (const file of walk(srcRoot)) {
    if (file === skip) continue;
    for (const v of scanCss(readFileSync(file, 'utf8'))) {
      all.push({ file: relative(root, file), ...v });
    }
  }
  for (const v of all) console.log(`${v.file}:${v.line}: ${v.kind} ${v.match}`);
  console.log(`css-token gate: ${all.length === 0 ? 'CLEAN' : `${all.length} violation(s)`}`);
  return all.length;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(run() === 0 ? 0 : 1);
}
