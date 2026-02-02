/**
 * System Query Auto-Fix
 * 
 * Ensures system sections always have their required system conditions.
 * Auto-restores missing system conditions when loading queries.
 * 
 * System sections:
 * - linked_references: MUST have reference condition
 * - child_pages: MUST have parent_uuid condition (scope handles page filtering)
 * - classed_nodes: MUST have class condition (for "Nodes classed as X" views)
 */

import type { QueryAST, ConditionNode, ReferenceCondition, PropertyCondition, ClassCondition, ParentCondition } from '@/types/queryAST';
import { markAsSystemNode, isSystemNode } from '@/types/queryAST';
import type { NodeViewType } from '@/types/query';

// ==================== Type Guards ====================

function isReferenceCondition(node: ConditionNode): node is ReferenceCondition {
  return node.condition_type === 'reference';
}

function isPropertyCondition(node: ConditionNode): node is PropertyCondition {
  return node.condition_type === 'property';
}

function isClassCondition(node: ConditionNode): node is ClassCondition {
  return node.condition_type === 'class';
}

function isParentCondition(node: ConditionNode): node is ParentCondition {
  return node.condition_type === 'parent';
}

// ==================== System Section Definitions ====================

interface SystemSectionRequirement {
  viewType: NodeViewType | string;
  requiresCondition: (_ast: QueryAST, context: SystemContext) => ConditionNode | null;
  hasRequiredCondition: (ast: QueryAST, context: SystemContext) => boolean;
}

interface SystemContext {
  nodeUuid?: string;
  typeUuid?: string;
  parentUuid?: string;
}

const SYSTEM_SECTIONS: SystemSectionRequirement[] = [
  // Linked References section
  {
    viewType: 'linked_references',
    requiresCondition: (_ast, context) => {
      if (!context.nodeUuid) return null;
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'reference',
        target_uuid: context.nodeUuid,
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isReferenceCondition(child) &&
          child.target_uuid === context.nodeUuid &&
          isSystemNode(child)
      );
    },
  },
  
  // Child Pages section - requires parent condition with UUID filter
  {
    viewType: 'child_pages',
    requiresCondition: (_ast, context) => {
      // Always use placeholder - don't need context check since placeholder resolves at runtime
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'parent',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: [
            {
              type: 'condition',
              condition_type: 'property',
              property_name: 'uuid',
              property_type: 'text',
              operator: 'equals',
              value: '{current_node_uuid}',
            },
          ],
        },
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) => {
          if (child.type !== 'condition' || !isSystemNode(child)) return false;
          const parentCond = child as any;
          if (parentCond.condition_type !== 'parent') return false;
          // Check if nested group has UUID condition matching context
          const nestedChildren = parentCond.nested_group?.children || [];
          return nestedChildren.some(
            (nested: any) =>
              nested.condition_type === 'property' &&
              nested.property_name === 'uuid' &&
              (nested.value === context.nodeUuid || nested.value === '{current_node_uuid}')
          );
        }
      );
    },
  },
  
  // Class-specific views
  {
    viewType: 'classed_nodes',
    requiresCondition: (_ast, context) => {
      // For classed_nodes views, lock to the current page as the class
      if (!context.nodeUuid) return null;
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'class',
        class_uuid: context.nodeUuid, // Lock to current page
        operator: 'contains', // Use contains for broader matching
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isClassCondition(child) &&
          (child.class_uuid === context.nodeUuid || child.class_uuid === '{current_node_uuid}') &&
          isSystemNode(child)
      );
    },
  },
];

// ==================== Auto-Fix Functions ====================

/**
 * Check if a view type requires system conditions
 */
export function isSystemSection(viewType: string): boolean {
  return SYSTEM_SECTIONS.some((section) => section.viewType === viewType);
}

/**
 * Auto-fix: Restore missing system conditions for a query
 * 
 * This function ensures system views have the required system-marked condition.
 * It removes any existing system-marked conditions and adds the correct one.
 * 
 * @param ast The QueryAST to fix
 * @param viewType The view type (e.g., 'linked_references')
 * @param context Context data (nodeUuid, typeUuid, etc.)
 * @returns Fixed QueryAST with system conditions restored
 */
export function autoFixSystemQuery(
  ast: QueryAST,
  viewType: string,
  context: SystemContext
): QueryAST {
  const section = SYSTEM_SECTIONS.find((s) => s.viewType === viewType);
  if (!section) {
    // Not a system section, return as-is
    return ast;
  }
  
  // Auto-fix scope for system views
  const defaultScopes: Record<string, ScopeNode['scope_type']> = {
    'linked_references': 'all',
    'child_pages': 'pages',
    'classed_nodes': 'all',
  };
  
  const correctScope: ScopeNode = {
    type: 'scope',
    scope_type: defaultScopes[viewType] || 'all',
  };
  
  // Check if required condition already exists
  if (section.hasRequiredCondition(ast, context)) {
    // Condition already exists and is marked as system, just ensure scope is correct
    return {
      ...ast,
      scope: correctScope,
    };
  }
  
  // Condition doesn't exist or isn't marked - add it
  const requiredCondition = section.requiresCondition(ast, context);
  if (!requiredCondition) {
    // Can't generate condition without context
    console.warn(`Cannot auto-fix ${viewType}: missing context data`);
    return {
      ...ast,
      scope: correctScope,
    };
  }
  
  // Remove any old system-marked conditions and add the new one
  const nonSystemChildren = ast.root_group.children.filter(
    (child) => !isSystemNode(child)
  );
  
  return {
    ...ast,
    scope: correctScope,
    root_group: {
      ...ast.root_group,
      children: [requiredCondition, ...nonSystemChildren],
    },
  };
}

/**
 * Auto-fix multiple queries in a batch
 */
export function autoFixSystemQueries(
  queries: Array<{ ast: QueryAST; viewType: string; context: SystemContext }>
): QueryAST[] {
  return queries.map(({ ast, viewType, context }) =>
    autoFixSystemQuery(ast, viewType, context)
  );
}

/**
 * Check if a query needs auto-fixing
 */
export function needsAutoFix(
  ast: QueryAST,
  viewType: string,
  context: SystemContext
): boolean {
  const section = SYSTEM_SECTIONS.find((s) => s.viewType === viewType);
  if (!section) return false;
  return !section.hasRequiredCondition(ast, context);
}

/**
 * Get description of what auto-fix will do
 */
export function getAutoFixDescription(viewType: string): string | null {
  const descriptions: Record<string, string> = {
    linked_references: 'Add required reference condition',
    child_pages: 'Add required parent condition',
    classed_nodes: 'Add required class condition',
  };
  return descriptions[viewType] || null;
}
