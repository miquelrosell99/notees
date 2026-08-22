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
 */

// ==================== Operator Types ====================

/**
 * Operators for property conditions
 * Matches backend: PropertyOperator enum
 */
export type PropertyOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'less_than'
  | 'gte'
  | 'lte'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in';

/**
 * Operators for content/text search conditions
 * Matches backend: ContentOperator enum
 */
export type ContentOperator =
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'equals'
  | 'regex'
  | 'fts';

/**
 * Operators for style/formatting conditions
 */
export type StyleOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'does_not_contain';

/**
 * Style types for formatting filter conditions
 */
export type StyleType =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'broken_link';

/**
 * Property types for property filter conditions in query AST nodes.
 * Matches backend: PropertyType enum
 *
 * NOTE: Named QueryPropertyType (not PropertyType) to avoid ambiguity with
 * the api.ts PropertyType union which covers the full set of property storage types.
 */
export type QueryPropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'selection'
  | 'node'
  | 'url'
  | 'email';

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
 * Locked capabilities for system-defined nodes (visible in query builder)
 */
export const SYSTEM_CAPABILITIES: NodeCapabilities = {
  removable: false,
  editable: false,
  movable: false,
  combinable: false,
  visible: true,
};

/**
 * Locked capabilities for hidden system nodes (enforced by backend, not shown in builder)
 */
