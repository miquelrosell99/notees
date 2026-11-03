# CSS Token-Drift Gate + Magic-Number Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every law-owned hardcoded value in `apps/web/src/**/*.css` to token references (pixel-identical), and land a zero-tolerance CI gate that fails on any new one.

**Architecture:** A dependency-free scanner (`scripts/check-css-tokens.mjs`) with an enumerated allowlist is the objective checker, wired into CI as its own job. The sweep converts per a fixed mapping table in dependency order: tokens first, then kit → ui → features, one commit per area, with the gate and pixel captures as each area's acceptance test. Because the sweep ships in the same slice, the gate has no baseline file — it goes green exactly when the sweep completes.

**Tech Stack:** Node 22 built-ins only (`node:test`, `node:fs`) for the gate; the repo's existing vite dev server + Playwright probe idiom for visual verification.

**Spec:** `docs/superpowers/specs/2026-11-03-css-token-drift-gate-design.md` (worktree: `.worktrees/css-token-gate/` — all paths below are worktree-relative)

## Global Constraints

- **Worktree:** all work happens in `.worktrees/css-token-gate/` on branch `css-token-gate`. NEVER build or deploy from the worktree; deployment happens from the main checkout after landing (Task 12).
- **Pixel-identity:** every conversion must render identically. New token values MUST equal the literal they replace (root font-size is 16px, no override exists — verified 2026-11-03). The acceptance test is "same pixels", not "nicer value".
- **No restyling:** no adaptive-form conversions (`1lh`/`clamp()`) in this pass; fixed tokens only. No palette changes: a color conversion takes the role token that computes to the same value in the SAME theme context (check both the light and dark blocks of `variables.css`).
- **The gate never scans the token source:** `apps/web/src/ui/variables.css` is excluded — it defines the law, it doesn't obey it.
- **Gate allowlist (exhaustive):** `0px`; `1px` (hairlines); `48px` ONLY in `min-width`/`min-height`/`min-block-size`/`min-inline-size` (tap-floor ruling); any px inside an `@media` condition (CSS cannot take var() there); a line carrying the comment `/* token-gate: constant <reason> */`. Anything else fails.
- **Commit discipline:** per-file staging only, Conventional Commits, one commit per area task. CHANGELOG entries prepend under the current date heading.
- **Host memory discipline:** one test suite at a time in this worktree; never run a full gate while another suite runs.

## Value Mapping Table (the sweep's single source)

Spacing px → token (computed values at 16px root):

| px | token | | px | token |
|---|---|---|---|---|
| 2 | `--spacing-micro` | | 18 | `--spacing-4-5` |
| 3 | `--spacing-tiny` | | 20 | `--spacing-5` |
| 4 | `--spacing-1` | | 22 | `--spacing-5-5` (Task 3 adds) |
| 5 | `--spacing-xxs` | | 24 | `--spacing-6` |
| 6 | `--spacing-1-5` | | 28 | `--spacing-7` |
| 8 | `--spacing-2` | | 30 | `--spacing-7-5` |
| 10 | `--spacing-2-5` | | 32 | `--spacing-8` |
| 12 | `--spacing-3` | | 36 | `--spacing-9` |
| 14 | `--spacing-3-5` (Task 3 adds) | | 40 | `--spacing-10` |
| 16 | `--spacing-4` | | 48 | `--spacing-12` (never tap floors) |

Negative offsets: `calc(-1 * var(--spacing-N))` with the same table.

