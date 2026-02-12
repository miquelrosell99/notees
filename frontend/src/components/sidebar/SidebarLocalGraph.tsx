/**
 * SidebarLocalGraph Component
 * 
 * Local graph showing connections for a specific node:
 * - The current page (center)
 * - Linked pages (outgoing references)
 * - Backlinked pages (incoming references)
 * 
 * Displayed inside a SidebarCard.
 * Extracts a subgraph and passes it to GraphView in controlled mode.
 */
import { useMemo } from 'react';
import { useGraphData, useNode } from '@/hooks';
import { GraphView } from '@/components/nodes/views/GraphView';
import './SidebarLocalGraph.css';

export interface SidebarLocalGraphProps {
  /** The node ID to center the local graph on */
  nodeId: number;
  /** CSS class */
  className?: string;
}

export function SidebarLocalGraph({ 
  nodeId,
  className = '' 
}: SidebarLocalGraphProps) {
  const { data: graphData, isLoading } = useGraphData();
  const { data: centerNode } = useNode(nodeId);
  
  // Extract local subgraph nodes centered on nodeId
  const nodes = useMemo(() => {
    if (!graphData) return [];
    
    // Build parent map from links
    const parentMap = new Map<number, number>();
    for (const link of graphData.links) {
      if (link.type === 'parent') {
        parentMap.set(link.target, link.source);
      }
    }
    
    // Helper to get all ancestors of a node
    const getAncestors = (nodeId: number): Set<number> => {
      const ancestors = new Set<number>();
      let currentId: number | null = nodeId;
      const visited = new Set<number>();
      
      while (currentId !== null && !visited.has(currentId)) {
        visited.add(currentId);
        ancestors.add(currentId);
        currentId = parentMap.get(currentId) ?? null;
      }
      
      return ancestors;
    };
    
    // Find all directly connected node IDs
    const connectedIds = new Set<number>();
    connectedIds.add(nodeId);
    
    for (const link of graphData.links) {
      if (link.source === nodeId) {
        connectedIds.add(link.target);
      } else if (link.target === nodeId) {
        connectedIds.add(link.source);
      }
    }
    
    // For each connected node, include all its ancestors (for full path display)
    const allIds = new Set<number>(connectedIds);
    for (const id of connectedIds) {
      const ancestors = getAncestors(id);
      ancestors.forEach(ancestorId => allIds.add(ancestorId));
    }
    
    // Filter nodes to include connected ones AND their ancestors
    return graphData.nodes.filter(n => allIds.has(n.id));
  }, [graphData, nodeId]);
  
  if (isLoading) {
    return (
      <div className={`graph-view-local loading ${className}`}>
        <div className="graph-view-local__loading">Loading...</div>
      </div>
    );
  }
  
  if (nodes.length === 0) {
    return (
      <div className={`graph-view-local empty ${className}`}>
        <div className="graph-view-local__empty">No connections</div>
      </div>
    );
  }
  
  return (
    <div className={`graph-view-local ${className}`}>
      <div className="graph-view-local__info">
        <span className="graph-view-local__label">
          {centerNode?.name || 'Local Graph'}
        </span>
        <span className="graph-view-local__stats">
          {nodes.length} nodes
        </span>
      </div>
      <div className="graph-view-local__content">
        <GraphView
          viewId={`local-${nodeId}`}
          nodes={nodes}
          currentNodeId={nodeId}
          showSettings={false}
          showSearch={false}
          showViewModes={false}
          className="graph-view-local__graph"
        />
      </div>
    </div>
  );
}

export default SidebarLocalGraph;
