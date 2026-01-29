/**
 * Hook for resolving hierarchical paths with conflict resolution
 */
import { useState, useCallback } from 'react';
import { usePages } from './useNodes';
import { analyzeHierarchicalPath, parseHierarchicalPath, type PathSegmentInfo } from '@/utils/hierarchicalPath';
import type { Node } from '@/types';

export interface ConflictState {
  /** The segment that has conflicts */
  segment: PathSegmentInfo;
  /** Index of this segment in the path */
  segmentIndex: number;
  /** The full path being resolved */
  fullPath: string;
  /** Resolved nodes so far (before this conflict) */
  resolvedNodes: (Node | null)[];
}

/**
 * Hook for resolving hierarchical paths with conflict handling
 * 
 * Analyzes a path and handles conflicts when multiple pages exist with same name at same level.
 * Returns conflict state for UI to resolve, then continues resolution after user selects.
 */
export function useHierarchicalPathResolver() {
  const { data: allPages } = usePages({ includeChildren: true });
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);

  /**
   * Start resolving a hierarchical path
   * Returns null if there are conflicts (check conflictState)
   * Returns the resolved parent ID if successful
   */
  const resolvePath = useCallback(async (
    path: string,
    createPageFn: (name: string, parentId: number | null) => Promise<Node>
  ): Promise<number | null> => {
    if (!allPages) return null;

    const parsed = parseHierarchicalPath(path);
    if (!parsed.isHierarchical || parsed.parentSegments.length === 0) {
      return null;
    }

    // Analyze the path for conflicts
    const analysis = analyzeHierarchicalPath(path, allPages, false);
    if (!analysis) return null;

    // If there are conflicts, set state and return null
    // The UI should show conflict modal and call resolveWithSelection
    if (analysis.hasConflicts) {
      const firstConflict = analysis.segments.find(s => s.hasConflict);
      if (firstConflict) {
        const segmentIndex = analysis.segments.indexOf(firstConflict);
        
        // Get resolved nodes before this conflict
        const resolvedNodes: (Node | null)[] = [];
        for (let i = 0; i < segmentIndex; i++) {
          resolvedNodes.push(analysis.segments[i].node || null);
        }

        setConflictState({
          segment: firstConflict,
          segmentIndex,
          fullPath: path,
          resolvedNodes,
        });
        return null;
      }
    }

    // No conflicts - resolve the path
    return await resolvePathSegments(parsed.parentSegments, allPages, createPageFn);
  }, [allPages]);

  /**
   * Continue resolution after user has resolved a conflict
   */
  const resolveWithSelection = useCallback(async (
    selectedNode: Node,
    createPageFn: (name: string, parentId: number | null) => Promise<Node>
  ): Promise<number | null> => {
    if (!conflictState || !allPages) return null;

    const { segmentIndex, fullPath, resolvedNodes } = conflictState;
    const parsed = parseHierarchicalPath(fullPath);

    // Build the resolved path so far
    const resolvedSoFar = [...resolvedNodes, selectedNode];
    let currentParentId = selectedNode.id;

    // Build lookup map for O(1) access
    const pageMap = new Map<string, Node[]>();
    for (const page of allPages) {
      const key = `${page.name}|${page.parent_id ?? 'null'}`;
      const existing = pageMap.get(key) || [];
      existing.push(page);
      pageMap.set(key, existing);
    }

    // Continue from after the resolved conflict
    const remainingSegments = parsed.parentSegments.slice(segmentIndex + 1);

    for (const segment of remainingSegments) {
      const key = `${segment}|${currentParentId ?? 'null'}`;
      const matchingNodes = pageMap.get(key) || [];

      if (matchingNodes.length > 1) {
        // Another conflict - update state and return null
        const newSegmentIndex = segmentIndex + 1 + remainingSegments.indexOf(segment);
        const segmentInfo: PathSegmentInfo = {
          name: segment,
          exists: true,
          matchingNodes,
          hasConflict: true,
        };

        setConflictState({
          segment: segmentInfo,
          segmentIndex: newSegmentIndex,
          fullPath,
          resolvedNodes: resolvedSoFar,
        });
        return null;
      }

      // Single or no match - resolve it
      let node = matchingNodes[0];
      if (!node) {
        node = await createPageFn(segment, currentParentId);
        // Add to map for subsequent iterations
        const newKey = `${node.name}|${node.parent_id ?? 'null'}`;
        pageMap.set(newKey, [node]);
      }
      resolvedSoFar.push(node);
      currentParentId = node.id;
    }

    // All resolved - clear conflict state
    setConflictState(null);
    return currentParentId;
  }, [conflictState, allPages]);

  /**
   * Cancel conflict resolution
   */
  const cancelResolution = useCallback(() => {
    setConflictState(null);
  }, []);

  return {
    resolvePath,
    resolveWithSelection,
    cancelResolution,
    conflictState,
  };
}

/**
 * Resolve path segments without conflicts (internal helper)
 */
async function resolvePathSegments(
  segments: string[],
  allPages: Node[],
  createPageFn: (name: string, parentId: number | null) => Promise<Node>
): Promise<number | null> {
  if (segments.length === 0) return null;

  // Build lookup map for O(1) access
  const pageMap = new Map<string, Node>();
  for (const page of allPages) {
    const key = `${page.name}|${page.parent_id ?? 'null'}`;
    pageMap.set(key, page);
  }

  let currentParentId: number | null = null;

  for (const segment of segments) {
    const key = `${segment}|${currentParentId ?? 'null'}`;
    let node = pageMap.get(key);

    if (!node) {
      node = await createPageFn(segment, currentParentId);
      // Add to map for subsequent iterations
      const newKey = `${node.name}|${node.parent_id ?? 'null'}`;
      pageMap.set(newKey, node);
    }

    currentParentId = node.id;
  }

  return currentParentId;
}
