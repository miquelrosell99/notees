# State Management

Notees uses a **dual state management** approach:

- **Zustand** — Client/UI state (7 stores)
- **TanStack Query** — Server/async state (5 query key namespaces, 50+ hooks)

---

## Architecture Overview

```
┌─────────────────────────────────┐
│        React Components         │
├────────────────┬────────────────┤
│  Zustand       │  TanStack      │
│  Stores        │  Query         │
│                │                │
│  • UI state    │  • Server data │
│  • Preferences │  • Caching     │
│  • Auth        │  • Mutations   │
│  • Shortcuts   │  • Optimistic  │
│                │    updates     │
├────────────────┴────────────────┤
│          localStorage           │
│  (persisted stores)             │
└─────────────────────────────────┘
```

### Global Query Client Configuration

```typescript
// lib/queryClient.ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,         // 5 minutes
      refetchOnWindowFocus: false,
      retry: 1,                          // no retry on 401/403
    },
    mutations: {
      retry: 0,
      onError: (error) => {
        useNotificationStore.getState().error('Error', error.message);
      }
    }
  }
});
```

---

## Zustand Stores

### 1. `useAppStore` — Central UI State

The primary store for navigation, layout, and view management.

**Persisted fields** (key: `'notees-node-view-modes'`): `nodeViewModes`, `cardLayout`, `cardSize`, `contentDisplayMode`

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `activeNode` | `Node \| null` | `null` | Currently selected node |
| `activeNodeId` | `number \| null` | `null` | Active node ID |
| `currentNodeId` | `number \| null` | `null` | Node being viewed |
| `sidebarOpen` | `boolean` | `true` | Left sidebar visibility |
| `rightSidebarOpen` | `boolean` | `false` | Right sidebar visibility |
| `isSidebarCollapsed` | `boolean` | `false` | Sidebar collapsed state |
| `sidebarTab` | `'pages' \| 'graph'` | `'pages'` | Active sidebar tab |
| `rightSidebarContent` | `'node' \| 'localGraph' \| 'activity' \| null` | `null` | Right sidebar mode |
| `sidebarCards` | `SidebarCard[]` | `[]` | Right sidebar card stack |
| `viewMode` | `'default' \| 'focus' \| 'zen'` | `'default'` | Layout display mode |
| `mainViewType` | `MainViewType` | `'node'` | Main content type |
| `contentDisplayMode` | `'document' \| 'bullet' \| 'card'` | `'bullet'` | Block display style |
| `cardLayout` | `string` | `'no-cover'` | Card cover position |
| `cardSize` | `1-5` | `3` | Card grid columns |
| `isCommandPaletteOpen` | `boolean` | `false` | Command palette visibility |
| `isQuickAddOpen` | `boolean` | `false` | Quick add dialog |
| `isCalendarOpen` | `boolean` | `false` | Calendar modal |
| `nodeViewModes` | `Record<number, ViewMode>` | `{}` | Per-node view overrides |

`MainViewType` values: `'node'`, `'all-pages'`, `'journals'`, `'graph'`, `'terrain'`, `'timeline'`, `'archived'`, `'trash'`, `'assets'`, `'property'`

**Key actions**: `openNode(id)`, `openNodeInSidebar(id, type)`, `toggleSidebar()`, `setMainViewType(type)`, `openPropertyView(id)`, `addSidebarCard(card)`, `setNodeViewMode(nodeId, mode)`

---

### 2. `useAuthStore` — Authentication

**Persisted** (key: `'auth-storage'`), only `user` and `token` fields.

| Field | Type | Default |
|-------|------|---------|
| `user` | `User \| null` | `null` |
| `token` | `string \| null` | `null` |
| `isAuthenticated` | `boolean` | `false` (derived) |
| `isLoading` | `boolean` | `false` |
| `error` | `string \| null` | `null` |

**Actions**: `login(username, password)`, `register(username, password)`, `logout()`, `setUser(user)`, `clearError()`

---

### 3. `useSettingsStore` — User Preferences

**Persisted** (key: `'notees-settings'`).

