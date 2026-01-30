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

// Re-export for convenience
export type { PropertyOperator, ContentOperator, PropertyType };

// ==================== Capability Model ====================

/**
 * Capabilities define what operations are allowed on a node
 * System queries use locked capabilities (UI-only, evaluator ignores)
 */
export interface NodeCapabilities {
  /** Can the node be deleted by the user? */
  removable: boolean;
  /** Can the node's values be edited? */
  editable: boolean;
  /** Can the node be reordered via drag & drop? */
  movable: boolean;
  /** Can the node participate in OR combinations or negation? */
  combinable: boolean;
  /** Should the node be visible in the UI? */
  visible: boolean;
}

/**
 * Default capabilities for user-created nodes
 */
export const DEFAULT_CAPABILITIES: NodeCapabilities = {
  removable: true,
  editable: true,
  movable: true,
  combinable: true,
  visible: true,
};

/**
 * Locked capabilities for system-defined nodes
 */
export const SYSTEM_CAPABILITIES: NodeCapabilities = {
  removable: false,
  editable: false,
  movable: false,
  combinable: false,
  visible: true,
};

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
  | 'all'               // All nodes in the graph
  | 'pages'             // All pages only (is_page=true)
  | 'current';          // Descendants of current node (PARENT_PATH)

/**
 * Scope node - defines the starting point for query execution
 */
export interface ScopeNode {
  type: 'scope';
  scope_type: ScopeType;
  // For specific_pages scope type
  page_uuids?: string[];
  // For parent_path filtering (nodes inside specific pages)
  include_descendants?: boolean;
  // For negated scope filters
  excluded_page_uuids?: string[];
}

// ==================== Condition Node ====================

/**
 * Condition types
 */
export type ConditionType =
  | 'class'
  | 'property'
  | 'content'
  | 'reference'
  | 'reference_path'
  | 'parent'
  | 'parent_path'
  | 'child'
  | 'child_path'
  | 'class_path';

/**
 * Base condition node
 */
export interface BaseConditionNode {
  type: 'condition';
  condition_type: ConditionType;
  /** Capabilities control what operations are allowed (default: all true) */
  capabilities?: NodeCapabilities;
}

/**
 * Class condition - filter by node class
 */
export interface ClassCondition extends BaseConditionNode {
  condition_type: 'class';
  class_uuid: string;
  class_id?: number;
  // For dynamic mode: comma-separated UUIDs
  class_uuids?: string[];
  operator?: 'is' | 'is_not' | 'contains' | 'does_not_contain' | 'defined' | 'not_defined';  // Default: 'contains'
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
  // For dynamic mode: comma-separated UUIDs
  target_uuids?: string[];
  operator?: 'references' | 'does_not_reference' | 'has_references' | 'has_no_references';  // Default: 'references'
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
 * Parent condition - filter by direct parent
 */
export interface ParentCondition extends BaseConditionNode {
  condition_type: 'parent';
  nested_group: GroupNode;
  operator?: 'has_parent' | 'has_no_parent';  // Default: 'has_parent'
}

/**
 * Parent path condition - filter by nodes with ancestors matching criteria
 */
export interface ParentPathCondition extends BaseConditionNode {
  condition_type: 'parent_path';
  nested_group: GroupNode;
  max_depth?: number;
}

/**
 * Child condition - filter by direct children
 */
export interface ChildCondition extends BaseConditionNode {
  condition_type: 'child';
  operator?: 'has_child' | 'has_no_child';  // Default: 'has_child'
  nested_group: GroupNode;
}

/**
 * Child path condition - filter by descendants
 */
export interface ChildPathCondition extends BaseConditionNode {
  condition_type: 'child_path';
  nested_group: GroupNode;
  max_depth?: number;
}

/**
 * Class path condition - filter by inherited classes from ancestors
 */
export interface ClassPathCondition extends BaseConditionNode {
  condition_type: 'class_path';
  nested_group: GroupNode;
}

/**
 * Union type for all conditions
 */
export type ConditionNode =
  | ClassCondition
  | PropertyCondition
  | ContentCondition
  | ReferenceCondition
  | ReferencePathCondition
  | ParentCondition
  | ParentPathCondition
  | ChildCondition
  | ChildPathCondition
  | ClassPathCondition;

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
  /** Capabilities control what operations are allowed (default: all true) */
  capabilities?: NodeCapabilities;
}

// ==================== Not Node ====================

/**
 * Not node - negates a condition or group
 */
export interface NotNode {
  type: 'not';
  child: ConditionNode | GroupNode | NotNode;
  /** Capabilities control what operations are allowed (default: all true) */
  capabilities?: NodeCapabilities;
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
  
  // System queries are read-only (e.g., linked references, child pages)
  is_system?: boolean;
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
 * Create a class condition
 */
export function createClassCondition(classUuid: string, classId?: number): ClassCondition {
  return {
    type: 'condition',
    condition_type: 'class',
    class_uuid: classUuid,
    class_id: classId,
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

// ==================== Capability Helpers ====================

/**
 * Check if a node is a system node (locked capabilities)
 */
export function isSystemNode(node: ConditionNode | GroupNode | NotNode): boolean {
  const caps = node.capabilities;
  if (!caps) return false;
  return !caps.removable && !caps.editable && !caps.movable && caps.visible;
}

/**
 * Check if a node is editable
 */
export function isNodeEditable(node: ConditionNode | GroupNode | NotNode): boolean {
  return node.capabilities?.editable ?? true;
}

/**
 * Check if a node is removable
 */
export function isNodeRemovable(node: ConditionNode | GroupNode | NotNode): boolean {
  return node.capabilities?.removable ?? true;
}

/**
 * Check if a node is movable
 */
export function isNodeMovable(node: ConditionNode | GroupNode | NotNode): boolean {
  return node.capabilities?.movable ?? true;
}

/**
 * Mark a node as a system node (locked)
 */
export function markAsSystemNode<T extends ConditionNode | GroupNode | NotNode>(node: T): T {
  return {
    ...node,
    capabilities: SYSTEM_CAPABILITIES,
  };
}
