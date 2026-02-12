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
import { useGraphNodes, useGraphLinks, useNode } from '@/hooks';
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
  const { data: allNodes, isLoading: nodesLoading } = useGraphNodes();
  const { data: centerNode } = useNode(nodeId);
  
  // Fetch links touching this node (neighborhood discovery)
  const { data: touchingLinks = [], isLoading: linksLoading } = useGraphLinks(
    [nodeId],
    { scope: 'touching' }
  );
  
  // Extract local subgraph nodes centered on nodeId
  const nodes = useMemo(() => {
    if (!allNodes || touchingLinks.length === 0) return [];
    
    // Find all directly connected node IDs from touching links
    const connectedIds = new Set<number>();
    connectedIds.add(nodeId);
    
    for (const link of touchingLinks) {
      connectedIds.add(link.source);
      connectedIds.add(link.target);
    }
    
    // Filter nodes to just the connected ones
    return allNodes.filter(n => connectedIds.has(n.id));
  }, [allNodes, touchingLinks, nodeId]);
  
  const isLoading = nodesLoading || linksLoading;
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
