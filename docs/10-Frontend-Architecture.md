# Frontend Architecture

The frontend is a React 19 single-page application built with TypeScript, Vite, Zustand for state management, and TanStack Query for server-state caching.

---

## Technology Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 19 | UI framework |
| TypeScript | 5+ | Type safety |
| Vite | Latest | Build tool & dev server |
| Zustand | Latest | Client-side state management |
| TanStack Query | Latest | Server-state caching & sync |
| Lexical | Latest | Rich-text editor |
| Axios | Latest | HTTP client |
| @dnd-kit | Latest | Drag & drop |

---

## Directory Structure

```
frontend/src/
├── api/                  # HTTP client + endpoint functions
│   ├── client.ts         # Axios instance (base config, interceptors)
│   ├── nodes.ts          # Node CRUD, search, batch, daily, classes, etc.
│   ├── properties.ts     # Property definitions, values, class properties
│   ├── nodeViews.ts      # NodeView CRUD + query execution
│   ├── activity.ts       # Activity log + link tracking
│   ├── workspaces.ts     # Workspace management + settings
│   ├── assets.ts         # File uploads + URL generation
│   ├── assetTokens.ts    # Short-lived token cache
│   └── auth.ts           # Register, login, token storage
│
├── components/           # React components (see below)
│   ├── core/             # Domain-agnostic atoms
│   ├── blocks/           # Block display (Bullet, NodeInline)
│   ├── nodes/            # Node-level (NodeCollection, PageHeader)
│   ├── properties/       # Property editing
│   ├── queries/          # Query builder UI
│   ├── layout/           # App shell
│   ├── sidebar/          # Right sidebar
│   └── workspace/        # Workspace management
│
├── editor/               # Lexical editor integration
│   ├── BlockEditor.tsx   # Main editor component
│   ├── nodes/            # Custom Lexical nodes
│   ├── plugins/          # 28 editor plugins
│   ├── components/       # Editor-specific UI
│   └── utils/            # Editor utilities
│
├── hooks/                # React hooks
│   ├── useNodes.ts       # Core node query hooks
│   ├── useNodeMutations.ts    # Node mutation hooks
│   ├── useNodeQueries.ts      # Read-only node hooks
│   ├── useProperties.ts       # Property hooks
│   ├── useNodeViews.ts        # View/query hooks
│   ├── queryKeys.ts           # TanStack Query key factory
│   └── ...
│
├── stores/               # Zustand stores
│   ├── appStore.ts       # Navigation, sidebars, view mode
│   ├── settingsStore.ts  # User preferences
│   ├── authStore.ts      # Authentication state
│   └── ...
│
├── types/                # TypeScript definitions
│   └── api.ts            # Node, Property, NodeView interfaces
│
├── utils/                # Utility functions
│   ├── nodeTree.ts       # Tree traversal/manipulation
│   ├── hierarchicalPath.ts  # Path parsing
│   └── ...
│
└── views/                # Top-level view components
    ├── NodeView.tsx       # Pages & blocks (1280 lines)
    ├── JournalsView.tsx   # Daily pages
    ├── AllPagesView.tsx   # All root pages
    └── ...
```

---

## Application Boot Sequence

```
App component mounts
    │
    ├── Check authentication (getAuthToken())
    │   └── No token → Show LoginView
    │
    ├── Fetch workspaces (TanStack Query)
    │   └── No workspace → Show WorkspaceManagementView
    │
    ├── Preload settings
    │   └── fetchQuery() before mounting Layout
    │
    ├── Load favorites & recents
    │
    └── Mount Layout
        ├── TopBar
        ├── NavigationSidebar
        ├── MainContent (view router)
        ├── CommentsSidebar
        └── RightSidebarCards
```

The settings preload is critical — it prevents settings requests from competing with the request flood that occurs when journal views mount.

---

## View Router

The `MainContent` component routes to the correct view based on `mainViewType` from `appStore`:

| View Type | Component | Description |
|-----------|-----------|-------------|
| `node` | `NodeView` | Page or block view |
| `journals` | `JournalsView` | Daily pages list |
| `all-pages` | `AllPagesView` | All root pages |
| `graph` | `AllPagesGraphView` | Force-directed graph |
| `terrain` | `AllPagesTerrainView` | Terrain visualization |
| `timeline` | `AllPagesTimelineView` | Chronological timeline |
| `archived` | `ArchivedPagesView` | Archived pages |
| `trash` | `TrashView` | Deleted nodes |
| `property` | `PropertyView` | Single property view |

---

