# Frontend Architecture

> Generic React/TypeScript/Vite patterns (strict TS, path aliases, co-located CSS, data flow, store boundaries, query key discipline, mutation cache invalidation, barrel files, hook decomposition, TanStack Query v5 unmounting behavior) are covered by the `react-ui-patterns` skill. This document covers Notees-specific frontend implementation.

## React SPA

- **Build tool**: Vite with PWA plugin (`vite-plugin-pwa`). The build outputs to `app/static/dist`.
- **State**: Zustand for client state (navigation, UI, auth, settings, undo); TanStack Query for server state and caching.
- **Feature-first frontend**: `frontend/src/features/` owns cohesive domains: `content` (core node/page/block logic), `editor` (Lexical editor, plugins, inline editor), `properties` (property cells/renderers/registry), `views` (graph, timeline, gantt, kanban, table, etc.), `whiteboard`, `tasks`, `queries`, `auth`, `workspace`, `shares`, `journals`, `layout`, `sidebar`, and `collab`. Cross-feature imports go through feature barrels.
- **Editor**: Lexical with 28+ custom plugins for block editing, slash commands, drag-and-drop, tables, code blocks, etc. Editor code lives in `frontend/src/features/editor/`.
- **Routing**: Client-side routing within the SPA via a custom router (`src/hooks/useRouter.hook.ts`). FastAPI serves `index.html` for all non-API routes (`spa_fallback`).
- **Path aliases**: `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`, `@/features`.
- **Optimistic UI**: Mutations update TanStack Query cache immediately and roll back on failure.
- **View modes**: `NodeCollection` dispatches to view components in `frontend/src/features/views/` (`ListView`, `DocumentView`, `CardView`, `TableView`, `GanttView`, `GraphView`, `TimelineView`, etc.).
- **Canvas Renderers**: `GanttView` and `TimelineView` use extracted imperative canvas renderers (`GanttRenderer.ts`, `TimelineRenderer.ts`) in `frontend/src/features/views/renderers/`.
- **PWA**: Service worker auto-updates; precaches JS/CSS/HTML/ICO/PNG/SVG/WOFF2; network-first API caching; CacheFirst WASM caching; Web Share Target support.

## Data Flow Architecture

The frontend follows the `react-ui-patterns` three-layer model without deviation:

```
Backend API ←→ TanStack Query (server state) ←→ SyncManager (adapter) ←→ OperationRuntime + helpers (derived state) ←→ React UI
```

**Layers:**

1. **OperationRuntime** (`frontend/src/runtime/OperationRuntime.ts`): Pure derived-state engine. It owns base nodes (from TanStack Query) + pending operations = projected nodes. It has no React, TanStack Query, or API imports.
2. **Runtime helpers** (`frontend/src/runtime/graphHelpers.ts`, `eventBus.ts`, `serverIdMap.ts`, plus `frontend/src/stores/undoEngine.ts`): Thin modules around OperationRuntime. They provide graph traversal, typed event emission, server-id mapping, undo/redo, and intent dispatch. None of them call the API.
3. **SyncManager** (`frontend/src/sync/SyncManager.tsx`): The **sole** React adapter between OperationRuntime and TanStack Query. Mounted once in `App.tsx`, it observes dispatchable operations, fires `useMutation` hooks, applies targeted cache updates, and acknowledges operations on success.
4. **useContentSave** (`frontend/src/features/editor/hooks/useContentSave.ts`): Debounces editor content changes and forwards them to the undo engine as `update_content` intents. It no longer calls the API directly.

**Boundary rules:**

- The runtime never calls the API or TanStack Query directly.
- Only SyncManager dispatches API mutations.
- Cache updates are centralized in `cacheWriter.ts` and `mutationMap.ts`.
- Offline/ordering is handled by OperationRuntime's operation log and dependency graph; operations dispatch only after their dependencies are acknowledged.
- Graph helper functions return **ephemeral projections**, not persistent state.
- Legacy bridge hooks (`useBlockPersist`, `useStructureSync`, `useOfflineQueue`) are no-ops; their responsibilities moved to SyncManager and OperationRuntime.

