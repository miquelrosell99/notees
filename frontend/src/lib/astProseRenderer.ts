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
  TypeCondition,
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
export function getQueryIntent(ast: QueryAST): string {
  const scopePhrase = renderScopeProse(ast.scope);
  const conditions = ast.root_group.children;
  
  if (conditions.length === 0) {
    return `All nodes ${scopePhrase}`;
  }
  
  const conditionPhrase = renderGroupProse(ast.root_group);
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
    
    case 'current_page':
      if (scope.include_descendants) {
        return 'in this page and its descendants';
      }
      return 'in this page';
    
    case 'specific_pages':
      const count = scope.page_uuids?.length || 0;
      const pageWord = count === 1 ? 'page' : 'pages';
      if (scope.include_descendants) {
        return `in ${count} selected ${pageWord} and their descendants`;
      }
      return `in ${count} selected ${pageWord}`;
    
    case 'linked_refs':
      return 'that reference this page';
    
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
    case 'current_page':
      return scope.include_descendants ? 'This page (with children)' : 'This page';
    case 'specific_pages':
      const count = scope.page_uuids?.length || 0;
      return `${count} selected page${count === 1 ? '' : 's'}`;
    case 'linked_refs':
      return 'Linked references';
    default:
      return 'Unknown scope';
  }
}

// ==================== Group Prose ====================

/**
 * Render a group node as prose
 * Returns a sentence fragment describing the condition
 */
export function renderGroupProse(group: GroupNode): string {
  if (group.children.length === 0) {
    return 'match any node';
  }
  
  if (group.children.length === 1) {
    return renderChildProse(group.children[0]);
  }
  
  // Multiple children - combine with logic
  const childPhrases = group.children.map(renderChildProse);
  
  if (group.logic === 'AND') {
    return `match all of these: ${childPhrases.join(', ')}`;
  } else {
    return `match any of these: ${childPhrases.join(', or ')}`;
  }
}

/**
 * Render a child node (can be condition, group, or NOT)
 */
function renderChildProse(node: ConditionNode | GroupNode | NotNode): string {
  if (node.type === 'not') {
    const childPhrase = node.child.type === 'group' 
      ? renderGroupProse(node.child)
      : renderConditionProse(node.child);
    return `do not ${childPhrase}`;
  }
  
  if (node.type === 'group') {
    return renderGroupProse(node);
  }
  
  return renderConditionProse(node);
}

// ==================== Condition Prose ====================

/**
 * Render a condition node as a prose fragment
 * Returns a sentence fragment describing the filter
 */
export function renderConditionProse(condition: ConditionNode): string {
  switch (condition.condition_type) {
    case 'type':
      return renderTypeProse(condition);
    case 'property':
      return renderPropertyProse(condition);
    case 'content':
      return renderContentProse(condition);
    case 'reference':
      return renderReferenceProse(condition);
    case 'reference_path':
      return renderReferencePathProse(condition);
    case 'parent':
      return renderParentProse(condition);
    case 'parent_path':
      return renderParentPathProse(condition);
    case 'child':
      return renderChildConditionProse(condition);
    case 'child_path':
      return renderChildPathProse(condition);
    case 'class_path':
      return renderClassPathProse(condition);
    default:
      return 'match unknown condition';
  }
}

function renderTypeProse(condition: TypeCondition): string {
  return `have class "${condition.type_uuid}"`;
}

function renderPropertyProse(condition: PropertyCondition): string {
  const propName = condition.property_name || '(unnamed property)';
  
  switch (condition.operator) {
    case 'is_empty':
      return `have empty property "${propName}"`;
    case 'is_not_empty':
      return `have non-empty property "${propName}"`;
    case '=':
      return `have property "${propName}" equal to "${condition.value}"`;
    case '!=':
      return `have property "${propName}" not equal to "${condition.value}"`;
    case 'contains':
      return `have property "${propName}" containing "${condition.value}"`;
    case '>':
      return `have property "${propName}" greater than ${condition.value}`;
    case '<':
      return `have property "${propName}" less than ${condition.value}`;
    case '>=':
      return `have property "${propName}" at least ${condition.value}`;
    case '<=':
      return `have property "${propName}" at most ${condition.value}`;
    default:
      return `have property "${propName}"`;
  }
}

function renderContentProse(condition: ContentCondition): string {
  switch (condition.operator) {
    case 'contains':
      return `contain text "${condition.value}"`;
    case '=':
      return `have content equal to "${condition.value}"`;
    case 'starts_with':
      return `start with "${condition.value}"`;
    case 'ends_with':
      return `end with "${condition.value}"`;
    case 'matches_regex':
      return `match pattern /${condition.value}/`;
    case 'fts':
      return `match full-text search "${condition.value}"`;
    default:
      return `match content "${condition.value}"`;
  }
}

function renderReferenceProse(condition: ReferenceCondition): string {
  return `reference node "${condition.target_uuid}"`;
}

function renderReferencePathProse(condition: ReferencePathCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    return `reference nodes that ${nested}`;
  }
  return 'reference nodes matching criteria';
}

function renderParentProse(condition: ParentCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    return `have a parent that ${nested}`;
  }
  return 'have a parent matching criteria';
}

function renderParentPathProse(condition: ParentPathCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    const depthPhrase = condition.max_depth 
      ? ` (within ${condition.max_depth} level${condition.max_depth > 1 ? 's' : ''})`
      : '';
    return `have an ancestor that ${nested}${depthPhrase}`;
  }
  return 'have ancestors matching criteria';
}

function renderChildConditionProse(condition: ChildCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    return `have a child that ${nested}`;
  }
  return 'have children matching criteria';
}

function renderChildPathProse(condition: ChildPathCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    const depthPhrase = condition.max_depth 
      ? ` (within ${condition.max_depth} level${condition.max_depth > 1 ? 's' : ''})`
      : '';
    return `have a descendant that ${nested}${depthPhrase}`;
  }
  return 'have descendants matching criteria';
}

function renderClassPathProse(condition: ClassPathCondition): string {
  if (condition.nested_group && condition.nested_group.children.length > 0) {
    const nested = renderGroupProse(condition.nested_group);
    return `inherit a class that ${nested}`;
  }
  return 'inherit classes from ancestors';
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
