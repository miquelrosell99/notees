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
 *   - px inside an @media condition (custom properties are not allowed
 *     there by CSS)
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
const MEDIA_RE = /@media[^{]*\{/g;
const TOKEN_SOURCE = join('apps', 'web', 'src', 'ui', 'variables.css');
const MIN_PROPS = ['min-width', 'min-height', 'min-block-size', 'min-inline-size'];

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

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
  // Blank media-query CONDITIONS (keep their bodies scannable).
  let content = stripComments(rawContent);
  content = content.replace(MEDIA_RE, (m) => ' '.repeat(m.length - 1) + '{');
  const lines = content.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (optOut.has(lineNo)) continue;
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('@')) continue; // @import/@keyframes names etc.

    // COLOR — a #hex is a color VALUE only in declaration context: a ':'
    // must precede it on the line (id selectors, attribute values, and
    // keyframe names carry no preceding colon and are suppressed).
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/gi)) {
      if (!line.slice(0, m.index).includes(':')) continue;
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
    // Z
    for (const m of line.matchAll(/z-index\s*:\s*(-?\d+)\b/g)) {
      violations.push({ line: lineNo, kind: 'Z', match: m[0] });
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
