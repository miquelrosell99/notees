/**
 * useNodeIcon Hook
 * 
 * A hook that returns the effective icon for a node, considering class inheritance.
 */
import { useMemo } from 'react';
import { useClasses } from './useNodes';
import { getEffectiveIcon, getEffectiveIconFromClasses } from '@/utils/nodeIcon';
import type { Node } from '@/types';

/**
 * Hook to get the effective icon for a node.
 * 
 * Automatically fetches all classes and resolves the icon based on:
 * 1. Node's own icon (highest priority)
 * 2. First assigned class's icon (if node has classes)
 * 3. undefined (for default fallback)
 * 
 * @param node - The node to get the icon for
 * @returns The effective icon string or undefined
 */
export function useNodeIcon(node: Node | null | undefined): string | null | undefined {
  const { data: allClasses } = useClasses();
  
  return useMemo(() => {
    return getEffectiveIcon(node, allClasses);
  }, [node, allClasses]);
}

/**
 * Hook to get the effective icon when you already have resolved class nodes.
 * 
 * Use this when you've already resolved the class nodes for performance.
 * 
 * @param node - The node to get the icon for
 * @param nodeClasses - The resolved class nodes for this node
 * @returns The effective icon string or undefined
 */
export function useNodeIconFromClasses(
  node: Node | null | undefined,
  nodeClasses: Node[] | null | undefined
): string | null | undefined {
  return useMemo(() => {
    return getEffectiveIconFromClasses(node, nodeClasses);
  }, [node, nodeClasses]);
}

// Re-export utility functions for direct use
export { getEffectiveIcon, getEffectiveIconFromClasses } from '@/utils/nodeIcon';
