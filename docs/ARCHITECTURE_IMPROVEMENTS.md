# Notees Architecture Improvements

This document details the architectural improvements made to the Notees block-based editor, providing a reference for the patterns and systems in place.

---

## Table of Contents

1. [Block Editor Core](#block-editor-core)
   - [Model-First Selection](#1-model-first-selection-architecture)
   - [useLayoutEffect for DOM Sync](#2-uselayouteffect-for-dom-synchronization)
   - [Memoization](#3-memoization-with-reactmemo)
   - [X-Position Memory](#4-x-position-memory-for-vertical-navigation)
   - [Operation Queue](#5-operation-queue-system)
   - [Structural History](#6-structural-history-undoredo)
2. [Application Architecture](#application-architecture)
   - [Debounced Content Save](#7-debounced-content-save)
   - [Notification System](#8-global-notification-system)
   - [Error Handling](#9-global-error-handling)
   - [Error Boundaries](#10-error-boundaries)
   - [Keyboard Shortcuts](#11-centralized-keyboard-shortcuts)
   - [Focus Management](#12-focus-management)
   - [Command Pattern](#13-command-pattern-for-block-operations)
   - [Feature Flags](#14-feature-flags-system)
   - [Lazy Loading](#15-lazy-loading--code-splitting)
3. [Files Reference](#files-reference)

---

## Block Editor Core

### 1. Model-First Selection Architecture

**Problem:** React re-renders cause cursor/selection loss in contentEditable elements.

**Solution:** Store selection state in Zustand; DOM is a projection of model state.

**Location:** `frontend/src/stores/blockSelectionStore.ts`

```typescript
interface EditorSelection {
  blockId: string;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

// In store state:
pendingSelection: EditorSelection | null;
setPendingSelection: (selection: EditorSelection | null) => void;
```

**How it works:**
1. Before any operation that might cause re-render, capture selection to `pendingSelection`
2. After React renders, restore selection from `pendingSelection` in `useLayoutEffect`
3. Clear `pendingSelection` after restoration

**Usage in BlockEditor:**
```typescript
// Before blur/operation
const selection = window.getSelection();
if (selection && selection.rangeCount > 0) {
  setPendingSelection({
    blockId: block.id,
    start: range.startOffset,
    end: range.endOffset,
    direction: 'none',
  });
}

// After render (in useLayoutEffect)
if (pendingSelection && pendingSelection.blockId === block.id) {
  restoreSelection(pendingSelection);
  setPendingSelection(null);
}
```

---

### 2. useLayoutEffect for DOM Synchronization

**Problem:** `useEffect` runs after browser paint, causing visible cursor flicker.

**Solution:** Use `useLayoutEffect` for selection restoration - runs synchronously after DOM mutations but before paint.

**Pattern:**
```typescript
// ❌ WRONG - causes flicker
useEffect(() => {
  restoreSelection(pendingSelection);
}, [pendingSelection]);

// ✅ CORRECT - no flicker
useLayoutEffect(() => {
  if (pendingSelection) {
    restoreSelection(pendingSelection);
    setPendingSelection(null);
  }
}, [pendingSelection]);
```

---

### 3. Memoization with React.memo

**Problem:** Editing one block causes all sibling blocks to re-render, losing their selection state.

**Solution:** Wrap Block components with `memo()` and custom comparison function.

**Location:** `frontend/src/components/blocks/Block.tsx`

```typescript
// Custom comparison - only re-render if these props change
function blockPropsAreEqual(prev: BlockProps, next: BlockProps): boolean {
  return (
    prev.block.id === next.block.id &&
    prev.block.name === next.block.name &&
    prev.block.collapsed === next.block.collapsed &&
    prev.depth === next.depth &&
    // ... other relevant props
  );
}

export const MemoizedBlock = memo(Block, blockPropsAreEqual);
```

---

### 4. X-Position Memory for Vertical Navigation

**Problem:** Moving cursor up/down loses horizontal position when lines have different lengths.

**Solution:** Track "target X position" that persists during vertical navigation.

**Store state:**
```typescript
interface BlockSelectionState {
  targetXPosition: number | null;
  setTargetXPosition: (x: number | null) => void;
}
```

**Usage:**
```typescript
// On left/right arrow or typing: clear target
setTargetXPosition(null);

// On up/down arrow: 
// 1. If no target, capture current X position
// 2. Move to new line
// 3. Position cursor at closest X to target
```

---

### 5. Operation Queue System

**Problem:** Structural operations (indent, split, merge) during editing cause state conflicts.

**Solution:** Queue operations to run after current edit completes.

**Location:** `frontend/src/stores/blockSelectionStore.ts`

```typescript
type OperationQueueEntry = {
  type: 'indent' | 'outdent' | 'split' | 'merge' | 'delete' | 'moveUp' | 'moveDown';
  blockId: string;
  data?: Record<string, unknown>;
};

interface BlockSelectionState {
  operationQueue: OperationQueueEntry[];
  queueOperation: (op: OperationQueueEntry) => void;
  processQueue: () => OperationQueueEntry | null;
}
```

**Flow:**
1. User triggers Tab (indent) while editing
2. `queueOperation({ type: 'indent', blockId })`
3. Exit edit mode
4. `processQueue()` returns the operation
5. Execute indent operation
6. Re-enter edit mode if appropriate

---

### 6. Structural History (Undo/Redo)

**Problem:** Browser's built-in undo only handles text; structural changes need separate tracking.

**Location:** 
- `frontend/src/stores/historyStore.ts`
- `frontend/src/hooks/useStructuralHistory.ts`

```typescript
interface NodeSnapshot {
  id: number;
  name: string;
  parent_id: number | null;
  sequence: number;
  collapsed: boolean;
}

interface HistoryEntry {
  id: string;
  type: HistoryOperationType;
  timestamp: number;
  before: NodeSnapshot[];
  after: NodeSnapshot[];
  metadata?: Record<string, unknown>;
}

type HistoryOperationType = 
  | 'indent' | 'outdent' 
  | 'move' | 'delete' | 'create'
  | 'split' | 'merge' | 'batch';
```

**Usage:**
```typescript
const { pushHistory, undo, redo, canUndo, canRedo } = useStructuralHistory();

// Before operation
const before = captureSnapshot(affectedBlocks);

// Perform operation
await moveBlock(blockId, newParentId);

// After operation
const after = captureSnapshot(affectedBlocks);
pushHistory({ type: 'move', before, after });
```

---

## Application Architecture

### 7. Debounced Content Save

**Problem:** Every keystroke triggers an API call, overwhelming the server.

**Location:**
- `frontend/src/hooks/useDebouncedSave.ts` - Generic utility
- `frontend/src/hooks/useContentSave.ts` - Block-specific implementation

```typescript
interface UseContentSaveOptions {
  delay?: number;        // Default: 500ms
  onSaved?: (blockId: number) => void;
  onError?: (blockId: number, error: Error) => void;
}

function useContentSave(options?: UseContentSaveOptions) {
  return {
    handleContentChange,  // Debounced - use as onContentChange prop
    saveImmediate,        // Bypass debounce
    flushBlock,           // Force save specific block
    flushAll,             // Force save all pending
    hasPendingChanges,    // Check for unsaved changes
    isSaving,             // Mutation in progress
  };
}
```

**Integrated in:**
- `frontend/src/views/NodeView.tsx`
- `frontend/src/components/nodes/NodeContent.tsx`
- `frontend/src/components/LinkedReferences.tsx`

**Features:**
- Per-block tracking (changes to block A don't affect block B's timer)
- Auto-flush on component unmount
- Auto-flush on `beforeunload` (page close/refresh)

---

### 8. Global Notification System

**Location:**
- `frontend/src/stores/notificationStore.ts`
- `frontend/src/components/core/NotificationToast.tsx`

```typescript
type NotificationType = 'success' | 'error' | 'warning' | 'info';

interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  duration?: number;      // Auto-dismiss time (ms)
  action?: {
    label: string;
    onClick: () => void;
  };
}

// Usage
const { addNotification } = useNotifications();

addNotification({
  type: 'success',
  message: 'Block saved successfully',
  duration: 3000,
});

addNotification({
  type: 'error',
  message: 'Failed to save',
  action: { label: 'Retry', onClick: handleRetry },
});
```

---

### 9. Global Error Handling

**Location:** `frontend/src/lib/queryClient.ts`

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      onError: (error) => {
        const message = extractErrorMessage(error);
        useNotificationStore.getState().addNotification({
          type: 'error',
          message,
          duration: 5000,
        });
      },
    },
  },
});
```

All TanStack Query mutation errors automatically show a toast notification.

---

### 10. Error Boundaries

**Location:** `frontend/src/components/core/ErrorBoundary.tsx`

```typescript
// Basic usage
<ErrorBoundary context="NodeView" onError={logError}>
  <NodeView />
</ErrorBoundary>

// HOC usage
const SafeNodeView = withErrorBoundary(NodeView, {
  context: 'NodeView',
  onError: logError,
});

// Specialized boundaries
<BlockErrorBoundary blockId={block.id}>
  <Block {...props} />
</BlockErrorBoundary>

<ViewErrorBoundary viewName="Settings">
  <SettingsModal />
</ViewErrorBoundary>
```

**Features:**
- Captures React rendering errors
- Shows user-friendly fallback UI
- Retry button to attempt recovery
- Error logging callback

---

### 11. Centralized Keyboard Shortcuts

**Location:**
- `frontend/src/stores/keyboardStore.ts`
- `frontend/src/hooks/useKeyboardShortcuts.tsx`

#### Shortcut Definition

```typescript
interface ShortcutDefinition {
  id: ShortcutId;
  key: string;                    // 'n', 's', 'Enter', etc.
  modifiers: ModifierKeys;        // { ctrl?, alt?, shift?, meta? }
  context: ShortcutContext;       // When shortcut is active
  description: string;
  priority?: number;              // Higher = checked first
}

type ShortcutContext = 
  | 'global'      // Always active
  | 'editor'      // When editing a block
  | 'selection'   // When blocks are selected
  | 'modal'       // When a modal is open
  | 'sidebar'     // When sidebar is focused
  | 'search';     // When search is open
```

#### Default Shortcuts (25+)

```typescript
const SHORTCUT_IDS = {
  // Global
  QUICK_ADD: 'global.quickAdd',           // Ctrl+N
  SAVE: 'global.save',                    // Ctrl+S
  SEARCH: 'global.search',                // Ctrl+K
  GO_TO_DAILY: 'global.goToDaily',        // Ctrl+Shift+D
  TOGGLE_SIDEBAR: 'global.toggleSidebar', // Ctrl+\
  
  // Editor
  BOLD: 'editor.bold',                    // Ctrl+B
  ITALIC: 'editor.italic',                // Ctrl+I
  LINK: 'editor.link',                    // Ctrl+K
  INDENT: 'editor.indent',                // Tab
  OUTDENT: 'editor.outdent',              // Shift+Tab
  
  // Selection
  SELECT_ALL: 'selection.selectAll',      // Ctrl+A
  DELETE: 'selection.delete',             // Backspace/Delete
  COPY: 'selection.copy',                 // Ctrl+C
  CUT: 'selection.cut',                   // Ctrl+X
  PASTE: 'selection.paste',               // Ctrl+V
  
  // History
  UNDO: 'history.undo',                   // Ctrl+Z
  REDO: 'history.redo',                   // Ctrl+Shift+Z
  // ... more
};
```

#### Hook Usage

```typescript
// Register a handler
useKeyboardShortcut(SHORTCUT_IDS.QUICK_ADD, (event) => {
  event.preventDefault();
  openQuickAdd();
});

// Conditional registration
useKeyboardShortcut('editor.bold', handleBold, {
  enabled: isEditing,
  priority: 10,
});

// Activate a context
useShortcutContext('modal', isModalOpen);

// Get display string
const display = useShortcutDisplay(SHORTCUT_IDS.SAVE); // "⌘S" or "Ctrl+S"
```

#### App Setup

```typescript
// In App.tsx
<KeyboardShortcutsProvider>
  <AppContent />
</KeyboardShortcutsProvider>
```

---

### 12. Focus Management

**Location:** `frontend/src/hooks/useFocusTrap.ts`

#### useFocusTrap - Modal Focus Trapping

```typescript
function Modal({ onClose }) {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useFocusTrap(containerRef, {
    enabled: true,
    onEscape: onClose,
    autoFocus: true,       // Focus first element on mount
    restoreFocus: true,    // Restore focus on unmount
  });
  
  return (
    <div ref={containerRef}>
      <button>First focusable</button>
      <input />
      <button>Last focusable</button>
    </div>
  );
}
```

**Behavior:**
- Tab cycles through focusable elements within container
- Shift+Tab cycles backwards
- Focus doesn't escape the modal
- Escape calls `onEscape` callback

#### useFocusableList - Arrow Key Navigation

```typescript
function Menu() {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { setFocusIndex } = useFocusableList(containerRef, {
    vertical: true,     // Up/Down arrows (vs Left/Right)
    wrap: true,         // Wrap at ends
    onSelect: (el, index) => handleSelect(index),
  });
  
  return (
    <div ref={containerRef} role="menu">
      <button role="menuitem">Item 1</button>
      <button role="menuitem">Item 2</button>
      <button role="menuitem">Item 3</button>
    </div>
  );
}
```

---

### 13. Command Pattern for Block Operations

**Location:** `frontend/src/stores/blockCommandStore.ts`

```typescript
type BlockCommandType =
  | 'indent' | 'outdent'
  | 'moveUp' | 'moveDown'
  | 'delete' | 'duplicate'
  | 'split' | 'merge'
  | 'toggleCollapse'
  | 'updateContent'
  | 'insertBlock';

interface CommandDefinition {
  type: BlockCommandType;
  execute: (context: CommandContext) => Promise<CommandResult>;
  undo: (context: CommandContext, undoData: Record<string, unknown>) => Promise<CommandResult>;
  description: string;
}
```

#### Registering Commands

```typescript
useRegisterBlockCommands({
  indent: {
    execute: async (ctx) => {
      const prevParent = block.parent_id;
      await indentBlock(ctx.blockId);
      return { success: true, undoData: { prevParent } };
    },
    undo: async (ctx, undoData) => {
      await moveBlock(ctx.blockId, undoData.prevParent);
      return { success: true };
    },
    description: 'Indent block',
  },
});
```

#### Using Commands

```typescript
const { indent, outdent, deleteBlock, undo, redo, canUndo, canRedo } = useBlockCommands();

// Execute commands
await indent(blockId);
await deleteBlock(blockId);

// Undo/redo
if (canUndo) await undo();
if (canRedo) await redo();
```

---

### 14. Feature Flags System

**Location:**
- `frontend/src/stores/featureFlagStore.ts`
- `frontend/src/components/core/FeatureFlag.tsx`

#### Available Flags

| Flag | Default | Description |
|------|---------|-------------|
| `graphView` | true | Graph visualization |
| `newEditor` | true | New block editor |
| `blockComments` | false | Comments on blocks |
| `aiAssist` | false | AI writing assistance |
| `darkMode` | true | Dark theme support |
| `offlineMode` | false | Offline caching |
| `collaborativeEditing` | false | Real-time collab |
| `propertyInheritance` | true | Inherit parent props |
| `advancedQueries` | false | Advanced search syntax |
| `customThemes` | false | Custom theme creation |
| `importExport` | true | Import/export notes |
| `keyboardShortcutsPanel` | true | Shortcuts help |
| `blockTemplates` | false | Block templates |
| `typeInheritance` | false | Type hierarchy |
| `debugMode` | DEV only | Debug overlays |

#### Usage

```typescript
// Hook
const isEnabled = useFeatureFlag('graphView');

// Component
<FeatureFlag name="aiAssist" fallback={<LegacyAssist />}>
  <AIAssistant />
</FeatureFlag>

// HOC
const EnhancedEditor = withFeatureFlag(NewEditor, 'newEditor', LegacyEditor);
```

#### Overrides

```
# URL parameter (temporary)
https://app.notees.com/?ff_debugMode=true

# Environment variable (build time)
VITE_FEATURE_GRAPHVIEW=false
```

---

### 15. Lazy Loading / Code Splitting

**Location:** `frontend/src/components/lazy.tsx`

```typescript
import { lazy, Suspense } from 'react';

// Lazy-loaded components
export const LazyNodeGraphView = lazy(() => import('./nodes/NodeGraphView'));
export const LazySettingsModal = lazy(() => import('./SettingsModal'));
export const LazyDatabaseManagementView = lazy(() => import('../views/DatabaseManagementView'));

// HOC with loading fallback
export function withSuspense<P extends object>(
  Component: React.ComponentType<P>,
  fallback: React.ReactNode = <LoadingSpinner />
) {
  return function SuspendedComponent(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Component {...props} />
      </Suspense>
    );
  };
}

// Usage
const NodeGraphView = withSuspense(LazyNodeGraphView);
```

---

## Files Reference

### Stores

| File | Purpose |
|------|---------|
| `stores/blockSelectionStore.ts` | Selection state, operation queue, pending selection |
| `stores/historyStore.ts` | Structural undo/redo history |
| `stores/notificationStore.ts` | Toast notification state |
| `stores/keyboardStore.ts` | Centralized keyboard shortcuts |
| `stores/blockCommandStore.ts` | Command pattern for block ops |
| `stores/featureFlagStore.ts` | Feature toggle system |

### Hooks

| File | Purpose |
|------|---------|
| `hooks/useStructuralHistory.ts` | History management hook |
| `hooks/useDebouncedSave.ts` | Generic debounce utility |
| `hooks/useContentSave.ts` | Block content save with debounce |
| `hooks/useKeyboardShortcuts.tsx` | Shortcut registration hooks |
| `hooks/useFocusTrap.ts` | Modal focus trapping |

### Components

| File | Purpose |
|------|---------|
| `components/core/NotificationToast.tsx` | Toast UI |
| `components/core/ErrorBoundary.tsx` | Error boundary components |
| `components/core/FeatureFlag.tsx` | Feature flag component/HOC |
| `components/lazy.tsx` | Lazy loading utilities |

### Modified Files

| File | Changes |
|------|---------|
| `lib/queryClient.ts` | Global mutation error handling |
| `App.tsx` | Provider integration, error boundary |
| `views/NodeView.tsx` | Debounced save integration |
| `components/nodes/NodeContent.tsx` | Debounced save integration |
| `components/LinkedReferences.tsx` | Debounced save integration |
| `components/blocks/Block.tsx` | Memoization, selection restoration |
| `components/blocks/BlockEditor.tsx` | pendingSelection, useLayoutEffect |

---

## Design Principles

1. **Model-First State**: UI state lives in stores, DOM is a projection
2. **Synchronous DOM Updates**: Use `useLayoutEffect` for DOM sync
3. **Debounce API Calls**: Batch rapid changes to reduce server load
4. **Graceful Degradation**: Error boundaries prevent full app crashes
5. **Centralized Shortcuts**: One system for all keyboard handling
6. **Feature Isolation**: Feature flags for safe rollout
7. **Command Pattern**: Undoable operations with clear interfaces
8. **Focus Management**: Accessible keyboard navigation
