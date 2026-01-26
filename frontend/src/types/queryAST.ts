/**
 * Query AST Types
 * 
 * Abstract Syntax Tree representation for queries.
 * This is the single source of truth for query semantics.
 * 
 * Design principles:
 * - AST is serializable (JSON)
 * - AST is validatable
 * - AST is the source of truth (UI is a projection)
 * - AST is forward-compatible and extensible
 * - AST maintains backward compatibility with QueryBlockTree
 */

import type { PropertyOperator, ContentOperator, PropertyType } from './query';

// ==================== AST Node Types ====================

export type ASTNodeType =
  | 'query'
  | 'scope'
  | 'group'
  | 'condition'
  | 'not';

// ==================== Scope Node ====================

/**
 * Scope types define the universe of nodes to query
 */
export type ScopeType =
  | 'entire_graph'      // All nodes in the graph
  | 'current_page'      // Current page being viewed
  | 'specific_pages'    // Explicitly selected pages
  | 'linked_refs';      // Nodes that reference the current page

/**
 * Scope node - defines the starting point for query execution
 */
export interface ScopeNode {
  type: 'scope';
  scope_type: ScopeType;
  // For specific_pages scope type
  page_uuids?: string[];
  // For ancestor_path filtering (nodes inside specific pages)
  include_descendants?: boolean;
  // For negated scope filters
  excluded_page_uuids?: string[];
}

// ==================== Condition Node ====================

/**
 * Condition types
 */
export type ConditionType =
  | 'type'
  | 'property'
  | 'content'
  | 'reference'
  | 'reference_path'
  | 'ancestor_path';

/**
 * Base condition node
 */
export interface BaseConditionNode {
  type: 'condition';
  condition_type: ConditionType;
}

/**
 * Type condition - filter by node type
 */
export interface TypeCondition extends BaseConditionNode {
  condition_type: 'type';
  type_uuid: string;
  type_id?: number;
}

/**
 * Property condition - filter by property value
 */
export interface PropertyCondition extends BaseConditionNode {
  condition_type: 'property';
  property_name: string;
  property_id?: number;
  property_type: PropertyType;
  operator: PropertyOperator;
  value?: unknown;
}

/**
 * Content condition - filter by content/name
 */
export interface ContentCondition extends BaseConditionNode {
  condition_type: 'content';
  operator: ContentOperator;
  value: string;
  case_sensitive?: boolean;
}

/**
 * Reference condition - filter by references
 */
export interface ReferenceCondition extends BaseConditionNode {
  condition_type: 'reference';
  target_uuid: string;
  target_id?: number;
  // Optional nested group for filtering the referencing nodes
  nested_group?: GroupNode;
}

/**
 * Reference path condition - filter by nodes that reference nodes matching criteria
 */
export interface ReferencePathCondition extends BaseConditionNode {
  condition_type: 'reference_path';
  nested_group: GroupNode;
}

/**
 * Ancestor path condition - filter by nodes with ancestors matching criteria
 */
export interface AncestorPathCondition extends BaseConditionNode {
  condition_type: 'ancestor_path';
  nested_group: GroupNode;
  max_depth?: number;
}

/**
 * Union type for all conditions
 */
export type ConditionNode =
  | TypeCondition
  | PropertyCondition
  | ContentCondition
  | ReferenceCondition
  | ReferencePathCondition
  | AncestorPathCondition;

// ==================== Group Node ====================

/**
 * Logic type for how conditions in a group combine
 */
export type LogicType = 'AND' | 'OR';

/**
 * Group node - contains conditions and nested groups
 */
export interface GroupNode {
  type: 'group';
  logic: LogicType;
  children: (ConditionNode | GroupNode | NotNode)[];
}

// ==================== Not Node ====================

/**
 * Not node - negates a condition or group
 */
export interface NotNode {
  type: 'not';
  child: ConditionNode | GroupNode;
}

// ==================== Query Root ====================

/**
 * Query AST root - the complete query representation
 */
export interface QueryAST {
  type: 'query';
  version: '1.0'; // For future compatibility
  id?: string; // Stable identifier for query identity
  
  // The scope defines where we're querying
  scope: ScopeNode;
  
  // The root group contains all conditions and logic
  root_group: GroupNode;
  
  // Metadata
  created_at?: string;
  updated_at?: string;
  description?: string; // Human-readable description
}

// ==================== Validation Types ====================

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  severity: ValidationSeverity;
  message: string;
  path?: string[]; // Path to the problematic node in the AST
  suggestion?: string; // How to fix it
}

// ==================== Helper Functions ====================

/**
 * Create an empty query AST
 */
export function createEmptyQueryAST(): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'current_page',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [],
    },
  };
}

/**
 * Create a scope node
 */
export function createScopeNode(scopeType: ScopeType, pageUuids?: string[]): ScopeNode {
  return {
    type: 'scope',
    scope_type: scopeType,
    page_uuids: pageUuids,
  };
}

/**
 * Create a group node
 */
export function createGroupNode(logic: LogicType = 'AND'): GroupNode {
  return {
    type: 'group',
    logic,
    children: [],
  };
}

/**
 * Create a not node
 */
export function createNotNode(child: ConditionNode | GroupNode): NotNode {
  return {
    type: 'not',
    child,
  };
}

/**
 * Create a type condition
 */
export function createTypeCondition(typeUuid: string, typeId?: number): TypeCondition {
  return {
    type: 'condition',
    condition_type: 'type',
    type_uuid: typeUuid,
    type_id: typeId,
  };
}

/**
 * Create a property condition
 */
export function createPropertyCondition(
  propertyName: string,
  operator: PropertyOperator,
  value: unknown,
  propertyType: PropertyType = 'text',
): PropertyCondition {
  return {
    type: 'condition',
    condition_type: 'property',
    property_name: propertyName,
    property_type: propertyType,
    operator,
    value,
  };
}

/**
 * Create a content condition
 */
export function createContentCondition(
  operator: ContentOperator,
  value: string,
  caseSensitive = false,
): ContentCondition {
  return {
    type: 'condition',
    condition_type: 'content',
    operator,
    value,
    case_sensitive: caseSensitive,
  };
}

/**
 * Check if a query AST is empty (no conditions)
 */
export function isEmptyQuery(ast: QueryAST): boolean {
  return ast.root_group.children.length === 0;
}

/**
 * Count total number of conditions in a query
 */
export function countConditions(ast: QueryAST): number {
  function countInGroup(group: GroupNode): number {
    let count = 0;
    for (const child of group.children) {
      if (child.type === 'condition') {
        count++;
      } else if (child.type === 'group') {
        count += countInGroup(child);
      } else if (child.type === 'not') {
        if (child.child.type === 'condition') {
          count++;
        } else {
          count += countInGroup(child.child);
        }
      }
    }
    return count;
  }
  
  return countInGroup(ast.root_group);
}

/**
 * Get maximum nesting depth of groups
 */
export function getMaxDepth(ast: QueryAST): number {
  function getGroupDepth(group: GroupNode, currentDepth: number): number {
    let maxDepth = currentDepth;
    for (const child of group.children) {
      if (child.type === 'group') {
        const childDepth = getGroupDepth(child, currentDepth + 1);
        maxDepth = Math.max(maxDepth, childDepth);
      } else if (child.type === 'not' && child.child.type === 'group') {
        const childDepth = getGroupDepth(child.child, currentDepth + 1);
        maxDepth = Math.max(maxDepth, childDepth);
      }
    }
    return maxDepth;
  }
  
  return getGroupDepth(ast.root_group, 1);
}
