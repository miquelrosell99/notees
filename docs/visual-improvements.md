# Notees Visual Improvement Assessment

This document records the visual audit of Notees against `docs/design-language.md` and the `frontend-design` skill, and the implementation that followed.

## Current alignment (what is working well)

- **Warm monochrome base + sage accent** is implemented consistently across light, dark, and OLED modes.
- **OLED mode** uses `#000000` for backgrounds (`variables.css`), satisfying the `frontend-design` requirement.
- **Page header** uses the editorial serif stack, a warm surface background, and a dedicated accent border token.
- **TopBar** is transparent and recedes; buttons have accessible 44×44 touch targets.
- **Focus mode** dims chrome but keeps it locatable with higher opacities and a subtle backdrop blur.
- **Primary buttons** correctly use `--color-accent` / `--color-on-accent`.
- **Global reduced-motion** support is in place (`src/index.css`), and the custom caret plugin explicitly suppresses animations under `prefers-reduced-motion: reduce`.

## Implemented improvements

### 1. Micro-values are now semantic
- `src/components/ui/Card.css`: hover lift uses `calc(var(--spacing-hairline) * -1)`.
- `src/features/content/editor/plugins/CustomCaretPlugin.css`: caret move/resize/breathe durations use `--motion-duration-caret-*` tokens; caret underline thickness/offset use spacing tokens.
- `src/features/content/components/nodes/PageHeader.css`: badge letter-spacing uses `--letter-spacing-badge`; accent border uses `--page-header-accent-border-width`.
- `src/components/ui/LoadingSkeleton.css`: shimmer duration and skeleton heights use tokens.
- `src/variables.css`: added `--letter-spacing-badge`, `--letter-spacing-label`, `--letter-spacing-section`, `--page-header-accent-border-width`, caret motion tokens, and skeleton tokens.

### 2. Focus-mode accessibility
- `src/focus-mode.css`: raised dimmed chrome opacities to accessible levels (`--opacity-10`–`--opacity-15`) and added `backdrop-filter: blur(2px)` with a translucent background tint so chrome remains locatable before hover.

### 3. Grandfathered CSS files brought into the token system
- `src/features/content/components/nodes/views/CalendarView.css`:
  - Fixed the critical bug where color tokens were referenced without the `--color-` prefix (`var(--surface)` → `var(--color-surface)`, etc.).
  - Week row min-height and label letter-spacing are now tokenized.
- `src/features/content/components/nodes/views/GraphView.css`:
  - Dot radius, grid size, spinner duration, sidebar header min-height, and section letter-spacing use component-scoped tokens.
- `src/features/content/components/nodes/views/WhiteboardView.css`:
  - Minimap height, rotation-handle divider, search-bar input width, properties label letter-spacing, and stroke dasharrays use tokens.
- `src/components/ui/EmojiPicker.css`: width, max-height, and section letter-spacing use component tokens.
- `src/features/content/components/blocks/BlockAfterContent.css`: line-heights, letter-spacing, backlink preview duration, table font-size, embed header letter-spacing, and list padding use tokens; redundant fallbacks removed.
- `src/features/content/components/properties/PropertyForm.css`: already fully tokenized; no changes needed.
- `src/features/content/components/nodes/views/GanttView.css`: max-height uses a component token.
- `src/features/content/components/nodes/views/TimelineView.css`: minimap width/height, event-card max-heights, settings label letter-spacing, and mono font use tokens.

### 4. Empty states and onboarding copy
- Rewrote user-facing empty-state copy across 34 TSX files to follow the `frontend-design` writing rules: explain the area, offer a primary action, use sentence case and active voice, and keep vocabulary consistent with the rest of the app.
- Key surfaces updated: Graph, Timeline, Calendar, Gantt, Chart, Whiteboard, Shares inboxes, Query results, Onboarding/Enrollment, and core collection views.

### 5. Custom caret reduced motion
- `src/features/content/editor/plugins/CustomCaretPlugin.css` already had a reduced-motion media query; it now explicitly suppresses animations and transitions on all caret variants.

## Verification

- `npm run lint` ✅
- `npx tsc -b --noEmit` ✅
- `node scripts/validate-design-system.js` ✅ (189 CSS files checked, 0 violations)
- `ruff check app/` ✅
- No undefined CSS variables in use ✅
