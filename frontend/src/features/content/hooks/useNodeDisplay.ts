/**
 * useNodeDisplay — Shared hook for computing node display data.
 *
 * Centralises the repeated pattern of:
 *   1. Fetching the class list (for icon inheritance)
 *   2. Computing the effective icon via getEffectiveIcon()
 *   3. Computing the human-readable display text (truncated, with fallbacks)
 *
 * Used by NodeRef (interactive pill and lightweight inline variant) and
 * other node display surfaces such as the sidebar recents/favorites.
 */
import { useMemo } from 'react';
import { useBatchedNode } from '@/hooks/useBatchedNode';
import { useClasses } from '@/features/content/hooks/useNodes';
import { nodeNameToText } from '@/features/queries';
import { getEffectiveIcon, getEffectiveColor } from '@/utils/nodeIcon';
import { useCoreDisplayName } from '@/features/content/hooks/useCoreDisplayName';
import type { Node } from '@/types';

/** Resolve effective class IDs for a node, inheriting from aliased node if needed. */
function useEffectiveClassIds(node: Node | null | undefined, aliasedNode: Node | null | undefined) {
  const hasOwnClasses = !!node?.classes_uuid?.length;
  return hasOwnClasses ? node!.classes_uuid : aliasedNode?.classes_uuid;
}

/** Fetch the aliased (main) node for an alias, or null. */
function useAliasedNode(node: Node | null | undefined) {
  const aliasedId = node?.aliased_uuid ?? null;
  const { data: aliasedNode } = useBatchedNode(aliasedId);
  return aliasedNode ?? null;
}

export interface NodeDisplayData {
  /** Resolved icon string (own or inherited from class), or undefined */
  effectiveIcon: string | null | undefined;
  /** Human-readable display text (truncated for blocks, fallback for untitled) */
  displayText: string;
  /** Whether the node is a page (true) or a block */
  isPage: boolean;
  /** Node colour (if set) */
  color: string | undefined;
}

/**
 * Compute display data for a node.
 *
 * @param node — resolved Node object (or null/undefined while loading)
 * @param fallbackText — text to show when node is null (defaults to '')
 */
export function useNodeDisplay(
  node: Node | null | undefined,
  fallbackText = '',
): NodeDisplayData {
  const { data: allClasses } = useClasses();
  const aliasedNode = useAliasedNode(node);
  const effectiveClassIds = useEffectiveClassIds(node, aliasedNode);

  // Live name from the core store: observer surfaces (inline links, pills,
  // recents/favorites) must reflect a referenced block's content the moment it
  // is edited elsewhere, not after the next query refetch.
  const liveName = useCoreDisplayName(node?.uuid ?? null, node?.name ?? '');

  const effectiveIcon = useMemo(
    () => getEffectiveIcon(node, allClasses, effectiveClassIds, aliasedNode),
    [node, allClasses, effectiveClassIds, aliasedNode],
  );

  const effectiveColor = useMemo(
    () => getEffectiveColor(node, allClasses, effectiveClassIds, aliasedNode),
    [node, allClasses, effectiveClassIds, aliasedNode],
  );

  const displayText = useMemo(() => {
    if (!node) return fallbackText;
    // Use display_name when it has been pre-resolved server-side (i.e. it
    // differs from the raw AST stored in name). This happens for nodes in the
    // referenced_nodes map whose names contain [[nodeId]] links — those links
    // are resolved to plain text by the backend so they don't render as "…".
    // Fall back to the API node's name when the live core content is empty or
    // malformed (e.g. legacy migration wrote inline text nodes at document level).
    const text = (node.display_name && node.display_name !== node.name)
      ? node.display_name
      : (nodeNameToText(liveName) || nodeNameToText(node.name || ''));
    if (!text || text.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    return text;
  }, [node, fallbackText, liveName]);

  return {
    effectiveIcon,
    displayText,
    isPage: node?.is_page ?? true,
    color: effectiveColor || undefined,
  };
}
