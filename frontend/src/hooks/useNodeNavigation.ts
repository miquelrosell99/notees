/**
 * useNodeNavigation Hook
 * 
 * Provides standardized navigation handlers for nodes.
 * Consolidates the repeated pattern of openNode/addSidebarCard.
 * openNode no longer needs a type — the view layer resolves page vs block
 * from node.is_page in the database.
 * 
 * Usage:
 *   const { navigateToNode, openInSidebar, handleNodeClick, handleNodeShiftClick } = useNodeNavigation();
 *   
 *   // Simple navigation:
 *   navigateToNode(node);
 *   openInSidebar(node);
 *   
 *   // As click handlers (pass directly to onNodeClick / onNodeShiftClick):
 *   <NodeCollection onNodeClick={handleNodeClick} onNodeShiftClick={handleNodeShiftClick} />
 */
import { useCallback } from 'react';
import { useAppStore } from '@/stores';
import type { Node } from '@/types';
import type { SidebarCardType } from '@/stores';

/** Resolve a node's view type: 'page' if is_page, otherwise 'block' */
export function getNodeViewType(node: { is_page?: boolean; parent_id?: number | null }): 'page' | 'block' {
  return node.is_page ? 'page' : 'block';
}

/**
 * Hook that provides standardized node navigation functions.
 * Wraps openNode and addSidebarCard from the store with automatic type resolution.
 */
export function useNodeNavigation() {
  const openNode = useAppStore(state => state.openNode);
  const addSidebarCard = useAppStore(state => state.addSidebarCard);

  /** Navigate to a node in the main view */
  const navigateToNode = useCallback((node: Node) => {
    openNode(node.id);
  }, [openNode]);

  /** Open a node in the sidebar */
  const openInSidebar = useCallback((node: Node) => {
    addSidebarCard(node.id, getNodeViewType(node) as SidebarCardType);
  }, [addSidebarCard]);

  /** Click handler: navigates to the node. Pass directly as onNodeClick. */
  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id);
  }, [openNode]);

  /** Shift+click handler: opens in sidebar. Pass directly as onNodeShiftClick. */
  const handleNodeShiftClick = useCallback((node: Node) => {
    addSidebarCard(node.id, getNodeViewType(node) as SidebarCardType);
  }, [addSidebarCard]);

  return {
    navigateToNode,
    openInSidebar,
    handleNodeClick,
    handleNodeShiftClick,
    /** Raw store actions for custom patterns */
    openNode,
    addSidebarCard,
  };
}
