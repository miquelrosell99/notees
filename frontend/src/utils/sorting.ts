/**
 * Sorting Utilities
 * 
 * Reusable sorting logic for nodes across the app.
 * - Alphabetical sorting for regular pages
 * - Chronological sorting (recent first) for day/date pages
 */
import type { Node } from '@/types';
import { parseDateUuid } from '@/types/api';

/**
 * Check if a node is a date-based page (day, month, year)
 */
export function isDateNode(node: Node): boolean {
  return node.is_daily || node.is_monthly || node.is_yearly || false;
}

/**
 * Get a sortable date value from a date node's UUID
 * Returns a numeric timestamp for sorting (more recent = higher value)
 * Returns null for non-date nodes
 */
export function getDateSortValue(node: Node): number | null {
  if (!isDateNode(node)) return null;
  
  const dateInfo = parseDateUuid(node.uuid);
  if (!dateInfo) return null;
  
  // Create a sortable value: YYYYMMDD as number
  const year = dateInfo.year;
  const month = dateInfo.month ?? 1;
  const day = dateInfo.day ?? 1;
  
  return year * 10000 + month * 100 + day;
}

/**
 * Compare two nodes for sorting with smart date handling
 * 
 * Rules:
 * - Date nodes are sorted by date (most recent first)
 * - Non-date nodes are sorted alphabetically (A-Z)
 * - Date nodes come before non-date nodes when mixed
 */
export function compareNodes(a: Node, b: Node): number {
  const aIsDate = isDateNode(a);
  const bIsDate = isDateNode(b);
  
  // Both are date nodes: sort by date (most recent first)
  if (aIsDate && bIsDate) {
    const aDateValue = getDateSortValue(a);
    const bDateValue = getDateSortValue(b);
    
    if (aDateValue !== null && bDateValue !== null) {
      return bDateValue - aDateValue; // Descending (recent first)
    }
    // Fallback to name comparison if date parsing fails
    return (a.name || '').localeCompare(b.name || '');
  }
  
  // Only a is a date node: a comes first
  if (aIsDate && !bIsDate) {
    return -1;
  }
  
  // Only b is a date node: b comes first
  if (!aIsDate && bIsDate) {
    return 1;
  }
  
  // Neither is a date node: alphabetical (A-Z)
  return (a.name || '').localeCompare(b.name || '');
}

/**
 * Sort nodes with smart date handling
 * Returns a new sorted array (does not mutate original)
 */
export function sortNodes(nodes: Node[]): Node[] {
  return [...nodes].sort(compareNodes);
}

/**
 * Compare function for sorting groups/pages by name
 * Handles date pages specially (most recent first)
 */
export function compareGroupsByPage(
  a: { page: Node | null }, 
  b: { page: Node | null }
): number {
  // Nulls (no page) come last
  if (!a.page && !b.page) return 0;
  if (!a.page) return 1;
  if (!b.page) return -1;
  
  return compareNodes(a.page, b.page);
}

/**
 * Sort pages with smart date handling
 * Date pages sorted by recency (most recent first)
 * Regular pages sorted alphabetically (A-Z)
 */
export function sortPages(pages: Node[]): Node[] {
  return sortNodes(pages);
}

/**
 * Group nodes by a key function and return sorted groups
 */
export function groupNodesBy<K>(
  nodes: Node[],
  getKey: (node: Node) => K,
  compareGroups: (a: K, b: K) => number
): Map<K, Node[]> {
  // Group nodes
  const groups = new Map<K, Node[]>();
  for (const node of nodes) {
    const key = getKey(node);
    const existing = groups.get(key);
    if (existing) {
      existing.push(node);
    } else {
      groups.set(key, [node]);
    }
  }
  
  // Sort groups and return as ordered Map
  const sortedKeys = [...groups.keys()].sort(compareGroups);
  const sortedGroups = new Map<K, Node[]>();
  for (const key of sortedKeys) {
    sortedGroups.set(key, groups.get(key)!);
  }
  
  return sortedGroups;
}
