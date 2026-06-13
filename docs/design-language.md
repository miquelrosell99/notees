# Notees Design Language

This document defines the deliberate visual identity for Notees. It exists so the design direction survives context-window limits and can be referenced during implementation.

## Product essence

Notees is a self-hosted, privacy-first knowledge tool: block-based notes, bidirectional links, daily journals, graph view, whiteboard. The UI should feel like a calm, permanent place for thinking — not a dashboard, not a social feed.

## Aesthetic recipe

| Reference | Share | What it brings |
|---|---|---|
| `monastic-productivity` | 55% | Writing-first whitespace, minimal chrome, calm focus. |
| `editorial-software` | 30% | Structured pages, typographic hierarchy, content as the interface. |
| `playful-computational-design` | 15% | Tactile block-editor interactions and subtle, purposeful motion. |

Result: a warm, paper-like workspace with an editorial headline treatment and a single functional accent. It should feel crafted and personal, not generated.

## Design principles

1. **The page is the hero.** Chrome (sidebars, toolbars) recedes; the page surface and typography dominate.
2. **Warm monochrome base + one accent.** The background is warm paper, not cold gray. The accent (sage) is reserved for links, active filters, selected states, and primary actions.
3. **Display type is editorial.** Page titles and major headings use a system serif stack for a long-form reading feel; UI chrome stays in the sans stack.
4. **Zero gratuitous decoration.** No shadows, no gradients, no decorative icons. Every visual element serves navigation or content.
5. **Motion is small and informative.** Blocks appear with a subtle pop; focus states are clear; reduced motion is always respected.

## Tokens

### Base palette (light)

- Background: `#f5f3ef` (warm paper)
- Surface: `#ffffff`
- Surface variant: `#f0ede8`
- Ink: `#1a1a1a`
- Muted ink: `#5c5c5c`
- Outline: `#c4bfb6`
- Outline variant: `#e3ded6`

### Base palette (dark)

- Background: `#121211` (warm black)
- Surface: `#1a1a18`
- Surface variant: `#262623`
- Ink: `#e8e6e1`
- Muted ink: `#a8a29e`
- Outline: `#52504a`
- Outline variant: `#2a2926`

### Accent

Default accent is **sage**, already implemented via `data-accent="sage"`:

- Light: `#5B7D5B`
- Dark: `#7FB285`

Users can also choose an arbitrary custom accent from Settings → Appearance. When `data-accent="custom"` is active, `--color-accent` is set to the user-provided hex value and `--color-on-accent` is computed as black or white based on the color's luminance. This keeps primary buttons readable in light, dark, and OLED modes.

### Typography

- UI / body: `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- Display / headlines: `Georgia, 'Times New Roman', serif` (system serif, no external font request for privacy)

### Shape

Keep the existing minimal radius scale; identity comes from color and type, not from rounding corners differently.

## Signature elements

1. **Focus mode as the purest expression of the identity**
   - The existing focus mode hides all chrome and leaves only the page and its typography.
   - With the warm paper palette and serif page title, focus mode becomes a calm, monastic writing surface.

2. **The editorial page header**
   - Large serif page title.
   - Warm surface background for the header area.
   - A thin accent line or left border that marks the page as the current focus.

3. **The tactile block bullet**
   - A small, solid circular indicator.
   - Hover reveals the block handle; selection shows the accent color.

4. **The warm workspace**
   - The app background is warm paper; cards and pages are pure white (light) or warm charcoal (dark).
   - This creates a subtle “desk” feeling without skeuomorphism.

## Implementation phases

### Phase 1 — Foundation
- Update `variables.css` base palette (warm paper, warm dark, outline colors).
- Add `--font-family-display` and update display/headline tokens to use it.
- Add `--color-on-accent` for each accent variant so primary actions can use the accent safely.
- Verify lint, type, and design-system checks.

### Phase 2 — Signature components
- `PageHeader`: serif title, warm header background, accent left border.
- `Button`: primary variant uses accent; icon-only active states use accent.
- `TopBar`: reduce visual weight, recede into the workspace background.
- `BlockRow` / `Bullet`: circular bullet, accent selection state.
- Verify each change against the design-system validator.

### Phase 3 — Migration notes
- When Tailwind is adopted, map these tokens to `tailwind.config.js`.
- Until then, keep the token system in `variables.css` as the single source of truth.

## What to avoid

- Default Tailwind colors (`slate`, `blue`, `rounded-md`) without overriding them first.
- Generic hero gradients, big illustration placeholders, or dashboard-style widgets.
- Over-using the accent; it should mean “active / linked / selected / primary.”
