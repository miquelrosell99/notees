/**
 * System Query Auto-Fix
 * 
 * Ensures system sections always have their required system conditions.
 * Auto-restores missing system conditions when loading queries.
 * 
 * System sections:
 * - linked_references: MUST have reference condition
 * - unlinked_references: MUST have content condition with current node name, exclude current node, and exclude pages
 * - child_pages: MUST have parent_uuid condition (scope handles page filtering)
 * - classed_nodes: MUST have class condition (for "Nodes classed as X" views)
 */

import type { QueryAST, ConditionNode, ReferenceCondition, ClassCondition, ParentCondition, ExtendsCondition, ContentCondition, PropertyCondition, ScopeNode } from '@/types/queryAST';
import { markAsSystemNode, isSystemNode } from '@/types/queryAST';
import type { NodeViewType } from '@/types/nodeView';

// ==================== Type Guards ====================

function isReferenceCondition(node: ConditionNode): node is ReferenceCondition {
  return node.condition_type === 'reference';
}

function isClassCondition(node: ConditionNode): node is ClassCondition {
  return node.condition_type === 'class';
}

function isParentCondition(node: ConditionNode): node is ParentCondition {
  return node.condition_type === 'parent';
}

function isExtendsCondition(node: ConditionNode): node is ExtendsCondition {
  return node.condition_type === 'extends';
}

function isContentCondition(node: ConditionNode): node is ContentCondition {
  return node.condition_type === 'content';
}

function isPropertyCondition(node: ConditionNode): node is PropertyCondition {
  return node.condition_type === 'property';
}

// ==================== System Section Definitions ====================

interface SystemSectionRequirement {
  viewType: NodeViewType | string;
  requiresCondition: (_ast: QueryAST, context: SystemContext) => ConditionNode | null;
  hasRequiredCondition: (ast: QueryAST, context: SystemContext) => boolean;
}

