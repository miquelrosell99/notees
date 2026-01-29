/**
 * System Query Auto-Fix
 * 
 * Ensures system sections always have their required system conditions.
 * Auto-restores missing system conditions when loading queries.
 * 
 * System sections:
 * - linked_references: MUST have reference condition
 * - child_pages: MUST have parent_uuid AND is_page conditions
 * - classed_nodes: MUST have class condition (for "Nodes classed as X" views)
 */

import type { QueryAST, ConditionNode, ReferenceCondition, PropertyCondition, TypeCondition } from '@/types/queryAST';
import { markAsSystemNode, isSystemNode } from '@/types/queryAST';
import type { NodeViewType } from '@/types/query';

// ==================== Type Guards ====================

function isReferenceCondition(node: ConditionNode): node is ReferenceCondition {
  return node.condition_type === 'reference';
}

function isPropertyCondition(node: ConditionNode): node is PropertyCondition {
  return node.condition_type === 'property';
}

function isTypeCondition(node: ConditionNode): node is TypeCondition {
  return node.condition_type === 'type';
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
  
  // Child Pages section - requires parent_uuid condition
  {
    viewType: 'child_pages',
    requiresCondition: (_ast, context) => {
      if (!context.parentUuid) return null;
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'property',
        property_name: 'parent_uuid',
        property_type: 'text',
        operator: '=',
        value: context.parentUuid,
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isPropertyCondition(child) &&
          child.property_name === 'parent_uuid' &&
          child.value === context.parentUuid &&
          isSystemNode(child)
      );
    },
  },
  
  // Child Pages section - requires page class condition
  {
    viewType: 'child_pages',
    requiresCondition: (_ast, _context) => {
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'property',
        property_name: 'is_page',
        property_type: 'boolean',
        operator: '=',
        value: true,
      });
    },
    hasRequiredCondition: (ast, _context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isPropertyCondition(child) &&
          child.property_name === 'is_page' &&
          child.value === true &&
          isSystemNode(child)
      );
    },
  },
  
  // Class-specific views
  {
    viewType: 'classed_nodes',
    requiresCondition: (_ast, context) => {
      if (!context.typeUuid) return null;
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'type',
        type_uuid: context.typeUuid,
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isTypeCondition(child) &&
          child.type_uuid === context.typeUuid &&
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
  
  // Check if required condition exists
  if (section.hasRequiredCondition(ast, context)) {
    // Already has the condition, no fix needed
    return ast;
  }
  
  // Generate the required condition
  const requiredCondition = section.requiresCondition(ast, context);
  if (!requiredCondition) {
    // Can't generate condition without context
    console.warn(`Cannot auto-fix ${viewType}: missing context data`);
    return ast;
  }
  
  // Add the system condition at the beginning
  return {
    ...ast,
    root_group: {
      ...ast.root_group,
      children: [requiredCondition, ...ast.root_group.children],
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
    child_pages: 'Add required parent_uuid condition',
    classed_nodes: 'Add required class condition',
  };
  return descriptions[viewType] || null;
}
