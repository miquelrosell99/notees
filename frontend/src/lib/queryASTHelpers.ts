/**
 * AST Helpers
 * 
 * Utility functions for creating and manipulating QueryAST nodes.
 */

import type {
  ConditionNode,
  GroupNode,
  ScopeNode,
  QueryAST,
  TypeCondition,
  ContentCondition,
  PropertyCondition,
  ReferenceCondition,
  ContentOperator,
  PropertyOperator,
  PropertyType,
} from '@/types/queryAST';

// ==================== Factory Functions ====================

/**
 * Create a default scope node
 */
export function createDefaultScope(): ScopeNode {
  return {
    type: 'scope',
    scope_type: 'entire_graph',
  };
}

/**
 * Create an empty group node
 */
export function createEmptyGroup(logic: 'AND' | 'OR' = 'AND'): GroupNode {
  return {
    type: 'group',
    logic,
    children: [],
  };
}

/**
 * Create a default QueryAST
 */
export function createDefaultQueryAST(): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: createDefaultScope(),
    root_group: createEmptyGroup(),
    created_at: new Date().toISOString(),
  };
}

/**
 * Check if a query is a system query (read-only)
 */
export function isSystemQuery(query: QueryAST | null | undefined): boolean {
  return query?.is_system === true;
}

/**
 * Create a condition node from a QueryBlockType
 */
export function createConditionFromType(blockType: string): ConditionNode {
  switch (blockType) {
    case 'node-class':
    case 'class':
    case 'type':
      return {
        type: 'condition',
        condition_type: 'type',
        type_uuid: '', // Will be filled by user
      } as TypeCondition;
    
    case 'text':
    case 'content':
      return {
        type: 'condition',
        condition_type: 'content',
        operator: 'contains' as ContentOperator,
        value: '',
      } as ContentCondition;
    
    case 'property':
      return {
        type: 'condition',
        condition_type: 'property',
        property_name: '',
        property_type: 'text' as PropertyType,
        operator: 'equals' as PropertyOperator,
      } as PropertyCondition;
    
    case 'reference':
      return {
        type: 'condition',
        condition_type: 'reference',
        target_uuid: '', // Will be filled by user
      } as ReferenceCondition;
    
    default:
      // Default to content condition
      return {
        type: 'condition',
        condition_type: 'content',
        operator: 'contains' as ContentOperator,
        value: '',
      } as ContentCondition;
  }
}

// ==================== Manipulation Functions ====================

/**
 * Add a condition to a group
 */
export function addConditionToGroup(
  group: GroupNode,
  condition: ConditionNode
): GroupNode {
  return {
    ...group,
    children: [...group.children, condition],
  };
}

/**
 * Remove a child from a group by index
 */
export function removeChildFromGroup(
  group: GroupNode,
  index: number
): GroupNode {
  return {
    ...group,
    children: group.children.filter((_, i) => i !== index),
  };
}

/**
 * Update a child in a group by index
 */
export function updateChildInGroup(
  group: GroupNode,
  index: number,
  child: ConditionNode | GroupNode
): GroupNode {
  const newChildren = [...group.children];
  newChildren[index] = child;
  return {
    ...group,
    children: newChildren,
  };
}

/**
 * Add a nested group to a group
 */
export function addNestedGroup(
  group: GroupNode,
  logic: 'AND' | 'OR' = 'AND'
): GroupNode {
  return {
    ...group,
    children: [...group.children, createEmptyGroup(logic)],
  };
}

// ==================== Query Functions ====================

/**
 * Count total conditions in a query AST (recursive)
 */
export function countConditions(group: GroupNode): number {
  let count = 0;
  
  for (const child of group.children) {
    if (child.type === 'group') {
      count += countConditions(child);
    } else if (child.type === 'not') {
      // Count NOT as containing 1 condition
      count += 1;
    } else {
      count += 1;
    }
  }
  
  return count;
}

/**
 * Check if a group is empty (no conditions)
 */
export function isGroupEmpty(group: GroupNode): boolean {
  return group.children.length === 0;
}

/**
 * Get maximum nesting depth of groups
 */
export function getMaxDepth(group: GroupNode, currentDepth: number = 0): number {
  let maxDepth = currentDepth;
  
  for (const child of group.children) {
    if (child.type === 'group') {
      const childDepth = getMaxDepth(child, currentDepth + 1);
      maxDepth = Math.max(maxDepth, childDepth);
    } else if (child.type === 'not' && child.child.type === 'group') {
      const childDepth = getMaxDepth(child.child, currentDepth + 1);
      maxDepth = Math.max(maxDepth, childDepth);
    }
  }
  
  return maxDepth;
}
