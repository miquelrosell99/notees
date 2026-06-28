# Subsystem Reference

Detailed guides for complex subsystems that agents frequently need to understand or modify.

---

## Graph View

**File paths (all under `frontend/src/features/content/components/nodes/views/`):**
- `GraphView.tsx` — Main React component
- `GraphRenderer.tsx` — Canvas wrapper (WebGL + labels overlay)
- `GraphSettingsSidebar.tsx` — Collapsible left sidebar with controls
- `graphWebGLRenderer.ts` — Custom WebGL2 instanced renderer
- `useGraphRenderer.ts` — Hook wiring physics worker ↔ WebGL ↔ interaction
- `graphTypes.ts` / `viewTypes.ts` — `GraphNode`, `GraphLink`, `GraphSettings`, `VisibilityFilters`
- `evaluateQueryAST.ts` — Client-side QueryAST evaluator for color groups
- `sge/` — SGE v2 physics engine (see below)

### Data Flow

```
useGraphNodes()          useGraphLinks(nodeIds, { scope, cooccurrence, contextNodeId })
      │                           │
      ▼                           ▼
apiNodes (prop)            apiLinks (from POST /nodes/links)
      │                           │
      └──► GraphView ◄────────────┘
              │
              ├──► BFS neighborhood filter (when currentNodeId + levels > 1)
              ├──► Visibility filters (node types, link types, orphans)
              ├──► Alias resolution & deduplication
              ├──► Color resolution (explicit → QueryAST groups → tag hash)
              └──► GraphRenderer (WebGL + physics worker)
```

### Backend Endpoints

- `GET /nodes/workspace/nodes` — Returns all workspace pages (no `page_size` limit for graph views)
- `POST /nodes/links` — Returns links between a set of node IDs
  - `scope: 'between'` — both endpoints in the set
  - `scope: 'touching'` — at least one endpoint in the set
  - Link types: `reference`, `parent`, `class`, `extends`, `property-reference`, `cooccurrence`

### Two Usage Modes

| Mode | Source | `currentNodeId` | `localGraphMode` | Link fetching |
|------|--------|-----------------|------------------|---------------|
| **Global graph** | `AllPagesGraphView` | `null` | `false` | All links between all nodes |
| **Local / centered** | `SidebarLocalGraph`, `NodeCollection` graph mode | Set | `true` or `false` | All links between all nodes; BFS filter applied to show neighborhood |

### Neighborhood / Levels Filtering (BFS)

- When `currentNodeId` is set, a **Levels** slider (1–5) appears in `GraphSettingsSidebar`.
- Level 1 = directly linked nodes only.
- Level N = all nodes within N hops via any link type.
- BFS is computed on the frontend from `apiLinks` using `getNeighborhoodNodeIds()` in `GraphView.tsx`.
- Both `sourceNodes` and `sourceLinks` are filtered to the discovered neighborhood before the visibility-filter pipeline runs.
- Persisted per view in `localStorage` under `graph_{viewId}_levels`.

### SGE v2 Physics Engine

`frontend/src/features/content/components/nodes/views/sge/`

Modular replacement for the original monolithic SemanticGraphEngine. Uses Structure-of-Arrays (SoA) typed arrays and a force-plugin API.

| Module | Purpose |
|--------|---------|
| `engine.ts` | Orchestrator: SoA buffers, composes forces, runs integration loop |
| `types.ts` | `SGEPhysicsConfig`, `SGEConfig`, `SGEEdge`, `SGEState` |
| `config.ts` | `GraphSettings` → raw numeric `SGEConfig` translation |
| `spatialHash.ts` | Robin Hood typed-array spatial hash (local repulsion queries) |
| `barnesHut.ts` | Pool-based Barnes–Hut quadtree (cluster repulsion) |
| `integrator.ts` | Velocity Verlet + adaptive timestep |
| `forces/springs.ts` | Edge springs (per-type rest length & stiffness) |
| `forces/localRepel.ts` | Short-range node-node repulsion via spatial hash |
| `forces/clusterCohesion.ts` | Shell-model community cohesion |
| `forces/clusterRepulsion.ts` | Barnes–Hut / direct O(K²) cluster repulsion |
| `forces/radialStability.ts` | Prevents expansion drift within clusters |
| `forces/componentBubble.ts` | Connected-component bounding bubbles |
| `forces/centerGravity.ts` | Global center gravity + isolate soft wall |

### Worker Protocol (main ↔ sgeWorker.ts)

- `init` — full topology + config (creates or reuses engine)
- `setTopology` — incremental topology update
- `setConfig` — live physics parameter update
- `dragStart` / `dragMove` / `dragEnd` — node drag interaction
- `pause` / `resume` — stop/start tick loop
- `destroy` — clean up and terminate

