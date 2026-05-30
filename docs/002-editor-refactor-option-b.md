# Option B: Block-Level Editor Architecture

## Status
Draft — awaiting approval before implementation.

## Problem Statement

The current editor uses a **single monolithic Lexical instance** that projects the entire block tree from `NodeGraphRuntime` via `BlockPlugin.syncProjection`. This creates three categories of bugs that are structurally impossible to fix with local patches:

1. **Focus wars** — `syncProjection` restores focus after every runtime update. When a popup (triggered by `+`, `@`, `#`) opens, its input must fight `syncProjection`, `BlurOnClickOutsidePlugin`, and `EmptyClickPlugin` for focus ownership. The result is non-deterministic focus behavior.

2. **Selection clobbering** — Because `syncProjection` rebuilds the entire Lexical tree on every runtime event, cursor position is derived from `pendingFocus` block IDs and offsets. Any mutation that doesn't explicitly request focus causes the cursor to jump to the browser default (start of contentEditable = first block).

3. **Reactivity dead zones** — `BlockNode` renders bullets, icons, class pills, task badges, query toolbars, asset previews, table previews, code gutters, and property rows via raw DOM mutation in `createDOM`/`updateDOM` and React portals. Lexical's reconciler doesn't know about these, so metadata changes (class added, color changed) rely on the 600-line `syncProjection` to manually diff and patch DOM attributes.

## Target Architecture

Replace the monolithic `BlockEditor` + `BlockPlugin` with a **virtualized list of per-block inline editors**.

```
Before:
BlockEditor (1 Lexical instance)
└── BlockPlugin.syncProjection
    └── projects ALL blocks into ONE Lexical root
    └── handles Enter/Backspace/Delete/Tab via commands
    └── focus restoration after every sync

After:
BlockList (React virtualized list)
└── BlockRow (React component, one per block)
    ├── BlockUI (bullet, icon, collapse arrow, class pills)
    └── InlineEditor (1 small Lexical instance per block)
        └── PlainTextPlugin or RichTextPlugin
        └── only handles text formatting, links, pills
```

## Key Principles

1. **One editor per block** — Each block gets its own `LexicalComposer` with a minimal plugin set. No more `BlockNode`. No more `syncProjection`.

2. **React owns the tree** — Block hierarchy, depth indentation, collapsed state, and virtual scrolling are handled by React components, not Lexical nodes.

3. **Keyboard navigation is external** — Enter, Backspace, Delete, Tab, ArrowUp/Down are handled by React event listeners on the list container, not Lexical commands. They call `NodeGraphRuntime` intents directly.

4. **Focus is centralized** — A single `EditorFocusManager` (Zustand store) tracks which block editor is active. Popups request focus tokens; editors release them on unmount.

## Detailed Design

### 1. Data Flow

```
User types in InlineEditor → Lexical update listener →
  serializeContentAST() → onContentChange(blockId, ast) →
  runtime.applyIntent({ type: 'update_content', blockId, contentAST }) →
  runtime emits nodes_changed →
  BlockList re-renders with updated nodes (React Query cache) →
  ONLY the affected InlineEditor receives new props
```

No `syncProjection`. No `writeBlockContent`. No `blockIdToKeyMap`.

### 2. Component Hierarchy

```tsx
// BlockList.tsx
function BlockList({ nodes, rootBlockId }: BlockListProps) {
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
  });

  return (
    <div ref={scrollRef}>
      {virtualizer.getVirtualItems().map((item) => (
        <BlockRow
          key={nodes[item.index].uuid}
          node={nodes[item.index]}
          depth={nodes[item.index].depth}
        />
      ))}
    </div>
  );
}

// BlockRow.tsx
function BlockRow({ node, depth }: BlockRowProps) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="block-row" style={{ '--depth': depth }}>
      <BlockUI node={node} />
      <InlineEditor
        blockId={node.uuid}
        initialContentAST={node.contentAST}
        readOnly={!isEditing}
        onContentChange={handleContentChange}
      />
      <BlockAfterContent node={node} />
    </div>
  );
}
```

### 3. InlineEditor

A minimal Lexical instance that only handles inline content:

```tsx
function InlineEditor({ blockId, initialContentAST, onContentChange }: Props) {
  const initialConfig = useMemo(() => ({
    namespace: `InlineEditor-${blockId}`,
    theme: notesEditorTheme,
    nodes: [TextNode, InlineLinkNode], // NO BlockNode
    onError: console.error,
    editorState: (editor) => {
      populateInlineContent(editor, initialContentAST);
    },
  }), [blockId, initialContentAST]);

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin />
      <HistoryPlugin />
      <OnChangePlugin onChange={onContentChange} />
      <TriggerPlugin onAddClass={...} onSlashCommand={...} />
      <NodeLinkPlugin />
    </LexicalComposer>
  );
}
```

