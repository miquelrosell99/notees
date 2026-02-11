/**
 * Enhanced QueryAST Prose Renderer
 *
 * Unified prose grammar for rendering QueryAST nodes as natural language.
 * Every AST node implements a consistent interface for prose rendering.
 *
 * Design principles:
 * - Always reads as structured natural language
 * - Sentence fragments for conditions
 * - No mode switching between "sentence" and "rule list"
 * - Clear intent-first language
 */

import type {
  QueryAST,
  GroupNode,
  ConditionNode,
  NotNode,
  ScopeNode,
  ClassCondition,
  PropertyCondition,
  ContentCondition,
  ReferenceCondition,
  ReferencePathCondition,
  ParentCondition,
  ParentPathCondition,
  ChildCondition,
  ChildPathCondition,
  ClassPathCondition,
} from '@/types/queryAST';
import type { Node } from '@/types/api';

// ==================== Types ====================

/**
 * A fragment of prose that can be rendered
 */
export interface ProseFragment {
  /** The text content */
  text: string;
  /** Optional CSS class for styling */
  className?: string;
  /** Whether this fragment is system-defined (locked) */
  isSystem?: boolean;
}

/**
 * Node rendering capabilities
 */
export interface NodeProseCapabilities {
  /** Can this node be negated? */
  canNegate: boolean;
  /** Can this node be combined with others (OR, negation)? */
  combinable: boolean;
  /** Can this node have nested groups? */
  canNest: boolean;
}

// ==================== Query Label (Top-Level) ====================

/**
 * Generate the complete intent label for a query
 * This is the primary prose summary shown in the Intent Header
 */
export function getQueryIntent(ast: QueryAST, nodesMap?: Map<string, Node>): string {
  const scopePhrase = renderScopeProse(ast.scope);
  // Safety check for children array
  const conditions = Array.isArray(ast.root_group.children) ? ast.root_group.children : [];

  if (conditions.length === 0) {
    return `All nodes ${scopePhrase}`;
  }

  const conditionPhrase = renderGroupProse(ast.root_group, nodesMap);
  return `Nodes that ${conditionPhrase} ${scopePhrase}`;
}

// ==================== Scope Prose ====================

/**
 * Render scope as a prose phrase
 * Scopes define the universe of nodes to search
 */
export function renderScopeProse(scope: ScopeNode): string {
  switch (scope.scope_type) {
    case 'entire_graph':
      return 'in the entire graph';

    case 'pages':
      return 'in all pages';

    case 'current_page':
      if (scope.include_descendants) {
        return 'in this page and its descendants';
      }
      return 'in this page';

    default:
      return 'in unknown scope';
  }
}

/**
 * Get a short label for scope (for inline display)
 */
export function getScopeLabel(scope: ScopeNode): string {
  switch (scope.scope_type) {
    case 'entire_graph':
      return 'Entire graph';
    case 'pages':
      return 'All pages';
    case 'current_page':
      return scope.include_descendants ? 'This page (with children)' : 'This page';
    default:
      return 'Unknown scope';
  }
}

// ==================== Group Prose ====================

/**
 * Render a group node as prose
 * Returns a sentence fragment describing the condition
 */
export function renderGroupProse(group: GroupNode, nodesMap?: Map<string, Node>): string {
  if (group.children.length === 0) {
    return 'match any node';
  }

  if (group.children.length === 1) {
    return renderChildProse(group.children[0], nodesMap);
  }

  // Multiple children - combine with logic
  const childPhrases = group.children.map(child => renderChildProse(child, nodesMap));

  if (group.logic === 'AND') {
    return `match all of these: ${childPhrases.join(', ')}`;
  } else {
    return `match any of these: ${childPhrases.join(', or ')}`;
  }
}

/**
 * Render a child node (can be condition, group, or NOT)
 */
