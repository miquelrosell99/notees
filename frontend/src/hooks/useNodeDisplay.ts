/**
 * useNodeDisplay — Shared hook for computing node display data.
 *
 * Centralises the repeated pattern of:
 *   1. Fetching the class list (for icon inheritance)
 *   2. Computing the effective icon via getEffectiveIcon()
 *   3. Computing the human-readable display text (truncated, with fallbacks)
 *
 * Used by both NodeRef (interactive pill) and the editor's InlineLink
 * (read-only decorator inside Lexical).
 */
import { useMemo } from 'react';
import { useBatchedNode } from '@/hooks/useBatchedNode';
import { useClasses } from '@/hooks/useNodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import type { Node } from '@/types';

/** Resolve effective class IDs for a node, inheriting from aliased node if needed. */
function useEffectiveClassIds(node: Node | null | undefined) {
  const hasOwnClasses = !!node?.classes?.length;
  const aliasedId = (!hasOwnClasses && node?.aliased_id) ? node.aliased_id : null;
  const { data: aliasedNode } = useBatchedNode(aliasedId);
  return hasOwnClasses ? node!.classes : aliasedNode?.classes;
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
  const effectiveClassIds = useEffectiveClassIds(node);

  const effectiveIcon = useMemo(
    () => getEffectiveIcon(node, allClasses, effectiveClassIds),
    [node, allClasses, effectiveClassIds],
  );

  const displayText = useMemo(() => {
    if (!node) return fallbackText;
    // Use display_name when it has been pre-resolved server-side (i.e. it
    // differs from the raw AST stored in name). This happens for nodes in the
    // referenced_nodes map whose names contain [[nodeId]] links — those links
    // are resolved to plain text by the backend so they don't render as "…".
    const text = (node.display_name && node.display_name !== node.name)
      ? node.display_name
      : nodeNameToText(node.name);
    if (!text || text.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!node.is_page && text.length > 50) {
      return text.slice(0, 50) + '…';
    }
    return text;
  }, [node, fallbackText]);

  return {
    effectiveIcon,
    displayText,
    isPage: node?.is_page ?? true,
    color: node?.color || undefined,
  };
}