## Conventions

> Generic React patterns — See the `react-ui-patterns` skill for cross-project guidance on strict TypeScript, path aliases, CSS co-location, import boundaries, data flow architecture, store boundaries, query key discipline, mutation cache invalidation, API layer purity, barrel files, hook decomposition, and TanStack Query v5 unmounting behavior. The items below are Notees-specific implementations and file paths.

- **Strict TypeScript**: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `verbatimModuleSyntax: true`.
- **Path Aliases**: Mandatory. Use `@/components`, `@/hooks`, `@/stores`, `@/api`, `@/editor`, `@/runtime`, `@/types`. Never use relative `../../../` paths.
- **CSS Co-location**: Each component has a `.css` file with the same base name in the same directory.
- **Component File Extensions**: `.tsx` for React components, `.ts` for utilities.
- **Import Boundaries**:
  - `components/ui/` components are domain-agnostic atoms (Button, Card, Modal). They **must never** import domain components or stores.
  - Domain-specific components (`features/content/components/blocks/`, `features/content/components/nodes/`, `features/properties/`, `features/queries/`) may import from `components/ui/`, `api/`, `hooks/`, and `stores/`.
- **Custom Hooks**: Live in `frontend/src/hooks/`.
- **State**: Zustand for client state; TanStack Query for server state. Avoid direct fetch/XMLHttpRequest inside UI components.

### Custom Inline Editor — Popup Keepalive Invariant

The block editor (`features/editor/custom/components/CustomInlineEditor.tsx`) is mounted by `BlockRow.tsx` only while `shouldMountEditor` is true, i.e. `(isActive || isPendingFocus) && !isGhost && !readOnly && !isLocked`. `isActive` is `activeBlockId === node.uuid` from `stores/editorFocusStore.ts`. On editor blur, `handleBlur` calls `blurBlock(blockId)`, which **clears `activeBlockId` unless `popupOpen` is true**:

```ts
blurBlock: (blockId) => set((state) => {
  if (state.activeBlockId !== blockId) return state;
  if (state.popupOpen) return state; // keepalive while a popup is open
  return { activeBlockId: null, ... };
}),
```

**Rule:** any portaled popup or modal opened from within the editor subtree MUST hold `useEditorFocusStore.getState().openPopup()` for its entire open lifetime and call `closePopup()` on close. This is what keeps the editor mounted while the user interacts with the popup.

**Why it matters (the `/date` no-insert bug):** the slash trigger popup held the keepalive, but its follow-on pickers (`/date`, `/date-range`, `/url`, `/property`, `/comment`) did not. Clicking a day blurred the editor → `blurBlock` cleared `activeBlockId` → `CustomInlineEditor` (and `InlineTriggers`, which owns the picker) unmounted. The day-click handler still fired synchronously, but `await getOrCreateDaily(...)` only resolved *after* the unmount, so the subsequent `applyMutation(insertAtomicNode(...))` ran on a detached fiber — the link was silently never inserted, with no error. The picker looked usable only because the click handler runs in the same task as the blur, ahead of the React commit that tears it down.

**Where the keepalive must be held** (audit list — keep in sync when adding editor popups):

- `InlineTriggers.tsx` — the trigger popup **and** every follow-on picker (`datePickerOpen`, `dateRangePickerOpen`, `urlModalOpen`, `propertyPickerOpen`, `commentPromptOpen`) via one combined `anyPickerOpen` effect. The pickers are mutually exclusive, so a single boolean `popupOpen` is correct and there is no keepalive gap during the trigger→picker handoff.
- `CustomInlineEditor.tsx` — the pill "Edit link" `LinkEditModal` (keyed by `editingLinkId`).

**Not affected (no fix needed):** `FloatingToolbar` (calls `preventDefault()` on mousedown and only does synchronous `toggleMark` mutations — never blurs the editor) and `InlineNodeLinks` (synchronous click/keydown handlers, no portaled picker). The legacy Lexical editor under `features/editor/editor/` is no longer mounted as the block editor, so it is out of scope for this invariant.

