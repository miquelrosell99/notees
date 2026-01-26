/**
 * Hierarchical Path Utilities
 * 
 * Utilities for parsing and handling hierarchical page paths using "/" separator.
 * Examples:
 * - "Page1/Page2" - search for Page2 that is a child of Page1
 * - "Page1/Page2/Page3" - search for Page3 that is child of Page2, which is child of Page1
 * - When creating, sets up the parent hierarchy automatically
 */

import type { Node } from '@/types';

export interface ParsedPath {
  /** The segments split by "/" */
  segments: string[];
  /** Whether this query contains hierarchy (has "/") */
  isHierarchical: boolean;
  /** The leaf segment (what we're actually searching for or creating) */
  leaf: string;
  /** The parent path segments (everything before the leaf) */
  parentSegments: string[];
}

/**
 * Parse a page name/query into hierarchical segments
 */
export function parseHierarchicalPath(query: string): ParsedPath {
  const segments = query.split('/').map(s => s.trim()).filter(s => s.length > 0);
  
  if (segments.length === 0) {
    return {
      segments: [],
      isHierarchical: false,
      leaf: '',
      parentSegments: [],
    };
  }
  
  return {
    segments,
    isHierarchical: segments.length > 1,
    leaf: segments[segments.length - 1],
    parentSegments: segments.slice(0, -1),
  };
}

/**
 * Find a node by following a hierarchical path
 * Returns the node if found, or null if any segment in the path doesn't exist
 * 
 * @param segments - Path segments to follow (e.g., ["Page1", "Page2", "Page3"])
 * @param allPages - List of all available pages
 * @returns The node at the end of the path, or null if not found
 */
export function findNodeByPath(segments: string[], allPages: Node[]): Node | null {
  if (segments.length === 0) return null;
  
  let currentParentId: number | null = null;
  let currentNode: Node | null = null;
  
  for (const segment of segments) {
    // Find a page with this name that has the current parent
    const matchingNode = allPages.find(
      page => page.name === segment && page.parent_id === currentParentId
    );
    
    if (!matchingNode) {
      return null; // Path doesn't exist
    }
    
    currentNode = matchingNode;
    currentParentId = currentNode.id;
  }
  
  return currentNode;
}

/**
 * Filter nodes by hierarchical path
 * If the query is hierarchical (contains "/"), filter to only show nodes
 * that match the full path. Otherwise, show all matching nodes.
 * 
 * @param query - The search query (may contain "/")
 * @param nodes - Nodes to filter
 * @param allPages - All available pages (for path resolution)
 * @returns Filtered nodes that match the hierarchical criteria
 */
export function filterNodesByHierarchy(
  query: string,
  nodes: Node[],
  allPages: Node[]
): Node[] {
  const parsed = parseHierarchicalPath(query);
  
  // If not hierarchical, return all nodes
  if (!parsed.isHierarchical) {
    return nodes;
  }
  
  // Find the parent node by following the path (excluding the leaf)
  const parentNode = findNodeByPath(parsed.parentSegments, allPages);
  
  // If parent doesn't exist, no results
  if (parentNode === null && parsed.parentSegments.length > 0) {
    return [];
  }
  
  const expectedParentId = parentNode?.id ?? null;
  
  // Filter nodes to only those with the correct parent and matching the leaf name
  return nodes.filter(node => {
    // Check if this node has the right parent
    if (node.parent_id !== expectedParentId) {
      return false;
    }
    
    // Check if the name matches the leaf segment
    const nodeName = node.name?.toLowerCase() ?? '';
    const leafLower = parsed.leaf.toLowerCase();
    return nodeName.includes(leafLower) || nodeName === leafLower;
  });
}

/**
 * Resolve the parent ID for a hierarchical path when creating a new page
 * Creates intermediate pages if they don't exist
 * 
 * @param pathSegments - Path segments (excluding the leaf/final page)
 * @param allPages - All available pages
 * @param createPageFn - Function to create a page (returns the created node)
 * @returns The parent ID to use, or null for root level
 */
export async function resolveHierarchicalParent(
  pathSegments: string[],
  allPages: Node[],
  createPageFn: (name: string, parentId: number | null) => Promise<Node>
): Promise<number | null> {
  if (pathSegments.length === 0) {
    return null; // Root level
  }
  
  let currentParentId: number | null = null;
  
  for (const segment of pathSegments) {
    // Try to find existing page with this name and parent
    let existingNode = allPages.find(
      page => page.name === segment && page.parent_id === currentParentId
    );
    
    if (!existingNode) {
      // Create the intermediate page
      existingNode = await createPageFn(segment, currentParentId);
    }
    
    currentParentId = existingNode.id;
  }
  
  return currentParentId;
}
