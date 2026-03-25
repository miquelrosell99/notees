/**
 * Node Icon & Color Utilities
 * 
 * Functions for determining the effective icon and color to display for a node.
 * Nodes can inherit icons and colors from their assigned classes, and classes
 * can inherit from their Extends chain.
 */
import type { Node } from '@/types';
import { parseIconField, formatIconField } from './iconDom';

/**
 * Walk the Extends chain for a class to find the first inherited value of a field.
 * Uses depth-first traversal with cycle detection.
 */
function resolveFromExtendsChain(
  classNode: Node,
  allClasses: Node[],
  getter: (n: Node) => string | null | undefined,
): string | null | undefined {
  const visited = new Set<number>();
  const stack = [...(classNode.extends ?? [])];
  while (stack.length > 0) {
    const parentId = stack.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = allClasses.find(c => c.id === parentId);
    if (!parent) continue;
    const val = getter(parent);
    if (val) return val;
    // Continue up the chain
    if (parent.extends) {
      for (const grandparentId of parent.extends) {
        if (!visited.has(grandparentId)) stack.push(grandparentId);
      }
    }
  }
  return undefined;
}

/**
 * Resolve the effective icon for a class node, walking the Extends chain if needed.
 */
function resolveClassIcon(classNode: Node, allClasses: Node[]): string | null | undefined {
  if (classNode.icon) return classNode.icon;
  return resolveFromExtendsChain(classNode, allClasses, n => n.icon);
}

/**
 * Resolve the effective color for a class node, walking the Extends chain if needed.
 */
function resolveClassColor(classNode: Node, allClasses: Node[]): string | null | undefined {
  if (classNode.color) return classNode.color;
  return resolveFromExtendsChain(classNode, allClasses, n => n.color);
}

/**
 * Get the effective icon for a node.
 * 
 * Priority:
 * 1. Node's own icon (if set) - overrides everything
 * 2. Node's own Extends chain (if the node is a class)
 * 3. First assigned class's icon (from effectiveClassIds or node.classes)
 * 4. undefined (fallback to default icon based on node type)
 * 
 * @param node - The node to get the icon for
 * @param allClasses - All available class nodes (to resolve class icons)
 * @param effectiveClassIds - Override class IDs (e.g. inherited from aliased node)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIcon(
  node: Node | null | undefined,
  allClasses?: Node[] | null,
  effectiveClassIds?: number[],
): string | null | undefined {
  if (!node) return undefined;

  const classIds = effectiveClassIds ?? node.classes;

  if (node.icon) {
    const { icon: iconName, color } = parseIconField(node.icon);
    // If an explicit icon name is set, use the field as-is (color is embedded)
    if (iconName) return node.icon;
    // Color-only: find inherited icon and re-encode with node's color
    if (color) {
      // Check own extends chain first (for class nodes)
      if (node.extends && node.extends.length > 0 && allClasses && allClasses.length > 0) {
        const extendsIcon = resolveFromExtendsChain(node, allClasses, n => n.icon);
        if (extendsIcon) {
          const { icon: inheritedIcon } = parseIconField(extendsIcon);
          return formatIconField(inheritedIcon || extendsIcon, color);
        }
      }
      if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
        for (const classId of classIds) {
          const classNode = allClasses.find(c => c.id === classId);
          if (!classNode) continue;
          const classIcon = resolveClassIcon(classNode, allClasses);
          if (classIcon) {
            const { icon: inheritedIcon } = parseIconField(classIcon);
            return formatIconField(inheritedIcon || classIcon, color);
          }
        }
      }
      // No inherited icon — keep the color-only field so NodeIcon can tint the default
      return node.icon;
    }
  }

  // Check own extends chain first (for class nodes)
  if (node.extends && node.extends.length > 0 && allClasses && allClasses.length > 0) {
    const extendsIcon = resolveFromExtendsChain(node, allClasses, n => n.icon);
    if (extendsIcon) return extendsIcon;
  }

  // If the node has classes and we have class data, try to inherit icon from first class with an icon
  if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
    for (const classId of classIds) {
      const classNode = allClasses.find(c => c.id === classId);
      if (!classNode) continue;
      const classIcon = resolveClassIcon(classNode, allClasses);
      if (classIcon) {
        return classIcon;
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
 * @param allClasses - All classes (needed for Extends chain resolution)
 * @returns The effective icon string or undefined
 */
export function getEffectiveIconFromClasses(
  node: Node | null | undefined,
  nodeClasses?: Node[] | null,
  allClasses?: Node[] | null,
): string | null | undefined {
  if (!node) return undefined;
  const classes = allClasses ?? nodeClasses ?? [];

  if (node.icon) {
    const { icon: iconName, color } = parseIconField(node.icon);
    if (iconName) return node.icon;
    if (color) {
      // Check own extends chain first (for class nodes)
      if (node.extends && node.extends.length > 0 && classes.length > 0) {
        const extendsIcon = resolveFromExtendsChain(node, classes, n => n.icon);
        if (extendsIcon) {
          const { icon: inheritedIcon } = parseIconField(extendsIcon);
          return formatIconField(inheritedIcon || extendsIcon, color);
        }
      }
      if (nodeClasses && nodeClasses.length > 0) {
        for (const classNode of nodeClasses) {
          const classIcon = resolveClassIcon(classNode, classes);
          if (classIcon) {
            const { icon: inheritedIcon } = parseIconField(classIcon);
            return formatIconField(inheritedIcon || classIcon, color);
          }
        }
      }
      return node.icon;
    }
  }

  // Check own extends chain first (for class nodes)
  if (node.extends && node.extends.length > 0 && classes.length > 0) {
    const extendsIcon = resolveFromExtendsChain(node, classes, n => n.icon);
    if (extendsIcon) return extendsIcon;
  }

  // Find the first class with an icon (including via Extends chain)
  if (nodeClasses && nodeClasses.length > 0) {
    for (const classNode of nodeClasses) {
      const classIcon = resolveClassIcon(classNode, classes);
      if (classIcon) {
        return classIcon;
      }
    }
  }

  // No icon found - return undefined to allow default behavior
  return undefined;
}

/**
 * Get the effective color for a node.
 * 
 * Priority:
 * 1. Node's own color (if set) - overrides everything
 * 2. Node's own Extends chain (if the node is a class)
 * 3. First assigned class's color (including Extends chain inheritance)
 * 4. undefined (no color)
 */
export function getEffectiveColor(
  node: Node | null | undefined,
  allClasses?: Node[] | null,
  effectiveClassIds?: number[],
): string | null | undefined {
  if (!node) return undefined;
  if (node.color) return node.color;

  // Check own extends chain first (for class nodes)
  if (node.extends && node.extends.length > 0 && allClasses && allClasses.length > 0) {
    const extendsColor = resolveFromExtendsChain(node, allClasses, n => n.color);
    if (extendsColor) return extendsColor;
  }

  const classIds = effectiveClassIds ?? node.classes;
  if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
    for (const classId of classIds) {
      const classNode = allClasses.find(c => c.id === classId);
      if (!classNode) continue;
      const classColor = resolveClassColor(classNode, allClasses);
      if (classColor) return classColor;
    }
  }

  return undefined;
}
