/**
 * History Store - Undo/Redo for Structural Block Operations
 * 
 * This store manages history for STRUCTURAL operations only:
 * - Block split (Enter key)
 * - Block merge (Backspace at start)
 * - Indent/Outdent (Tab/Shift+Tab)
 * - Move (drag & drop)
 * - Delete (block deletion)
 * - Create (new block creation)
 * 
 * TEXT changes within blocks are NOT tracked here - they use the browser's
 * native undo/redo (Cmd/Ctrl+Z) within the contenteditable.
 * 
 * Design Principles:
 * 1. Structural operations are tracked as discrete "entries"
 * 2. Each entry stores enough state to fully reverse/replay
 * 3. Selection state is captured with each entry for proper restoration
 * 4. History has a maximum size to prevent memory issues
 */
import { create } from 'zustand';
import type { EditorSelection } from './blockSelectionStore';

/**
 * Snapshot of a node's state at a point in time
 */
export interface NodeSnapshot {
  id: number;
  name: string;
  parent_id: number | null;
  order_index: number;
  /** Additional fields as needed */
  properties?: Record<string, unknown>;
}

/**
 * Types of structural operations that can be undone
 */
export type HistoryOperationType = 
  | 'split'      // Block split (Enter)
  | 'merge'      // Block merge (Backspace at start)
  | 'indent'     // Increase indent (Tab)
  | 'outdent'    // Decrease indent (Shift+Tab)
  | 'move'       // Drag & drop move
  | 'delete'     // Block deletion
  | 'create'     // Block creation
  | 'batch';     // Multiple operations grouped

/**
 * A single undoable/redoable entry
 */
export interface HistoryEntry {
  /** Unique identifier */
  id: string;
  
  /** Type of operation */
  type: HistoryOperationType;
  
  /** Human-readable description for debugging */
  description: string;
  
  /** Timestamp when operation was performed */
  timestamp: number;
  
  /** State BEFORE the operation (for undo) */
  before: {
    /** Affected nodes in their pre-operation state */
    nodes: NodeSnapshot[];
    /** Selection state to restore on undo */
    selection: EditorSelection | null;
  };
  
  /** State AFTER the operation (for redo) */
  after: {
    /** Affected nodes in their post-operation state */
    nodes: NodeSnapshot[];
    /** IDs of any nodes that were created (for deletion on undo) */
    createdNodeIds: number[];
    /** IDs of any nodes that were deleted (for recreation on undo) */
    deletedNodeSnapshots: NodeSnapshot[];
    /** Selection state to restore on redo */
    selection: EditorSelection | null;
  };
}

/**
 * Configuration for the history store
 */
interface HistoryConfig {
  /** Maximum number of entries to keep */
  maxEntries: number;
  /** Whether to log history operations (for debugging) */
  debug: boolean;
}

interface HistoryState {
  /** Past operations that can be undone */
  past: HistoryEntry[];
  
  /** Future operations that can be redone (cleared on new operation) */
  future: HistoryEntry[];
  
  /** Whether an undo/redo operation is currently in progress */
  isUndoRedoInProgress: boolean;
  
  /** Configuration */
  config: HistoryConfig;
  
  // === Actions ===
  
  /** 
   * Record a new operation. Clears future stack.
   * Call this AFTER the operation completes successfully.
   */
  pushEntry: (entry: Omit<HistoryEntry, 'id' | 'timestamp'>) => void;
  
  /**
   * Undo the most recent operation.
   * Returns the entry to undo, or null if nothing to undo.
   * The caller is responsible for actually reverting the state.
   */
  undo: () => HistoryEntry | null;
  
  /**
   * Redo the most recently undone operation.
   * Returns the entry to redo, or null if nothing to redo.
   * The caller is responsible for actually replaying the state.
   */
  redo: () => HistoryEntry | null;
  
  /**
   * Mark undo/redo operation as complete
   */
  completeUndoRedo: () => void;
  
