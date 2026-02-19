# Editor & Block System

The Notees editor is built on [Lexical](https://lexical.dev/) and treats content as a **tree of blocks**, each containing rich text. The editor projects this tree into a flat editing surface while preserving hierarchy through indentation.

---

## Block Hierarchy

Content is stored as a tree of nodes, where each child node is a "block":

```
Page: "My Notes" (is_page=true)
├── Block: "Introduction paragraph" (sequence=0)
├── Block: "Key Points" (sequence=1)
│   ├── Block: "Point one" (sequence=0)    ← indented
│   ├── Block: "Point two" (sequence=1)
│   └── Block: "Point three" (sequence=2)
├── Block: "Conclusion" (sequence=2)
└── Block: "" (sequence=3)                  ← empty block for typing
```

Each block's `name` field contains a **JSON AST** (Abstract Syntax Tree) with rich-text content:

```json
{
  "root": {
    "children": [
      {
        "type": "paragraph",
        "children": [
          { "text": "Hello " },
          { "text": "world", "format": 1 },
          { "text": "!" }
        ]
      }
    ]
  }
}
```

---

## BlockEditor Component

`BlockEditor.tsx` is the main editor component — a single Lexical editor instance that renders the **entire block hierarchy** as a flat list with depth metadata.

### Architecture

```
BlockEditor
├── Lexical Editor State
│   └── Flat list of BlockNodes (with depth)
├── NodeGraphRuntime (manages block tree)
├── 28 Plugins (rich editing features)
├── useStructureSync() (syncs runtime → editor)
└── useBlockPersist() (persists to backend)
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `nodes` | `Node[]` | Block tree from API |
| `rootBlockId` | `number?` | Root block for slice projection |
| `pageId` | `number` | Parent page ID |
| `pageUuid` | `string` | Parent page UUID |
| `mode` | `'list' \| 'document'` | Display mode |
| `readOnly` | `bool` | Disable editing |
| `onContentChange` | `fn` | Content change callback |
| `onNavigateToNode` | `fn` | Link click handler |
| `onAddClass` | `fn` | Inline class handler |
| `canIndent` | `fn` | Structural guard |
| `canOutdent` | `fn` | Structural guard |
| `canMerge` | `fn` | Structural guard |
| `canDelete` | `fn` | Structural guard |

### Display Modes

| Mode | Appearance | Use Case |
|------|-----------|----------|
| `list` | Bullets + indent levels | Default outliner view |
| `document` | Prose paragraphs (no bullets) | Document/writing view |

Card mode uses **separate editor instances** per card item.

---

## Custom Lexical Nodes

The editor defines custom Lexical node types:

### BlockNode

The primary content unit. Each `BlockNode` represents one block in the tree:

```typescript
class BlockNode extends ElementNode {
  __depth: number;        // Nesting level (0 = root)
  __blockId: string;      // Maps to Node.uuid
  __isCollapsed: boolean; // Whether children are hidden
  __classIds: number[];   // Inline class assignments
  __icon: string | null;  // Block emoji icon
}
```

### InlineLinkNode

Inline reference displayed as a clickable link:

```
See [[📄 My Page]] for details.
     └─── InlineLinkNode ───┘
```

```typescript
class InlineLinkNode extends DecoratorNode {
  __targetUuid: string;
  __linkUuid: string;
  __displayText: string;
}
```

### Other Node Types

| Node | Purpose |
|------|---------|
| `BlockHeadingNode` | Heading blocks (H1-H6) |
| `BlockCodeNode` | Code blocks with syntax highlighting |
| `BlockTableCellNode` | Table cell blocks |

---

## Editor Plugins (28 total)

The editor's functionality is decomposed into plugins:

### Core Editing

| Plugin | Purpose |
|--------|---------|
| `BlockPlugin` | Block creation, deletion, merging |
| `NodeLinkPlugin` | `[[` trigger for link creation |
| `FormattingPlugin` | Bold, italic, underline, strikethrough |
| `TriggerPlugin` | `/` slash commands for block types |
| `EditablePlugin` | Toggle read-only mode |

### Selection & Navigation

| Plugin | Purpose |
|--------|---------|
| `SelectionPlugin` | Text selection management |
| `KeyboardSelectionPlugin` | Arrow key navigation between blocks |
| `SelectionConstraintPlugin` | Prevent selection across block boundaries |
| `BlockDragSelectionPlugin` | Multi-block selection by dragging |
| `CustomCaretPlugin` | Custom caret rendering |

### Structural

| Plugin | Purpose |
|--------|---------|
| `CollapsePlugin` | Block collapse/expand |
| `DragDropPlugin` | Block drag-and-drop reordering |
| `VirtualizationPlugin` | Render only visible blocks (performance) |

### UI

| Plugin | Purpose |
|--------|---------|
| `FloatingToolbarPlugin` | Floating formatting toolbar on text selection |
| `ContextMenuPlugin` | Right-click context menu |
| `BlurOnClickOutsidePlugin` | Deselect block on outside click |
| `BlockClassPillsPlugin` | Show class pills on blocks |
| `BlockPropertyIconsPlugin` | Show property icons on blocks |
| `TaskCyclePlugin` | Cycle task status on click |

---

## Block Lifecycle

### Creation (Optimistic)

When the user presses Enter to create a new block:

```
1. User presses Enter
   │
2. BlockPlugin creates new BlockNode in Lexical state
   │
3. NodeGraphRuntime records the new block (no serverId yet)
   │
4. useBlockPersist detects unpersisted block
   │
5. Resolves parent's serverId (waits if parent also new)
   │
6. POST /api/nodes/ with serialized AST
   │
7. Receives server ID → writes back to runtime
   │
8. Flushes queued content saves waiting on this serverId
   │
9. Recursively persists children waiting on this parent
```

### Content Update

Block content changes are debounced and saved:

```
1. User types text
   │
2. Lexical fires content change
   │
3. useContentSave debounces (300ms)
   │
4. Serializes content AST → JSON string
   │
5. PUT /api/nodes/{id} with new name
   │
6. Backend re-parses links from AST
   │
7. Updates NodeLink records
```

### Deletion

```
1. User presses Backspace on empty block (or selects + deletes)
   │
2. Block removed from Lexical state
   │
3. NodeGraphRuntime fires 'block_deleted' event
   │
4. useBlockPersist batches delete UUIDs via microtask
   │
5. DELETE /api/nodes/batch { uuids: [...] }
   │
6. Optimistically removed from TanStack Query cache
```

### Moving (Indent/Outdent)

| Action | Key | Effect |
|--------|-----|--------|
| Indent | `Tab` | Move block under previous sibling |
| Outdent | `Shift+Tab` | Move block to parent's parent |
| Drag | Mouse drag | Move to any position |

All moves are validated against structural guards:

```typescript
// Slice guards prevent breaking page boundaries
const guards = createSliceGuards(projectionRootIds);

guards.canIndent(blockId);   // Can this block become a child?
guards.canOutdent(blockId);  // Can this block move up a level?
guards.canMerge(blockId);    // Can this block merge with above?
guards.canDelete(blockId);   // Can this block be deleted?
```

---

## Bullet Component

The `Bullet` component is the visual anchor for each block:

```
┌─ Bullet ─┐
│  ▸ •     │ ← Collapse arrow + dot
└──────────┘
  │  │
  │  └── Dot: click to focus, right-click for context menu
  └───── Arrow: click to collapse/expand children
```

**Interaction modes:**
- **Click**: Focus on this block
- **Shift+Click**: Open in right sidebar
- **Right-click**: Context menu
- **Drag**: Start block drag

**Visual states:**
- Outer ring when collapsed with children
- Optional emoji icon instead of dot
- Sizes: `xs`, `sm`, `md`

---

## Rich Text Features

### Inline Formatting

| Format | Shortcut | AST Attribute |
|--------|----------|--------------|
| **Bold** | `Ctrl+B` | `format: 1` |
| *Italic* | `Ctrl+I` | `format: 2` |
| <u>Underline</u> | `Ctrl+U` | `format: 8` |
| ~~Strikethrough~~ | `Ctrl+Shift+S` | `format: 4` |

### Floating Toolbar

Selecting text shows a floating toolbar:

```
                ┌──────────────────────┐
Selected text → │ B  I  U  S  🔗  📝  │
                └──────────────────────┘
```

### Links (`[[...]]`)

Typing `[[` triggers the `NodeLinkPlugin`:

```
1. User types [[
   │
2. Search popup opens
   │
3. User types/selects a target page
   │
4. InlineLinkNode inserted in editor
   │
5. Content saved → NodeLink created on backend
```

### Slash Commands

Typing `/` triggers the `TriggerPlugin`:

```
┌─────────────────────┐
│ / heading 1         │
│   Heading 2         │
│   Heading 3         │
│   Code Block        │
│   Quote             │
│   Todo              │
│   Table             │
└─────────────────────┘
```

---

## Virtualization

For long pages with many blocks, the `VirtualizationPlugin` renders only visible blocks:

```
┌──────────── viewport ─────────────┐
│                                   │
│  [spacer: 500px]  ← hidden above │
│                                   │
│  • Visible block 1                │
│  • Visible block 2                │
│  • Visible block 3                │
│  ...                              │
│                                   │
│  [spacer: 300px]  ← hidden below │
│                                   │
└───────────────────────────────────┘
```

This dramatically improves performance for pages with hundreds of blocks.

---

## Content Serialization

Block content is serialized between the Lexical editor state and the JSON AST format:

```typescript
// Lexical → JSON string (for API)
const json = serializeContentAST(lexicalEditorState);

// JSON string → Lexical (on load)
// BlockEditor parses the JSON AST and creates BlockNodes
```

### AST Example

```json
{
  "root": {
    "children": [
      {
        "type": "paragraph",
        "children": [
          { "text": "This is " },
          { "text": "bold", "format": 1 },
          { "text": " and " },
          {
            "type": "pill",
            "target": "page-uuid",
            "linkUuid": "link-uuid",
            "children": [{ "text": "linked page" }]
          },
          { "text": " text." }
        ]
      }
    ]
  }
}
```

---

## NodeGraphRuntime

The `NodeGraphRuntime` bridges the block tree data model with the Lexical editor:

```
API Data (Node tree)
      ↓
NodeGraphRuntime (manages graph of blocks)
      ↓ events (structure_changed, nodes_changed, block_deleted)
      ↓
useStructureSync() (syncs to Lexical)
      ↓
Lexical Editor State (flat BlockNode list)
```

Events:
- `structure_changed`: Block added, removed, or moved
- `nodes_changed`: Block content updated
- `block_deleted`: Block permanently removed

`useBlockPersist()` listens to these events and syncs changes to the backend API.

---

## Multi-Block Selection

The `BlockDragSelectionPlugin` and `KeyboardSelectionPlugin` support selecting multiple blocks:

- **Drag select**: Click and drag across multiple blocks
- **Shift+Arrow**: Extend selection with keyboard
- **Ctrl+A**: Select all blocks

Selected blocks can be:
- Cut/copied to clipboard
- Deleted together
- Indented/outdented together
- Dragged to a new position

---

## Table Blocks

Tables in Notees are block-based — each cell is a block node:

```
Block: "Table" (class: table)
├── Block: "Row 1" (class: table-row)
│   ├── Block: "Cell 1,1" (class: table-cell)
│   └── Block: "Cell 1,2" (class: table-cell)
└── Block: "Row 2"
    ├── Block: "Cell 2,1"
    └── Block: "Cell 2,2"
```

When deleting a table cell, a replacement empty cell is automatically created to maintain table structure.