**Critical:** `InlineEditor` does NOT contain `BlockPlugin`, `BlurOnClickOutsidePlugin`, `VirtualizationPlugin`, `BlockClassPillsPlugin`, `TaskBadgesPlugin`, etc. Those responsibilities move to `BlockRow`.

### 4. Keyboard Navigation (List Level)

React captures keyboard events on the list container and routes them:

```tsx
function BlockList({ ... }) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const activeId = focusManager.getActiveBlockId();
    if (!activeId) return;

    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        runtime.applyIntent({ type: 'split_block', blockId: activeId, ... });
        break;
      }
      case 'Backspace': {
        // Only handle at block level if cursor is at start of inline editor
        if (isCursorAtStart(activeId)) {
          e.preventDefault();
          runtime.applyIntent({ type: 'merge_blocks', ... });
        }
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        focusManager.focusPreviousBlock();
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        focusManager.focusNextBlock();
        break;
      }
      case 'Tab': {
        e.preventDefault();
        runtime.applyIntent({ type: e.shiftKey ? 'outdent_block' : 'indent_block', blockId: activeId });
        break;
      }
    }
  }, []);

  return <div onKeyDown={handleKeyDown}>...</div>;
}
```

### 5. Focus Management

Replace scattered focus logic with a single Zustand store:

```ts
interface EditorFocusState {
  activeBlockId: string | null;
  popupOpen: boolean;
  pendingFocusBlockId: string | null;

  focusBlock(blockId: string): void;
  blurBlock(): void;
  openPopup(): void;
  closePopup(): void;
}
```

Rules:
- `InlineEditor` calls `focusManager.focusBlock(blockId)` on `focus` event.
- `InlineEditor` calls `focusManager.blurBlock()` on `blur` event, but ONLY if `popupOpen === false`.
- `TriggerPopup` calls `focusManager.openPopup()` on mount and `focusManager.closePopup()` on unmount.
- `BlockList` does NOT blur the editor when clicking outside; it only changes `activeBlockId`.

### 6. BlockUI (Non-Editable Chrome)

All non-editable block UI moves to regular React components:

```tsx
function BlockUI({ node }: { node: Node }) {
  return (
    <div className="block-ui">
      <Bullet
        hasChildren={node.has_children}
        collapsed={node.collapsed}
        icon={node.icon}
        color={node.color}
        taskStatus={node.taskStatus}
      />
      <ClassPills classIds={node.classes} />
      <PropertyIcons properties={node.properties} />
    </div>
  );
}
```

This UI updates via normal React props — no portals, no DOM queries, no `updateDOM` hacks.

### 7. Virtualization

Use `@tanstack/react-virtual` (already in the project) instead of IntersectionObserver + Lexical placeholder swapping:

```tsx
const virtualizer = useVirtualizer({
  count: visibleNodes.length,
  getScrollElement: () => containerRef.current,
  estimateSize: (index) => {
    // Rough estimate; actual measurement happens after mount
    return 28;
  },
  overscan: 20,
});
```

Only visible blocks render `InlineEditor`. Off-screen blocks render a cheap placeholder (`<div style={{ height }} />`).

### 8. Collapsed State

If a block is collapsed, its children are simply not in the `visibleNodes` array passed to `BlockList`. The `NodeGraphRuntime` still knows the full tree; `BlockList` just receives a flattened, filtered projection.

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `frontend/src/editor/InlineEditor.tsx` | Minimal Lexical instance for one block's inline content |
| `frontend/src/editor/plugins/InlineEditorPlugin.tsx` | Shared plugin bundle for InlineEditor |
| `frontend/src/components/blocks/BlockList.tsx` | Virtualized list container |
| `frontend/src/components/blocks/BlockRow.tsx` | Single block row (UI + editor) |
| `frontend/src/components/blocks/BlockUI.tsx` | Bullet, icon, collapse arrow |
| `frontend/src/components/blocks/BlockAfterContent.tsx` | Class pills, task badges, property rows |
| `frontend/src/stores/editorFocusStore.ts` | Centralized focus state machine |
| `frontend/src/hooks/useBlockKeyboard.ts` | List-level keyboard handler |

### Modified Files

| File | Change |
|------|--------|
| `frontend/src/editor/BlockEditor.tsx` | Deprecated; replaced by `BlockList` + `InlineEditor` |
| `frontend/src/editor/plugins/BlockPlugin.tsx` | Deleted (or reduced to legacy shim) |
| `frontend/src/editor/plugins/TriggerPlugin.tsx` | Simplified — no more `BlockPlugin` integration |
| `frontend/src/editor/nodes/BlockNode.ts` | Deleted — blocks are React components, not Lexical nodes |
| `frontend/src/components/nodes/views/ListView.tsx` | Uses `BlockList` instead of `BlockEditor` |
| `frontend/src/components/nodes/views/DocumentView.tsx` | Uses `BlockList` with `mode="document"` |
| `frontend/src/runtime/NodeGraphRuntime.ts` | Add `subscribeToBlock(blockId, callback)` for fine-grained updates |

