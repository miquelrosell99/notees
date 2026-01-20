/**
 * Node Icon Utilities
 * 
 * Functions for determining the effective icon to display for a node.
 * Nodes can inherit icons from their assigned types.
 */
import type { Node } from '@/types';

/**
 * Get the effective icon for a node.
 * 
 * Priority:
 * 1. Node's own icon (if set) - overrides everything
 * 2. First type's icon (if the node has types and the type has an icon)
 * 3. undefined (fallback to default icon based on node type)
 * 
 * @param node - The node to get the icon for
 * @param allTypes - All available type nodes (to resolve type icons)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIcon(
  node: Node | null | undefined,
  allTypes?: Node[] | null
): string | null | undefined {
  if (!node) return undefined;
  
  // If the node has its own icon, use it (highest priority)
  if (node.icon) {
    return node.icon;
  }
  
  // If the node has types and we have type data, try to inherit icon from first type with an icon
  if (node.types && node.types.length > 0 && allTypes && allTypes.length > 0) {
    for (const typeId of node.types) {
      const typeNode = allTypes.find(t => t.id === typeId);
      if (typeNode?.icon) {
        return typeNode.icon;
      }
    }
  }
  
  // No icon found - return undefined to allow default behavior
  return undefined;
}

/**
 * Get the effective icon for a node when you have the type nodes already resolved.
 * 
 * @param node - The node to get the icon for
 * @param nodeTypes - The resolved type nodes for this node (in order)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIconFromTypes(
  node: Node | null | undefined,
  nodeTypes?: Node[] | null
): string | null | undefined {
  if (!node) return undefined;
  
  // If the node has its own icon, use it (highest priority)
  if (node.icon) {
    return node.icon;
  }
  
  // Find the first type with an icon
  if (nodeTypes && nodeTypes.length > 0) {
    for (const typeNode of nodeTypes) {
      if (typeNode?.icon) {
        return typeNode.icon;
      }
    }
  }
  
  // No icon found - return undefined to allow default behavior
  return undefined;
}
