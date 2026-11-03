// Self-tests for the CSS token-drift gate. Run: node --test scripts/check-css-tokens.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCss } from './check-css-tokens.mjs';

const kinds = (v) => v.map((x) => x.kind).sort();
const has = (v, kind, line) => v.some((x) => x.kind === kind && x.line === line);

test('clean token-only file passes', () => {
  const css = `.a { color: var(--md-sys-color-primary); gap: var(--spacing-2); transition: opacity var(--motion-duration-short) var(--motion-easing-standard); z-index: var(--z-overlay); }`;
  assert.deepEqual(scanCss(css), []);
});

test('every violation class is flagged with its line', () => {
  const css = [
    '/* a comment mentioning 99px and #ff00ff must NOT flag */',
    '.a { color: #a1b2c3; }',                       // 2 COLOR
    '.b { color: rgb(1, 2, 3); }',                 // 3 COLOR
    '.c { transition: opacity 120ms ease; }',      // 4 MOTION
    '.d { transition: all 0.2s linear; }',         // 5 MOTION
    '.e { transition: all var(--d) cubic-bezier(0.1, 0.2, 0.3, 0.4); }', // 6 MOTION
    '.f { padding: 8px; }',                        // 7 PX
    '.g { transform: translateY(-4px); }',          // 8 PX (negative)
    '.h { margin: 0.5rem; }',                      // 9 REM
    '.i { z-index: 42; }',                         // 10 Z
  ].join('\n');
  const v = scanCss(css);
  assert.ok(has(v, 'COLOR', 2) && has(v, 'COLOR', 3));
  assert.ok(has(v, 'MOTION', 4) && has(v, 'MOTION', 5) && has(v, 'MOTION', 6));
  assert.ok(has(v, 'PX', 7) && has(v, 'PX', 8));
  assert.ok(has(v, 'REM', 9));
  assert.ok(has(v, 'Z', 10));
  assert.equal(v.filter((x) => x.kind === 'COLOR').length, 2);
});

test('allowlist: hairlines, zero, tap floors in min-*, media conditions', () => {
  const css = [
    '.a { border: 1px solid var(--md-sys-color-outline); }',
    '.b { top: 0px; }',
    '.c { min-height: 48px; min-width: 48px; }',
    '@media (width <= 768px) {',
    '  .d { padding: 12px; }',                      // body of the media query — MUST flag
    '}',
  ].join('\n');
  const v = scanCss(css);
  assert.deepEqual(v, [{ line: 5, kind: 'PX', match: '12px' }]);
});

test('48px outside min-* properties is flagged', () => {
  const v = scanCss('.a { width: 48px; }\n.b { min-block-size: 48px; }');
  assert.deepEqual(v, [{ line: 1, kind: 'PX', match: '48px' }]);
});

test('opt-out comment exempts its line', () => {
  const css = '.a { width: 9999px; /* token-gate: constant JS tether contract, changing it breaks the overlay math */ }';
  assert.deepEqual(scanCss(css), []);
});

test('color-mix over tokens is clean; px inside media condition is clean', () => {
  const css = '@media (width <= 480px) { .a { color: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); } }';
  assert.deepEqual(scanCss(css), []);
});

test('units are case-insensitive: uppercase PX/REM/RGBA/MS flag', () => {
  const css = [
    '.a { width: 10PX; }',                    // 1 PX
    '.b { margin: 10REM; }',                  // 2 REM
    '.c { color: RGBA(1, 2, 3, 0.5); }',      // 3 COLOR
    '.d { transition: all 0.2S linear; }',    // 4 MOTION
  ].join('\n');
  const v = scanCss(css);
  assert.ok(has(v, 'PX', 1) && has(v, 'REM', 2) && has(v, 'COLOR', 3) && has(v, 'MOTION', 4));
});

test('48px exemption is declaration-scoped, not line-wide', () => {
  const v = scanCss('.a { min-height: 48px; width: 48px; }');
  assert.deepEqual(v, [{ line: 1, kind: 'PX', match: '48px' }]);
});

test('opt-out without a reason does not exempt', () => {
  const v = scanCss('.a { width: 9999px; /* token-gate: constant */ }');
  assert.deepEqual(v, [{ line: 1, kind: 'PX', match: '9999px' }]);
});

test('#hex as id selector is clean; #hex as a color value flags', () => {
  const css = [
    '#abc { color: red; }',
    '.x #abc { color: red; }',
    '.a { color: #abc; }',                   // 3 COLOR
  ].join('\n');
  const v = scanCss(css);
  assert.deepEqual(v, [{ line: 3, kind: 'COLOR', match: '#abc' }]);
});

test('negative rem is flagged', () => {
  const v = scanCss('.a { margin: -0.5rem; }');
  assert.deepEqual(v, [{ line: 1, kind: 'REM', match: '-0.5rem' }]);
});

test('multi-line comment preserves line numbers and opt-out honoring', () => {
  const css = [
    '/* a multi-line comment',
    '   spanning lines 1-3, mentioning',
    '   99px and #ff00ff */',
    '.a { padding: 8px; }',                                                   // 4 PX
    '.b { width: 9999px; /* token-gate: constant JS tether contract */ }',    // 5 exempt
  ].join('\n');
  const v = scanCss(css);
  assert.deepEqual(v, [{ line: 4, kind: 'PX', match: '8px' }]);
});
