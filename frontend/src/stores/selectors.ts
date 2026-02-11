/**
 * Zustand Selectors for Performance
 * 
 * Fine-grained selectors that prevent render cascades.
 * 
 * RULE: Never subscribe to entire collections (nodes, nodeMap).
 * Instead, use these targeted selectors that return stable references.
 * 
 * WHY THIS MATTERS:
 * - Broad subscriptions cause ALL node components to re-render on ANY change
 * - Selectors with stable identity only trigger re-renders when relevant data changes
 * - Derived values computed in selectors prevent inline recomputation
 * 
 * NOTE ON ACTIONS:
 * - For selectors returning only actions (no state), use getState() instead
 * - Actions are stable references and don't need reactive subscriptions
 */
import { useShallow } from 'zustand/react/shallow';
import { useNodesStore } from './nodesStore';
import type { Node } from '@/types';

// ==================== NodesStore Selectors ====================

/**
 * Select current node ID only - minimal subscription
 */
export function useCurrentNodeId() {
  return useNodesStore(state => state.currentNodeId);
}

/**
 * Select current node type (page vs block)
 */
export function useCurrentNodeType() {
  return useNodesStore(state => state.currentNodeType);
}

/**
 * Select view mode only
 */
export function useViewMode() {
  return useNodesStore(state => state.viewMode);
}

/**
 * Check if currently in focused view mode
 */
export function useIsFocusedMode() {
  return useNodesStore(state => state.currentNodeType === 'block');
}

/**
 * Select sidebar state only - uses shallow comparison for object
 */
export function useSidebarState() {
  return useNodesStore(
    useShallow(state => ({
      sidebarOpen: state.sidebarOpen,
      rightSidebarOpen: state.rightSidebarOpen,
      isSidebarCollapsed: state.isSidebarCollapsed,
    }))
  );
}

/**
 * Select display mode (document/bullet/card)
 */
export function useContentDisplayMode() {
  return useNodesStore(state => state.contentDisplayMode);
}

// ==================== Action Selectors ====================
// These return only actions, preventing re-renders on state changes

/**
 * Get node navigation action only
 */
export function useOpenNodeAction() {
  return useNodesStore(state => state.openNode);
}

/**
 * Get sidebar card action only
 */
export function useAddSidebarCardAction() {
  return useNodesStore(state => state.addSidebarCard);
}

// ==================== Equality Functions ====================

/**
 * Shallow compare for array selectors
 */
export function shallowArrayEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare node by ID only (for memoization)
 */
export function nodeIdEqual(a: Node | null, b: Node | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id;
}

// ==================== Export ====================

export {
  // Re-export store for direct access when needed
  useNodesStore,
};
