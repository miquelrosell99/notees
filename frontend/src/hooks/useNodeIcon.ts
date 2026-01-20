/**
 * useNodeIcon Hook
 * 
 * A hook that returns the effective icon for a node, considering type inheritance.
 */
import { useMemo } from 'react';
import { useTypes } from './useNodes';
import { getEffectiveIcon, getEffectiveIconFromTypes } from '@/utils/nodeIcon';
import type { Node } from '@/types';

/**
 * Hook to get the effective icon for a node.
 * 
 * Automatically fetches all types and resolves the icon based on:
 * 1. Node's own icon (highest priority)
 * 2. First assigned type's icon (if node has types)
 * 3. undefined (for default fallback)
 * 
 * @param node - The node to get the icon for
 * @returns The effective icon string or undefined
 */
export function useNodeIcon(node: Node | null | undefined): string | null | undefined {
  const { data: allTypes } = useTypes();
  
  return useMemo(() => {
    return getEffectiveIcon(node, allTypes);
  }, [node, allTypes]);
}

/**
 * Hook to get the effective icon when you already have resolved type nodes.
 * 
 * Use this when you've already resolved the type nodes for performance.
 * 
 * @param node - The node to get the icon for
 * @param nodeTypes - The resolved type nodes for this node
 * @returns The effective icon string or undefined
 */
export function useNodeIconFromTypes(
  node: Node | null | undefined,
  nodeTypes: Node[] | null | undefined
): string | null | undefined {
  return useMemo(() => {
    return getEffectiveIconFromTypes(node, nodeTypes);
  }, [node, nodeTypes]);
}

// Re-export utility functions for direct use
export { getEffectiveIcon, getEffectiveIconFromTypes } from '@/utils/nodeIcon';