- Layout sizes ≥56px and one-off sizes with no scale step: a `--width-<role>` token if the size recurs (≥3 sites in the same role — sidebar/panel/popover/modal/avatar/thumb — named by ROLE not pixel value), else the `/* token-gate: constant <reason> */` opt-out on that line.
- `rem` literals: `font-size` rems map to the value-exact `--font-size-*` token (read the type scale section of `variables.css`); spacing rems map to `--spacing-*`; anything else → opt-out with reason.
- Durations (`ms`/`s`) → the value-exact `--motion-duration-*` token (existing: 50/80/100/150/200/250/300/500). A duration with no token gets one added to `variables.css` (`--motion-duration-<name>`), named by its role.
- `cubic-bezier` → the value-exact token: `(0.645, 0.045, 0.355, 1)` → `--motion-easing-standard` (or `-emphasized`, same value); `(0, 0, 0, 1)` → `--motion-easing-decelerate`; `(0.3, 0, 1, 1)` → `--motion-easing-accelerate`; `(0.34, 1.56, 0.64, 1)` → `--motion-easing-tactile`; `(0.4, 0, 0.2, 1)` → `--motion-easing-collapse`. An unmapped curve gets a token added.
- `z-index: N` → the smallest tier ≥ N: `--z-base: 1`, `--z-raised: 10`, `--z-sticky: 30`, `--z-overlay: 50`, `--z-popup: 60`, `--z-toast: 70`, `--z-max: 80` (Task 3 adds all seven). Monotonic mapping preserves every current stacking order.
- Colors (hex/`rgb()`) → the `--md-sys-color-*` role token computing to the same value in the same theme context; when no role matches, add a functional token to `variables.css` (`--color-<role>`), never a literal at the use site.
- `@media` literals: stay literal; the breakpoint trio is tokenized in `variables.css` for the JS reader (Task 3).

## Review Focus

1. **px inside comments or strings must not flag** — a naive line scan false-positives on commented-out CSS; pinned by scanner tests (Task 1).
2. **`variables.css` must never be scanned** — it defines the tokens; scanning it would make the gate self-contradictory; pinned by scanner tests (Task 1).
3. **`@media` condition vs. body** — px is allowed in the condition `(width <= 768px)` but NOT in the media query's rule body; pinned by scanner tests (Task 1).
4. **`48px` only in `min-*` properties** — a content `48px` (e.g. avatar size) must map to `--spacing-12`, only tap floors keep the literal; pinned by scanner tests (Task 1).
5. **Dark-theme color mis-mapping** — a token equal in light but different in dark flips dark-theme surfaces; sweep tasks capture in BOTH themes (Tasks 4–11).
6. **z-index stacking regression** — the monotonic tier rule preserves order; Task 12 captures full-app overlays (popups over toasts over content) to prove it.
7. **The inciting incident** — a gap-cancel margin drifting from its gap; Task 12 re-runs the collapsed-row indent probe on the final build (delta must stay 0.00px).

---

### Task 1: The gate scanner — `scripts/check-css-tokens.mjs`

**Files:**
- Create: `scripts/check-css-tokens.mjs`
- Test: `scripts/check-css-tokens.test.mjs`

**Interfaces:**
- Produces: `export function scanCss(content: string): Array<{line: number, kind: 'COLOR'|'MOTION'|'PX'|'REM'|'Z', match: string}>` — pure, line-numbered violations for ONE file's content (already comment-stripped, media-conditions blanked, opt-outs honoured). `node scripts/check-css-tokens.mjs` walks `apps/web/src/**/*.css`, skips `ui/variables.css`, prints `file:line: KIND match`, prints a summary, exits 1 on any violation. `node --test scripts/check-css-tokens.test.mjs` runs the self-tests. Later tasks consume only the CLI contract.

- [ ] **Step 1: Write the failing self-test**

Create `scripts/check-css-tokens.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/check-css-tokens.test.mjs`
Expected: FAIL — `check-css-tokens.mjs` does not exist (import error).

- [ ] **Step 3: Implement the scanner**

Create `scripts/check-css-tokens.mjs`:

