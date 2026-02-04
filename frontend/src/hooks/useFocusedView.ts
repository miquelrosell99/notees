/**
 * useFocusedView Hook
 * 
 * PERFORMANCE CRITICAL: Isolated data loading for focused view.
 * 
 * This hook enforces a HARD BOUNDARY between focused view and the full graph.
 * It loads ONLY what's needed for focused view rendering:
 * - Focused node content + direct children (1 level)
 * - Minimal breadcrumb chain (parents metadata only)
 * - NO: full page list, siblings, backlinks, references by default
 * 
 * WHY THIS MATTERS:
 * - Prevents focused view from subscribing to full node graph
 * - Reduces mounted node count significantly
 * - Enables focused view to load in <200ms regardless of graph size
 */
import { useQuery } from '@tanstack/react-query';
import { useState, useCallback, useLayoutEffect } from 'react';
import * as nodesApi from '@/api/nodes';
import { nodeKeys } from './useNodes';
import type { Node, Backlink } from '@/types';

// ==================== Query Keys ====================

export const focusedViewKeys = {
  all: ['focused-view'] as const,
  node: (id: number) => [...focusedViewKeys.all, 'node', id] as const,
  breadcrumbs: (id: number) => [...focusedViewKeys.all, 'breadcrumbs', id] as const,
  children: (id: number) => [...focusedViewKeys.all, 'children', id] as const,
};

// ==================== Types ====================

interface FocusedViewData {
  /** The focused node with direct children only */
  node: Node | null;
  /** Parent chain for breadcrumbs (metadata only) */
  breadcrumbs: BreadcrumbNode[];
  /** Whether the primary node is loading */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Trigger deferred backlinks load */
  loadBacklinks: () => void;
  /** Backlinks data (only after loadBacklinks called) */
  backlinks: Backlink[] | undefined;
  /** Whether backlinks are loading */
  isBacklinksLoading: boolean;
}

interface BreadcrumbNode {
  id: number;
  name: string | null;
  is_page: boolean;
  icon?: string | null;
}

// ==================== Hook ====================

/**
 * Primary hook for focused view data isolation.
 * 
 * GUARANTEES:
 * - Does NOT trigger useNodes, usePages, or useClasses queries
 * - Loads maximum 1 level of children
 * - Breadcrumbs are metadata-only (no children, no backlinks)
 * - Backlinks are deferred until explicitly requested
 */
export function useFocusedView(nodeId: number | null): FocusedViewData {
  const [shouldLoadBacklinks, setShouldLoadBacklinks] = useState(false);

  // Primary node query - includes direct children only
  // Uses dedicated focused-view key to avoid poisoning page-view cache
  const {
    data: node,
    isLoading,
    error,
  } = useQuery({
    queryKey: focusedViewKeys.node(nodeId ?? 0),
    queryFn: async () => {
      if (!nodeId) return null;
      // Fetch node with children but NO backlinks (deferred)
      const result = await nodesApi.getNode(nodeId, {
        include_children: true,
        include_backlinks: false,
        include_properties: true,
      });
      return result;
    },
    enabled: !!nodeId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Breadcrumb chain - metadata only, no heavy fields
  const { data: breadcrumbsRaw } = useQuery({
    queryKey: focusedViewKeys.breadcrumbs(nodeId ?? 0),
    queryFn: async () => {
      if (!nodeId || !node) return [];
      
      // Build breadcrumb chain by walking up parent_id
      const chain: BreadcrumbNode[] = [];
      let currentId = node.parent_id;
      const visited = new Set<number>();
      
      // Walk up the tree (max 20 levels to prevent infinite loops)
      while (currentId && !visited.has(currentId) && chain.length < 20) {
        visited.add(currentId);
        
        // Fetch parent with minimal data
        try {
          const parent = await nodesApi.getNode(currentId, {
            include_children: false,
            include_backlinks: false,
            include_properties: false,
          });
          
          chain.unshift({
            id: parent.id,
            name: parent.name,
            is_page: parent.is_page,
            icon: parent.icon,
          });
          
          currentId = parent.parent_id;
        } catch {
          break;
        }
      }
      
      return chain;
    },
    enabled: !!nodeId && !!node,
    staleTime: 1000 * 60 * 10, // 10 minutes - breadcrumbs are very stable
  });

  // Deferred backlinks - only loads when explicitly requested
  const { data: backlinks, isLoading: isBacklinksLoading } = useQuery({
    queryKey: nodeKeys.backlinks(nodeId ?? 0),
    queryFn: () => nodesApi.getBacklinks(nodeId!),
    enabled: !!nodeId && shouldLoadBacklinks,
    staleTime: 1000 * 60 * 5,
  });

  // Callback to trigger backlinks load (e.g., when user scrolls to section)
  const loadBacklinks = useCallback(() => {
    if (!shouldLoadBacklinks) {
      setShouldLoadBacklinks(true);
    }
  }, [shouldLoadBacklinks]);

  // Reset backlinks state when node changes
  useLayoutEffect(() => {
    setShouldLoadBacklinks(false);
  }, [nodeId]);

  return {
    node: node ?? null,
    breadcrumbs: breadcrumbsRaw ?? [],
    isLoading,
    error: error as Error | null,
    loadBacklinks,
    backlinks,
    isBacklinksLoading,
  };
}

// ==================== Selectors ====================

/**
 * Selector for focused node ID - use instead of broad store subscription
 */
export function selectFocusedNodeId(state: { currentNodeId: number | null; currentNodeType: string }) {
  return state.currentNodeType === 'block' ? state.currentNodeId : null;
}

/**
 * Selector for focused node children count - stable reference
 */
export function useFocusedChildrenCount(nodeId: number | null): number {
  const { data } = useQuery({
    queryKey: focusedViewKeys.node(nodeId ?? 0),
    enabled: false, // Only read from cache, don't fetch
  });
  return (data as Node | undefined)?.children?.length ?? 0;
}