## Layout Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TopBar                                                 │
│  [≡] [📝 Scratchpad] [Today] [📅] [⚡Quick Add] [🗺️] [▤]  │
├──────────┬──────────────────────────┬───────┬───────────┤
│          │                          │       │           │
│ Navigation│    Main Content          │Comments│  Right   │
│ Sidebar  │                          │Sidebar│  Sidebar  │
│          │  ┌────────────────────┐  │       │           │
│ Journals │  │ NodeView           │  │       │ ┌───────┐ │
│ All Pages│  │ ┌────────────────┐ │  │       │ │Card 1 │ │
│ Graph    │  │ │ Page Header    │ │  │       │ └───────┘ │
│ Terrain  │  │ ├────────────────┤ │  │       │ ┌───────┐ │
│ Timeline │  │ │ Properties     │ │  │       │ │Card 2 │ │
│ Archived │  │ ├────────────────┤ │  │       │ └───────┘ │
│ Trash    │  │ │ Block Content  │ │  │       │           │
│          │  │ ├────────────────┤ │  │       │           │
│ ─────── │  │ │ Query Sections │ │  │       │           │
│ FAVORITES│  │ └────────────────┘ │  │       │           │
│ • Page 1 │  │                    │  │       │           │
│ • Page 2 │  └────────────────────┘  │       │           │
│ ─────── │                          │       │           │
│ RECENTS  │                          │       │           │
│ • Page A │                          │       │           │
│ • Page B │                          │       │           │
│          │                          │       │           │
├──────────┤                          ├───────┤           │
│  resize  │                          │       │  resize   │
└──────────┴──────────────────────────┴───────┴───────────┘
```

Both sidebars are **resizable** with drag handles and min/max constraints.

---

## NodeView: The Core View

`NodeView` (~1280 lines) is the most complex component. It handles both pages and blocks.

### Page View Structure

```
NodeView (page)
├── Banner Image (collapsible, drag-to-upload)
├── Page Header Grid
│   ├── PageHeader (icon + editable title)
│   ├── NodeSelector (classes)
│   ├── NodeSelector (tags)
│   ├── NodeSelector (aliases)
│   ├── NodeSelector (extends — class nodes only)
│   └── Cover Image
├── PropertiesSection
├── ClassPropertiesEditor (class nodes only)
├── NodeContent → NodeCollection (children blocks)
├── QuerySection: Extended By
├── QuerySection: Classed Nodes
├── QuerySection: Child Pages
├── QuerySection: Linked References
├── QuerySection: Unlinked References
└── Footer (created/updated timestamps)
```

### Block View Structure

```
NodeView (block)
├── PropertiesSection
└── FocusedBlockContent → NodeCollection
```

### Return Pattern

`NodeView` returns a `{ header, content }` object — not JSX directly:

```typescript
// NodeView returns:
{ header: <NodeViewWrapper />, content: <NodeViewContent /> }

// Layout renders them in separate scroll contexts:
<FixedBar>{header}</FixedBar>
<ScrollArea>{content}</ScrollArea>
```

### Compact Mode

Used by `JournalsView` — skips properties, backlinks, and query sections for performance.

---

## NodeCollection: The Universal List

`NodeCollection` is the **single component for displaying any collection of nodes**. It dispatches to specialized view renderers:

| View Mode | Renderer | Description |
|-----------|----------|------------|
| `list` | `ListView` | Outliner-style bullets with Lexical |
| `document` | `DocumentView` | Prose-style document |
| `card` | `CardView` | Card grid layout |
| `table` | `TableView` | Spreadsheet with property columns |
| `gantt` | `GanttView` | Gantt chart for date properties |
| `graph` | `GraphView` | Force-directed graph (canvas) |
| `terrain` | `TerrainView` | Contour visualization (canvas) |
| `timeline` | `TimelineView` | Chronological timeline |

```typescript
<NodeCollection
  nodes={nodes}
  viewMode="table"
  editable={true}
  sortable={true}
  pageId={pageId}
  pageUuid={pageUuid}
  tableColumns={columns}
  groupBy="status"
  onNodeClick={handleClick}
