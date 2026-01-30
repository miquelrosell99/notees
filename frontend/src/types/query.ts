/**
 * Query Block Types
 * 
 * TypeScript types for the query block tree system.
 * Used by NodeViews to define dynamic queries for node collections.
 */

// ==================== Query Block Types ====================

/**
 * Types of blocks that can appear in a query block tree
 */
export type QueryBlockType =
  | 'AND_CONTAINER'
  | 'OR_CONTAINER'
  | 'NOT_CONTAINER'
  | 'CLASS'
  | 'PROPERTY'
  | 'CONTENT'
  | 'REFERENCE'
  | 'REFERENCE_PATH'
  | 'PARENT'
  | 'PARENT_PATH'
  | 'CHILD'
  | 'CHILD_PATH'
  | 'CLASS_PATH'
  | 'UUID';

/**
 * Operators for property conditions
 */
export type PropertyOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in';

/**
 * Operators for content/text search conditions
 */
export type ContentOperator =
  | 'contains'
  | '='
  | 'starts_with'
  | 'ends_with'
  | 'matches_regex'
  | 'fts';

/**
 * Property types for property filter blocks
 */
export type PropertyType =
  | 'text'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'selection'
  | 'node'
  | 'date';

// ==================== Block Interfaces ====================

/**
 * Base interface for all query blocks
 */
export interface BaseQueryBlock {
  type: QueryBlockType;
}

/**
 * AND/OR container block
 */
export interface ContainerBlock extends BaseQueryBlock {
  type: 'AND_CONTAINER' | 'OR_CONTAINER';
  blocks: QueryBlock[];
}

/**
 * NOT container block
 */
export interface NotBlock extends BaseQueryBlock {
  type: 'NOT_CONTAINER';
  block?: QueryBlock;
}

/**
 * Class filter block
 */
export interface ClassBlock extends BaseQueryBlock {
  type: 'CLASS';
  value: string; // Type name or UUID
  type_id?: number; // Resolved type node ID
}

/**
 * Property filter block
 */
export interface PropertyBlock extends BaseQueryBlock {
  type: 'PROPERTY';
  property_name: string;
  property_id?: number;
  property_type: PropertyType;
  operator: PropertyOperator;
  value?: unknown;
}

/**
 * Content/name filter block
 */
export interface ContentBlock extends BaseQueryBlock {
  type: 'CONTENT';
  operator: ContentOperator;
  value: string;
  case_sensitive?: boolean;
}

/**
 * Reference filter block - nodes that reference a specific target
 */
export interface ReferenceBlock extends BaseQueryBlock {
  type: 'REFERENCE';
  target_uuid: string; // UUID or placeholder like {current_node_uuid}
  target_id?: number;
  blocks?: QueryBlock[]; // Optional nested filters for the referencing nodes
}

/**
 * Reference path filter block - nodes that reference nodes matching criteria
 */
export interface ReferencePathBlock extends BaseQueryBlock {
  type: 'REFERENCE_PATH';
  blocks: QueryBlock[]; // Filters for what the references should match
}

/**
 * Parent filter block - nodes with direct parent matching criteria
 */
export interface ParentBlock extends BaseQueryBlock {
  type: 'PARENT';
  blocks: QueryBlock[]; // Filters for what the parent should match
}

/**
 * Parent path filter block - nodes with ancestors matching criteria
 */
export interface ParentPathBlock extends BaseQueryBlock {
  type: 'PARENT_PATH';
  blocks: QueryBlock[]; // Filters for what ancestors should match
  max_depth?: number;
}

/**
 * Child filter block - nodes with direct children matching criteria
 */
export interface ChildBlock extends BaseQueryBlock {
  type: 'CHILD';
  blocks: QueryBlock[]; // Filters for what children should match
}

/**
 * Child path filter block - nodes with descendants matching criteria
 */
export interface ChildPathBlock extends BaseQueryBlock {
  type: 'CHILD_PATH';
  blocks: QueryBlock[]; // Filters for what descendants should match
  max_depth?: number;
}

/**
 * Class path filter block - nodes with inherited classes from ancestors
 */
export interface ClassPathBlock extends BaseQueryBlock {
  type: 'CLASS_PATH';
  blocks: QueryBlock[]; // Filters for what classes should be in the path
}

/**
 * UUID filter block
 */
export interface UuidBlock extends BaseQueryBlock {
  type: 'UUID';
  value: string; // UUID or placeholder like {current_node_uuid}
}

/**
 * Union type for all query blocks
 */
export type QueryBlock =
  | ContainerBlock
  | NotBlock
  | ClassBlock
  | PropertyBlock
  | ContentBlock
  | ReferenceBlock
  | ReferencePathBlock
  | ParentBlock
  | ParentPathBlock
  | ChildBlock
  | ChildPathBlock
  | ClassPathBlock
  | UuidBlock;

/**
 * Root of a query block tree - always a container
 */
export interface QueryBlockTree {
  type: 'AND_CONTAINER' | 'OR_CONTAINER';
  blocks: QueryBlock[];
  // Scope is stored separately, not encoded in blocks
  scope?: {
    scope_type: 'all' | 'pages' | 'current';
  };
}

// ==================== NodeView Types ====================

/**
 * View types for NodeViews
 */
export type NodeViewType =
  | 'child_pages'
  | 'classed_nodes'
  | 'linked_references'
  | 'main_content'
  | 'all_pages';

/**
 * NodeView entity - defines a dynamic query tab for a node
 */
export interface NodeView {
  id: number;
  uuid: string;
  node_id: number;
  name: string;
  view_type: NodeViewType | string;
  order_index: number;
  is_default: boolean;
  active: boolean;
  shown_properties: Array<{ uuid: string; sequence: number }>;
  group_by: string | null;
  create_date: string;
  write_date: string;
  // Query block tree is stored directly on the view
  query_block_tree?: QueryBlockTree;
}

