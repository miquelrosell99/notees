/**
 * GraphViewLocal Component
 * 
 * Local graph showing connections for a specific node:
 * - The current page (center)
 * - Linked pages (outgoing references)
 * - Backlinked pages (incoming references)
 * 
 * Displayed inside a SidebarCard.
 * Uses NodeGraphViewSimple (no settings/menus).
 */
import { useMemo } from 'react';
import { useGraphData, useNode } from '@/hooks';
import { NodeGraphViewSimple } from './NodeGraphViewSimple';
import './GraphViewLocal.css';

export interface GraphViewLocalProps {
  /** The node ID to center the local graph on */
  nodeId: number;
  /** CSS class */
  className?: string;
}

export function GraphViewLocal({ 
  nodeId,
  className = '' 
}: GraphViewLocalProps) {
  const { data: graphData, isLoading } = useGraphData();
  const { data: centerNode } = useNode(nodeId);
  
  // Extract local subgraph centered on nodeId
  const { nodes, links } = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    
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
    const localNodes = graphData.nodes.filter(n => allIds.has(n.id));
    
    // Filter links to only include those between local nodes
    const localLinks = graphData.links.filter(
      l => allIds.has(l.source) && allIds.has(l.target)
    );
    
    return { nodes: localNodes, links: localLinks };
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
          {nodes.length} nodes • {links.length} connections
        </span>
      </div>
      <div className="graph-view-local__content">
        <NodeGraphViewSimple
          nodes={nodes}
          links={links}
          currentNodeId={nodeId}
          className="graph-view-local__graph"
        />
      </div>
    </div>
  );
}

export default GraphViewLocal;