| Field | Type | Default |
|-------|------|---------|
| `theme` | `'light' \| 'dark' \| 'system'` | `'system'` |
| `dateFormat` | `DateFormat` | `'YYYY/MM/DD'` |
| `defaultView` | `string` | `'journal'` |
| `showDailyNotes` | `boolean` | `true` |
| `quickAddDestination` | `'inbox' \| 'today'` | `'today'` |
| `linkedRefsCollapseLevel` | `number` | `1` |

Listens to `prefers-color-scheme` media query for system theme. Exports helpers: `applyTheme()`, `formatDate()`, `formatMonth()`, `formatYear()`, `parseFormattedDate()`.

---

### 4. `useFavoritesStore` — Favorites & Recents

**Not persisted** — data comes from the API.

| Field | Type | Default |
|-------|------|---------|
| `favorites` | `FavoriteItem[]` | `[]` |
| `recents` | `RecentItem[]` | `[]` |

All mutations use **optimistic updates** with rollback on error:

```typescript
addFavorite(nodeId) {
  const prev = get().favorites;
  set({ favorites: [...prev, { nodeId }] }); // optimistic
  try {
    await api.addFavorite(nodeId);
  } catch {
    set({ favorites: prev }); // rollback
  }
}
```

---

### 5. `useNotificationStore` — Toast System

**Not persisted.** Provides toast notifications.

```typescript
interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  duration?: number;     // default: 4000ms, errors: 6000ms
  dismissible?: boolean;
  action?: { label: string; onClick: () => void };
}
```

Convenience methods: `success(title)`, `error(title)`, `warning(title)`, `info(title)`

Auto-removed after duration unless `duration === 0`. Used by TanStack Query's global `onError` handler.

---

### 6. `useFeatureFlagStore` — Feature Toggles

**Persisted** (key: `'notees-feature-flags'`), only user-toggleable flags.

15 flags: `graphView`, `newEditor`, `blockComments`, `aiAssist`, `darkMode`, `offlineMode`, `collaborativeEditing`, `propertyInheritance`, `advancedQueries`, `customThemes`, `importExport`, `keyboardShortcutsPanel`, `blockTemplates`, `typeInheritance`, `debugMode`

Flag sources (priority order):
1. URL parameters: `?ff_flagName=true`
2. Environment variables: `VITE_FEATURE_*`
3. Default values

Flags support **dependency chains**: e.g., `collaborativeEditing` depends on `offlineMode`.

```typescript
// Usage
const isEnabled = useFeatureFlag('graphView');
```

---

### 7. `useKeyboardStore` — Keyboard Shortcuts

**Persisted** (key: `'notees-keyboard-shortcuts'`), only `customShortcuts`.

28 default shortcuts across 4 contexts: `global`, `editor`, `selection`, `navigation`.

```typescript
// Register a handler
const unregister = useKeyboardStore.getState()
  .registerHandler('toggle-sidebar', myHandler, priority);

// Check shortcut
const shortcut = useKeyboardStore.getState().getShortcut('toggle-sidebar');
```

Runtime state (not persisted): `handlers` (Map), `activeContexts` (Set), `disabled` flag.

---

## TanStack Query — Query Key Factory

All query keys are defined in a factory pattern for consistency:

### `nodeKeys`

```typescript
nodeKeys.all                 // ['nodes']
nodeKeys.lists()             // ['nodes', 'list']
nodeKeys.list(filters)       // ['nodes', 'list', {filters}]
nodeKeys.details()           // ['nodes', 'detail']
nodeKeys.detail(id, opts)    // ['nodes', 'detail', id, options]
nodeKeys.detailBase(id)      // ['nodes', 'detail', id]  ← for invalidation
nodeKeys.byUuid(uuid)        // ['nodes', 'uuid', uuid]
nodeKeys.pageContent(id)     // ['nodes', 'page-content', id]
nodeKeys.backlinks(id)       // ['nodes', 'backlinks', id]
nodeKeys.linkedRefs(id)      // ['nodes', 'linked-refs', id]
nodeKeys.daily(date)         // ['nodes', 'daily', date]
nodeKeys.monthly(y, m)       // ['nodes', 'monthly', year, month]
nodeKeys.search(q, filters)  // ['nodes', 'search', query, classFilters]
nodeKeys.pages(opts)         // ['nodes', 'pages', options]
nodeKeys.classes()           // ['nodes', 'classes']
nodeKeys.graph()             // ['nodes', 'graph']
nodeKeys.breadcrumbs(id)     // ['nodes', 'breadcrumbs', id]
nodeKeys.batchProperties(ids)// ['nodes', 'batch-properties', ...sortedIds]
```

