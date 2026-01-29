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

export interface PathSegmentInfo {
  /** The segment name */
  name: string;
  /** Whether a page with this name exists at this level */
  exists: boolean;
  /** The node if it exists (single match) */
  node?: Node;
  /** All matching nodes if multiple exist at this level (conflict) */
  matchingNodes?: Node[];
  /** Whether there's a conflict (multiple pages with same name at this level) */
  hasConflict: boolean;
}

export interface HierarchicalPathAnalysis {
  /** Information about each segment in the path */
  segments: PathSegmentInfo[];
  /** The parsed path structure */
  parsed: ParsedPath;
  /** Whether any segment has conflicts that need resolution */
  hasConflicts: boolean;
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
 * IMPORTANT: Pages are matched by name AND parent_id at each level.
 * Example: If you have "Company/Pokemon" and create "Pokemon/Charizard",
 * a NEW root-level "Pokemon" page will be created (not reusing Company/Pokemon).
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
    // Try to find existing page with this name AND parent at this level
    // This ensures "Pokemon" under "Company" is different from "Pokemon" at root
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

/**
 * Analyze a hierarchical path to determine which pages exist and which need to be created
 * Useful for showing path previews, validation, etc.
 * 
 * IMPORTANT: Pages are matched by name AND parent_id at each level.
 * Example: If you have "Company/Pokemon" and analyze "Pokemon/Charizard",
 * it will show Pokemon as "needs to be created" (not reusing Company/Pokemon).
 * 
 * @param path - The path string to analyze (e.g., "Pokemon/Charizard")
 * @param allPages - All available pages
 * @param includeLeaf - Whether to include the leaf segment in the analysis (default: true)
 * @returns Analysis of the path structure, or null if not hierarchical
 */
export function analyzeHierarchicalPath(
  path: string,
  allPages: Node[],
  includeLeaf: boolean = true
): HierarchicalPathAnalysis | null {
  if (!path.trim()) return null;
  
  const parsed = parseHierarchicalPath(path.trim());
  if (!parsed.isHierarchical) return null;
  
  // Check which segments exist
  const segments: PathSegmentInfo[] = [];
  let currentParentId: number | null = null;
  
  // Analyze parent segments
  for (const segment of parsed.parentSegments) {
    // Look for all pages with this name AND parent at this level
    // This ensures hierarchy is respected (Pokemon at root ≠ Company/Pokemon)
    const matchingNodes = allPages.filter(
      page => page.name === segment && page.parent_id === currentParentId
    );
    
    const hasConflict = matchingNodes.length > 1;
    const singleNode = matchingNodes.length === 1 ? matchingNodes[0] : undefined;
    
    segments.push({
      name: segment,
      exists: matchingNodes.length > 0,
      node: singleNode,
      matchingNodes: hasConflict ? matchingNodes : undefined,
      hasConflict,
    });
    
    // If there's a conflict, we can't determine the next parent
    // Stop here and let the caller resolve it
    if (hasConflict) {
      currentParentId = null;
    } else {
      currentParentId = singleNode?.id ?? null;
    }
  }
  
  // Optionally add the leaf segment
  if (includeLeaf) {
    // Check if leaf exists at the current parent level
    // Again, respecting hierarchy: looks for name AND parent match
    const leafMatches = allPages.filter(
      page => page.name === parsed.leaf && page.parent_id === currentParentId
    );
    
    const hasConflict = leafMatches.length > 1;
    const singleNode = leafMatches.length === 1 ? leafMatches[0] : undefined;
    
    segments.push({
      name: parsed.leaf,
      exists: leafMatches.length > 0,
      node: singleNode,
      matchingNodes: hasConflict ? leafMatches : undefined,
      hasConflict,
    });
  }
  
  const hasConflicts = segments.some(s => s.hasConflict);
  
  return { segments, parsed, hasConflicts };
}
