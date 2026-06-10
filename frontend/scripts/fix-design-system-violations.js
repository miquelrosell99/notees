#!/usr/bin/env node
/**
 * Automated Design System Violation Fixer
 *
 * Replaces hardcoded pixel values with CSS custom properties.
 * Only performs safe, unambiguous replacements.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const srcDir = join(projectRoot, 'src');

// ─── Replacement Rules ─────────────────────────────────────────────

const REPLACEMENTS = {
  'margin':            { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'margin-top':        { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'margin-right':      { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'margin-bottom':     { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'margin-left':       { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'padding':           { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'padding-top':       { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'padding-right':     { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'padding-bottom':    { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'padding-left':      { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'gap':               { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'row-gap':           { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'column-gap':        { '4px': 'var(--spacing-1)', '8px': 'var(--spacing-2)', '12px': 'var(--spacing-3)', '16px': 'var(--spacing-4)', '20px': 'var(--spacing-5)', '24px': 'var(--spacing-6)', '32px': 'var(--spacing-8)', '40px': 'var(--spacing-10)', '48px': 'var(--spacing-12)', '64px': 'var(--spacing-16)' },
  'border-radius':            { '2px': 'var(--shape-extra-small)', '4px': 'var(--shape-small)', '6px': 'var(--shape-medium)', '8px': 'var(--shape-large)', '12px': 'var(--shape-extra-large)', '20px': 'var(--shape-card)', '16px': 'var(--shape-button-large)', '28px': 'var(--shape-sheet)' },
  'border-top-left-radius':   { '2px': 'var(--shape-extra-small)', '4px': 'var(--shape-small)', '6px': 'var(--shape-medium)', '8px': 'var(--shape-large)', '12px': 'var(--shape-extra-large)', '20px': 'var(--shape-card)' },
  'border-top-right-radius':  { '2px': 'var(--shape-extra-small)', '4px': 'var(--shape-small)', '6px': 'var(--shape-medium)', '8px': 'var(--shape-large)', '12px': 'var(--shape-extra-large)', '20px': 'var(--shape-card)' },
  'border-bottom-left-radius': { '2px': 'var(--shape-extra-small)', '4px': 'var(--shape-small)', '6px': 'var(--shape-medium)', '8px': 'var(--shape-large)', '12px': 'var(--shape-extra-large)', '20px': 'var(--shape-card)' },
  'border-bottom-right-radius': { '2px': 'var(--shape-extra-small)', '4px': 'var(--shape-small)', '6px': 'var(--shape-medium)', '8px': 'var(--shape-large)', '12px': 'var(--shape-extra-large)', '20px': 'var(--shape-card)' },
  'font-size':         { '11px': 'var(--font-size-xs)', '12px': 'var(--font-size-sm)', '13px': 'var(--font-size-button)', '14px': 'var(--font-size-base)', '16px': 'var(--font-size-md)', '20px': 'var(--font-size-lg)' },
  'width':             { '14px': 'var(--icon-size-xs)', '16px': 'var(--icon-size-sm)', '18px': 'var(--icon-size-md)', '20px': 'var(--icon-size-md)', '24px': 'var(--icon-size-lg)', '28px': 'var(--icon-size-xl)', '32px': 'var(--icon-size-xl)', '40px': 'var(--icon-size-2xl)' },
  'height':            { '14px': 'var(--icon-size-xs)', '16px': 'var(--icon-size-sm)', '18px': 'var(--icon-size-md)', '20px': 'var(--icon-size-md)', '24px': 'var(--height-xs)', '28px': 'var(--height-sm)', '32px': 'var(--height-md)', '38px': 'var(--height-lg)', '46px': 'var(--height-xl)', '56px': 'var(--height-2xl)' },
  'min-height':        { '24px': 'var(--height-xs)', '28px': 'var(--height-sm)', '32px': 'var(--height-md)', '38px': 'var(--height-lg)', '46px': 'var(--height-xl)', '56px': 'var(--height-2xl)' },
  'max-height':        { '24px': 'var(--height-xs)', '28px': 'var(--height-sm)', '32px': 'var(--height-md)', '38px': 'var(--height-lg)', '46px': 'var(--height-xl)', '56px': 'var(--height-2xl)' },
};

// ─── Parser ────────────────────────────────────────────────────────

function splitByFunctions(value) {
  const funcRegex = /(calc|var|color-mix|min|max|clamp)\([^)]*\)/g;
  const parts = [];
  let lastIndex = 0;
  let funcMatch;
  while ((funcMatch = funcRegex.exec(value)) !== null) {
    parts.push({ text: value.slice(lastIndex, funcMatch.index), isFunc: false });
    parts.push({ text: funcMatch[0], isFunc: true });
    lastIndex = funcMatch.index + funcMatch[0].length;
  }
  parts.push({ text: value.slice(lastIndex), isFunc: false });
  return parts;
}

function replaceValuePart(part, pxVal, token) {
  const escaped = pxVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return part.replace(new RegExp(`(^|[\\s(,])${escaped}([\\s,);]|$)`, 'g'), (m, before, after) => `${before}${token}${after}`);
}

function replaceInDeclarations(css) {
  let changed = false;

  const declRegex = /([a-z-]+)\s*:\s*([^;]+);/g;
  const newCss = css.replace(declRegex, (match, property, value) => {
    const rules = REPLACEMENTS[property.trim()];
    if (!rules) return match;

    let newValue = value;
    let localChanged = false;

    for (const [pxVal, token] of Object.entries(rules)) {
      if (!newValue.includes(pxVal)) continue;

      const parts = splitByFunctions(newValue);
      const replaced = parts.map((part) => {
        if (part.isFunc) return part.text;
        return replaceValuePart(part.text, pxVal, token);
      }).join('');

      if (replaced !== newValue) {
        newValue = replaced;
        localChanged = true;
      }
    }

    if (localChanged) {
      changed = true;
      return `${property.trim()}: ${newValue};`;
    }
    return match;
  });

  return { css: newCss, changed };
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

const cssFiles = getAllCssFiles(srcDir);
let totalFilesChanged = 0;
let totalReplacements = 0;

for (const file of cssFiles) {
  const content = readFileSync(file, 'utf-8');
  const { css: newCss, changed } = replaceInDeclarations(content);

  if (changed) {
    writeFileSync(file, newCss, 'utf-8');
    totalFilesChanged++;
    const beforeTokens = (content.match(/var\(--/g) || []).length;
    const afterTokens = (newCss.match(/var\(--/g) || []).length;
    totalReplacements += Math.max(0, afterTokens - beforeTokens);
  }
}

console.log(`✅ Fixed ${totalReplacements} violations across ${totalFilesChanged} files.`);
console.log('   Run `node scripts/validate-design-system.js --update-baseline` to refresh the baseline.');