**SharedArrayBuffer path:** When `crossOriginIsolated` is true, the worker writes positions into a SAB each tick and signals via `Atomics.load(meta, META_SEQ)`. The main thread polls in its RAF loop — zero per-frame `postMessage` overhead.

**Transferable fallback:** When SAB is unavailable, the worker posts a `Float32Array` of positions each tick via transferable (zero-copy).

### Color Resolution Pipeline

Evaluated per node during `useMemo`:
1. Explicit `node.properties.color`
2. **QueryAST color groups** — first matching group wins; groups are ordered by priority
3. Tag hash fallback (`getTagColor(tag)` — deterministic 8-color palette)
4. Renderer default color

### Key Files

| File | Purpose |
|------|---------|
| `GraphView.tsx` | Main component: state, sidebar, filters, color resolution, BFS neighborhood |
| `GraphRenderer.tsx` | Canvas wrapper: handles events, labels, keyboard shortcuts |
| `GraphSettingsSidebar.tsx` | Sidebar UI: physics, visibility, style, levels slider, groups |
| `graphWebGLRenderer.ts` | WebGL2 renderer: instanced nodes, glow, edges, picking |
| `sgeWorker.ts` | Web Worker entry point: thin wrapper around SGEEngine |
| `evaluateQueryAST.ts` | Client-side QueryAST evaluator for group coloring |
| `GraphGroupModal.tsx` | Modal for creating/editing QueryAST color groups |
| `graphTypes.ts` | `GraphNode`, `GraphLink`, `GraphColorGroup`, `GraphSettings` types |
| `graphConstants.ts` | Physics & rendering constants (forces, LOD, radii, dashes) |
| `graphHelpers.ts` | Radius calc, path finding, render skip, deduplication |
| `graphColoring.ts` | Palette resolution, hex→rgba, node color lookup |
| `viewTypes.ts` | Barrel re-export (backward compat) |

### Adding a New Graph Setting

1. Add to `GraphSettings` in `graphTypes.ts`
2. Add UI control in `GraphSettingsSidebar.tsx`
3. Persist via `setSetting('graph_settings', ...)`
4. If the setting affects physics, wire it through `buildSGEPhysicsConfig()` in `GraphView.tsx`

### Adding a New Graph Filter or Data-Mode Control

1. If it needs backend data, extend `LinksRequest` / `LinksResponse` in `app/features/nodes/models.py` and the endpoint in `app/features/nodes/router.py` (search routes)
2. Update `frontend/src/api/nodes.ts` and `frontend/src/hooks/useNodeGraphQueries.ts` to expose the new parameter
3. Add state + persistence logic in `GraphView.tsx` (localStorage key pattern: `graph_{viewId}_{key}`)
4. Apply the filter in the main `useMemo` that builds `nodes` and `links`
5. Add UI control in `GraphSettingsSidebar.tsx` inside the appropriate section

---

## QueryAST Client-Side Evaluation

The `evaluateQueryAST.ts` module lets you evaluate QueryAST queries against local node data without hitting the backend. This powers graph color groups and can be reused for any client-side filtering.

### Supported Conditions

| Condition | Evaluates Against | Notes |
|-----------|------------------|-------|
| `class` | `node.class_ids` | Supports `is`/`is_not`/`contains`/`defined`/`not_defined` |
| `extends` | Class hierarchy | Uses `classDescendants` map from `useClasses()` |
| `property` | `node.properties[name]` | All property operators (equals, contains, gte, etc.) |
| `content` | `nodeNameToText(node.name)` | String matching: contains, starts_with, regex, fts |
| `page` | `node.type === 'page'` | — |
| `parent` | `GraphLink[]` with `type === 'parent'` | Static (specific parent IDs) or dynamic (nested group) |
| `parent_path` | Transitive parent closure | Pre-computed via `buildTransitiveClosure()` |
| `child` / `child_path` | Inverse of parent | Same patterns as parent |
| `reference` | `GraphLink[]` with `type === 'reference'` | — |
| `reference_path` | Direct references only | Transitive reference closure not pre-computed |
| `style` | — | Returns `false` (content AST not available client-side) |

### Usage

```typescript
import { evaluateQueryAST, buildEvalContext } from './evaluateQueryAST';

const ctx = buildEvalContext(nodes, links, classes);
const matches = nodes.filter(n => evaluateQueryAST(queryAST, n, ctx));
```

### Context Pre-computation

