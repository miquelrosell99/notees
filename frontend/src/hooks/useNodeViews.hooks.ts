/**
 * NodeView Utility Hooks
 */

import { useNodeViews } from './useNodeViews.queries';

export function useActiveNodeView(
  nodeId: number,
  viewType: string,
  activeViewId?: number
) {
  const { data: views = [], isLoading } = useNodeViews(nodeId, {
    viewType,
  });

  const activeView = activeViewId
    ? views.find((v) => v.id === activeViewId)
    : views[0]; // First view (lowest order_index) is default

  return {
    views,
    activeView,
    isLoading,
    hasMultipleViews: views.length > 1,
  };
}

/**
 * Hook to manage NodeView tab state
 */
export function useNodeViewTabs(nodeId: number, viewType: string) {
  const { data: views = [], isLoading, isError } = useNodeViews(nodeId, {
    viewType,
  });

  const defaultView = views.length > 0 ? views[0] : null;
  
  return {
    views,
    defaultView,
    isLoading,
    isError,
    isEmpty: views.length === 0,
  };
}
