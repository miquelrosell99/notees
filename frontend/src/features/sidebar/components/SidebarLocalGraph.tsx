/**
 * SidebarLocalGraph Component
 * 
 * Local graph showing connections for a specific node:
 * - The current page (center)
 * - Linked pages (outgoing references)
 * - Backlinked pages (incoming references)
 * 
 * Displayed inside a SidebarCard.
 * Passes all workspace nodes to GraphView, which filters by BFS depth
 * via the levels slider.
 */
import { useGraphNodes } from '@/hooks';
import { Spinner } from '@/components/ui/Spinner';
import { GraphView } from '@/features/content';
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
  const { data: allNodes, isLoading } = useGraphNodes();
  
  if (isLoading) {
    return (
      <div className={`graph-view-local loading ${className}`}>
        <Spinner size="md" centered />
      </div>
    );
  }
  
  if (!allNodes || allNodes.length === 0) {
    return (
      <div className={`graph-view-local empty ${className}`}>
        <div className="graph-view-local__empty">No connections yet</div>
      </div>
    );
  }
  
  return (
    <div className={`graph-view-local ${className}`}>
      <div className="graph-view-local__content">
        <GraphView
          viewId={`local-${nodeId}`}
          nodes={allNodes}
          currentNodeId={nodeId}
          showSettings={true}
          showSearch={false}
          showViewModes={false}
          localGraphMode={true}
          className="graph-view-local__graph"
        />
      </div>
    </div>
  );
}

