/**
 * useResolvedClassDetails Hook
 * 
 * Resolves a node's class IDs into full Node objects.
 * Consolidates the repeated class resolution pattern from NodeView, SidebarNodeView,
 * NodeCardView, Block, and NodeTableView.
 * 
 * Looks up each class ID in allClasses first, then falls back to allNodes.
 * Filters out the implicit "page" system class by default.
 */
import { useMemo } from 'react';
import { useClasses, useNodes } from '@/hooks';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import type { Node } from '@/types';

/**
 * Resolve a node's class IDs into full Node objects.
 * 
 * @param classIds - Array of class IDs to resolve (typically from node.classes)
 * @param options.includePageClass - If true, includes the implicit "page" class (default: false)
 * @param options.skipNodesFallback - If true, only searches allClasses, not allNodes (default: false)
 * @returns Array of resolved Node objects for the classes
 */
export function useResolvedClassDetails(
  classIds: number[] | undefined | null,
  options?: { includePageClass?: boolean; skipNodesFallback?: boolean }
): Node[] {
  const { data: allClasses } = useClasses();
  const { data: allNodes } = useNodes(
    options?.skipNodesFallback ? null : { pages_only: true }
  );

  return useMemo(() => {
    if (!classIds || classIds.length === 0) return [];

    return classIds
      .map((classId: number) => {
        const fromClasses = allClasses?.find(c => c.id === classId);
        if (fromClasses) return fromClasses;
        if (!options?.skipNodesFallback) {
          return allNodes?.find(n => n.id === classId);
        }
        return undefined;
      })
      .filter((c): c is Node =>
        c !== undefined &&
        (options?.includePageClass || c.uuid !== SYSTEM_CLASS_UUIDS.page)
      );
  }, [classIds, allClasses, allNodes, options?.includePageClass, options?.skipNodesFallback]);
}