export const HIDDEN_SYSTEM_CAPABILITIES: NodeCapabilities = {
  removable: false,
  editable: false,
  movable: false,
  combinable: false,
  visible: false,
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
 * Must match backend ScopeType enum exactly
 */
export type ScopeType =
  | 'entire_workspace'      // All nodes in the workspace
  | 'pages'             // All pages only (is_page=true)
  | 'current_page';     // Current page being viewed

/**
 * Scope node - defines the starting point for query execution
 */
export interface ScopeNode {
  type: 'scope';
  scope_type: ScopeType;
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
  | 'extends'
  | 'property'
  | 'content'
  | 'style'
  | 'reference'
  | 'reference_path'
  | 'parent'
  | 'parent_path'
  | 'child'
  | 'child_path'
  | 'page'
  | 'tag';

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
  // Optional to match the backend: an empty/missing class_uuid compiles to no
  // filter (match-all), e.g. the all_pages pseudo-query uses 'is_any_of'.
  class_uuid?: string;
  // For dynamic mode: comma-separated UUIDs
  class_uuids?: string[];
  operator?: 'is' | 'is_not' | 'contains' | 'does_not_contain' | 'defined' | 'not_defined' | 'is_any_of';  // Default: 'contains'
}

/**
 * Extends condition - filter by classes that extend a given class
 */
export interface ExtendsCondition extends BaseConditionNode {
  condition_type: 'extends';
  extends_class_uuid: string;
}

/**
 * Property condition - filter by property value
 */
export interface PropertyCondition extends BaseConditionNode {
  condition_type: 'property';
  property_name: string;
  property_uuid?: string;
  property_type: QueryPropertyType;
  operator: PropertyOperator;
  value?: unknown;
  // Optional nested group for filtering node values (when property_type is 'node')
  nested_group?: GroupNode;
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
 * Style condition - filter by text formatting (bold, italic, underline, strikethrough)
 */
export interface StyleCondition extends BaseConditionNode {
  condition_type: 'style';
  style_type: StyleType;
  operator: StyleOperator;
}

/**
 * Reference condition - filter by references
 */
export interface ReferenceCondition extends BaseConditionNode {
  condition_type: 'reference';
  target_uuid: string;
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
  // Static mode: specific target node(s) being referenced
  target_uuids?: string[];
  // Dynamic mode: target nodes matching criteria
  nested_group?: GroupNode;
}

/**
 * Parent condition - filter by direct parent
 */
export interface ParentCondition extends BaseConditionNode {
  condition_type: 'parent';
  // Static mode: specific parent(s)
  parent_uuid?: string;  // Legacy: single parent
  parent_uuids?: string[];  // Multiple parents
  // Dynamic mode: parent matching criteria
  nested_group?: GroupNode;
  operator?: 'has_parent' | 'not_has_parent' | 'has_no_parent' | 'has_any_parent';  // Default: 'has_parent'
}

/**
 * Parent path condition - filter by nodes with ancestors matching criteria
 */
export interface ParentPathCondition extends BaseConditionNode {
  condition_type: 'parent_path';
  // Static mode: specific ancestor(s)
  ancestor_uuids?: string[];
  // Dynamic mode: ancestors matching criteria
  nested_group?: GroupNode;
  max_depth?: number;
  operator?: 'has_ancestor' | 'not_has_ancestor' | 'has_no_ancestor' | 'has_any_ancestor';  // Default: 'has_ancestor'
}

/**
 * Child condition - filter by direct children
 */
export interface ChildCondition extends BaseConditionNode {
  condition_type: 'child';
  // Static mode: specific children
  child_uuids?: string[];
  // Dynamic mode: children matching criteria
  nested_group?: GroupNode;
  operator?: 'has_child' | 'not_has_child' | 'has_no_child' | 'has_any_child';  // Default: 'has_child'
}

/**
 * Child path condition - filter by descendants
 */
export interface ChildPathCondition extends BaseConditionNode {
  condition_type: 'child_path';
  // Static mode: specific descendant(s)
  descendant_uuids?: string[];
  // Dynamic mode: descendants matching criteria
  nested_group?: GroupNode;
  max_depth?: number;
  operator?: 'has_descendant' | 'not_has_descendant' | 'has_no_descendant' | 'has_any_descendant';  // Default: 'has_descendant'
}

/**
 * Page condition - filter by containing page (via page_uuid)
 */
export interface PageCondition extends BaseConditionNode {
  condition_type: 'page';
  // Static mode: specific page(s)
  page_uuid?: string;
  page_uuids?: string[];
  // Dynamic mode: page matching criteria
  nested_group?: GroupNode;
  operator?: 'is_page' | 'is_not_page' | 'has_no_page' | 'has_any_page';
}

/**
 * Tag condition - filter by descriptive tags (node.tag_uuids)
 */
export interface TagCondition extends BaseConditionNode {
  condition_type: 'tag';
  // Static mode: specific tag page(s)
  tag_uuid?: string;
  tag_uuids?: string[];
  operator?: 'is' | 'is_not' | 'has_any_tag' | 'has_no_tag';
}

/**
 * Union type for all conditions
 */
export type ConditionNode =
  | ClassCondition
  | ExtendsCondition
  | PropertyCondition
  | ContentCondition
  | StyleCondition
  | ReferenceCondition
  | ReferencePathCondition
  | ParentCondition
  | ParentPathCondition
  | ChildCondition
  | ChildPathCondition
  | PageCondition
  | TagCondition;

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

// ==================== Aggregation Node ====================

/**
 * Supported aggregate functions
 */
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * A single grouping dimension (builtin field or property UUID)
 */
export interface AggregationDimension {
  type: 'dimension';
  field: string; // builtin ('is_page', 'create_date', ...) or property UUID
  property_type?: QueryPropertyType; // required when field is a property UUID
}

/**
 * Aggregation measure (count or numeric aggregate of a field/property)
 */
export interface AggregationMeasure {
  type: 'measure';
  function: AggregateFunction;
  field?: string; // omitted/empty means count nodes; otherwise builtin or property UUID
  property_type?: QueryPropertyType; // required when field is a property UUID
}

/**
 * Aggregation definition for a query
 */
export interface AggregationNode {
  type: 'aggregation';
  dimensions: AggregationDimension[];
  measure: AggregationMeasure;
  // Legacy single-dimension fields (kept for backward compatibility)
  group_by?: string;
  group_by_property_type?: QueryPropertyType;
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
  
  // Optional aggregation (returns groups instead of nodes)
  aggregation?: AggregationNode;
  
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
      scope_type: 'pages',
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
export function createScopeNode(scopeType: ScopeType): ScopeNode {
  return {
    type: 'scope',
    scope_type: scopeType,
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
export function createClassCondition(classUuid: string): ClassCondition {
  return {
    type: 'condition',
    condition_type: 'class',
    class_uuid: classUuid,
  };
}

/**
 * Create a property condition
 */
export function createPropertyCondition(
  propertyName: string,
  operator: PropertyOperator,
  value: unknown,
  propertyType: QueryPropertyType = 'text',
  propertyUuid?: string,
): PropertyCondition {
  return {
    type: 'condition',
    condition_type: 'property',
    property_name: propertyName,
    ...(propertyUuid ? { property_uuid: propertyUuid } : {}),
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
  return !ast.root_group || ast.root_group.children.length === 0;
}

/**
 * Count total number of user (non-system) conditions in a query.
 * System conditions (marked with locked capabilities) are excluded from the count.
 */
export function countConditions(ast: QueryAST): number {
  function countInGroup(group: GroupNode): number {
    let count = 0;
    for (const child of group.children) {
      if (child.type === 'condition') {
        // Only count non-system conditions
        if (!isSystemNode(child)) {
          count++;
        }
      } else if (child.type === 'group') {
        count += countInGroup(child);
      } else if (child.type === 'not') {
        if (child.child.type === 'condition') {
          // Only count non-system conditions
          if (!isSystemNode(child.child)) {
            count++;
          }
        } else if (child.child.type === 'group') {
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
 * Check if a node is a system node (locked capabilities, visible or hidden)
 */
export function isSystemNode(node: ConditionNode | GroupNode | NotNode): boolean {
  if (!node) return false;
  const caps = node.capabilities;
  if (!caps) return false;
  return !caps.removable && !caps.editable && !caps.movable;
}

/**
 * Check if a node should be hidden from the query builder UI
 */
export function isHiddenSystemNode(node: ConditionNode | GroupNode | NotNode): boolean {
  if (!node) return false;
  return node.capabilities?.visible === false;
}

/**
 * Check if a node is editable
 */
export function isNodeEditable(node: ConditionNode | GroupNode | NotNode): boolean {
  if (!node) return false;
  return node.capabilities?.editable ?? true;
}

/**
 * Check if a node is removable
 */
export function isNodeRemovable(node: ConditionNode | GroupNode | NotNode): boolean {
  if (!node) return false;
  return node.capabilities?.removable ?? true;
}

/**
 * Mark a node as a system node (locked, visible in query builder)
 */
export function markAsSystemNode<T extends ConditionNode | GroupNode | NotNode>(node: T): T {
  return {
    ...node,
    capabilities: SYSTEM_CAPABILITIES,
  };
}

/**
 * Mark a node as a hidden system node (locked, not shown in query builder)
 */
export function markAsHiddenSystemNode<T extends ConditionNode | GroupNode | NotNode>(node: T): T {
  return {
    ...node,
    capabilities: HIDDEN_SYSTEM_CAPABILITIES,
  };
}
