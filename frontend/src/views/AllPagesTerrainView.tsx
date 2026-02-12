/**
 * AllPagesTerrainView - displays all pages as a terrain contour map
 * 
 * Pseudo-page that fetches all graph data and passes it to TerrainView.
 * Similar to AllPagesGraphView but for terrain visualization.
 */
import { useGraphNodes } from '@/hooks';
import { TerrainView } from '@/components/nodes/views/TerrainView';
import './AllPagesGraphView.css'; // Reuse the same styles

export interface AllPagesTerrainViewProps {
  className?: string;
}

export function AllPagesTerrainView({ className = '' }: AllPagesTerrainViewProps) {
  const { data: graphNodes, isLoading } = useGraphNodes();

  if (isLoading) {
    return (
      <div className={`all-pages-graph-view all-pages-graph-view--loading ${className}`}>
        <div className="all-pages-graph-view__loading">Loading terrain...</div>
      </div>
    );
  }

  if (!graphNodes || graphNodes.length === 0) {
    return (
      <div className={`all-pages-graph-view all-pages-graph-view--empty ${className}`}>
        <div className="all-pages-graph-view__empty">
          <h3>No pages found</h3>
          <p>Create some pages to see them in the terrain view.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`all-pages-graph-view ${className}`}>
      <TerrainView
        viewId="global"
        nodes={graphNodes}
        className="all-pages-graph-view__graph"
      />
    </div>
  );
}

export default AllPagesTerrainView;