**Symptom of a missing keepalive:** a popup opened from the editor closes normally on selection but the editor content does not change and no error is thrown. If you see "popup closes, nothing inserted, no error," check whether the popup holds `popupOpen`.

### Icons

The app uses **SVG-only icon rendering** via a shared sprite sheet (`frontend/public/mdi-sprite.svg`).

- **Sprite sheet**: All 7,000+ Material Design Icons are stored as `<symbol>` elements in a single static file generated from `@mdi/svg`.
- **Rendering**: `Icon.tsx` and `iconDom.ts` render icons with `<svg><use href="/mdi-sprite.svg#mdi-{name}" /></svg>`.
- **No icon fonts**: `@mdi/font` and `@mdi/js` are not used. Do not introduce font-based icon fallbacks.
- **Regeneration**: After updating `@mdi/svg`, run `node scripts/generate-mdi-sprite.js` to rebuild the sprite.
- **PWA caching**: The sprite is precached by the service worker. If the sprite grows beyond 4 MB raw, update `maximumFileSizeToCacheInBytes` in `vite.config.ts`.

### Mobile Hover-Reveal Pattern

Buttons that are only visible on `:hover` are impossible to discover on touch devices. The codebase uses a shared `.hover-reveal` utility class to solve this centrally:

```css
/* frontend/src/index.css */
.hover-reveal {
  opacity: 0;
  transition: opacity var(--motion-duration-short) var(--motion-easing-standard);
}

@media (max-width: 768px) {
  .hover-reveal {
    opacity: 1 !important;
    pointer-events: auto !important;
  }
}
```

**Usage:** add `hover-reveal` to any element that should be hidden by default and revealed on parent hover:

```tsx
<button className="my-action-button hover-reveal">…</button>
```

The component's existing parent-hover rule (e.g., `.my-container:hover .my-action-button { opacity: 1; }`) is typically **more specific** than `.hover-reveal`, so desktop behavior is unchanged. On mobile the `!important` override forces visibility.

**Rules:**
- Always prefer `.hover-reveal` over scattering `@media (max-width: 768px)` opacity overrides across individual component CSS files.
- If an element also collapses `width` or `transform` (not just opacity), keep the layout collapse in the component CSS and add a co-located mobile override for that property only (see `NodeBreadcrumbs.css` and `WhiteboardView.css` for examples).
- Do not add `.hover-reveal` to elements that are already always visible; it is only for hover-only affordances.

### CSS & Design System Conventions

> Generic design system guidance is covered by `design-system`. The Notees-specific token names and rules are below.

- **Design Tokens First**: All spacing, layout, sizing, and positioning values must use tokens from `variables.css`. Never hardcode pixel values that describe spatial relationships between components.
  - Block indentation: `--block-indent-step`
  - Thread line position: `--thread-line-offset`
  - Collapse arrow position: `--collapse-arrow-offset`
  - Bullet sizes: `--bullet-wrapper-size`, `--bullet-dot-size`
- **No Cross-Component Selectors**: A CSS file must never reach into another component's internals (e.g., `.node-block--editing .bullet-dot` is forbidden). If a child component needs to change appearance based on parent state, pass a prop or use a data attribute on the child.
- **Component Co-location**: Each `.tsx` file has exactly one `.css` file in the same directory. CSS for a component lives only in its own file.
- **Dead Code Hygiene**: Delete unused CSS classes immediately when the corresponding TSX structure changes. Do not leave orphaned rules "just in case."
- **No Magic Numbers**: If a value appears in more than one CSS file, it must be a token.
- **UI Components First**: Never create a one-off `<button>` or `<input>` when a shared UI component exists. The `Button`, `Icon`, `Input`, `Checkbox`, etc. components in `frontend/src/components/ui/` enforce consistency (sizing, accessibility, focus states, hover styles). Always use them. If a design truly requires a custom element, extract a new UI component rather than inlining raw HTML.
  - Icon-only buttons: `<Button variant="ghost" size="xs" iconOnly icon="mdi mdi-close" />`
  - Text + icon buttons: `<Button icon="mdi mdi-plus">Add</Button>`
  - Never use raw `<button>` for icon actions — `Button` handles `aspect-ratio: 1`, `padding: 0`, and flex-centering automatically.

