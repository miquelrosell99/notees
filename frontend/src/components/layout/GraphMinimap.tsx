/**
 * GraphMinimap Component
 * 
 * Minimap card showing all pages in a compact view.
 * Displayed in the bottom-right corner of the interface.
 * Fetches graph data and passes it to GraphView with toolbar disabled.
 */
import { Card } from '@/components/core/Card';
import { useGraphNodes } from '@/hooks';
import { GraphView } from '@/components/nodes/views/GraphView';
import './GraphMinimap.css';

export interface GraphMinimapProps {
  /** Currently highlighted node ID */
  currentNodeId?: number | null;
  /** CSS class */
  className?: string;
}

export function GraphMinimap({ 
  currentNodeId = null,
  className = '' 
}: GraphMinimapProps) {
  const { data: graphNodes } = useGraphNodes();

  if (!graphNodes || graphNodes.length === 0) return null;

  return (
    <Card className={`graph-view-all-card ${className}`} elevation="medium" padding={false}>
      <div className="graph-view-all-card__header">
        <h4>Graph Minimap</h4>
        <span className="graph-view-all-card__hint">Click to navigate</span>
      </div>
      <div className="graph-view-all-card__content">
        <GraphView
          viewId="minimap"
          nodes={graphNodes}
          currentNodeId={currentNodeId}
          showSettings={false}
          showSearch={false}
          showViewModes={false}
          className="graph-view-all-card__graph"
        />
      </div>
    </Card>
  );
}

export default GraphMinimap;
