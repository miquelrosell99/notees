# UI Building Blocks

Notees UI is built from **composable primitives**. View modes (list, table, kanban, …) are compositions of shared building blocks — not containers you nest inside each other. When you build a new surface (a cell, a card, a panel, a property value), embed the leaf primitive you need; never mount a whole view mode inside another one.

This document is the inventory of what you can compose with, grounded in the actual files. Conventions (barrels, CSS co-location, import boundaries) live in `frontend.md`.

## Layering Model

```
NodeCollection (container: toolbar + view dispatch)
  └── View component (ListView, TableView, KanbanView, … — registered via registerView)
        └── Row/item primitive (BlockRow, KanbanCard, NodeTable row, …)
              ├── Content primitive   — InlineContentStatic / CustomInlineEditor
              ├── Chrome primitive    — BlockUI (bullet, collapse, presence)
              ├── Display primitive   — NodeRef, NodeBreadcrumbs, PropertyCell, …
              └── UI atom             — Button, Card, Modal, Checkbox, … (components/ui)
```

**The rule:** pick the lowest layer that does the job. A table cell that edits one block's text needs the *content primitive*, not `NodeCollection`. Nesting a view mode brings its toolbar, child rendering, bullets, and indentation along — that is a bug, not reuse.

## Content Primitives (edit or display a block's inline content)

The block's text lives in `node.name` as a JSON `ContentAST`. These are the only two components that render it:

| Primitive | Path | Use |
|---|---|---|
| `CustomInlineEditor` | `features/editor/custom/components/CustomInlineEditor.tsx` | contentEditable editor for one block's inline content. Mounted only while the block is active. Props: `blockId`, `initialContentAST`, `onContentChange`, `onEnter`/`onEscape`/`onBlur`, `onPillClick`. Ships with plugins: `InlineTriggers` (`+ @ # /`), `InlineNodeLinks` (pill click/select), `InlineCopyPaste`, `FloatingToolbar`. |
| `InlineContentStatic` | `features/editor/editor/InlineContentStatic.tsx` | Read-only rendering of the same AST as plain DOM (links, marks, math, date-range pills). Click → `onFocus(cursorOffset)` enters edit mode. Cheap enough to render per visible row. |

Supporting pieces:

- **`editorFocusStore`** (`stores/editorFocusStore.ts`) — single source of truth for which block is being edited (`activeBlockId`, `pendingFocusBlockId`) plus the `popupOpen` keepalive. The static→editor switch is driven by this store: `focusBlock(uuid)` + `setPendingFocus(uuid)` mounts the editor; `blurBlock(uuid)` unmounts it unless a popup holds the keepalive. See `frontend.md#custom-inline-editor--popup-keepalive-invariant`.
- **`useContentSave`** (`features/editor/hooks/useContentSave.ts`) — debounced `handleContentChange(blockId, content)` → `update_content` intent through the undo engine/runtime. Call `flushAllContentSaves()` on blur so static views never show stale content.
- **`getRuntimeDisplayName(node)`** (`features/content/hooks/runtimeContentOverlay.ts`) — live display name from the runtime projection, for read-only render paths that should reflect unsaved edits.

### Pattern: editing one block's text in a cell/panel

`NodeCellEditable` (`features/content/components/nodes/NodeCellEditable.tsx`, used for the table Name column) is the reference implementation:

- Not active → `InlineContentStatic` with `onFocus` → `focusBlock` + `setPendingFocus`.
- Active → `CustomInlineEditor` with `onContentChange={handleContentChange}`, `onBlur` → `flushAllContentSaves()`, `onEnter`/`onEscape` → blur (a cell has no sibling/child blocks).
- No bullet, no child blocks, no `NodeCollection`.

## Block Composition (outliner rows)

| Primitive | Path | Use |
|---|---|---|
| `BlockList` | `features/content/components/blocks/BlockList.tsx` | The outliner: flattens the block tree, keyboard routing (Enter/Backspace/Tab/Arrows), drag/selection/touch-indent hooks. Renders one `BlockRow` per block. |
| `BlockRow` | `features/content/components/blocks/BlockRow.tsx` | One block row = `BlockUI` (chrome) + content primitive + `BlockAfterContent`. The canonical composition — copy from it when embedding blocks. |
| `BlockUI` | `features/content/components/blocks/BlockUI.tsx` | Non-editable chrome: bullet, icon, collapse arrow, presence/lock indicators. Supports `hideBullet` and `documentMode`. |
| `BlockAfterContent` | `features/content/components/blocks/BlockAfterContent.tsx` | Backlinks/property previews after the block content. |
| `Bullet`, `BulletLine` | `features/content/components/blocks/` | Bullet glyph and thread/guide lines for nested blocks. |
| `ClassPillsRow` | `features/content/components/nodes/ClassPillsRow.tsx` | Class pills under a block. |
| `PropertiesSection` | `features/properties/components/PropertiesSection.tsx` | Inline property list for a node. |