### Aesthetic Recipe

The full design language is documented in `docs/design-language.md`. The summary below is the single source of truth for implementation decisions.

Notees is a calm, writing-first knowledge workspace. Its visual identity is defined by a deliberate recipe:

- **55% monastic-productivity** — generous whitespace, minimal chrome, content as the hero.
- **30% editorial-software** — typographic hierarchy, structured pages, long-form reading feel.
- **15% playful-computational-design** — tactile block-editor interactions and purposeful micro-motion.

**Palette**: a warm paper base (`--color-background: #f5f3ef` in light mode; warm charcoal in dark mode) with pure-white page surfaces. The default functional accent is **sage** (`--color-accent: #5B7D5B`; dark-mode override `#7FB285`). Users can choose an arbitrary custom accent from Settings → Appearance. Custom accents set `--color-accent` directly and compute `--color-on-accent` (black or white) from the hex value so primary actions stay readable in light, dark, and OLED modes. Preset accents include dark-mode overrides; accent is reserved for links, active filters, selected states, and primary actions.

**Typography**: Inter remains the UI and body face. Page titles and major headlines use the system serif display stack (`--font-family-display: Georgia, 'Times New Roman', serif`) for an editorial feel. Use the type-scale tokens (`--font-body-*`, `--font-title-*`, `--font-headline-*`, `--font-label-*`, `--font-display-*`) rather than raw sizes.

**Signature elements**:
- **Editorial page header**: warm surface container, accent left border, large serif title.
- **Circular block bullet**: small, solid circular bullet indicator (`border-radius: 50%`) that turns accent on hover/selection.
- **Receding chrome**: top bar and sidebars use transparent or surface-container backgrounds so the page surface dominates.

**Design decision log**:
| Date | Decision | Rationale |
|---|---|---|
| 2026-06-12 | Block bullets remain circular | Product-owner preference; the earlier “sharp square” exploration was rejected in favor of the softer circular mark. |
| 2026-06-12 | Custom accent picker in Settings | Phase 6.3 of the fleet migration plan; `--color-on-accent` is computed from luminance so the chosen color is usable in every theme. |

**Elevation**: Zero decorative shadows. `--elevation-*` tokens are all `none`. Depth is conveyed with surface color shifts and thin outlines (`--color-outline-variant`).

**Shape**: Keep the existing minimal radius scale. Identity comes from color and type, not from corner roundness.

**Spacing**: Use the 4px-based scale (`--spacing-1` = 0.25rem). Avoid arbitrary margins/paddings; if a value is repeated, make it a token.

**Motion**: Short and tactile. Default transitions use `--motion-duration-short` (100ms) or `--motion-duration-medium` (250ms). Respect `prefers-reduced-motion` — the global reset in `index.css` already disables animations for users who request it.

**Icons**: Decorative icons are `aria-hidden`. If an icon conveys meaning on its own, pass a `title` to the `Icon` component so it exposes `role="img"` and `aria-label`.

**CSS implementation**: The app currently uses co-located custom CSS driven by `variables.css`. A phased migration to Tailwind CSS is planned; when it happens, the tokens above must be mapped to `tailwind.config.js` rather than replaced with default Tailwind utilities.

**Registration**: Open registration is **disabled by default** (`REGISTRATION_ENABLED=false`). Frontend fallbacks also default to `false` so the UI does not expose a registration form when the status endpoint is unreachable.

### Adding a New Frontend Component

1. Place React components in the appropriate feature under `frontend/src/features/`.
2. Use path aliases (e.g., `@/components/ui/Button`) for all imports.
3. Co-locate CSS in a `.css` file with the same base name.
4. Respect import boundaries: `components/ui/` must not import domain components or stores.
5. Register new routes/views in the appropriate `frontend/src/features/{name}/pages/` and wire them into `MainContent` / `appStore`.