- `parentMap`, `childMap`, `referenceMap` — built from `GraphLink[]` in O(links)
- `transitiveParentMap`, `transitiveChildMap` — BFS closures in O(nodes × avg_depth)
- `classDescendants` — class hierarchy map from `useClasses()` data

### Limitations

- Structural conditions (parent, child, reference) only see **visible links**. If a parent is not in the `apiLinks` array, the child won't match.
- `style` conditions always return `false`.
- `reference_path` does not compute transitive reference closures.

---

## Block Editor (Lexical)

There are **two editor architectures** in the codebase. The new per-block editor is active; the old monolithic editor is deprecated but retained for rollback safety.

### New Architecture: Per-Block Editor (Active)

Each block gets its own minimal `LexicalComposer` instance. React owns the block tree (hierarchy, depth, drag-and-drop, selection); Lexical owns only inline text inside a single block.

**Component Hierarchy:**
```
NodeCollectionView / NodeView
  └── BlockList (React: flatten tree, keyboard routing, container hooks)
        └── BlockRow (React: bullet, inline editor, after-content, context menu)
              ├── BlockUI (React: bullet, collapse arrow, icon)
              ├── InlineEditor (LexicalComposer: ParagraphNode + TextNode + InlineLinkNode + MathNode)
              │     ├── CustomCaretPlugin
              │     ├── InlineEditorKeysPlugin
              │     ├── InlineCopyPastePlugin
              │     ├── FloatingToolbarPlugin
              │     ├── NodeLinkPlugin
              │     ├── TriggerPlugin
              │     └── HistoryPlugin
              └── BlockAfterContent (React: property previews, class pills)
```

**Key New Files:**

| File | Purpose |
|------|---------|
| `frontend/src/components/blocks/BlockList.tsx` | Static list container. Flattens tree, wires drag/selection/touch-indent hooks, handles keyboard routing (Enter/Backspace/Delete/Tab/Arrows). |
| `frontend/src/components/blocks/BlockRow.tsx` | Single block row. Composes `BlockUI` + `InlineEditor` + `BlockAfterContent` + `NodeContextMenu`. |
| `frontend/src/components/blocks/BlockUI.tsx` | Non-editable chrome: bullet, icon, collapse arrow. |
| `frontend/src/editor/InlineEditor.tsx` | Minimal Lexical instance per block. Exposes imperative `focus`/`blur`/`getCursorPosition`/`getCursorOffset`. |
| `frontend/src/stores/editorFocusStore.ts` | Zustand store for active block tracking and cross-block keyboard navigation. |
| `frontend/src/hooks/useBlockDragDrop.ts` | DOM-based drag-and-drop on `.node-block[data-block-id]` selectors (replaces `DragDropPlugin`). |
| `frontend/src/hooks/useBlockSelection.ts` | Mouse drag-to-select + shift+arrow keyboard selection (replaces `BlockDragSelectionPlugin` + `KeyboardSelectionPlugin`). |
| `frontend/src/hooks/useTouchIndent.ts` | Horizontal swipe on bullet for indent/outdent (replaces `TouchIndentPlugin`). |
| `frontend/src/editor/plugins/InlineEditorKeysPlugin.tsx` | Per-block Enter/Backspace/Delete/Tab handlers. |
| `frontend/src/editor/plugins/InlineCopyPastePlugin.tsx` | Per-block copy (`[[uuid]]`) and paste (link pills, internal block paste). |

**Mutation Flow:**
```
User types in InlineEditor
  → OnChangePlugin → extractInlineContent() → ContentAST
  → handleContentChange callback
  → runtime.applyIntent({ type: 'update_content', blockId, contentAST })
  → onContentChangeCallback → parent component
  → API PATCH /api/nodes/{id} with JSON AST
```

**Known Deferred Items:**
- **Cross-block undo/redo**: Each `InlineEditor` has an isolated `HistoryPlugin`. Unified undo across merge/split/create is not yet implemented.

### Old Architecture: Monolithic Editor (Deprecated)

A single `LexicalComposer` instance spanned the entire page. The block hierarchy was projected into Lexical as custom `BlockNode` elements via `BlockPlugin.syncProjection`.

**Legacy Files (unused, retained for rollback):**
- `frontend/src/editor/BlockEditor.tsx`
- `frontend/src/editor/plugins/BlockPlugin.tsx`
- `frontend/src/editor/plugins/BlurOnClickOutsidePlugin.tsx`
- `frontend/src/editor/plugins/VirtualizationPlugin.tsx`
- `frontend/src/editor/plugins/useBlockPluginCommands.ts`
- `frontend/src/editor/plugins/EmptyClickPlugin.tsx`
- `frontend/src/editor/plugins/DragDropPlugin.tsx`
- `frontend/src/editor/plugins/BlockDragSelectionPlugin.tsx`
- `frontend/src/editor/plugins/KeyboardSelectionPlugin.tsx`
- `frontend/src/editor/plugins/TouchIndentPlugin.tsx`