/>
```

**Key props:**

| Prop | Type | Description |
|------|------|-------------|
| `nodes` | `Node[]` | Nodes to display |
| `viewMode` | `string` | View rendering mode |
| `editable` | `bool` | Enable editing with `BlockEditor` |
| `sortable` | `bool` | Enable drag-and-drop reordering |
| `groupBy` | `string?` | Group by property name |
| `showClasses` | `bool` | Show class pills on items |
| `maxDepth` | `number?` | Max nesting depth |
| `tableColumns` | `array?` | Property columns for table view |
| `autoCollapse` | `bool` | Auto-collapse at depth level |
| `containerCard` | `bool` | Wrap in Card component |

---

## Core Components

Domain-agnostic building blocks in `components/core/`:

| Component | Purpose |
|-----------|---------|
| `Button` | Variants: primary, ghost, danger. Sizes: sm, md, lg |
| `Card` | Container with elevation (low/medium/high) |
| `Modal` | Overlay dialog (sm/md/lg) |
| `ConfirmationModal` | Danger confirmation |
| `ContextMenu` | Right-click menus |
| `Dropdown` | Select dropdown |
| `TextField` | Text input with label |
| `SearchBox` | Search with results popup |
| `EmojiPicker` | Emoji grid selector |
| `DatePickerPopup` | Calendar date picker |
| `Table` | Styled table |
| `Badge` / `Pill` | Status indicators |
| `Checkbox` / `ToggleSwitch` | Boolean inputs |
| `ListSortable` | Drag-sortable list |
| `ErrorBoundary` | Error recovery |
| `NotificationToast` | Toast messages |

**Rule**: Core components never import from domain components. Domain components import from core.

---

## Command Palette (`Ctrl+K`)

A floating search modal (~914 lines) with rich features:

```
┌──────────────────────────────────────┐
│ 🔍 search query                     │
│                                      │
│ Pages                                │
│   📄 My Page (→ Projects)           │
│   📋 Project Alpha                   │
│                                      │
│ Blocks                               │
│   • Block content preview            │
│                                      │
│ Properties                           │
│   🔤 Priority                        │
│                                      │
│ + Create "search query"              │
└──────────────────────────────────────┘
```

Features:
- Searches all node names with parent hierarchy breadcrumbs
- `@classname` syntax for filtering/creating pages with a specific class
- Date parsing for navigating to journal pages
- Duplicate page detection
- Quick page creation
- Keyboard navigation (arrow keys, Enter, Escape)

---

## Sidebar Components

### Navigation Sidebar (Left)

```
┌──────────────────┐
│ 🏠 Workspace     │
│ ─────────────── │
│ 📅 Journals      │
│ 📄 All Pages     │
│ 🕸️ Graph         │
│ 🏔️ Terrain       │
│ 📊 Timeline      │
│ 📦 Archived      │
│ 🗑️ Trash         │
│ ─────────────── │
│ ⭐ FAVORITES     │
│   📋 Project A   │
│   📝 Notes       │
│ ─────────────── │
│ 🕐 RECENTS       │
│   📄 Page 1      │
│   📄 Page 2      │
└──────────────────┘
```

Favorites support **drag-and-drop reordering** using manual DOM drag events.

### Right Sidebar

Opened by **Shift-clicking** a block bullet. Shows mini node views in cards:

```
┌──────────────────┐
│ ┌──────────────┐ │
│ │ Page A    [×]│ │
│ │              │ │
│ │ • Block 1    │ │
│ │ • Block 2    │ │
│ └──────────────┘ │
│ ┌──────────────┐ │
│ │ Local Graph  │ │
│ │ [○──○──○]    │ │
│ └──────────────┘ │
└──────────────────┘
```

---

## Keyboard Shortcuts

The `keyboardStore` manages a centralized shortcut registry:

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Command Palette |
| `Ctrl+N` | Quick Add |
| `Ctrl+Shift+D` | Calendar |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo (in editor) |
| `Tab` / `Shift+Tab` | Indent / Outdent block |
| `Enter` | New block below |
| `Backspace` (empty) | Delete block, merge with above |
| Arrow keys | Navigate blocks |

### Hook API

```typescript
// Register a handler
useKeyboardShortcut('command-palette', () => openPalette(), { priority: 1 });

// Activate a context
useShortcutContext('editor', isEditing);

// Get display string
const display = useShortcutDisplay('command-palette'); // "Ctrl+K"
```

---

## Settings Modal

```
┌──────────────────────────────────────┐
│ Settings                          [×] │
│                                      │
│ [General] [Appearance] [Account] [About]
│                                      │
│ General:                             │
│   Date Format:  [MMMM D, YYYY ▼]    │
│   Default View: [Journal ▼]          │
│   Quick Add To: [Today ▼]           │
│   Linked Refs:  [Collapse at 2 ▼]   │
│                                      │
│ Appearance:                          │
│   Theme:    [Light] [Dark] [System]  │
│   Font Size: [──●──────]             │
└──────────────────────────────────────┘
```

Settings are persisted both locally (Zustand + localStorage) and remotely (API settings endpoint).

---

## Utility Functions

### Tree Operations (`nodeTree.ts`)

```typescript
// Find in tree
const node = findNodeById(tree, 42);
const node = findNodeByUuid(tree, "abc-123");

// Immutable updates (preserves reference equality for React)
const newTree = updateNodeByIdImmutable(tree, 42, { name: "Updated" });
const newTree = removeNodeFromTreeImmutable(tree, 42);

// Traversal
const flat = flattenNodeTree(tree);
const ids = getAllNodeIds(tree);
const depth = getNodeDepth(tree, 42);
const count = countNodes(tree);
```

### Date Parsing (`dateParser.ts`)

```typescript
const result = parseDate("feb 16");
// → { type: 'day', year: 2026, month: 2, day: 16, label: 'February 16, 2026' }

const result = parseDate("2026");
// → { type: 'year', year: 2026, label: '2026' }
```

### Color Utilities (`color.ts`)

```typescript
const styles = getNodeColorStyles("#4A90D9");
// → { borderColor, backgroundColor (tinted), textColor }

const isLight = isColorLight("#FFFFFF"); // true
```
