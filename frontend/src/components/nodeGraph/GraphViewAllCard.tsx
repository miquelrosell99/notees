/**
 * GraphViewAllCard Component
 * 
 * Minimap card showing all pages in a compact view.
 * Displayed in the bottom-right corner of the interface.
 * Uses NodeGraphView in self-fetching mode with chrome disabled.
 */
import { Card } from '../core/Card';
import { NodeGraphView } from './NodeGraphView';
import './GraphViewAllCard.css';

export interface GraphViewAllCardProps {
  /** Currently highlighted node ID */
  currentNodeId?: number | null;
  /** CSS class */
  className?: string;
}

export function GraphViewAllCard({ 
  currentNodeId = null,
  className = '' 
}: GraphViewAllCardProps) {
  return (
    <Card className={`graph-view-all-card ${className}`} elevation="medium" padding={false}>
      <div className="graph-view-all-card__header">
        <h4>Graph Minimap</h4>
        <span className="graph-view-all-card__hint">Click to navigate</span>
      </div>
      <div className="graph-view-all-card__content">
        <NodeGraphView
          viewId="minimap"
          currentNodeId={currentNodeId}
          chrome={false}
          className="graph-view-all-card__graph"
        />
      </div>
    </Card>
  );
}

export default GraphViewAllCard;