function renderChildProse(node: ConditionNode | GroupNode | NotNode, nodesMap?: Map<string, Node>): string {
  if (node.type === 'not') {
    const childPhrase = node.child.type === 'group'
      ? renderGroupProse(node.child, nodesMap)
      : renderConditionProse(node.child as ConditionNode, nodesMap);
    return `do not ${childPhrase}`;
  }

  if (node.type === 'group') {
    return renderGroupProse(node, nodesMap);
  }

  return renderConditionProse(node, nodesMap);
}

// ==================== Condition Prose ====================

/**
 * Render a condition node as a prose fragment
 * Returns a sentence fragment describing the filter
 */
export function renderConditionProse(condition: ConditionNode, nodesMap?: Map<string, Node>): string {
  switch (condition.condition_type) {
    case 'class':
      return renderClassProse(condition, nodesMap);
    case 'property':
      return renderPropertyProse(condition);
    case 'content':
      return renderContentProse(condition);
    case 'reference':
      return renderReferenceProse(condition, nodesMap);
    case 'reference_path':
      return renderReferencePathProse(condition, nodesMap);
    case 'parent':
      return renderParentProse(condition, nodesMap);
    case 'parent_path':
      return renderParentPathProse(condition, nodesMap);
    case 'child':
      return renderChildConditionProse(condition, nodesMap);
    case 'child_path':
      return renderChildPathProse(condition, nodesMap);
    case 'class_path':
      return renderClassPathProse(condition, nodesMap);
    default:
      return 'match unknown condition';
  }
}

function renderClassProse(condition: ClassCondition, nodesMap?: Map<string, Node>): string {
  const operator = condition.operator || 'contains';
  const classValue = condition.class_uuid || '';

  if (!classValue || classValue.trim() === '') {
    return 'have a class defined';
  }

  // Convert UUID to markdown link if possible
  const displayValue = formatNodeReference(classValue, nodesMap);

  switch (operator) {
    case 'is':
      return `have class ${displayValue}`;
    case 'is_not':
      return `do not have class ${displayValue}`;
    case 'contains':
      return `have a class containing ${displayValue}`;
    case 'does_not_contain':
      return `do not have a class containing ${displayValue}`;
    case 'defined':
      return 'have a class defined';
    case 'not_defined':
      return 'have no classes defined';
    default:
      return `have class ${displayValue}`;
  }
}

function renderPropertyProse(condition: PropertyCondition): string {
  const propName = condition.property_name || '(unnamed property)';
  let value = condition.value;

  // Handle common placeholders for better display
  if (typeof value === 'string') {
    if (value === '{current_node_uuid}') {
      value = 'current page UUID';
    } else if (value.startsWith('{') && value.endsWith('}')) {
      value = value.slice(1, -1).replace(/_/g, ' '); // Remove braces and replace underscores
    }
  }

  switch (condition.operator) {
    case 'is_empty':
      return `have empty property "${propName}"`;
    case 'is_not_empty':
      return `have non-empty property "${propName}"`;
    case 'equals':
      return `have property "${propName}" equal to "${value}"`;
    case 'not_equals':
      return `have property "${propName}" not equal to "${value}"`;
    case 'contains':
      return `have property "${propName}" containing "${value}"`;
    case 'greater_than':
      return `have property "${propName}" greater than ${value}`;
    case 'less_than':
      return `have property "${propName}" less than ${value}`;
    case 'gte':
      return `have property "${propName}" at least ${value}`;
    case 'lte':
      return `have property "${propName}" at most ${condition.value}`;
    default:
      return `have property "${propName}"`;
  }
}

function renderContentProse(condition: ContentCondition): string {
  switch (condition.operator) {
    case 'contains':
      return `contain text "${condition.value}"`;
    case 'equals':
      return `have content equal to "${condition.value}"`;
    case 'starts_with':
      return `start with "${condition.value}"`;
    case 'ends_with':
      return `end with "${condition.value}"`;
    case 'regex':
      return `match pattern /${condition.value}/`;
    case 'fts':
      return `match full-text search "${condition.value}"`;
    default:
      return `match content "${condition.value}"`;
  }
}

function renderReferenceProse(condition: ReferenceCondition, nodesMap?: Map<string, Node>): string {
  const displayValue = formatNodeReference(condition.target_uuid, nodesMap);
  return `reference node ${displayValue}`;
}