### `propertyKeys`

```typescript
propertyKeys.all             // ['properties']
propertyKeys.list(type?)     // ['properties', 'list', {type}]
propertyKeys.detail(id)      // ['properties', 'detail', id]
propertyKeys.forClass(id)    // ['properties', 'class', classId]
propertyKeys.forClassInherited(id) // ['properties', 'class-inherited', classId]
propertyKeys.classExtends(id)      // ['properties', 'class-extends', classId]
```

### `commentKeys`, `activityKeys`, `settingsKeys`, `nodeViewKeys`

```typescript
commentKeys.forNode(nodeId)  // ['comments', 'node', nodeId]
commentKeys.count(nodeId)    // ['comments', 'count', nodeId]

activityKeys.forNode(nodeId) // ['activity', 'node', nodeId]
activityKeys.linkClicks(src) // ['activity', 'link-clicks', sourceNodeId]

settingsKeys.all             // ['settings']

nodeViewKeys.list(nodeId)    // ['nodeViews', 'list', nodeId]
nodeViewKeys.queryResult(id) // ['nodeViews', 'queryResults', viewId]
```

### `detailBase` vs `detail` Usage

```typescript
// Querying — include options for data shape
useQuery({
  queryKey: nodeKeys.detail(id, { include_children: true }),
  queryFn: () => getNode(id, { include_children: true })
});

// Invalidating — match ALL queries for this node
queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(id) });
```

---

## Per-Hook `staleTime` Configuration

Different data types have different freshness needs:

| Hook | staleTime | Notes |
|------|-----------|-------|
| Default | **5 minutes** | Global default |
| `useNode` | 5 min | `structuralSharing: false` |
| `useNodeMetadata` | **10 minutes** | Lightweight metadata |
| `usePageContent` | 5 min | `structuralSharing: false` |
| `useCommentCount` | **30 seconds** | Frequently changing |
| `useBatchPropertyValues` | **30 seconds** | |
| `useLinkClicks` | **60 seconds** | |
| `useNodeViewQuery` | **30 seconds** | |
| `useVirtualizedQuery` | **0 (always stale)** | Ad-hoc queries |

### Why `structuralSharing: false`?

Disabled for all tree-bearing queries (`useNode`, `usePageContent`, `useDailyNote`, etc.):

> React Query's structural sharing preserves stale object references in deeply nested structures. This prevents React from detecting optimistic changes at depth 3+, causing blocks to appear stale after Enter/Backspace operations.

---

## Optimistic Update Patterns

### Create Node (Full Optimistic Insertion)

```
1. onMutate:
   ├─ Cancel outgoing refetches
   ├─ Create optimistic Node with negative ID
   └─ Insert into parent's children via explicit cache iteration

2. onSuccess:
   ├─ Replace negative ID with server ID
   ├─ Remap runtime blockId
   └─ Invalidate lists/pages/classes/search/graph

3. onError:
   └─ Remove optimistic node from all caches
```

### Update Node (Immediate Merge)

```
1. onMutate:
   ├─ Cancel queries
   └─ Apply update recursively via updateNodeInTreeImmutable

2. onSuccess:
   ├─ Merge server response (preserving children/backlinks/properties
   │   from cache when server returns empty arrays)
   └─ Smart invalidation based on changed fields

3. onError (409):
   └─ Conflict detected → refetch
```

### Delete Node (Immediate Removal)

```
1. onMutate:
   └─ Remove from tree via removeNodeFromTreeImmutable

2. onSuccess:
   ├─ Navigate home if viewing deleted node
   ├─ Remove from favorites/recents
   └─ Soft invalidate all related caches
```