Use `BlockList` when you want the full outliner (children, keyboard nav, drag). Use `BlockRow`'s composition (or just the content primitive) when you want one block without the tree.

## Node Display Primitives (reference a node without editing it)

| Primitive | Path | Use |
|---|---|---|
| `NodeRef` | `features/content/components/nodes/NodeRef.tsx` | Inline pill linking to a node (icon + name). Variants for inline links and decorator-style rendering. |
| `NodeBreadcrumbs` | `features/content/components/nodes/NodeBreadcrumbs.tsx` | Ancestor path of a node; `compact` for dense surfaces. |
| `NodeNameContent` | `features/content/components/blocks/NodeNameContent.tsx` | Plain rendering of a node's name content (no edit affordance). |
| `CollapsiblePillRow` | `features/content/components/nodes/` | Row of pills that collapses overflow (used by the Classes table column). |
| `NodeSelector` | `features/content/components/nodes/` | Search-and-pick a node (e.g. add class). |
| `NodeContextMenu` | `features/content/components/nodes/NodeContextMenu.tsx` | Standard node right-click menu. |

## Collection Views (many nodes)

- **`NodeCollection`** (`features/content/components/nodes/NodeCollection.tsx`) — the container: toolbar (view switcher, sort, filters) + dispatch to the active view. This is the *top* of a composition, never a child.
- **View registry** (`features/views/components/registry.ts`) — views self-register via `registerView({ id, label, icon, component, capabilities })`. Registered: `list`, `document`, `card`, `table`, `kanban`, `gantt`, `timeline`, `graph`, `pivot`, `calendar`, `chart`. New views must register here.
- **`NodeTable`** (`features/views/components/NodeTable.tsx`) — generic table used by `TableView`: columns with custom renderers, selection, sorting, row context menu, optional virtualization. Name-column cells render via `renderNodeCell` → `NodeCellEditable`.
- **`PropertyCell`** (`features/properties/`) + `getPropertyValueRenderer(type)` — type-aware property value display/edit and comparison for sorting.

## UI Atoms (`frontend/src/components/ui/`)

Domain-agnostic atoms: `Button`, `Card`, `Modal`, `ConfirmationModal`, `Checkbox`, `Dropdown`, `TextField`, `SearchBox`/`SearchField`, `Pill`, `Badge`, `Spinner`, `LoadingSkeleton`, `Tabs`, `Slider`, `ToggleSwitch`, `ContextMenu`, `EmptyState`, `DataStateView`, `EmojiPicker`, `CalendarPopup`, `Icon` (SVG sprite — see `frontend.md#icons`).

Rules (from `frontend.md`): atoms must never import domain components or stores; never create a one-off `<button>`/`<input>` when an atom exists; icon-only actions use `<Button variant="ghost" size="xs" icon=… />`.

## Stores as Building Blocks

| Store | Path | Use |
|---|---|---|
| `editorFocusStore` | `stores/editorFocusStore.ts` | Active-block focus state machine + popup keepalive. |
| `useNavigationStore` | `stores/` | `openNode(uuid)`, `addSidebarCard(uuid, type)` — the only way to navigate. |
| `useUIStateStore` | `features/sync/` | Device-local UI state (collapsed blocks, etc.). |
| `useModalStore` | `stores/modalStore.ts` | Global modals (e.g. conflict resolution). |

## Composition Rules Recap

1. **Never nest view modes.** No `NodeCollection`/`ListView`/`DocumentView` inside a cell, card, or panel. Embed the leaf primitive instead (`NodeCellEditable` is the pattern).
2. **Edit inline content** → `CustomInlineEditor` + `InlineContentStatic`, driven by `editorFocusStore`, saved via `useContentSave`.
3. **Show a block with chrome** (bullet, children) → `BlockList`/`BlockRow`; never rebuild bullet rendering by hand.
4. **Reference a node** → `NodeRef`/`NodeBreadcrumbs`; navigate via `useNavigationStore`.
5. **Render many nodes** → a registered view under `NodeCollection`; tabular data → `NodeTable`.
6. **Actions and inputs** → `components/ui` atoms; domain components compose atoms, never the reverse.
