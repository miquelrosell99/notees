# Design: CSS token-drift gate + full magic-number sweep

Date: 2026-11-03 · Branch: `css-token-gate` · Worktree: `.worktrees/css-token-gate/`

## Problem

The web app stylesheets carry hardcoded values the design law owns. The
inciting incident: a collapsed-block badge cancel margin (`-8px`) had to
equal a row flex `gap: 8px` by copy — two restatements of one value, exactly
the drift the token system exists to prevent (found and fixed 2026-11-03,
`adf4c515f` + `13b34f2ed`). Nothing stops the next one: no gate scans app
CSS, and CI has no CSS value check.

Audit of `apps/web/src` (2026-11-03):

| Class | Count | Law owner |
|---|---|---|
| hardcoded `px` | 887 | spacing/size scale, shape scale |
| hex colors | 178 | `--md-sys-color-*` roles |
| raw `rgb()/rgba()` | 44 | `--md-sys-color-*` roles |
| `ms` durations | 15 | `--motion-duration-*` |
| `s` durations | 3 | `--motion-duration-*` |
| hardcoded `cubic-bezier` | 5 | `--motion-easing-*` |
| hardcoded `rem` | 118 | spacing scale (rem = the scale's unit) |
| bare `z-index` numbers (1–80) | ~30 | (no tier tokens yet — added by this slice) |
| `@media` breakpoints | 36 | 480/768/1024, only `--breakpoint-tablet` tokenized |

TSX inline styles: zero px — the sweep is CSS-only. Kit components are
near-clean (41 px in 37 files); the bulk (846 px) is in feature/`ui/`
stylesheets. CSS custom properties cannot be used inside `@media`
conditions, so breakpoints need a distinct treatment (below).

## Goal

1. Convert every law-owned hardcode in `apps/web/src/**/*.css` to a token
   reference (or an enumerated allowlist constant), rendering
   **pixel-identical** before and after.
2. Land a zero-tolerance CI gate so no new hardcode can merge.

Non-goals: no restyling (pixel-identity is the acceptance test); no
adaptive-form adoption (`1lh`/`clamp()` conversions) in this pass — fixed
tokens only, adaptive adoption stays documented follow-up; no GTK/Flutter
lockstep (web CSS only); no TSX inline-style rules (none exist today).

## Component 1 — the gate: `scripts/check-css-tokens.mjs`

A dependency-free node script, runnable from any cwd, mirroring the
`verify-min.mjs` self-locating convention. Exit 0 = pass, exit 1 = drift,
with a `file:line` report. Because the sweep ships in the same slice, there
is **no baseline file** — the gate is pure allowlist from day one.

Scan target: `apps/web/src/**/*.css`.

Checks, each a named section in the script's own header comment:

1. **COLORS** — `#hex` and `rgb()/rgba()` literals are rejected unless they
   appear inside a `color-mix()` whose color arguments are tokens, or inside
   a comment. Everything else references `var(--md-sys-color-*)` (or derived
   functional tokens).
2. **MOTION** — `<n>ms`, `<n>s`, and literal `cubic-bezier(...)` in
   `transition`/`animation`/standalone properties must be
   `var(--motion-duration-*)` / `var(--motion-easing-*)`.
3. **SPACING/SIZING** — `<n>px` is rejected except the enumerated allowlist:
   - `1px` — hairlines (the repo law's named constant);
   - `48px` — tap-target floors (the 48px-touch-floor ruling), allowed only
     in `min-*` size properties;
   - `0px`;
   - any px inside an `@media` condition (breakpoints cannot take var());
   - values on an explicit per-site opt-out comment
     `/* token-gate: constant <reason> */`, reserved for JS-contract
     dimensions (scroll/tether math) — every use names its reason.
4. **REM** — hardcoded `<n>rem` that duplicates a spacing-scale step is
   rejected (map to the token); non-scale rems ride the same opt-out
   comment as px.
5. **Z-INDEX** — bare `z-index: <number>` is rejected; the slice adds
   `--z-*` tier tokens (below).

The script owns its allowlist in its header — a deviation without a
justified entry fails, not debates (the design skill's drift-gate idiom).

**CI wiring** — new job `css-token-drift` in `.github/workflows/ci.yml`,
checkout + setup-node only (no pnpm install — the script is
dependency-free), mirroring the `openapi-coverage` job pattern. Local:
`node scripts/check-css-tokens.mjs`; added to the repo-root gate docs in
`docs/developers/development.md`.

## Component 2 — token additions (`apps/web/src/ui/variables.css`)

App-local additions alongside the existing app tokens (`--spacing-1-5`,
`--shape-sheet` establish the precedent; brand-submodule values are
untouched):

- **Breakpoints**: `--breakpoint-phone: 480px`, `--breakpoint-desktop:
  1024px` (completing the existing `--breakpoint-tablet: 768px` trio). Media
  queries keep their literal px (CSS limitation) — the tokens serve the
  JS reader and document the trio in one place; a header comment keeps the
  sync contract that already exists for the tablet value.
- **Z-index tiers**: a `--z-*` ladder (base/content/sticky/overlay/popup/
  toast/max) consolidating the current raw numbers; each existing raw value
  maps to the tier at or above its current maximum.
- **Semantic widths**: `--width-*` tokens for the recurring panel/sidebar/
  modal sizes (200/220/250/260/280/300/320…) — one token per recurring
  semantic size, named by role (sidebar, panel, popover, modal), not per
  pixel value; one-off sizes take the closest scale step or an opt-out.
- **Odd spacing sizes** with no scale step (22/26/30/44px etc.): mapped to
  existing `--spacing-*`/`--height-*` tokens where one matches; genuinely
  optical one-offs take the per-site opt-out comment with a reason.

Every new token's value equals the value it replaces — pixel-identity.

## Component 3 — the sweep

Order, one commit per area (Conventional Commits, per-file staging):

1. `variables.css` (tokens above) — no behavior change by construction.
2. `components/ui/kit/` (41 px) — the catalog the law cares most about.
3. `apps/web/src/ui/` core stylesheets (BlockRow, app shell, PageView,
   NodeView, …).
4. `apps/web/src/features/**` alphabetical.

Conversion rules:

- px/rem → `var(--spacing-N)` / semantic token of equal computed value.
- hex/rgb → the color role already in use at that site (the site's existing
  token vocabulary decides; no palette changes).
- durations/easings → the matching `--motion-*` token; where no token
  matches an existing value, the value is added as a motion token.
- z-index → the consolidated tier tokens.
- breakpoints → literals stay in `@media`; the trio is tokenized in
  `variables.css` and the sync comment extended.

## Verification

- The gate passes after every area commit (it is the per-area acceptance
  test alongside pixel-identity).
- Pixel probes against a **vite dev server running from the worktree**
  (live API at `:8377`, test workspace only, probe data deleted after),
  reusing the existing `scripts/screenshots/*-probe.mjs` idiom; captures at
  1440/768/390 per the design skill's visual-QA contract for the changed
  surfaces.
- Full gate: `pnpm install && pnpm typecheck && pnpm test` in the worktree
  (host discipline: one suite at a time, `--maxWorkers=2` under pressure).
- Landing: rebase onto freshest `origin/main`, fast-forward main in the
  main checkout, **deploy from the main checkout only** (rebuild
  `notees-web`, `verify-min.mjs` → VERIFY-PASS).
- Changelog: one entry per landed area, prepended under the date heading.

## Risks

- **Pixel drift from token computed-value mismatch** (e.g. a `rem` token at
  a non-16px root) — mitigated: no root font-size override exists; probes
  assert identity, not approximation.
- **Color-role mis-mapping** (wrong `--md-sys-color-*` at a site) —
  mitigated: each conversion takes the role the site already uses; captures
  catch theme-context mistakes.
- **Sweep size** (~1,240 edits across ~180 files) — mitigated: per-area
  commits keep each diff reviewable; the gate makes partial landings safe.