function renderReferencePathProse(condition: ReferencePathCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    return `reference nodes that ${nested}`;
  }
  return 'reference nodes matching criteria';
}

function renderParentProse(condition: ParentCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    return `have a parent that ${nested}`;
  }
  return 'have a parent matching criteria';
}

function renderParentPathProse(condition: ParentPathCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    const depthPhrase = condition.max_depth
      ? ` (within ${condition.max_depth} level${condition.max_depth > 1 ? 's' : ''})`
      : '';
    return `have an ancestor that ${nested}${depthPhrase}`;
  }
  return 'have ancestors matching criteria';
}

function renderChildConditionProse(condition: ChildCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    return `have a child that ${nested}`;
  }
  return 'have children matching criteria';
}

function renderChildPathProse(condition: ChildPathCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    const depthPhrase = condition.max_depth
      ? ` (within ${condition.max_depth} level${condition.max_depth > 1 ? 's' : ''})`
      : '';
    return `have a descendant that ${nested}${depthPhrase}`;
  }
  return 'have descendants matching criteria';
}

function renderClassPathProse(condition: ClassPathCondition, nodesMap?: Map<string, Node>): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = toThirdPersonSingular(renderGroupProse(condition.nested_group, nodesMap));
    return `inherit a class that ${nested}`;
  }
  return 'inherit classes from ancestors';
}

// ==================== Helper Functions ====================

/**
 * Convert a condition phrase to third-person singular form
 * E.g., "have a class" -> "has a class", "contain text" -> "contains text"
 */
function toThirdPersonSingular(phrase: string): string {
  return phrase
    .replace(/^have /i, 'has ')
    .replace(/^contain /i, 'contains ')
    .replace(/^reference /i, 'references ')
    .replace(/^match /i, 'matches ')
    .replace(/^start /i, 'starts ')
    .replace(/^end /i, 'ends ');
}

/**
 * Format a node UUID as a markdown link if the node is found, otherwise return quoted UUID
 */
function formatNodeReference(uuid: string, nodesMap?: Map<string, Node>): string {
  if (!nodesMap) {
    return `"${uuid}"`;
  }

  const node = nodesMap.get(uuid);
  if (!node) {
    return `"${uuid}"`;
  }

  // Return markdown link format with quotes: "[node name](uuid)"
  return `"[${node.name}](${uuid})"`;
}

// ==================== Capabilities ====================

/**
 * Get prose rendering capabilities for a condition
 */
export function getConditionCapabilities(condition: ConditionNode): NodeProseCapabilities {
  // Most conditions can be negated and combined
  const defaults: NodeProseCapabilities = {
    canNegate: true,
    combinable: true,
    canNest: false,
  };

  // Conditions with nested groups can nest
  const nestableTypes: ConditionNode['condition_type'][] = [
    'reference_path',
    'parent',
    'parent_path',
    'child',
    'child_path',
    'class_path',
  ];

  if (nestableTypes.includes(condition.condition_type)) {
    return { ...defaults, canNest: true };
  }

  return defaults;
}

/**
 * Get prose rendering capabilities for a group
 */
export function getGroupCapabilities(_group: GroupNode): NodeProseCapabilities {
  return {
    canNegate: true,
    combinable: true,
    canNest: true,
  };
}

// ==================== Backward Compatibility ====================

/**
 * Legacy function - kept for compatibility
 * Use getQueryIntent instead
 */
export function getQueryLabel(ast: QueryAST): string {
  return getQueryIntent(ast);
}

/**
 * Legacy function - kept for compatibility
 * Use renderConditionProse instead
 */
export function getConditionLabel(condition: ConditionNode): string {
  return renderConditionProse(condition);
}

/**
 * Check if a condition can be negated
 */
export function canNegateCondition(condition: ConditionNode): boolean {
  return getConditionCapabilities(condition).canNegate;
}

/**
 * Check if a condition can have nested groups
 */
export function canNestInCondition(condition: ConditionNode): boolean {
  return getConditionCapabilities(condition).canNest;
}
