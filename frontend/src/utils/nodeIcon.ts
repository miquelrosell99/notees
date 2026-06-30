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
  const visited = new Set<string>();
  const stack = [...(classNode.extends_uuid ?? [])];
  while (stack.length > 0) {
    const parentId = stack.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = allClasses.find(c => c.uuid === parentId);
    if (!parent) continue;
    const val = getter(parent);
    if (val) return val;
    // Continue up the chain
    if (parent.extends_uuid) {
      for (const grandparentId of parent.extends_uuid) {
        if (!visited.has(grandparentId)) stack.push(grandparentId);
      }
    }
  }
  return undefined;
}

/**
 * Resolve the effective icon for a class node, walking the Extends chain if needed.
 *
 * Uses the canonical class from `allClasses` when available, because generic
 * node responses (e.g. getNode, referenced_nodes) do not populate extends_uuid
 * while the /classes endpoints do.
 */
function resolveClassIcon(classNode: Node, allClasses: Node[]): string | null | undefined {
  const canonicalClass = allClasses.find(c => c.uuid === classNode.uuid) ?? classNode;
  if (canonicalClass.icon) return canonicalClass.icon;
  return resolveFromExtendsChain(canonicalClass, allClasses, n => n.icon);
}

/**
 * Resolve the effective color for a class node, walking the Extends chain if needed.
 *
 * Uses the canonical class from `allClasses` when available, because generic
 * node responses (e.g. getNode, referenced_nodes) do not populate extends_uuid
 * while the /classes endpoints do.
 */
function resolveClassColor(classNode: Node, allClasses: Node[]): string | null | undefined {
  const canonicalClass = allClasses.find(c => c.uuid === classNode.uuid) ?? classNode;
  if (canonicalClass.color) return canonicalClass.color;
  return resolveFromExtendsChain(canonicalClass, allClasses, n => n.color);
}

/**
 * Get the effective icon for a node.
 * 
 * Priority:
 * 1. Node's own icon (if set) - overrides everything
 * 2. Node's own Extends chain (if the node is a class)
 * 3. Aliased node's effective icon (for alias nodes)
 * 4. First assigned class's icon (from effectiveClassIds or node.classes)
 * 5. undefined (fallback to default icon based on node type)
 * 
 * @param node - The node to get the icon for
 * @param allClasses - All available class nodes (to resolve class icons)
 * @param effectiveClassIds - Override class IDs (e.g. inherited from aliased node)
 * @param aliasedNode - The aliased (main) node, if this node is an alias
 * @returns The effective icon string or undefined
 */
export function getEffectiveIcon(
  node: Node | null | undefined,
  allClasses?: Node[] | null,
  effectiveClassIds?: string[],
  aliasedNode?: Node | null,
): string | null | undefined {
  if (!node) return undefined;

  const classIds = effectiveClassIds ?? node.classes_uuid;

  if (node.icon) {
    const { icon: iconName, color } = parseIconField(node.icon);
    // If an explicit icon name is set, use the field as-is (color is embedded)
    if (iconName) return node.icon;
    // Color-only: find inherited icon and re-encode with node's color
    if (color) {
      // Check own extends chain first (for class nodes)
      const canonicalNode = allClasses?.find(c => c.uuid === node.uuid) ?? node;
      if (canonicalNode.extends_uuid && canonicalNode.extends_uuid.length > 0 && allClasses && allClasses.length > 0) {
        const extendsIcon = resolveFromExtendsChain(canonicalNode, allClasses, n => n.icon);
        if (extendsIcon) {
          const { icon: inheritedIcon } = parseIconField(extendsIcon);
          return formatIconField(inheritedIcon || extendsIcon, color);
        }
      }
      if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
        for (const classId of classIds) {
          const classNode = allClasses.find(c => c.uuid === classId);
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

  // Check own extends chain first (for class nodes).
  // Use the canonical class from allClasses when available because generic
  // node responses do not populate extends_uuid.
  const canonicalNode = allClasses?.find(c => c.uuid === node.uuid) ?? node;
  if (canonicalNode.extends_uuid && canonicalNode.extends_uuid.length > 0 && allClasses && allClasses.length > 0) {
    const extendsIcon = resolveFromExtendsChain(canonicalNode, allClasses, n => n.icon);
    if (extendsIcon) return extendsIcon;
  }

  // For aliases, resolve from the aliased (main) node
  if (aliasedNode) {
    const aliasedIcon = getEffectiveIcon(aliasedNode, allClasses);
    if (aliasedIcon) return aliasedIcon;
  }

  // If the node has classes and we have class data, try to inherit icon from first class with an icon
  if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
    for (const classId of classIds) {
      const classNode = allClasses.find(c => c.uuid === classId);
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
      const canonicalNode = classes.find(c => c.uuid === node.uuid) ?? node;
      if (canonicalNode.extends_uuid && canonicalNode.extends_uuid.length > 0 && classes.length > 0) {
        const extendsIcon = resolveFromExtendsChain(canonicalNode, classes, n => n.icon);
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
  const canonicalNode = classes.find(c => c.uuid === node.uuid) ?? node;
  if (canonicalNode.extends_uuid && canonicalNode.extends_uuid.length > 0 && classes.length > 0) {
    const extendsIcon = resolveFromExtendsChain(canonicalNode, classes, n => n.icon);
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
 * 3. Aliased node's effective color (for alias nodes)
 * 4. First assigned class's color (including Extends chain inheritance)
 * 5. undefined (no color)
 */
export function getEffectiveColor(
  node: Node | null | undefined,
  allClasses?: Node[] | null,
  effectiveClassIds?: string[],
  aliasedNode?: Node | null,
): string | null | undefined {
  if (!node) return undefined;
  if (node.color) return node.color;

  // Check own extends chain first (for class nodes).
  // Use the canonical class from allClasses when available because generic
  // node responses do not populate extends_uuid.
  const canonicalNode = allClasses?.find(c => c.uuid === node.uuid) ?? node;
  if (canonicalNode.extends_uuid && canonicalNode.extends_uuid.length > 0 && allClasses && allClasses.length > 0) {
    const extendsColor = resolveFromExtendsChain(canonicalNode, allClasses, n => n.color);
    if (extendsColor) return extendsColor;
  }

  // For aliases, resolve from the aliased (main) node
  if (aliasedNode) {
    const aliasedColor = getEffectiveColor(aliasedNode, allClasses);
    if (aliasedColor) return aliasedColor;
  }

  const classIds = effectiveClassIds ?? node.classes_uuid;
  if (classIds && classIds.length > 0 && allClasses && allClasses.length > 0) {
    for (const classId of classIds) {
      const classNode = allClasses.find(c => c.uuid === classId);
      if (!classNode) continue;
      const classColor = resolveClassColor(classNode, allClasses);
      if (classColor) return classColor;
    }
  }

  return undefined;
}