### Deleted Files (eventually)

| File | Reason |
|------|--------|
| `frontend/src/editor/plugins/BlurOnClickOutsidePlugin.tsx` | Focus is managed by `editorFocusStore` |
| `frontend/src/editor/plugins/VirtualizationPlugin.tsx` | Virtualization is at React level |
| `frontend/src/editor/plugins/BlockClassPillsPlugin.tsx` | Class pills are React components in `BlockRow` |
| `frontend/src/editor/plugins/BlockPropertiesPlugin.tsx` | Properties are React components in `BlockRow` |
| `frontend/src/editor/plugins/TaskBadgesPlugin.tsx` | Task badges are React components in `BlockRow` |
| `frontend/src/editor/plugins/BlockBacklinksPlugin.tsx` | Backlink badge is React component in `BlockRow` |

## Migration Strategy

### Phase 1: Focus Store + InlineEditor (2 days)
1. Create `editorFocusStore.ts`.
2. Create `InlineEditor.tsx` with a minimal Lexical config.
3. Create `BlockRow.tsx` that renders `BlockUI` + `InlineEditor`.
4. Render a static (non-virtualized) list of `BlockRow` components alongside the existing `BlockEditor` for comparison.
5. Port `TriggerPlugin` to work inside `InlineEditor`.

### Phase 2: List-Level Keyboard (2 days)
1. Implement `useBlockKeyboard.ts` with Enter, Backspace, Delete, Tab, ArrowUp/Down.
2. Wire keyboard handlers to `NodeGraphRuntime` intents.
3. Test split/merge/indent/outdent behavior.
4. Remove `useBlockPluginCommands.ts`.

### Phase 3: Virtualization (1 day)
1. Replace static list with `@tanstack/react-virtual`.
2. Measure row heights dynamically.
3. Ensure off-screen blocks don't mount `InlineEditor` (performance).

### Phase 4: UI Extraction (1 day)
1. Extract bullets, class pills, task badges, property icons into `BlockRow` subcomponents.
2. Delete portal-based plugins (`BlockClassPillsPlugin`, `TaskBadgesPlugin`, etc.).
3. Delete `BlockNode.ts`.

### Phase 5: Cleanup (1 day)
1. Delete `BlockEditor.tsx`, `BlockPlugin.tsx`, `BlurOnClickOutsidePlugin.tsx`, `VirtualizationPlugin.tsx`.
2. Update all view components (`ListView`, `DocumentView`, `CardView`) to use `BlockList`.
3. Full regression test.

**Total estimated effort: 7 days.**

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Drag-and-drop breaks** | DnD currently uses Lexical's `DragDropPlugin`. Move to `@dnd-kit` at the `BlockRow` level. |
| **Block selection (box select) breaks** | Reimplement with mouse events on `BlockList` container; selected block IDs live in `editorFocusStore`. |
| **Undo/redo breaks** | Lexical `HistoryPlugin` still works per-block. For cross-block operations (merge, split), add custom undo entries to `NodeGraphRuntime` that restore both blocks' content. |
| **Collaboration (Yjs) breaks** | Yjs binding currently attaches to one root editor. Switch to per-block binding: each `InlineEditor` gets its own Yjs provider fragment. |
| **Mobile touch behavior changes** | `TouchIndentPlugin` becomes unnecessary; swipe gestures are handled at `BlockRow` level. |
| **Performance regression with 10k blocks** | Virtualization ensures only ~40 `InlineEditor` instances exist at once. Each is small. Benchmark against current `INITIAL_POPULATE_COUNT = 200`. |

## Decision Gate

Do not proceed past Phase 1 until:
1. `InlineEditor` renders a 100-block page with correct content.
2. Typing in one `InlineEditor` does not cause re-mount of adjacent editors.
3. `TriggerPlugin` (`+`, `@`, `#`) opens popup, focuses input, and closes correctly without focus jumps.
4. Enter and Backspace create/merge blocks correctly.

## Appendix: Why This Is Better Than Option A (Patching)

Option A (patching the current system) requires every new popup, plugin, or focus interaction to be aware of `syncProjection`, `isFocusInsideCompanion`, `pendingFocus`, `blockIdToKeyMap`, `isSyncingRef`, and 28 other pieces of implicit state. It is mathematically impossible to make this consistent.

Option B makes the boundaries explicit:
- **React** owns the block tree, chrome, and virtualization.
- **Lexical** owns inline text formatting inside one block.
- **Runtime** owns hierarchy and persistence.
- **Focus store** owns who has the keyboard.

Each layer has a single, narrow interface to the others. Bugs become local and fixable.
