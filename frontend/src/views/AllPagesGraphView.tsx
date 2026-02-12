/**
 * AllPagesGraphView - displays all pages as a force-directed graph
 * 
 * Pseudo-page that fetches all graph data and passes it to GraphView.
 * Similar to AllPagesView but for graph visualization.
 */
import { useGraphNodes } from '@/hooks';
import { GraphView } from '@/components/nodes/views/GraphView';
import './AllPagesGraphView.css';

export interface AllPagesGraphViewProps {
  className?: string;
}

export function AllPagesGraphView({ className = '' }: AllPagesGraphViewProps) {
  const { data: graphNodes, isLoading } = useGraphNodes();

  if (isLoading) {
    return (
      <div className={`all-pages-graph-view all-pages-graph-view--loading ${className}`}>
        <div className="all-pages-graph-view__loading">Loading graph...</div>
      </div>
    );
  }

  if (!graphNodes || graphNodes.length === 0) {
    return (
      <div className={`all-pages-graph-view all-pages-graph-view--empty ${className}`}>
        <div className="all-pages-graph-view__empty">
          <h3>No pages found</h3>
          <p>Create some pages to see them in the graph view.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`all-pages-graph-view ${className}`}>
      <GraphView
        viewId="global"
        nodes={graphNodes}
        className="all-pages-graph-view__graph"
      />
    </div>
  );
}

export default AllPagesGraphView;