```js
#!/usr/bin/env node
/**
 * check-css-tokens.mjs — the app-level CSS token-drift gate.
 *
 * The law (docs/developers/ui-primitives.md + the RosellRamos design
 * skill): every value in app CSS resolves to a custom property from
 * src/ui/variables.css. Hard-coded values the law owns are drift.
 *
 * Scans apps/web/src/**/*.css and rejects, per line:
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
 *   - 48px in min-width/min-height/min-block-size/min-inline-size
 *     (the 48px touch-floor ruling)
 *   - px inside an @media condition (custom properties are not allowed
 *     there by CSS)
 *   - a line carrying /* token-gate: constant <reason> *\/ — reserved for
 *     JS-contract dimensions; the reason is mandatory
 *
 * The token definition file (ui/variables.css) is never scanned.
 * Exit 0 = clean, exit 1 = drift (file:line report + summary).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPT_OUT_RE = /\/\*\s*token-gate:\s*constant\b/;
const MEDIA_RE = /@media[^{]*\{/g;
const TOKEN_SOURCE = join('apps', 'web', 'src', 'ui', 'variables.css');
const MIN_PROPS = ['min-width', 'min-height', 'min-block-size', 'min-inline-size'];

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

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

    // COLOR
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      violations.push({ line: lineNo, kind: 'COLOR', match: m[0] });
    }
    for (const m of line.matchAll(/\brgba?\([^)]*\)/g)) {
      violations.push({ line: lineNo, kind: 'COLOR', match: m[0] });
    }
    // MOTION
    for (const m of line.matchAll(/(?<![-\w.])(\d+(?:\.\d+)?)(ms|s)\b/g)) {
      violations.push({ line: lineNo, kind: 'MOTION', match: m[0] });
    }
    for (const m of line.matchAll(/cubic-bezier\([^)]*\)/g)) {
      violations.push({ line: lineNo, kind: 'MOTION', match: m[0] });
    }
    // PX (allowlist: 0px, 1px, 48px on a min-* line, media conditions already blanked)
    const inMinProp = MIN_PROPS.some((p) => line.includes(`${p}:`));
    for (const m of line.matchAll(/(?<![-\w.])(\d+(?:\.\d+)?)px\b/g)) {
      const px = parseFloat(m[0]);
      if (px === 0 || px === 1) continue;
      if (px === 48 && inMinProp) continue;
      violations.push({ line: lineNo, kind: 'PX', match: m[0] });
    }
    // REM (all hardcoded rem duplicates a scale step or needs an opt-out)
    for (const m of line.matchAll(/(?<![-\w.])(\d+(?:\.\d+)?)rem\b/g)) {
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
```

- [ ] **Step 4: Run the self-tests to verify they pass**

Run: `node --test scripts/check-css-tokens.test.mjs`
Expected: all tests pass. If a test fails, fix the scanner (not the test) unless the test contradicts the spec's allowlist.

- [ ] **Step 5: Run the gate to capture the drift baseline**

