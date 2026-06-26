/**
 * useNodeNavigation Hook
 * 
 * Provides standardized navigation handlers for nodes.
 * Consolidates the repeated pattern of openNode/addSidebarCard.
 * openNode no longer needs a type — the view layer resolves page vs block
 * from node.is_page in the database.
 * 
 * Alias redirection:
 * When navigating to a node that is an alias (has aliased_id set), it will
 * automatically redirect to the main node, unless skipAliasRedirect is true.
 * 
 * Usage:
 *   const { navigateToNode, openInSidebar, handleNodeClick, handleNodeShiftClick } = useNodeNavigation();
 *   
 *   // Simple navigation:
 *   navigateToNode(node);
 *   openInSidebar(node);
 *   
 *   // Skip alias redirection (e.g., in aliases section):
 *   navigateToNode(node, { skipAliasRedirect: true });
 *   
 *   // As click handlers (pass directly to onNodeClick / onNodeShiftClick):
 *   <NodeCollection onNodeClick={handleNodeClick} onNodeShiftClick={handleNodeShiftClick} />
 */
import { useCallback } from 'react';
import { useNavigationStore } from '@/stores';
import { flushAllContentSaves } from '@/features/editor';
import type { Node } from '@/types';
import type { SidebarCardType } from '@/stores';

/** Resolve a node's view type: 'page' if is_page, otherwise 'block' */
export function getNodeViewType(node: { is_page?: boolean; parent_id?: number | null }): 'page' | 'block' {
  return node.is_page ? 'page' : 'block';
}

/** Options for node navigation */
export interface NavigationOptions {
  /** If true, navigate to the alias node itself instead of redirecting to the main node */
  skipAliasRedirect?: boolean;
}

/**
 * Hook that provides standardized node navigation functions.
 * Wraps openNode and addSidebarCard from the store with automatic type resolution
 * and alias redirection.
 */
export function useNodeNavigation() {
  const openNode = useNavigationStore(state => state.openNode);
  const addSidebarCard = useNavigationStore(state => state.addSidebarCard);

  /** Navigate to a node in the main view */
  const navigateToNode = useCallback((node: Node, options?: NavigationOptions) => {
    // Flush pending content saves before navigation so the mutation's
    // onMutate optimistic update runs while the current query cache is
    // still active. Without this, navigating to a focused block view can
    // show stale (blank) content because the save fires too late.
    flushAllContentSaves();
    // Redirect to main node if this is an alias (unless opted out)
    const targetId = (!options?.skipAliasRedirect && node.aliased_uuid) 
      ? node.aliased_uuid 
      : node.uuid;
    openNode(targetId);
  }, [openNode]);

  /** Open a node in the sidebar */
  const openInSidebar = useCallback((node: Node, options?: NavigationOptions) => {
    // Redirect to main node if this is an alias (unless opted out)
    const targetId = (!options?.skipAliasRedirect && node.aliased_uuid) 
      ? node.aliased_uuid 
      : node.uuid;
    addSidebarCard(targetId, getNodeViewType(node) as SidebarCardType);
  }, [addSidebarCard]);

  /** Click handler: navigates to the node. Pass directly as onNodeClick. */
  const handleNodeClick = useCallback((node: Node, options?: NavigationOptions) => {
    flushAllContentSaves();
    // Redirect to main node if this is an alias (unless opted out)
    const targetId = (!options?.skipAliasRedirect && node.aliased_uuid) 
      ? node.aliased_uuid 
      : node.uuid;
    openNode(targetId);
  }, [openNode]);

  /** Shift+click handler: opens in sidebar. Pass directly as onNodeShiftClick. */
  const handleNodeShiftClick = useCallback((node: Node, options?: NavigationOptions) => {
    // Redirect to main node if this is an alias (unless opted out)
    const targetId = (!options?.skipAliasRedirect && node.aliased_uuid) 
      ? node.aliased_uuid 
      : node.uuid;
    addSidebarCard(targetId, getNodeViewType(node) as SidebarCardType);
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
