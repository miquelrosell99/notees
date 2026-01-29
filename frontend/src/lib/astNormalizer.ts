/**
 * AST Normalizer
 * 
 * Provides normalization functions that ensure the QueryAST is in its simplest,
 * most canonical form. These functions run on every edit to maintain a clean AST.
 * 
 * Normalization rules:
 * 1. Flatten single-child AND/OR groups
 * 2. Remove empty groups
 * 3. Ensure stable, minimal structure
 */

import type { QueryAST, GroupNode, ConditionNode, NotNode } from '@/types/queryAST';
import { isSystemNode } from '@/types/queryAST';

// ==================== Group Normalization ====================

/**
 * Normalize a group node by applying all normalization rules
 * Preserves system nodes (never removes or merges them)
 */
function normalizeGroup(group: GroupNode): GroupNode | ConditionNode | NotNode | null {
  // First, recursively normalize all children
  const normalizedChildren: (ConditionNode | GroupNode | NotNode)[] = [];
  
  for (const child of group.children) {
    if (child.type === 'group') {
      const normalized = normalizeGroup(child);
      if (normalized !== null) {
        normalizedChildren.push(normalized);
      }
    } else if (child.type === 'not') {
      // Normalize the child of NOT
      if (child.child.type === 'group') {
        const normalized = normalizeGroup(child.child);
        if (normalized !== null) {
          if (normalized.type === 'group' || normalized.type === 'condition') {
            normalizedChildren.push({ type: 'not', child: normalized });
          } else {
            // NOT of NOT - keep as is for now
            normalizedChildren.push(child);
          }
        }
      } else {
        // Keep condition as is
        normalizedChildren.push(child);
      }
    } else {
      // Condition - keep as is
      normalizedChildren.push(child);
    }
  }
  
  // If group is empty after normalization, remove it (unless it's a system node)
  if (normalizedChildren.length === 0) {
    return isSystemNode(group) ? group : null;
  }
  
  // If group has only one child, flatten it (unless it's a system node)
  if (normalizedChildren.length === 1 && !isSystemNode(group)) {
    return normalizedChildren[0];
  }
  
  // Otherwise, return the normalized group
  return {
    ...group,
    children: normalizedChildren,
  };
}

// ==================== Public API ====================

/**
 * Normalize a QueryAST to its canonical form
 * 
 * This function:
 * - Flattens single-child groups
 * - Removes empty groups
 * - Ensures the AST is in its simplest form
 * - Preserves system nodes (never removes or merges them)
 * 
 * @param ast The QueryAST to normalize
 * @returns A normalized QueryAST
 */
export function normalizeAST(ast: QueryAST): QueryAST {
  const normalized = normalizeGroup(ast.root_group);
  
  // If the root group normalized to nothing, create an empty group
  if (normalized === null) {
    return {
      ...ast,
      root_group: {
        type: 'group',
        logic: ast.root_group.logic,
        children: [],
      },
    };
  }
  
  // If the root group normalized to a single condition or NOT, wrap it back
  if (normalized.type === 'condition' || normalized.type === 'not') {
    return {
      ...ast,
      root_group: {
        type: 'group',
        logic: ast.root_group.logic,
        children: [normalized],
      },
    };
  }
  
  // Otherwise, use the normalized group
  return {
    ...ast,
    root_group: normalized,
  };
}

/**
 * Check if a group can be flattened (has only one child)
 */
export function canFlattenGroup(group: GroupNode): boolean {
  return group.children.length === 1;
}

/**
 * Check if a group is empty
 */
export function isGroupEmpty(group: GroupNode): boolean {
  return group.children.length === 0;
}

/**
 * Count how many levels of single-child groups exist
 */
export function countRedundantNesting(ast: QueryAST): number {
  let count = 0;
  
  function traverse(group: GroupNode): void {
    if (canFlattenGroup(group)) {
      count++;
      const child = group.children[0];
      if (child.type === 'group') {
        traverse(child);
      }
    }
  }
  
  traverse(ast.root_group);
  return count;
}
