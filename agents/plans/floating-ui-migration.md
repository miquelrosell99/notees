# Floating UI Migration — All Popup Positioning

**Status:** completed (2026-07-13)
**Started:** 2026-07-13
**Scope:** user-approved "Everything" — migrate every hand-rolled popup/popover
positioning implementation in `frontend/src` to `@floating-ui/dom`.

## Why

- `ButtonWithPanel` popups detached from their trigger on background scroll;
  first fix (React state per scroll frame) was laggy.
- Survey found the same bug class in ~15 components: coordinates computed once
  at open, no scroll tracking, estimated-size flip math, duplicated clamp logic.
- Decision: standardize on `@floating-ui/dom` (core only, **not**
  `@floating-ui/react` — its hook updates x/y via React state, reintroducing
  render-per-frame lag). `computePosition` + `autoUpdate` write styles straight
  to the floating element.

## Canonical pattern (established in `ButtonWithPanel.tsx`)

```ts
import { autoUpdate, computePosition, flip, offset, shift, type Placement, type Strategy } from '@floating-ui/dom';

useLayoutEffect(() => {
  if (!isOpen) return;
  const reference = anchorRef.current;       // trigger element
  const floating = panelRef.current;         // popup element
  if (!reference || !floating) return;

  const strategy: Strategy = portaled ? 'fixed' : 'absolute';

  const update = () => {
    computePosition(reference, floating, {
      placement,                              // e.g. 'bottom-start'
      strategy,
      middleware: [
        offset(GAP),                          // preserve each component's existing gap
        flip({ padding: EDGE, fallbackPlacements: [...] }),
        shift({ padding: EDGE, crossAxis: true }),
      ],
    }).then(({ x, y }) => {
      floating.style.left = `${x}px`;
      floating.style.top = `${y}px`;
      floating.style.right = 'auto';
      floating.style.bottom = 'auto';
    });
  };

  update();
  return autoUpdate(reference, floating, update);  // scroll/resize/ResizeObserver/layoutShift
}, [isOpen, ...placementDeps]);
```

Rules:
- Core package only (`@floating-ui/dom`, installed 1.8.0). Never add
  `@floating-ui/react` for this.
- Preserve each component's existing gap/edge-padding values; do not blindly
  copy ButtonWithPanel's 8/16.
- Caret/selection anchoring uses Floating UI **virtual elements**
  (`{ getBoundingClientRect: () => range.getBoundingClientRect() }`).
- Editor popups must keep the keepalive invariant: portaled popups from the
  custom inline editor hold `openPopup()` while open and `closePopup()` on
  close (see `agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`).

## Work items

| # | Item | Notes |
|---|------|-------|
| 1 | `ButtonWithPanel.tsx` | ✅ done (pattern reference) |
| 2 | `hooks/useViewportFlip.ts` | ✅ done — internals on Floating UI, `popupRef` now required, `popupWidth` option removed; consumers: Dropdown, DatePickerPopup, NodeSelector (single), InlineTriggers property picker, CalendarPopup |
| 3 | `ui/ContextMenu.tsx` | ✅ done — also covers `WorkspaceActionsMenu` |
| 4 | `ui/ColorButton.tsx` | ✅ done — own scroll-capture listeners replaced by autoUpdate |
| 5 | `layout/AccountMenu.tsx` | ✅ done — menu + notification panel via shared `useAnchoredPopup` |
| 6 | `editor/editor/plugins/TriggerPopup.tsx` | ✅ done — estimated-height flip killed; virtual element spanning caret line |
| 7 | `nodes/NodeContextMenu.tsx` (+ `iconRow.tsx`) | ✅ done — `adjustMenuPosition.ts` deleted as dead code |
| 8 | `ui/EmojiPicker.tsx` | ✅ done — API change: `anchorRef` replaces `{x,y}`; callers migrated (EmojiPickerTrigger, PageHeader, iconRow) |
| 9 | `nodes/SuggestionPopup.tsx` | ✅ done — required `anchorRef` replaces `{top,left}`; callers migrated (CommandPalette, PageHeader) |
| 10 | `layout/CommandPalette/FilterPrefixPopup.tsx` | ✅ done — same anchor API change |
| 11 | `editor/custom/plugins/InlineTriggers.tsx` | ✅ done — viewport coords normalized (scrollY≠0 bug fixed); keepalive invariant preserved |
| 12 | `editor/custom/plugins/FloatingToolbar.tsx` | ✅ done — virtual element from live Range; gained flip |
| 13 | `nodes/NodeSelector.tsx` | ✅ done — multi-select + pill-row/anchored modes migrated; single-select verified against new hook |
| 14 | `ui/SearchBox.tsx` | ✅ done — gained flip/shift + autoUpdate |
| 15 | `content/components/transclusion/TransclusionPopover.tsx` | ✅ deleted (dead code) — barrel export removed from `features/content/index.ts` |

## Final verification (2026-07-13)

- `npx tsc -b --noEmit`: clean
- `npm run lint`: clean on all migrated files (remaining issues are pre-existing in untouched files)
- `npm run test:run`: 434/434 pass
- Dev server: all migrated modules transform and serve (HTTP 200)

## Verification (per item, then globally at the end)

```bash
docker compose -f compose.dev.yaml exec frontend npx tsc -b --noEmit
docker compose -f compose.dev.yaml exec frontend npx eslint <changed files>
docker compose -f compose.dev.yaml exec frontend npm run test:run   # global, at the end
```

## Follow-ups (after migration)

- Add "check online for established libraries before hand-rolling common UI
  primitives" guidance to the `react-ui-patterns` skill (user request).
- Future: native CSS Anchor Positioning (Baseline 2026) could replace the
  dependency entirely; not worth it while we need flip middleware + virtual
  elements.
