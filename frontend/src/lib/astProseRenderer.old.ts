/**
 * QueryAST Prose Renderer
 * 
 * Converts QueryAST nodes into human-readable prose with inline controls.
 * This is the core of the "intent-first" UI that hides engine-level details.
 * 
 * Each AST node type exposes:
 * - label(): string - Natural language description
 * - inlineControls(): React component - Inline editing UI
 * - canNegate: boolean
 * - canNest: boolean
 */

import type {
  QueryAST,
  GroupNode,
  ConditionNode,
  ScopeNode,
  TypeCondition,
  PropertyCondition,
  ContentCondition,
  ReferenceCondition,
} from '@/types/queryAST';

// ==================== Prose Labels ====================

/**
 * Generate prose label for scope
 */
export function getScopeLabel(scope: ScopeNode): string {
  switch (scope.scope_type) {
    case 'entire_graph':
      return 'Entire graph';
    case 'current_page':
      return scope.include_descendants 
        ? 'This page and child blocks' 
        : 'This page';
    case 'specific_pages':
      const count = scope.page_uuids?.length || 0;
      return count === 1 
        ? '1 selected page' 
        : `${count} selected pages`;
    case 'linked_refs':
      return 'Nodes that reference this page';
    default:
      return 'Unknown scope';
  }
}

/**
 * Generate prose label for a condition
 */
export function getConditionLabel(condition: ConditionNode): string {
  switch (condition.condition_type) {
    case 'type':
      return `tagged with type "${(condition as TypeCondition).type_uuid}"`;
    
    case 'property': {
      const prop = condition as PropertyCondition;
      const opLabel = getPropertyOperatorLabel(prop.operator);
      if (prop.operator === 'is_empty' || prop.operator === 'is_not_empty') {
        return `property "${prop.property_name}" ${opLabel}`;
      }
      return `property "${prop.property_name}" ${opLabel} "${prop.value}"`;
    }
    
    case 'content': {
      const content = condition as ContentCondition;
      const opLabel = getContentOperatorLabel(content.operator);
      return `content ${opLabel} "${content.value}"`;
    }
    
    case 'reference': {
      const ref = condition as ReferenceCondition;
      return `references node ${ref.target_uuid}`;
    }
    
    case 'reference_path':
      return 'references nodes matching criteria';
    
    case 'parent_path':
      return 'has ancestors matching criteria';
    
    default:
      return 'unknown condition';
  }
}

/**
 * Get human-readable label for property operator
 */
function getPropertyOperatorLabel(operator: string): string {
  const labels: Record<string, string> = {
    'equals': 'equals',
    'not_equals': 'does not equal',
    'greater_than': 'is greater than',
    'less_than': 'is less than',
    'greater_than_or_equal': 'is at least',
    'less_than_or_equal': 'is at most',
    'contains': 'contains',
    'not_contains': 'does not contain',
    'starts_with': 'starts with',
    'ends_with': 'ends with',
    'is_empty': 'is empty',
    'is_not_empty': 'is not empty',
    'in': 'is one of',
    'not_in': 'is not one of',
  };
  return labels[operator] || operator;
}

/**
 * Get human-readable label for content operator
 */
function getContentOperatorLabel(operator: string): string {
  const labels: Record<string, string> = {
    'contains': 'contains',
    'not_contains': 'does not contain',
    'starts_with': 'starts with',
    'ends_with': 'ends with',
    'equals': 'equals',
    'not_equals': 'does not equal',
    'regex': 'matches pattern',
  };
  return labels[operator] || operator;
}

/**
 * Generate prose label for a group
 */
export function getGroupLabel(group: GroupNode): string {
  if (group.children.length === 0) {
    return 'No conditions';
  }
  
  if (group.children.length === 1) {
    const child = group.children[0];
    if (child.type === 'condition') {
      return getConditionLabel(child);
    } else if (child.type === 'not') {
      return `NOT (${getConditionLabel(child.child as ConditionNode)})`;
    } else {
      return getGroupLabel(child);
    }
  }
  
  const logic = group.logic === 'AND' ? 'all' : 'any';
  return `Match ${logic} of ${group.children.length} conditions`;
}

/**
 * Generate prose label for entire query
 */
export function getQueryLabel(ast: QueryAST): string {
  const scope = getScopeLabel(ast.scope);
  const conditions = ast.root_group.children.length;
  
  if (conditions === 0) {
    return `All nodes in ${scope.toLowerCase()}`;
  }
  
  // Special case for single reference condition (common pattern)
  if (conditions === 1 && ast.root_group.children[0].type === 'condition') {
    const condition = ast.root_group.children[0] as ConditionNode;
    if (condition.condition_type === 'reference') {
      return 'Nodes that reference this node';
    }
  }
  
  // Generic case
  const logic = ast.root_group.logic === 'AND' ? 'matching all' : 'matching any';
  return `Nodes ${logic} conditions`;
}

// ==================== Condition Capabilities ====================

/**
 * Check if a condition type can be negated
 */
export function canNegateCondition(_condition: ConditionNode): boolean {
  // All conditions can be negated
  return true;
}

/**
 * Check if a condition type can have nested groups
 */
export function canNestInCondition(condition: ConditionNode): boolean {
  // Only reference_path and parent_path support nesting
  return condition.condition_type === 'reference_path' || 
         condition.condition_type === 'parent_path';
}

// ==================== Sentence Construction ====================

/**
 * Build a complete prose sentence for a condition
 * Returns array of parts that can be mixed with React components
 */
export interface ProsePart {
  type: 'text' | 'dropdown' | 'input' | 'token';
  content: string;
  editable?: boolean;
  options?: { value: string; label: string }[];
}

/**
 * Generate prose parts for a condition (used for inline editing)
 */
export function getConditionProse(condition: ConditionNode): ProsePart[] {
  switch (condition.condition_type) {
    case 'type':
      return [
        { type: 'text', content: 'tagged with type' },
        { type: 'token', content: (condition as TypeCondition).type_uuid, editable: true },
      ];
    
    case 'property': {
      const prop = condition as PropertyCondition;
      return [
        { type: 'text', content: 'property' },
        { type: 'input', content: prop.property_name, editable: true },
        { 
          type: 'dropdown', 
          content: prop.operator,
          editable: true,
          options: [
            { value: 'equals', label: 'equals' },
            { value: 'not_equals', label: '≠' },
            { value: 'contains', label: 'contains' },
            { value: 'is_empty', label: 'is empty' },
            { value: 'is_not_empty', label: 'is not empty' },
          ],
        },
        ...(prop.operator !== 'is_empty' && prop.operator !== 'is_not_empty'
          ? [{ type: 'input' as const, content: String(prop.value || ''), editable: true }]
          : []
        ),
      ];
    }
    
    case 'content': {
      const content = condition as ContentCondition;
      return [
        { type: 'text', content: 'content' },
        {
          type: 'dropdown',
          content: content.operator,
          editable: true,
          options: [
            { value: 'contains', label: 'contains' },
            { value: 'starts_with', label: 'starts with' },
            { value: 'ends_with', label: 'ends with' },
            { value: 'equals', label: 'equals' },
            { value: 'regex', label: 'matches pattern' },
          ],
        },
        { type: 'input', content: content.value, editable: true },
      ];
    }
    
    case 'reference': {
      const ref = condition as ReferenceCondition;
      return [
        { type: 'text', content: 'references' },
        { type: 'token', content: ref.target_uuid === 'current_node_uuid' ? 'this node' : ref.target_uuid, editable: true },
      ];
    }
    
    default:
      return [{ type: 'text', content: getConditionLabel(condition) }];
  }
}
