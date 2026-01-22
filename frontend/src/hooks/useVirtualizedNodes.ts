/**
 * useVirtualizedNodes Hook
 * 
 * A hook for viewport-based node rendering using IntersectionObserver.
 * Tracks which nodes are visible and provides optimizations for:
 * - Deferring render of off-screen nodes
 * - Unloading/simplifying nodes far outside viewport
 * - Efficient scroll-based loading
 * 
 * Performance Benefits:
 * - Reduces DOM nodes for large node trees
 * - Decreases React reconciliation work
 * - Lower memory footprint for off-screen content
 * 
 * Usage:
 * ```tsx
 * function NodeList({ nodes }) {
 *   const { 
 *     visibleIds, 
 *     registerRef, 
 *     isVisible,
 *     shouldRender 
 *   } = useVirtualizedNodes({
 *     nodeIds: nodes.map(n => n.id),
 *     overscan: 5,  // Render 5 nodes beyond viewport
 *   });
 * 
 *   return nodes.map(node => (
 *     <div key={node.id} ref={registerRef(node.id)}>
 *       {shouldRender(node.id) ? (
 *         <Block node={node} />
 *       ) : (
 *         <NodePlaceholder height={estimatedHeight} />
 *       )}
 *     </div>
 *   ));
 * }
 * ```
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';

export interface UseVirtualizedNodesOptions {
  /** Array of node IDs to track */
  nodeIds: number[];
  /** Number of nodes to render beyond the viewport (default: 5) */
  overscan?: number;
  /** Root margin for IntersectionObserver (default: '200px') */
  rootMargin?: string;
  /** Threshold for visibility (0-1, default: 0) */
  threshold?: number;
  /** Whether virtualization is enabled (default: true) */
  enabled?: boolean;
}

export interface UseVirtualizedNodesReturn {
  /** Set of currently visible node IDs */
  visibleIds: Set<number>;
  /** Register a ref for a node - call with node ID, returns callback ref */
  registerRef: (nodeId: number) => (el: HTMLElement | null) => void;
  /** Check if a specific node is visible */
  isVisible: (nodeId: number) => boolean;
  /** Check if a node should be fully rendered (visible + overscan) */
  shouldRender: (nodeId: number) => boolean;
  /** Check if a node is within the overscan range */
  isInOverscan: (nodeId: number) => boolean;
}

/**
 * Hook for tracking and virtualizing visible nodes
 */
export function useVirtualizedNodes({
  nodeIds,
  overscan = 5,
  rootMargin = '200px',
  threshold = 0,
  enabled = true,
}: UseVirtualizedNodesOptions): UseVirtualizedNodesReturn {
  // Track visible node IDs
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  
  // Store refs for each node element
  const elementRefs = useRef<Map<number, HTMLElement>>(new Map());
  
  // Store the observer instance
  const observerRef = useRef<IntersectionObserver | null>(null);
  
  // Store node order for overscan calculation
  const nodeOrderRef = useRef<number[]>([]);
  useEffect(() => {
    nodeOrderRef.current = nodeIds;
  }, [nodeIds]);

  // Calculate which nodes should render (visible + overscan)
  const renderIds = useMemo(() => {
    if (!enabled) {
      return new Set(nodeIds);
    }
    
    const result = new Set<number>();
    const order = nodeOrderRef.current;
    
    // Add visible nodes and their neighbors
    visibleIds.forEach(id => {
      const index = order.indexOf(id);
      if (index === -1) {
        result.add(id);
        return;
      }
      
      // Add overscan nodes before
      for (let i = Math.max(0, index - overscan); i < index; i++) {
        result.add(order[i]);
      }
      
      // Add the visible node
      result.add(id);
      
      // Add overscan nodes after
      for (let i = index + 1; i <= Math.min(order.length - 1, index + overscan); i++) {
        result.add(order[i]);
      }
    });
    
    return result;
  }, [visibleIds, nodeIds, overscan, enabled]);

  // Initialize IntersectionObserver
  useEffect(() => {
    if (!enabled) {
      // When disabled, mark all as visible
      setVisibleIds(new Set(nodeIds));
      return;
    }

    // Disconnect existing observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    // Create new observer
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setVisibleIds(prev => {
          const next = new Set(prev);
          let changed = false;
          
          entries.forEach(entry => {
            // Find node ID from element
            const nodeId = parseInt(entry.target.getAttribute('data-node-id') ?? '', 10);
            if (isNaN(nodeId)) return;
            
            if (entry.isIntersecting) {
              if (!next.has(nodeId)) {
                next.add(nodeId);
                changed = true;
              }
            } else {
              if (next.has(nodeId)) {
                next.delete(nodeId);
                changed = true;
              }
            }
          });
          
          return changed ? next : prev;
        });
      },
      {
        rootMargin,
        threshold,
      }
    );

    // Observe all existing elements
    elementRefs.current.forEach((el, nodeId) => {
      el.setAttribute('data-node-id', String(nodeId));
      observerRef.current?.observe(el);
    });

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, [enabled, rootMargin, threshold, nodeIds]);

  // Create ref registration function
  const registerRef = useCallback((nodeId: number) => {
    return (el: HTMLElement | null) => {
      const prevEl = elementRefs.current.get(nodeId);
      
      // Unobserve previous element
      if (prevEl && prevEl !== el && observerRef.current) {
        observerRef.current.unobserve(prevEl);
      }
      
      if (el) {
        // Store and observe new element
        elementRefs.current.set(nodeId, el);
        el.setAttribute('data-node-id', String(nodeId));
        
        if (observerRef.current) {
          observerRef.current.observe(el);
        }
      } else {
        // Remove from tracking
        elementRefs.current.delete(nodeId);
        setVisibleIds(prev => {
          if (prev.has(nodeId)) {
            const next = new Set(prev);
            next.delete(nodeId);
            return next;
          }
          return prev;
        });
      }
    };
  }, []);

  // Check if a specific node is visible
  const isVisible = useCallback((nodeId: number) => {
    return !enabled || visibleIds.has(nodeId);
  }, [visibleIds, enabled]);

  // Check if a node should be rendered (visible + overscan)
  const shouldRender = useCallback((nodeId: number) => {
    return !enabled || renderIds.has(nodeId);
  }, [renderIds, enabled]);

  // Check if a node is in overscan (not directly visible but should be rendered)
  const isInOverscan = useCallback((nodeId: number) => {
    return !enabled || (renderIds.has(nodeId) && !visibleIds.has(nodeId));
  }, [renderIds, visibleIds, enabled]);

  return {
    visibleIds,
    registerRef,
    isVisible,
    shouldRender,
    isInOverscan,
  };
}

/**
 * Lightweight placeholder props for virtualized nodes
 * Shows a minimal representation while the full node is off-screen
 */
export interface NodePlaceholderProps {
  /** Estimated height of the node */
  height?: number;
  /** Whether to show a loading shimmer */
  shimmer?: boolean;
  /** Additional className */
  className?: string;
}

export default useVirtualizedNodes;
