/**
 * System Query Helpers
 * 
 * Factory functions for creating read-only system queries.
 * These queries are used for features like linked references, child pages, etc.
 */

import type { QueryAST, ReferenceCondition, TypeCondition, PropertyCondition, ContentCondition } from '@/types/queryAST';
import { markAsSystemNode } from '@/types/queryAST';

/**
 * Create a system query for linked references to a specific page.
 * Shows all pages that link to the current page.
 */
export function createLinkedReferencesQuery(pageUuid: string): QueryAST {
  const condition: ReferenceCondition = markAsSystemNode({
    type: 'condition',
    condition_type: 'reference',
    target_uuid: pageUuid,
  });

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [condition],
    },
    is_system: true,
    description: 'Linked References',
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a system query for child pages of a specific page.
 * Shows all direct children of the current page.
 */
export function createChildPagesQuery(parentPageUuid: string): QueryAST {
  const condition: PropertyCondition = markAsSystemNode({
    type: 'condition',
    condition_type: 'property',
    property_name: 'parent_uuid',
    property_type: 'text',
    operator: '=',
    value: parentPageUuid,
  });

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [condition],
    },
    is_system: true,
    description: 'Child Pages',
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a system query for pages of a specific type/class.
 * Shows all pages tagged with a specific type.
 */
export function createClassedNodesQuery(typeUuid: string, typeName?: string): QueryAST {
  const condition: TypeCondition = markAsSystemNode({
    type: 'condition',
    condition_type: 'type',
    type_uuid: typeUuid,
  });

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [condition],
    },
    is_system: true,
    description: typeName ? `Pages of type: ${typeName}` : 'Classed Nodes',
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a system query for unlinked references.
 * Shows pages that mention the page name but don't have an explicit link.
 */
export function createUnlinkedReferencesQuery(pageName: string): QueryAST {
  const condition: ContentCondition = markAsSystemNode({
    type: 'condition',
    condition_type: 'content',
    operator: 'contains',
    value: pageName,
  });

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [condition],
    },
    is_system: true,
    description: 'Unlinked References',
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a system query for recent changes.
 * Shows recently modified pages.
 */
export function createRecentChangesQuery(daysBack: number = 7): QueryAST {
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - daysBack);

  const condition: PropertyCondition = {
    type: 'condition',
    condition_type: 'property',
    property_name: 'updated_at',
    property_type: 'date',
    operator: '>',
    value: dateThreshold.toISOString(),
  };

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [condition],
    },
    is_system: true,
    description: `Recent Changes (${daysBack} days)`,
    created_at: new Date().toISOString(),
  };
}

/**
 * Check if a query matches a system query pattern.
 * Useful for detecting when a user tries to recreate a system query.
 */
export function isSystemQueryPattern(query: QueryAST): boolean {
  // If explicitly marked as system
  if (query.is_system) {
    return true;
  }

  // Check for common system query patterns
  const root = query.root_group;
  
  // Single condition queries that match system patterns
  if (root.children.length === 1) {
    const child = root.children[0];
    
    if (child.type === 'condition') {
      // Linked references pattern: reference condition with specific target
      if (child.condition_type === 'reference') {
        return true;
      }
      
      // Child pages pattern: parent_uuid property condition
      if (
        child.condition_type === 'property' &&
        child.property_name === 'parent_uuid'
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create a system query for nodes classed as a specific type with user conditions.
 * This demonstrates combining locked system conditions with editable user conditions.
 * 
 * Example: "Nodes classed as Research" with additional user filters
 */
export function createClassedNodesQueryWithUserFilters(
  typeUuid: string,
  typeName?: string
): QueryAST {
  // System condition (locked)
  const systemCondition: TypeCondition = markAsSystemNode({
    type: 'condition',
    condition_type: 'type',
    type_uuid: typeUuid,
  });

  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        systemCondition,
        // User can add more conditions here
      ],
    },
    is_system: false, // Not a pure system query since users can add conditions
    description: typeName ? `Nodes classed as ${typeName}` : 'Classed Nodes',
    created_at: new Date().toISOString(),
  };
}
