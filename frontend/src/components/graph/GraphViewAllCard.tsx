/**
 * GraphViewAllCard Component
 * 
 * Minimap card showing all pages in a compact view.
 * Displayed in the bottom-right corner of the interface.
 * Uses NodeGraphViewSimple (no settings/menus).
 */
import { useMemo } from 'react';
import { useGraphData } from '@/hooks';
import { Card } from '../core/Card';
import { NodeGraphViewSimple } from './NodeGraphViewSimple';
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
  const { data: graphData, isLoading } = useGraphData();
  
  const nodes = useMemo(() => graphData?.nodes ?? [], [graphData]);
  const links = useMemo(() => graphData?.links ?? [], [graphData]);
  
  if (isLoading) {
    return (
      <Card className={`graph-view-all-card loading ${className}`} elevation="medium" padding={false}>
        <div className="graph-view-all-card__header">
          <h4>Graph Minimap</h4>
        </div>
        <div className="graph-view-all-card__loading">Loading...</div>
      </Card>
    );
  }
  
  if (nodes.length === 0) {
    return (
      <Card className={`graph-view-all-card empty ${className}`} elevation="medium" padding={false}>
        <div className="graph-view-all-card__header">
          <h4>Graph Minimap</h4>
        </div>
        <div className="graph-view-all-card__empty">No pages yet</div>
      </Card>
    );
  }
  
  return (
    <Card className={`graph-view-all-card ${className}`} elevation="medium" padding={false}>
      <div className="graph-view-all-card__header">
        <h4>Graph Minimap</h4>
        <span className="graph-view-all-card__hint">Click to navigate</span>
      </div>
      <div className="graph-view-all-card__content">
        <NodeGraphViewSimple
          nodes={nodes}
          links={links}
          currentNodeId={currentNodeId}
          className="graph-view-all-card__graph"
        />
      </div>
    </Card>
  );
}

export default GraphViewAllCard;