### Move Node (Tree Restructure)

```
1. onMutate:
   ├─ Find node in cache
   ├─ Remove from old position
   └─ Insert at new parent/position

2. onSuccess:
   └─ Soft invalidate (mark stale, don't refetch)
```

---

## Explicit Cache Iteration Pattern

All optimistic updates use **explicit cache iteration** rather than `setQueriesData`. This was a deliberate choice — `setQueriesData` proved unreliable for deeply nested tree structures:

```typescript
// Pattern used in useCreateNode, useUpdateNode, useDeleteNode
const queryCache = queryClient.getQueryCache();
const detailQueries = queryCache.findAll({
  queryKey: nodeKeys.details()
});

for (const query of detailQueries) {
  const oldData = query.state.data as Node | undefined;
  if (oldData) {
    const newData = applyUpdate(oldData);
    if (newData !== oldData) {
      queryClient.setQueryData(query.queryKey, newData);
    }
  }
}
```

> **Do not refactor** this pattern to `setQueriesData` — it causes subtle bugs with tree-depth 3+ operations.

---

## Soft vs Hard Invalidation

### Soft Invalidation

Marks queries as stale **without triggering a refetch**:

```typescript
queryClient.invalidateQueries({
  queryKey: nodeKeys.backlinks(id),
  refetchType: 'none'   // ← mark stale, don't refetch
});
```

Used for:
- Backlinks and linked references
- Graph data
- Page content of related nodes
- Prevents race conditions during rapid typing

### Hard Invalidation

Forces an immediate refetch of active queries:

```typescript
queryClient.invalidateQueries({
  queryKey: nodeKeys.detailBase(parentId),
  refetchType: 'active'  // ← refetch immediately
});
```

Used sparingly:
- Table cell replacement after delete
- Parent node refetch after page creation

### Smart Conditional Invalidation

`useUpdateNode` checks **which fields changed** to minimize invalidation:

| Field Changed | Invalidated |
|---------------|-------------|
| `icon`, `color`, `is_page` | Lists, pages, graphNodes (soft) |
| `color` | Additionally: inlineClasses queries |
| `parent_id` | nodeViews/queryResults |
| `name` | linkedRefs, backlinks, propertyBacklinks, graph, parent detail (soft) |

---

## Batch Ensure-Defaults Optimization

`useNodeViews.ts` batches `ensure-defaults` API calls using microtask scheduling:

```
Component mounts → batchEnsureDefaults(nodeId)
                    │
                    ├─ Check _ensuredNodes Set (session dedup)
                    ├─ Add to pending batch
                    └─ queueMicrotask(_flushBatch)
                         │
                         └─ Fire ONE API call per unique nodeId
```

**Impact example**: Journal view with 4 view-types × 10 day-nodes → reduced from ~40 POST requests to ~10.

---

## Specialized Hooks

### `useBlockPersist`

Singleton hook that persists optimistic runtime blocks to the API:

- Tracks in-flight blocks (`inFlightBlocks` Set) to prevent duplicates
- Queues content saves for blocks without server IDs
- Batches deletes via `queueMicrotask`
- Resolves parent server ID before creating (waits if parent is also new)

### `useContentSave`

Debounced content save (500ms default):

- Per-block tracking with `Map<number, PendingChange>`
- Auto-flush on unmount
- Converts markdown syntax in AST before saving
- Skips no-op saves by tracking last saved content

### `useStructureSync`

Syncs indent/outdent/reorder operations to API:

- Debounced (200ms)
- Singleton pattern
- Updates cache optimistically but **does not invalidate** (prevents infinite loops)
- 1-second cooldown per node

### `useRuntimeSync`

Bridges TanStack Query → `NodeGraphRuntime`:

- Converts API `Node` objects to `GraphNode` format
- Reconciles server IDs with optimistic runtime blocks
- Prevents duplicate block flashes during create

### `useVirtualizedQuery`

High-performance query execution for large result sets:

- Debounced (300ms)
- Windowed result slicing (default: 500 results)
- AST auto-fix before execution
- Pagination metadata from backend