  /**
   * Check if undo is available
   */
  canUndo: () => boolean;
  
  /**
   * Check if redo is available
   */
  canRedo: () => boolean;
  
  /**
   * Clear all history
   */
  clearHistory: () => void;
  
  /**
   * Get history info for debugging
   */
  getHistoryInfo: () => { pastCount: number; futureCount: number; entries: string[] };
}

const DEFAULT_CONFIG: HistoryConfig = {
  maxEntries: 50,
  debug: false,
};

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  isUndoRedoInProgress: false,
  config: DEFAULT_CONFIG,
  
  pushEntry: (entry) => {
    const { config, past } = get();
    
    const fullEntry: HistoryEntry = {
      ...entry,
      id: `${entry.type}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: Date.now(),
    };
    
    if (config.debug) {
      console.log('[History] Push entry:', fullEntry.type, fullEntry.description);
    }
    
    // Add to past, clear future, enforce max size
    const newPast = [...past, fullEntry];
    if (newPast.length > config.maxEntries) {
      newPast.shift(); // Remove oldest
    }
    
    set({
      past: newPast,
      future: [], // New operation clears redo stack
    });
  },
  
  undo: () => {
    const { past, future, config, isUndoRedoInProgress } = get();
    
    if (isUndoRedoInProgress) {
      console.warn('[History] Undo/redo already in progress');
      return null;
    }
    
    if (past.length === 0) {
      if (config.debug) {
        console.log('[History] Nothing to undo');
      }
      return null;
    }
    
    const entry = past[past.length - 1];
    const newPast = past.slice(0, -1);
    const newFuture = [entry, ...future];
    
    if (config.debug) {
      console.log('[History] Undo:', entry.type, entry.description);
    }
    
    set({
      past: newPast,
      future: newFuture,
      isUndoRedoInProgress: true,
    });
    
    return entry;
  },
  
  redo: () => {
    const { past, future, config, isUndoRedoInProgress } = get();
    
    if (isUndoRedoInProgress) {
      console.warn('[History] Undo/redo already in progress');
      return null;
    }
    
    if (future.length === 0) {
      if (config.debug) {
        console.log('[History] Nothing to redo');
      }
      return null;
    }
    
    const entry = future[0];
    const newFuture = future.slice(1);
    const newPast = [...past, entry];
    
    if (config.debug) {
      console.log('[History] Redo:', entry.type, entry.description);
    }
    
    set({
      past: newPast,
      future: newFuture,
      isUndoRedoInProgress: true,
    });
    
    return entry;
  },
  
  completeUndoRedo: () => {
    set({ isUndoRedoInProgress: false });
  },
  
  canUndo: () => {
    return get().past.length > 0 && !get().isUndoRedoInProgress;
  },
  
  canRedo: () => {
    return get().future.length > 0 && !get().isUndoRedoInProgress;
  },
  
  clearHistory: () => {
    if (get().config.debug) {
      console.log('[History] Cleared');
    }
    set({ past: [], future: [] });
  },
  
  getHistoryInfo: () => {
    const { past, future } = get();
    return {
      pastCount: past.length,
      futureCount: future.length,
      entries: past.map(e => `${e.type}: ${e.description}`),
    };
  },
}));

// === Selectors ===

/**
 * Get history actions only (for use in operations)
 */
export function useHistoryActions() {
  return useHistoryStore(state => ({
    pushEntry: state.pushEntry,
    undo: state.undo,
    redo: state.redo,
    completeUndoRedo: state.completeUndoRedo,
    clearHistory: state.clearHistory,
  }));
}

/**
 * Check undo/redo availability
 */
export function useHistoryAvailability() {
  const canUndo = useHistoryStore(state => state.past.length > 0 && !state.isUndoRedoInProgress);
  const canRedo = useHistoryStore(state => state.future.length > 0 && !state.isUndoRedoInProgress);
  return { canUndo, canRedo };
}
