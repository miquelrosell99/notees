/**
 * AllPagesGraphView - displays all pages as a force-directed graph
 * 
 * Pseudo-page that fetches all graph data and passes it to GraphView.
 * Similar to AllPagesView but for graph visualization.
 */
import { useGraphNodes } from '@/hooks';
import { GraphView } from '@/features/content/components/nodes/views/GraphView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { DataStateView } from '@/components/ui/DataStateView';
import './AllPagesGraphView.css';

export interface AllPagesGraphViewProps {
  className?: string;
}

export function AllPagesGraphView({ className = '' }: AllPagesGraphViewProps) {
  const { data: graphNodes, isLoading, error, refetch } = useGraphNodes();

  return (
    <div className={`all-pages-graph-view ${className}`}>
      <DataStateView
        isLoading={isLoading}
        error={error}
        isEmpty={!graphNodes || graphNodes.length === 0}
        skeletonRows={6}
        emptyTitle="No pages yet"
        emptyDescription="Add pages to see them connected in the graph."
        onRetry={refetch}
        className="all-pages-graph-view__state"
      >
        <ErrorBoundary context="Graph View" showRetry>
          <GraphView
            viewId="global"
            nodes={graphNodes!}
            className="all-pages-graph-view__graph"
          />
        </ErrorBoundary>
      </DataStateView>
    </div>
  );
}
