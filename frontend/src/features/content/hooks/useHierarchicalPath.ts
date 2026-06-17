/**
 * Hook for analyzing hierarchical paths
 * Provides real-time analysis of which pages exist in a path structure
 */
import { useMemo } from 'react';
import { usePages } from './useNodes';
import { analyzeHierarchicalPath, type HierarchicalPathAnalysis } from '@/utils/hierarchicalPath';

/**
 * Analyze a hierarchical path to determine which pages exist
 * 
 * @param path - The path to analyze (e.g., "Pokemon/Charizard")
 * @param includeLeaf - Whether to include the leaf segment in the analysis
 * @returns Analysis of the path structure, or null if not hierarchical
 * 
 * @example
 * const pathInfo = useHierarchicalPath("Pokemon/Charizard");
 * // Returns: { segments: [{ name: "Pokemon", exists: true }, { name: "Charizard", exists: false }], ... }
 */
export function useHierarchicalPath(
  path: string,
  includeLeaf: boolean = true
): HierarchicalPathAnalysis | null {
  const { data: allPages } = usePages({ includeChildren: true });
  
  return useMemo(() => {
    if (!path.trim() || !allPages) return null;
    return analyzeHierarchicalPath(path.trim(), allPages, includeLeaf);
  }, [path, allPages, includeLeaf]);
}
