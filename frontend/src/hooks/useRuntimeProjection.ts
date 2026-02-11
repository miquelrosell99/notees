/**
 * useRuntimeProjection — Hook that projects nodes from the runtime
 * and re-renders when the projection changes.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { ProjectionReconciler } from '../runtime/ProjectionReconciler';
import type { ProjectedNode, ProjectionQuery, ViewMode } from '../runtime/types';

export interface UseRuntimeProjectionOptions {
  rootBlockId: string;
  maxDepth?: number;
  includeRoot?: boolean;
  viewMode?: ViewMode;
}

export interface UseRuntimeProjectionResult {
  projectedNodes: ProjectedNode[];
  visibleNodes: ProjectedNode[];
  projectionId: string;
}

export function useRuntimeProjection({
  rootBlockId,
  maxDepth = -1,
  includeRoot = false,
  viewMode = 'list',
}: UseRuntimeProjectionOptions): UseRuntimeProjectionResult {
  const projectionId = useMemo(
    () => `projection-${rootBlockId}-${viewMode}`,
    [rootBlockId, viewMode],
  );

  const reconcilerRef = useRef(new ProjectionReconciler(projectionId));
  const [projectedNodes, setProjectedNodes] = useState<ProjectedNode[]>([]);

  useEffect(() => {
    const runtime = getNodeGraphRuntime();
    const reconciler = reconcilerRef.current;

    const query: ProjectionQuery = {
      projectionId,
      rootBlockId,
      maxDepth,
      includeRoot,
    };

    const updateProjection = () => {
      const nodes = runtime.project(query);
      reconciler.reconcile(nodes);
      setProjectedNodes(nodes);
    };

    // Initial projection
    updateProjection();

    // Subscribe to runtime changes
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'nodes_changed' || event.type === 'structure_changed') {
        updateProjection();
      }
    });

    return () => {
      unsubscribe();
      reconciler.reset();
    };
  }, [rootBlockId, maxDepth, includeRoot, projectionId]);

  const visibleNodes = useMemo(
    () => projectedNodes.filter(n => n.visible),
    [projectedNodes],
  );

  return { projectedNodes, visibleNodes, projectionId };
}