**Custom Nodes (still shared with new editor):**

| Node | Extends | Purpose |
|------|---------|---------|
| `BlockNode` | `ElementNode` | Fundamental block unit. Stores `blockId`, `depth`, `collapsed`, `nodeType`, `hasChildren`, `icon`, `color`, `classIds`. DOM is a flex wrapper with bullet, content slot, and portal targets. |
| `InlineLinkNode` | `DecoratorNode` | Atomic inline pill referencing a node, class, URL, or embed. Renders via React portal. |
| `BlockHeadingNode` | `BlockNode` | Header variant (`<h1>`/`<h2>`/`<h3>`). |
| `BlockCodeNode` | `BlockNode` | Code block (`<pre><code>`) with optional `language`. |
| `BlockTableCellNode` | `BlockNode` | Table cell with mini-editor inside. |

**Content AST Format:**

Block content is stored as JSON AST in `node.name`. The canonical builder/stringifier are:
- `frontend/src/lib/astBuilder.ts` — `parseAST(input, mode)` with modes: `JSON`, `PLAIN`, `MARKDOWN`
- `frontend/src/lib/stringifyAST.ts` — Stringifier with modes: `NODE_MARKDOWN`, `PLAIN_MARKDOWN`, `TEXT_ONLY`
- `app/domain/stringify_ast.py` — Backend mirror

---

## Service Worker / PWA

The PWA uses **`vite-plugin-pwa`** with auto-generated Workbox service workers. There is **no custom service worker source code** in `frontend/src/`.

### Cache Strategies

| Resource | Strategy | Details |
|----------|----------|---------|
| SPA shell + static assets | **Precache** | JS/CSS/HTML/icons at SW install time. Hashed chunks use `revision: null`. |
| API responses (`/api/*`) | **NetworkFirst** | 3-second timeout. Falls back to `api-cache` (100 entries, 5-min TTL). |
| WASM (`sql-wasm.wasm`) | **CacheFirst** | 30-day TTL. Excluded from precache (~660 KB). |
| Navigation | **Fallback to index.html** | SPA routing works offline. |

### Update Flow

- `registerType: 'autoUpdate'` — new SW installs silently.
- `skipWaiting()` + `clientsClaim()` — activates immediately on next visit.
- **No user-facing update prompt.** Updates are automatic and silent.

### Current Offline State

- ✅ App shell loads offline
- ✅ Recent API calls may be served from cache (5-min window)
- ❌ No persistent offline data layer (TanStack Query cache is not persisted to IndexedDB)
- ❌ No `navigator.onLine` checks or offline UI states
- ❌ `offlineMode` feature flag exists but is disabled and unused

**Key Config:** `frontend/vite.config.ts` → `VitePWA({ ... })`

---

## Asset Upload System

Assets are **nodes with `is_asset=TRUE`** and the `asset` system class. There is no separate `asset` database table.

### Upload Flow

```
Frontend (drag/paste/slash command)
  → POST /api/assets/upload (multipart/form-data, max 50 MB)
  → Backend validates MIME type + magic bytes
  → AssetService writes to disk atomically (temp → rename)
  → Creates/updates node with is_asset=TRUE + asset class
  → Generates WebP thumbnail (images only, async thread pool)
```

### Disk Layout

```
data/workspaces/{workspace_uuid}/
  └── assets/
        └── {asset_uuid}/
              ├── main.{ext}      # original file
              └── thumbnail.webp  # generated thumbnail (images)
```

### Key API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/assets/upload` | Upload file |
| `GET` | `/api/assets/{uuid}` | Download file (auth via `asset_token` query param or Authorization header) |
| `GET` | `/api/assets/{uuid}/thumbnail` | Download WebP thumbnail |
| `GET` | `/api/assets/{uuid}/info` | Metadata |
| `POST` | `/api/assets/{uuid}/token` | Generate 5-min JWT token for secure URLs |
| `DELETE` | `/api/assets/{uuid}` | Delete asset node + folder |

### Frontend Components

- `AssetUploadModal.tsx` — Drag/drop/paste upload modal
- `FileDropZone.tsx` — Reusable dropzone UI
- `ImageNode.tsx` — Displays image assets
- `assetTokens.ts` — Short-lived token cache

### Gotchas

- Asset storage uses folders (`{uuid}/main.{ext}`). Deletion flows through `app/features/assets/service.py`, which removes the whole folder.