/**
 * Request to create a NodeView
 */
export interface NodeViewCreate {
  node_id: number;
  name: string;
  view_type: string;
  order_index?: number;
  is_default?: boolean;
  query_block_tree?: QueryBlockTree;
}

/**
 * Request to update a NodeView
 */
export interface NodeViewUpdate {
  name?: string;
  order_index?: number;
  is_default?: boolean;
  shown_properties?: Array<{ uuid: string; sequence: number }>;
  group_by?: string | null;
}

/**
 * Request to execute a query
 */
export interface QueryExecuteRequest {
  block_tree?: QueryBlockTree;
  runtime_params?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order_by?: string;
  include_children?: boolean;
  include_properties?: boolean;
}

// ==================== Runtime Parameters ====================

/**
 * Known runtime parameter placeholders
 */
export const QUERY_PLACEHOLDERS = {
  '{current_node_uuid}': 'The UUID of the current node being viewed',
  '{current_node_id}': 'The ID of the current node being viewed',
  '{current_user_id}': 'The ID of the current user',
  '{today}': "Today's date",
  '{this_week}': 'Start of current week',
  '{this_month}': 'Start of current month',
  '{this_year}': 'Start of current year',
} as const;

export type QueryPlaceholder = keyof typeof QUERY_PLACEHOLDERS;

// ==================== Helper Functions ====================

/**
 * Create an empty query block tree (AND container with no blocks)
 */
export function createEmptyBlockTree(): QueryBlockTree {
  return {
    type: 'AND_CONTAINER',
    blocks: [],
  };
}

/**
 * Create a class filter block
 */
export function createClassBlock(value: string, classId?: number): ClassBlock {
  return {
    type: 'CLASS',
    value,
    type_id: typeId,
  };
}

/**
 * Create a property filter block
 */
export function createPropertyBlock(
  propertyName: string,
  operator: PropertyOperator,
  value: unknown,
  propertyType: PropertyType = 'text',
): PropertyBlock {
  return {
    type: 'PROPERTY',
    property_name: propertyName,
    property_type: propertyType,
    operator,
    value,
  };
}

/**
 * Create a content filter block
 */
export function createContentBlock(
  operator: ContentOperator,
  value: string,
  caseSensitive = false,
): ContentBlock {
  return {
    type: 'CONTENT',
    operator,
    value,
    case_sensitive: caseSensitive,
  };
}

/**
 * Create a reference filter block
 */
export function createReferenceBlock(
  targetUuid: string,
  nestedBlocks?: QueryBlock[],
): ReferenceBlock {
  return {
    type: 'REFERENCE',
    target_uuid: targetUuid,
    blocks: nestedBlocks,
  };
}

/**
 * Create a parent filter block
 */
export function createParentBlock(
  nestedBlocks: QueryBlock[],
): ParentBlock {
  return {
    type: 'PARENT',
    blocks: nestedBlocks,
  };
}

/**
 * Create a parent path filter block
 */
export function createParentPathBlock(
  nestedBlocks: QueryBlock[],
  maxDepth?: number,
): ParentPathBlock {
  return {
    type: 'PARENT_PATH',
    blocks: nestedBlocks,
    max_depth: maxDepth,
  };
}

/**
 * Create a child filter block
 */
export function createChildBlock(
  nestedBlocks: QueryBlock[],
): ChildBlock {
  return {
    type: 'CHILD',
    blocks: nestedBlocks,
  };
}

/**
 * Create a child path filter block
 */
export function createChildPathBlock(
  nestedBlocks: QueryBlock[],
  maxDepth?: number,
): ChildPathBlock {
  return {
    type: 'CHILD_PATH',
    blocks: nestedBlocks,
    max_depth: maxDepth,
  };
}

/**
 * Create a class path filter block
 */
export function createClassPathBlock(
  nestedBlocks: QueryBlock[],
): ClassPathBlock {
  return {
    type: 'CLASS_PATH',
    blocks: nestedBlocks,
  };
}

/**
 * Check if a block is a container
 */
export function isContainerBlock(block: QueryBlock): block is ContainerBlock {
  return block.type === 'AND_CONTAINER' || block.type === 'OR_CONTAINER';
}

/**
 * Check if a query block tree is empty
 */
export function isEmptyBlockTree(tree: QueryBlockTree): boolean {
  return tree.blocks.length === 0;
}

/**
 * Get human-readable label for a block type
 */
export function getBlockTypeLabel(type: QueryBlockType): string {
  const labels: Record<QueryBlockType, string> = {
    AND_CONTAINER: 'All of (AND)',
    OR_CONTAINER: 'Any of (OR)',
    NOT_CONTAINER: 'Not',
    CLASS: 'Class',
    PROPERTY: 'Property',
    CONTENT: 'Content',
    REFERENCE: 'References',
    REFERENCE_PATH: 'References Matching',
    PARENT_PATH: 'Inside',
    UUID: 'UUID',
  };
  return labels[type] || type;
}

/**
 * Get human-readable label for an operator
 */
export function getOperatorLabel(operator: PropertyOperator | ContentOperator): string {
  const labels: Record<string, string> = {
    '=': 'equals',
    '!=': 'not equals',
    '>': 'greater than',
    '>=': 'greater than or equal',
    '<': 'less than',
    '<=': 'less than or equal',
    contains: 'contains',
    starts_with: 'starts with',
    ends_with: 'ends with',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
    in: 'in',
    not_in: 'not in',
    matches_regex: 'matches regex',
    fts: 'full-text search',
  };
  return labels[operator] || operator;
}
