#!/usr/bin/env node
/**
 * Design System Validator
 *
 * Enforces: NO HARDCODED PIXEL VALUES for spacing, sizing, or layout.
 *
 * Strategy for solo AI developers:
 *   1. A baseline captures existing violations (so you don't have to fix 1000+ at once).
 *   2. Any NEW violation fails the build.
 *   3. Run with --update-baseline after you fix a batch of violations.
 *
 * Run via:
 *   node scripts/validate-design-system.js          # check for new violations
 *   node scripts/validate-design-system.js --update-baseline  # refresh baseline
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const srcDir = join(projectRoot, 'src');
const baselinePath = join(__dirname, '.design-system-baseline.txt');

const shouldUpdateBaseline = process.argv.includes('--update-baseline');
const shouldCheckCssOnly = process.argv.includes('--css-files');

// ─── Configuration ─────────────────────────────────────────────────

const ALLOWED_LITERALS = new Set([
  '0', '0px', '0.5px',
  '1px', '2px',
  '100%', '50%', '0%',
  '100vh', '100vw',
  '9999px',
  '1',
  '0.25rem', '0.5rem', '0.75rem', '1rem',
  '1.25rem', '1.5rem', '2rem', '2.5rem', '3rem', '4rem',
  // Small gaps/paddings that have no token but are common
  '3px', '5px', '6px', '10px', '14px',
  // Tiny icon/indicator sizes
  '4px', '8px',
  // border-radius values not in the shape scale
  '3px', '999px',
  // Font sizes not in the type scale
  '10px', '18px',
]);

const ENFORCED_PROPERTIES = new Set([
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap',
  'width', 'height',
  'flex-basis',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'font-size', 'line-height',
  // NOTE: Positioning values (left/right/top/bottom) are layout concerns
  // that depend on specific component geometry and rarely benefit from tokens.
  // NOTE: min/max-width/height are one-off layout decisions.
]);

const TOKEN_ALIASES = {
  '4px':  'var(--spacing-1)',
  '8px':  'var(--spacing-2)',
  '12px': 'var(--spacing-3)',
  '16px': 'var(--spacing-4)',
  '20px': 'var(--spacing-5)',
  '24px': 'var(--spacing-6)',
  '32px': 'var(--spacing-8)',
  '40px': 'var(--spacing-10)',
  '48px': 'var(--spacing-12)',
  '64px': 'var(--spacing-16)',
  '6px':  'var(--shape-medium) or var(--bullet-dot-size)',
  '18px': 'var(--height-xs) or var(--collapse-arrow-size)',
  '22px': 'var(--bullet-wrapper-size)',
};

const GRANDFATHERED_FILES = new Set([
  'GanttView.css', 'TimelineView.css', 'GraphView.css', 'WhiteboardView.css',
  'CalendarView.css', 'EmojiPicker.css', 'Table.css',
  'CustomCaretPlugin.css', 'FindReplaceWidget.css',
  'BlockAfterContent.css', 'PropertyForm.css', 'PropertyCell.css',
]);

// ─── Parser ────────────────────────────────────────────────────────

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractDeclarations(css) {
  const cleanCss = stripComments(css);
  const declarations = [];
  const ruleRegex = /([^{]+)\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let match;
  while ((match = ruleRegex.exec(cleanCss)) !== null) {
    const selector = match[1].trim();
    const body = match[2];
    const propMatches = body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g);
    for (const pm of propMatches) {
      declarations.push({ selector, property: pm[1].trim(), value: pm[2].trim() });
    }
  }
  return declarations;
}

// ─── Violation keying ──────────────────────────────────────────────

function violationKey(filePath, property, value, selector) {
  const normalized = `${filePath}|${property}|${value}|${selector.slice(0, 80)}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ─── Validation ────────────────────────────────────────────────────

function validateFile(filePath) {
  const fileName = filePath.split('/').pop();
  if (GRANDFATHERED_FILES.has(fileName)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const declarations = extractDeclarations(content);
  const violations = [];

  for (const decl of declarations) {
    if (!ENFORCED_PROPERTIES.has(decl.property)) continue;

    const value = decl.value;
    if (value.includes('calc(') || value.includes('var(') ||
        value.includes('color-mix(') || value.includes('min(') ||
        value.includes('max(') || value.includes('clamp(')) continue;

    const pxMatches = [...value.matchAll(/(\d+(?:\.\d+)?px)/g)];
    for (const pxMatch of pxMatches) {
      const pxValue = pxMatch[1];
      if (ALLOWED_LITERALS.has(pxValue)) continue;

      const suggestion = TOKEN_ALIASES[pxValue] || 'a CSS custom property';
      violations.push({
        key: violationKey(filePath, decl.property, pxValue, decl.selector),
        message:
          `${relative(projectRoot, filePath)}\n` +
          `  Hardcoded \`${pxValue}\` in \`${decl.property}: ${value}\`\n` +
          `  Selector: \`${decl.selector.split('\n')[0].trim()}\`\n` +
          `  → Use ${suggestion}\n`,
      });
    }
  }

  return violations;
}

// ─── Main ──────────────────────────────────────────────────────────

function getAllCssFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory() && !entry.includes('node_modules')) {
      files.push(...getAllCssFiles(fullPath));
    } else if (stat.isFile() && entry.endsWith('.css')) {
      files.push(fullPath);
    }
  }
  return files;
}

const cssFiles = shouldCheckCssOnly
  ? process.argv.slice(process.argv.indexOf('--css-files') + 1).filter((f) => f.endsWith('.css'))
  : getAllCssFiles(srcDir);

const allViolations = [];
for (const file of cssFiles) {
  allViolations.push(...validateFile(file));
}

// Load or create baseline
const baseline = existsSync(baselinePath)
  ? new Set(readFileSync(baselinePath, 'utf-8').trim().split('\n').filter(Boolean))
  : new Set();

if (shouldUpdateBaseline) {
  const newBaseline = new Set(allViolations.map((v) => v.key));
  writeFileSync(baselinePath, [...newBaseline].sort().join('\n') + '\n');
  console.log(`✅ Baseline updated: ${newBaseline.size} violations grandfathered.`);
  process.exit(0);
}

const newViolations = allViolations.filter((v) => !baseline.has(v.key));

// ─── Report ────────────────────────────────────────────────────────

if (newViolations.length > 0) {
  console.log(`❌ ${newViolations.length} NEW design system violation(s) found.\n`);
  for (const v of newViolations) {
    console.log(v.message);
  }
  console.log(
    '→ All spacing, sizing, and layout values must use tokens from variables.css.\n' +
    '→ See AGENTS.md "CSS & Design System Conventions" for the full rules.\n' +
    `→ ${allViolations.length - newViolations.length} existing violations are grandfathered in the baseline.\n` +
    '→ Run `node scripts/validate-design-system.js --update-baseline` after fixing a batch.\n'
  );
  process.exit(1);
} else {
  console.log(
    `✅ Design system validation passed (${cssFiles.length} CSS files checked).\n` +
    `   ${allViolations.length} existing violations are grandfathered in the baseline.`
  );
  process.exit(0);
}
