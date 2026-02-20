/**
 * Node Icon Utilities
 * 
 * Functions for determining the effective icon to display for a node.
 * Nodes can inherit icons from their assigned classes.
 */
import type { Node } from '@/types';
import { parseIconField, formatIconField } from './iconDom';

/**
 * Get the effective icon for a node.
 * 
 * Priority:
 * 1. Node's own icon (if set) - overrides everything
 * 2. First class's icon (if the node has classes and the class has an icon)
 * 3. undefined (fallback to default icon based on node type)
 * 
 * @param node - The node to get the icon for
 * @param allClasses - All available class nodes (to resolve class icons)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIcon(
  node: Node | null | undefined,
  allClasses?: Node[] | null
): string | null | undefined {
  if (!node) return undefined;

  if (node.icon) {
    const { icon: iconName, color } = parseIconField(node.icon);
    // If an explicit icon name is set, use the field as-is (color is embedded)
    if (iconName) return node.icon;
    // Color-only: find inherited icon and re-encode with node's color
    if (color) {
      const classIds = node.classes;
      if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
        for (const classId of classIds) {
          const classNode = allClasses.find(c => c.id === classId);
          if (classNode?.icon) {
            const { icon: inheritedIcon } = parseIconField(classNode.icon);
            return formatIconField(inheritedIcon || classNode.icon, color);
          }
        }
      }
      // No inherited icon — keep the color-only field so NodeIcon can tint the default
      return node.icon;
    }
  }

  // If the node has classes and we have class data, try to inherit icon from first class with an icon
  const classIds = node.classes;
  if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
    for (const classId of classIds) {
      const classNode = allClasses.find(c => c.id === classId);
      if (classNode?.icon) {
        return classNode.icon;
      }
    }
  }

  // No icon found - return undefined to allow default behavior
  return undefined;
}

/**
 * Get the effective icon for a node when you have the class nodes already resolved.
 * 
 * @param node - The node to get the icon for
 * @param nodeClasses - The resolved class nodes for this node (in order)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIconFromClasses(
  node: Node | null | undefined,
  nodeClasses?: Node[] | null
): string | null | undefined {
  if (!node) return undefined;

  if (node.icon) {
    const { icon: iconName, color } = parseIconField(node.icon);
    if (iconName) return node.icon;
    if (color) {
      if (nodeClasses && nodeClasses.length > 0) {
        for (const classNode of nodeClasses) {
          if (classNode?.icon) {
            const { icon: inheritedIcon } = parseIconField(classNode.icon);
            return formatIconField(inheritedIcon || classNode.icon, color);
          }
        }
      }
      return node.icon;
    }
  }

  // Find the first class with an icon
  if (nodeClasses && nodeClasses.length > 0) {
    for (const classNode of nodeClasses) {
      if (classNode?.icon) {
        return classNode.icon;
      }
    }
  }

  // No icon found - return undefined to allow default behavior
  return undefined;
}