Run: `node scripts/check-css-tokens.mjs | tail -1`
Expected: a large violation count (the audit found ~1,240; the exact number is the sweep's remaining-work meter). Record the number in the Task 3 commit message.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-css-tokens.mjs scripts/check-css-tokens.test.mjs
git commit -m "feat(scripts): CSS token-drift gate — check-css-tokens with enumerated allowlist + self-tests"
```

### Task 2: CI wiring + developer docs

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/developers/development.md` (the command table / gate section)

**Interfaces:**
- Consumes: Task 1's CLI contract (`node scripts/check-css-tokens.mjs`, exit 0/1).
- Produces: the `css-token-drift` CI job; the local command documented.

- [ ] **Step 1: Add the CI job**

In `.github/workflows/ci.yml`, append a job alongside `openapi-coverage` (copy the pinned action SHAs from the existing jobs — do not introduce new action versions):

```yaml
  # CSS token-drift gate: app CSS references tokens, never law-owned literals
  # (colors, motion, spacing, z-index). Dependency-free; no pnpm install.
  css-token-drift:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Gate self-tests
        run: node --test scripts/check-css-tokens.test.mjs
      - name: CSS token drift
        run: node scripts/check-css-tokens.mjs
```

- [ ] **Step 2: Document the local command**

In `docs/developers/development.md`, add one line to the gate/command table (match the existing table format): `node scripts/check-css-tokens.mjs` — the CSS token-drift gate; app CSS must reference `var(--*)` tokens, law-owned literals fail CI.

- [ ] **Step 3: Verify locally**

Run: `node --test scripts/check-css-tokens.test.mjs && node scripts/check-css-tokens.mjs > /tmp/gate.out; echo "exit=$?"` — self-tests pass; gate exits 1 with the expected baseline count (> 0 until the sweep finishes — that is correct at this stage).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml docs/developers/development.md
git commit -m "ci: css-token-drift gate job + local command doc"
```

### Task 3: Token additions — `apps/web/src/ui/variables.css`

**Files:**
- Modify: `apps/web/src/ui/variables.css` (three insertion sites, listed in the steps)

**Interfaces:**
- Produces: `--breakpoint-phone`, `--breakpoint-desktop`, `--spacing-3-5`, `--spacing-5-5`, `--z-base`, `--z-raised`, `--z-sticky`, `--z-overlay`, `--z-popup`, `--z-toast`, `--z-max` — consumed by every sweep task. No computed value changes anywhere (new tokens are additive).

- [ ] **Step 1: Baseline the drift count**

Run: `node scripts/check-css-tokens.mjs | tail -1`
Expected: the count from Task 1 Step 5 (record it — the sweep drives it to 0).

- [ ] **Step 2: Complete the breakpoint trio**

In `variables.css`, in the "Responsive Breakpoints" section (currently lines ~683-690), after `--breakpoint-tablet: 768px;`:

```css
  --breakpoint-phone: 480px;
  --breakpoint-desktop: 1024px;
```

And extend the existing sync comment so it covers all three: "breakpoint values are hardcoded at each @media site (480 / 768 / 1024); these tokens are the single JS-read values and must stay in sync with the media queries."

- [ ] **Step 3: Fill the spacing-scale gaps**

In the Spacing section (after `--spacing-3: 0.75rem;` and `--spacing-5: 1.25rem;` respectively, matching the file's per-token comment style):

```css
  --spacing-3-5: 0.875rem; /* 14px */
  --spacing-5-5: 1.375rem; /* 22px */
```

- [ ] **Step 4: Add the z-index tier ladder**

New section after the Functional tokens header comment:

```css
  /* ==================== Elevation tiers ==================== */

  /* z-index ladder — every stacking site references a tier, never a bare
     number. Values consolidate the pre-token raw numbers (1/2/3/6/10/30/
     50/60/70/80); the sweep maps each site to the smallest tier >= its
     current value, which preserves every existing stacking order. */
  --z-base: 1;
  --z-raised: 10;
  --z-sticky: 30;
  --z-overlay: 50;
  --z-popup: 60;
  --z-toast: 70;
  --z-max: 80;
```

- [ ] **Step 5: Verify**

Run: `node scripts/check-css-tokens.mjs | tail -1`
Expected: same count as Step 1 — this task adds tokens, it removes no violations yet (variables.css is excluded from scanning).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui/variables.css
git commit -m "feat(web): breakpoint trio, spacing 3-5/5-5, z-index tier tokens"
```

### Task 4: Kit sweep — `components/ui/kit/`

**Files:**
- Modify (each carries violations to convert):
  `apps/web/src/components/ui/kit/Button.css`, `Chip.css`, `ColorButton.css`, `ContextMenu.css`, `Dropdown.css`, `FloatingButtonArray.css`, `FloatingToolbar.css`, `HoverRevealButton.css`, `InlineConfirmButton.css`, `ListRow.css`, `LoadingScreen.css`, `Modal.css`, `NotificationToast.css`, `Progress.css`, `SearchField.css`, `SelectionButton.css`, `SortMenuButton.css`, `SurfaceTopBar.css`, `Tabs.css`

**Interfaces:**
- Consumes: Tasks 1-3 (gate + tokens + mapping table in this plan's Global Constraints).
- Produces: a zero-violation kit; the visual-capture idiom later sweep tasks reuse.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep 'components/ui/kit' | wc -l`
Expected: ~41 (record the actual number).

- [ ] **Step 2: Convert every violation in the scope**

For each file, work through the gate's `file:line: KIND match` output and convert per the mapping table. Rules beyond the table:
- A `48px` on a button/control `min-height`/`height` tap target stays literal ONLY if it is a `min-*` property; a fixed `height: 48px` becomes `min-block-size: 48px` ONLY if the visual result is identical (block-size with border-box sizing on a single-line control is) — otherwise map to `var(--spacing-12)` and keep the property. When in doubt, preserve the property and value exactly via the token.
- Kit components are the catalog: prefer the semantic token that matches the component's existing vocabulary (e.g. `--height-sm`/`--height-lg` for control heights, `--shape-*` for radii) over a raw spacing step when one applies.
- Radii: `border-radius: Npx` maps to `--shape-*` tokens (`--shape-small` 4px, `--shape-medium`? — read the shape section of variables.css and use the value-exact token; add nothing, use the spacing table for non-shape sizes).
- Add `/* token-gate: constant <reason> */` only for true JS-contract/one-off optical values, with the reason naming the contract.

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep 'components/ui/kit' || echo "KIT CLEAN"`
Expected: `KIT CLEAN`.

- [ ] **Step 4: Visual verification (both themes, three viewports)**

Start the worktree dev server: `cd apps/web && pnpm dev --port 5199 --strictPort` (background; the server reads the API at its configured origin — set `VITE_`/config env if the repo's dev script needs the API origin; check `apps/web/vite.config.ts` first). Log in via the test workspace seed (fixed seed uuid `c491595f-9f94-5ade-a620-e30ed063d8d2`, same idiom as `scripts/screenshots/collapsed-count-measure.mjs` — seed localStorage before goto). Capture the kit-bearing surfaces — buttons/chips/menus/modals/toasts/tabs — at 1440/768/390 in light AND dark (`data-theme="dark"` via the app's theme switch), one screenshot set BEFORE the sweep edits (take it in Step 1) and one AFTER; the pairs must be pixel-identical. Attach nothing to the repo; keep captures under `scripts/screenshots/` (gitignored probe output convention) and eyeball-compare.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/kit/
git commit -m "refactor(web): kit stylesheets reference design tokens — zero law-owned literals"
```

### Task 5: ui core sweep — `apps/web/src/ui/*.css` + `ui/editor-popups/`

**Files:**
- Modify: `ui/app.css`, `ui/BlockMedia.css`, `ui/BlockRow.css`, `ui/BlockRowDnD.css`, `ui/BlockTable.css`, `ui/EmbedView.css`, `ui/GhostRow.css`, `ui/InlineTokens.css`, `ui/MainContentFrame.css`, `ui/NodeLinks.css`, `ui/PageChrome.css`, `ui/PageHeaderSection.css`, `ui/PageSections.css`, `ui/PageView.css`, `ui/QueryNodeSection.css`, `ui/QueryResults.css`, `ui/SearchPage.css`, `ui/SearchSurface.css`, `ui/WhiteboardCanvas.css`, `ui/editor-popups/TriggerPopup.css`
- NOT: `ui/variables.css` (excluded), `ui/app/` (Task 6), `ui/templates/` (Task 6)

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: zero-violation ui core; BlockRow keeps its collapsed-row alignment (regression-probed in Task 12).

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep -E '^apps/web/src/ui/(app\.css|Block|Embed|Ghost|Inline|Main|Node|Page|Query|Search|White|editor-popups)' | wc -l` — matches `ui/app.css` plus the other core files and `ui/editor-popups/`, excludes `ui/app/` (Task 6) and `ui/templates/` (Task 6) — record the number.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. Scope-specific notes:
- `BlockRow.css` — the file with the inciting incident: `--nt-row-gap: var(--spacing-2)` and its `calc(-1 * var(--nt-row-gap))` cancel must stay derived from ONE source; convert the remaining literals the same way (component-local custom properties are fine when their value is a `var()` reference; a px literal in a component custom property is still a violation).
- `WhiteboardCanvas.css` — canvas geometry may carry JS-contract constants (the canvas and its hit-testing math must agree); those take the opt-out comment naming the canvas contract.
- Layout constants in `PageChrome.css`/`MainContentFrame.css` (heights/widths of chrome) get semantic `--width-*/--height-*` tokens if they recur, else opt-out.

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep -E '^apps/web/src/ui/(app\.css|Block|Embed|Ghost|Inline|Main|Node|Page|Query|Search|White|editor-popups)' || echo "UI CORE CLEAN"`
Expected: `UI CORE CLEAN`.

- [ ] **Step 4: Visual verification**

Same dev-server idiom as Task 4 Step 4. Surfaces: a page with nested blocks (outline chrome, bullets, collapse), page header, search page, whiteboard if reachable. 1440/768/390, light + dark, before/after pixel-compare.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/app.css apps/web/src/ui/Block*.css apps/web/src/ui/EmbedView.css apps/web/src/ui/GhostRow.css apps/web/src/ui/InlineTokens.css apps/web/src/ui/MainContentFrame.css apps/web/src/ui/NodeLinks.css apps/web/src/ui/Page*.css apps/web/src/ui/Query*.css apps/web/src/ui/Search*.css apps/web/src/ui/WhiteboardCanvas.css apps/web/src/ui/editor-popups/
git commit -m "refactor(web): ui core stylesheets reference design tokens"
```

### Task 6: ui app + templates sweep — `ui/app/`, `ui/templates/`

**Files:**
- Modify: `ui/app/AppShell.css`, `ui/app/HubSurfaces.css`, `ui/app/PanelLayout.css`, `ui/app/ResponsivePass.css`, `ui/app/Sidebar.css`, `ui/app/TopBar.css`, `ui/templates/TemplateGalleryModal.css`, `ui/templates/TemplateListPopup.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation app chrome.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep -E '^apps/web/src/ui/(app|templates)/' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. Scope-specific notes:
- `ResponsivePass.css` — media-query bodies inside `@media (width <= 768px)` etc. still must be tokenized; only the condition literals stay. `ResponsivePass` is the one file most likely to hold breakpoint-adjacent layout px — sidebar widths, rail widths: these get `--width-*` semantic tokens (sidebar, rail, hub-panel) since they recur across the app shell.
- Chrome heights (top bar 64px ruling): the top-bar height is a ruling constant — if a literal 64 appears it maps to the existing `--height-*`/top-bar token vocabulary (check TopBar.css and variables.css for an existing token first; add `--height-top-bar` only if none exists).

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep -E '^apps/web/src/ui/(app|templates)/' || echo "APP CHROME CLEAN"`
Expected: `APP CHROME CLEAN`.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: the full app shell (sidebar, top bar, hub surfaces, panel layout), template gallery. 1440/768/390 — the 390 capture matters most here (responsive pass breakpoints). Light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/app/ apps/web/src/ui/templates/
git commit -m "refactor(web): app shell + template stylesheets reference design tokens"
```

### Task 7: collection sweep — `features/collection/**`

**Files:**
- Modify: `features/collection/CalendarView.css` (under `collection/calendar/`), `CardsView.css`, `CollectionHub.css`, `FilterBlockBuilder.css`, `features/collection/gantt/GanttView.css`, `features/collection/graph/GraphView.css`, `LocalGraphCard.css`, `NodeCard.css`, `OutlineView.css`, `features/collection/pivot/PivotGrid.css`, `ProseView.css`, `TableView.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation collection views.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep 'features/collection' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. Scope-specific notes:
- `GraphView.css` / `GanttView.css` — canvas/svg geometry shared with JS layout math is JS-contract: opt-out comment naming the layout engine. Pure chrome (panels, legends) converts normally.
- Density values in table/pivot/grid CSS (row heights, column mins) recur → semantic tokens (`--width-col-min`, `--height-row-dense` etc.); name by role.

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep 'features/collection' || echo "COLLECTION CLEAN"`
Expected: `COLLECTION CLEAN`.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: outline/table/cards/board views of a seeded collection, the graph card, prose view. 1440/768/390, light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/collection/
git commit -m "refactor(web): collection view stylesheets reference design tokens"
```

### Task 8: calendar sweep — `features/calendar/**`

**Files:**
- Modify: `features/calendar/AgendaView.css`, `calendar-grid.css`, `CalendarGrid.css`, `DatePickerZoom.css`, `JournalsView.css`, `MonthCalendar.css`, `TimeGrid.css`, `TopBarCalendarPopup.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation calendar surfaces.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep 'features/calendar' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. Scope-specific notes:
- Time-grid geometry (hour rows, now-line offsets) is JS-contract with the time-grid layout math — opt-out naming the contract; pure chrome converts.
- `calendar-grid.css` vs `CalendarGrid.css` both exist — check which is imported (grep the TSX imports) before converting both blindly; convert whichever is live (convert both if both are imported).

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep 'features/calendar' || echo "CALENDAR CLEAN"`
Expected: `CALENDAR CLEAN`.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: month calendar, journals view, agenda, the top-bar calendar popup. 1440/768/390, light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/calendar/
git commit -m "refactor(web): calendar stylesheets reference design tokens"
```

### Task 9: page-sections sweep — `features/page-sections/**`

**Files:**
- Modify: `features/page-sections/ActivityLogSection.css`, `CommentsSection.css`, `HistoryMenuPopup.css`, `PageBanner.css`, `PageCard.css`, `SystemSections.css`, `VersionHistorySection.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation page sections.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep 'features/page-sections' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. `PageBanner.css` media-query conditionals stay literal in the condition only.

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep 'features/page-sections' || echo "PAGE-SECTIONS CLEAN"`
Expected: `PAGE-SECTIONS CLEAN`.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: a page with banner, comments, activity log, version history. 1440/768/390, light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/page-sections/
git commit -m "refactor(web): page-section stylesheets reference design tokens"
```

### Task 10: metadata + classview + node-menu sweep

**Files:**
- Modify: `features/metadata/MetadataSection.css`, `NodePill.css`, `NodePills.css`, `PropertyCreateModal.css`, `PropertyIconButton.css`, `features/classview/CardBuckets.css`, `emplatesSection.css`, `PropertyDefinitionsSection.css`, `TaskBuckets.css`, `features/node-menu/Breadcrumbs.css`, `CondensedLinksPopup.css`, `NodeHoverPreview.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation metadata/class/node-menu surfaces.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep -E 'features/(metadata|classview|node-menu)' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. Pill/chip sizing in metadata is chrome — converts to spacing/shape tokens.

- [ ] **Step 3: Gate the scope to zero**

Run: `node scripts/check-css-tokens.mjs | grep -E 'features/(metadata|classview|node-menu)' || echo "META/CLASS/MENU CLEAN"`
Expected: `META/CLASS/MENU CLEAN`.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: a classed node with properties (pinned + unpinned pills), class view buckets, breadcrumbs with hover preview. 1440/768/390, light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/metadata/ apps/web/src/features/classview/ apps/web/src/features/node-menu/
git commit -m "refactor(web): metadata/classview/node-menu stylesheets reference design tokens"
```

### Task 11: remaining features sweep

**Files:**
- Modify: `features/archived/ArchivedHub.css`, `features/block-editor/FloatingEditor.css`, `features/command-palette/CommandPalette.css`, `features/command-palette/Modal.css`, `features/date-pickers/CalendarPopup.css`, `features/date-pickers/RepeatPicker.css`, `features/icon-picker/IconPickerPopup.css`, `features/import/ImportOptionsModal.css`, `features/pickers/NodeResultItem.css`, `features/pickers/NodeSelector.css`, `features/settings/settingsModal.css`, `features/settings/SettingsPage.css`, `features/sharing/SharePageModal.css`, `features/sharing/SharesHub.css`, `features/sources/SourcesFacets.css`, `features/sources/SourcesMatrix.css`, `features/trash/TrashHub.css`, `features/workspaces/WorkspacesView.css`, `features/workspaces/WorkspaceSwitcher.css`

**Interfaces:**
- Consumes: Tasks 1-4. Produces: zero-violation remaining features; after this task the whole tree is clean.

- [ ] **Step 1: Baseline the scope**

Run: `node scripts/check-css-tokens.mjs | grep -E 'features/(archived|block-editor|command-palette|date-pickers|icon-picker|import|pickers|settings|sharing|sources|trash|workspaces)' | wc -l` — record it.

- [ ] **Step 2: Convert every violation in the scope**

Per the mapping table. The command palette is overlay chrome — check its z-index sites land on sensible tiers (`--z-popup`/`--z-overlay`) preserving current stacking.

- [ ] **Step 3: Gate the WHOLE tree to zero**

Run: `node scripts/check-css-tokens.mjs`
Expected: final line `css-token gate: CLEAN`, exit 0.

- [ ] **Step 4: Visual verification**

Same idiom. Surfaces: command palette, settings modal + page, date pickers, import modal, sources matrix, workspace switcher. 1440/768/390, light + dark, before/after.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/archived/ apps/web/src/features/block-editor/ apps/web/src/features/command-palette/ apps/web/src/features/date-pickers/ apps/web/src/features/icon-picker/ apps/web/src/features/import/ apps/web/src/features/pickers/ apps/web/src/features/settings/ apps/web/src/features/sharing/ apps/web/src/features/sources/ apps/web/src/features/trash/ apps/web/src/features/workspaces/
git commit -m "refactor(web): remaining feature stylesheets reference design tokens"
```

### Task 12: Full gate, changelog, landing, deploy, verify

**Files:**
- Modify: `CHANGELOG.md`
- Modify: the main checkout (landing) — never deploy from this worktree.

**Interfaces:**
- Consumes: every prior task.

- [ ] **Step 1: Full gate in the worktree**

Run: `pnpm install && pnpm typecheck && pnpm test` (one suite at a time — host discipline). Plus `node --test scripts/check-css-tokens.test.mjs` and `node scripts/check-css-tokens.mjs` (CLEAN).
Expected: all green.

- [ ] **Step 2: Changelog entry**

Prepend under `## 2026-11-03` in `CHANGELOG.md`: one entry covering the slice — the drift gate (`scripts/check-css-tokens.mjs`, CI `css-token-drift` job, enumerated allowlist: hairlines/tap floors/media conditions/named opt-outs), the token additions (breakpoint trio, `--spacing-3-5`/`--spacing-5-5`, z-index tiers), and the sweep (every law-owned literal in app CSS converted to token references, ~1,240 conversions across ~105 stylesheets, pixel-identical acceptance, captures at 1440/768/390 in both themes). Follow the file's entry style.

- [ ] **Step 3: Land the branch**

In the worktree: `git fetch origin main && git rebase origin/main` (resolve conflicts by keeping both blocks in CHANGELOG). Then in the MAIN CHECKOUT (`/root/projects/notees`): ensure a clean tree (`git status --porcelain`), `git pull --ff-only`, then fast-forward main to the rebased branch tip (merge `--ff-only css-token-gate`). Verify the main checkout sits at `origin/main` afterwards (`git log --oneline -1` matches the pushed tip).

- [ ] **Step 4: Push**

`git push` from the main checkout. Per-file staging rules were satisfied per task; pushing is standing authorization.

- [ ] **Step 5: Deploy from the main checkout**

Invoke the `notees-operations` skill first. Then: `docker compose build notees-web && docker compose up -d notees-web` from `/root/projects/notees` (the live stack folder — this host's compose project builds from the checkout). Then `node scripts/screenshots/verify-min.mjs` → expect `VERIFY-PASS`.

- [ ] **Step 6: Inciting-incident regression probe**

Run `node scripts/screenshots/collapsed-indent-measure.mjs` from the main checkout against the rebuilt stack: collapsed vs. normal content-left delta must remain `0.00px`.

- [ ] **Step 7: Cleanup**

`git worktree remove .worktrees/css-token-gate` and `git branch -d css-token-gate` only after the main checkout is verified at `origin/main` and the deploy smoke passed.
