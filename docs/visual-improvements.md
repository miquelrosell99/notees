# Notees Visual Improvement Assessment

This document records the findings from a visual audit of Notees against the project’s own `docs/design-language.md` and the `frontend-design` skill. It covers quick wins already applied and recommended next steps.

## Quick wins applied in this pass

1. **Bullet dot is now perfectly circular** (`frontend/src/features/content/components/blocks/Bullet.css`).
   - The dot previously used `border-radius: calc(var(--shape-small) / 2)`, which produced a rounded rectangle for the 6 px dot. It now uses `border-radius: 50%`, matching the signature “circular bullet” in the design language.

2. **TopBar separator uses the spacing token** (`frontend/src/features/layout/components/TopBar.css`).
   - `width: 1px` → `width: var(--spacing-hairline)`.

3. **BlockRow redundant fallback removed** (`frontend/src/features/content/components/blocks/BlockRow.css`).
   - `border-radius: var(--shape-small, var(--shape-small))` → `border-radius: var(--shape-small)`.

## Current alignment (what is working well)

- **Warm monochrome base + sage accent** is implemented consistently across light, dark, and OLED modes.
- **OLED mode** uses `#000000` for backgrounds (`variables.css`), satisfying the `frontend-design` requirement.
- **Page header** uses the editorial serif stack, a warm surface background, and an accent left border.
- **TopBar** is transparent and recedes; buttons have accessible 44×44 touch targets.
- **Focus mode** dims chrome and leaves only the page/typography visible.
- **Primary buttons** correctly use `--color-accent` / `--color-on-accent`.
- **Global reduced-motion** support is in place (`src/index.css`).

## Remaining visual improvement recommendations

### 1. Tighten the remaining hardcoded micro-values
A few components still encode tiny “magic numbers” that are not yet semantic:

| Location | Current value | Suggested token |
|---|---|---|
| `components/ui/Card.css` `.card--interactive:hover` | `transform: translateY(-1px)` | `calc(var(--spacing-hairline) * -1)` or remove the lift entirely |
| `features/content/editor/plugins/CustomCaretPlugin.css` | hardcoded `0.08s`, `0.12s`, `0.85s`, `1.4s` durations | map to `--motion-duration-*` tokens |
| `features/content/components/nodes/PageHeader.css` badges | `letter-spacing: 0.5px` | add `--letter-spacing-badge: 0.5px` |

### 2. Focus-mode opacity accessibility
`.focus-mode .top-bar-card` is set to `opacity: var(--opacity-7)` (~7%). On some displays this is effectively invisible before hover. Consider raising the dimmed opacity to `var(--opacity-15)`–`var(--opacity-20)` and using a subtle `backdrop-filter` or background tint so users can still locate chrome.

### 3. Audit decorative surfaces in grandfathered CSS files
The design-system validator skips these files, so they still contain hardcoded colors and decorative effects:

- `src/features/content/components/nodes/views/GraphView.css`
- `src/features/content/components/nodes/views/WhiteboardView.css`
- `src/features/content/components/nodes/views/GanttView.css`
- `src/features/content/components/nodes/views/TimelineView.css`
- `src/features/content/components/nodes/views/CalendarView.css`
- `src/components/ui/EmojiPicker.css`
- `src/features/content/components/blocks/BlockAfterContent.css`
- `src/features/content/components/properties/PropertyForm.css`

Recommendation: bring the most user-visible ones (GraphView, WhiteboardView, CalendarView) into the token system so they respond correctly to dark/OLED mode and custom accent colors.

### 4. Empty states and onboarding copy
Several empty-state screens still use generic placeholder text. Apply the `frontend-design` writing guidance:
- Explain what the area is for.
- Offer a single primary action.
- Use sentence case, active voice, and the same vocabulary as the surrounding UI.

### 5. Custom caret respects reduced motion
Although `index.css` sets global reduced-motion rules, verify that the caret’s breathing animation (`notees-line-breathe`, `notees-block-breathe`, `notees-pill-breathe`) is fully suppressed. The current `@media (prefers-reduced-motion: reduce)` block should handle it, but testing with the OS reduced-motion flag is recommended.

### 6. Signature element: page header accent border
The accent left border currently uses `--border-width-thick` (2 px). Consider promoting this to a dedicated semantic token such as `--page-header-accent-border-width` so the signature element can be tuned independently of generic borders.

### 7. Loading skeletons
`src/components/ui/LoadingSkeleton.css` uses hardcoded gradient stops. Map them to `--color-surface`, `--color-surface-variant`, and `--color-outline-variant` so they look correct in dark/OLED modes.

## Verification

After the quick wins above:

- `npm run lint` ✅
- `npx tsc -b --noEmit` ✅
- `node scripts/validate-design-system.js` ✅
- `ruff check app/` ✅