interface SystemContext {
  nodeUuid?: string;
  classUuid?: string;
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
      // Don't require isSystemNode check - capabilities may be lost after backend round-trip
      // The marking logic will re-apply capabilities to matching conditions
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isReferenceCondition(child) &&
          (child.target_uuid === context.nodeUuid || child.target_uuid === '{current_node_uuid}')
      );
    },
  },
  
  // Child Pages section - requires parent condition with current node UUID
  {
    viewType: 'child_pages',
    requiresCondition: (_ast, _context) => {
      // Use the new static mode with placeholder
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'parent',
        parent_uuid: '{current_node_uuid}',
        operator: 'has_parent',
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) => {
          if (child.type !== 'condition') return false;
          const parentCond = child as ParentCondition;
          if (parentCond.condition_type !== 'parent') return false;
          // Check if it has parent_uuid set (static mode with placeholder or actual UUID)
          // Don't require isSystemNode check here - we'll mark it if found
          return !!(parentCond.parent_uuid && (
            parentCond.parent_uuid === '{current_node_uuid}' ||
            parentCond.parent_uuid === context.parentUuid ||
            parentCond.parent_uuid === context.nodeUuid
          ));
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
      // Don't require isSystemNode check - capabilities may be lost after backend round-trip
      // The marking logic will re-apply capabilities to matching conditions
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isClassCondition(child) &&
          (child.class_uuid === context.nodeUuid || child.class_uuid === '{current_node_uuid}')
      );
    },
  },
  
  // Extended By view - classes that extend this class
  {
    viewType: 'extended_by',
    requiresCondition: (_ast, context) => {
      // For extended_by views, lock to the current page as the class being extended
      if (!context.nodeUuid) return null;
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'extends',
        extends_class_uuid: context.nodeUuid, // Lock to current page
      });
    },
    hasRequiredCondition: (ast, context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          (child as unknown as Record<string, unknown>).condition_type === 'extends' &&
          ((child as unknown as Record<string, unknown>).extends_class_uuid === context.nodeUuid || 
           (child as unknown as Record<string, unknown>).extends_class_uuid === '{current_node_uuid}')
      );
    },
  },
  
  // Unlinked References - content search for the current node's display name
  {
    viewType: 'unlinked_references',
    requiresCondition: (_ast, _context) => {
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'content',
        operator: 'contains',
        value: '{current_node_name}',
      });
    },
    hasRequiredCondition: (ast, _context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isContentCondition(child as ConditionNode) &&
          (child as ContentCondition).value === '{current_node_name}'
      );
    },
  },

  // Unlinked References - exclude the current node itself
  {
    viewType: 'unlinked_references',
    requiresCondition: (_ast, _context) => {
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'property',
        property_name: 'uuid',
        property_type: 'text',
        operator: 'not_equals',
        value: '{current_node_uuid}',
      } as PropertyCondition);
    },
    hasRequiredCondition: (ast, _context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isPropertyCondition(child as ConditionNode) &&
          (child as PropertyCondition).property_name === 'uuid' &&
          (child as PropertyCondition).operator === 'not_equals' &&
          (child as PropertyCondition).value === '{current_node_uuid}'
      );
    },
  },

  // Unlinked References - exclude pages (class does not contain page)
  {
    viewType: 'unlinked_references',
    requiresCondition: (_ast, _context) => {
      return markAsSystemNode({
        type: 'condition',
        condition_type: 'class',
        class_uuid: '00000000-0000-0000-0001-000000000002',  // Page class UUID
        operator: 'does_not_contain',
      } as ClassCondition);
    },
    hasRequiredCondition: (ast, _context) => {
      return ast.root_group.children.some(
        (child) =>
          child.type === 'condition' &&
          isClassCondition(child as ConditionNode) &&
          (child as ClassCondition).class_uuid === '00000000-0000-0000-0001-000000000002' &&
          (child as ClassCondition).operator === 'does_not_contain'
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
 * @param context Context data (nodeUuid, classUuid, etc.)
 * @returns Fixed QueryAST with system conditions restored
 */
export function autoFixSystemQuery(
  ast: QueryAST,
  viewType: string,
  context: SystemContext
): QueryAST {
  const sections = SYSTEM_SECTIONS.filter((s) => s.viewType === viewType);
  if (sections.length === 0) {
    // Not a system section, return as-is
    return ast;
  }
  
  // Auto-fix scope for system views
  const defaultScopes: Record<string, 'entire_workspace' | 'pages' | 'current_page'> = {
    'linked_references': 'entire_workspace',
    'child_pages': 'pages',
    'classed_nodes': 'entire_workspace',
    'extended_by': 'pages',
    'unlinked_references': 'entire_workspace',
  };
  
  const correctScope: ScopeNode = {
    type: 'scope',
    scope_type: defaultScopes[viewType] || 'entire_workspace',
  };
  
  // Process each section requirement sequentially
  let currentAst = { ...ast, scope: correctScope };
  
  for (const section of sections) {
    if (section.hasRequiredCondition(currentAst, context)) {
      // Condition exists - ensure it's marked as system
      const updatedChildren = currentAst.root_group.children.map((child) => {
        if (child.type === 'condition') {
          if (viewType === 'child_pages' && isParentCondition(child as ConditionNode)) {
            const parentCond = child as ParentCondition;
            if (parentCond.parent_uuid && (
              parentCond.parent_uuid === '{current_node_uuid}' ||
              parentCond.parent_uuid === context.parentUuid ||
              parentCond.parent_uuid === context.nodeUuid
            )) {
              return markAsSystemNode(child);
            }
          } else if (viewType === 'linked_references' && isReferenceCondition(child as ConditionNode)) {
            const refCond = child as ReferenceCondition;
            if (refCond.target_uuid === context.nodeUuid || refCond.target_uuid === '{current_node_uuid}') {
              return markAsSystemNode(child);
            }
          } else if (viewType === 'classed_nodes' && isClassCondition(child as ConditionNode)) {
            const classCond = child as ClassCondition;
            if (classCond.class_uuid === context.nodeUuid || classCond.class_uuid === '{current_node_uuid}') {
              return markAsSystemNode(child);
            }
          } else if (viewType === 'extended_by' && isExtendsCondition(child as ConditionNode)) {
            const extCond = child as ExtendsCondition;
            if (extCond.extends_class_uuid === context.nodeUuid || extCond.extends_class_uuid === '{current_node_uuid}') {
              return markAsSystemNode(child);
            }
          } else if (viewType === 'unlinked_references' && isContentCondition(child as ConditionNode)) {
            const contentCond = child as ContentCondition;
            if (contentCond.value === '{current_node_name}') {
              return markAsSystemNode(child);
            }
          } else if (viewType === 'unlinked_references' && isPropertyCondition(child as ConditionNode)) {
            const propCond = child as PropertyCondition;
            if (propCond.property_name === 'uuid' && propCond.operator === 'not_equals' && propCond.value === '{current_node_uuid}') {
              return markAsSystemNode(child);
            }
          }
        }
        return child;
      });
      
      currentAst = {
        ...currentAst,
        root_group: {
          ...currentAst.root_group,
          children: updatedChildren,
        },
      };
    } else {
      // Condition doesn't exist - add it
      const requiredCondition = section.requiresCondition(currentAst, context);
      if (!requiredCondition) {
        console.warn(`Cannot auto-fix ${viewType}: missing context data`);
        continue;
      }
      
      // Remove any old system-marked conditions AND any conditions that match this specific system condition pattern
      const nonSystemChildren = currentAst.root_group.children.filter((child) => {
        if (isSystemNode(child) && section.hasRequiredCondition(
          { ...currentAst, root_group: { ...currentAst.root_group, children: [child] } },
          context
        )) return false;
        
        if (child.type === 'condition') {
          if (viewType === 'linked_references' && isReferenceCondition(child as ConditionNode)) {
            const refCond = child as ReferenceCondition;
            if (refCond.target_uuid === context.nodeUuid || refCond.target_uuid === '{current_node_uuid}') return false;
          } else if (viewType === 'child_pages' && isParentCondition(child as ConditionNode)) {
            const parentCond = child as ParentCondition;
            if (parentCond.parent_uuid && (
              parentCond.parent_uuid === '{current_node_uuid}' ||
              parentCond.parent_uuid === context.parentUuid ||
              parentCond.parent_uuid === context.nodeUuid
            )) return false;
          } else if (viewType === 'classed_nodes' && isClassCondition(child as ConditionNode)) {
            const classCond = child as ClassCondition;
            if (classCond.class_uuid === context.nodeUuid || classCond.class_uuid === '{current_node_uuid}') return false;
          } else if (viewType === 'extended_by' && isExtendsCondition(child as ConditionNode)) {
            const extCond = child as ExtendsCondition;
            if (extCond.extends_class_uuid === context.nodeUuid || extCond.extends_class_uuid === '{current_node_uuid}') return false;
          } else if (viewType === 'unlinked_references' && isContentCondition(child as ConditionNode)) {
            const contentCond = child as ContentCondition;
            if (contentCond.value === '{current_node_name}') return false;
          } else if (viewType === 'unlinked_references' && isPropertyCondition(child as ConditionNode)) {
            const propCond = child as PropertyCondition;
            if (propCond.property_name === 'uuid' && propCond.operator === 'not_equals' && propCond.value === '{current_node_uuid}') return false;
          }
        }
        
        return true;
      });
      
      currentAst = {
        ...currentAst,
        root_group: {
          ...currentAst.root_group,
          children: [requiredCondition, ...nonSystemChildren],
        },
      };
    }
  }
  
  return currentAst;
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
  const sections = SYSTEM_SECTIONS.filter((s) => s.viewType === viewType);
  if (sections.length === 0) return false;
  return sections.some((section) => !section.hasRequiredCondition(ast, context));
}

/**
 * Get description of what auto-fix will do
 */
export function getAutoFixDescription(viewType: string): string | null {
  const descriptions: Record<string, string> = {
    linked_references: 'Add required reference condition',
    child_pages: 'Add required parent condition',
    classed_nodes: 'Add required class condition',
    extended_by: 'Add required extends condition',
    unlinked_references: 'Add required content condition',
  };
  return descriptions[viewType] || null;
}
