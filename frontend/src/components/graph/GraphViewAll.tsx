/**
 * GraphViewAll Component
 * 
 * Main graph view showing all pages in the system.
 * Rendered in the main content area as a dedicated view.
 * Uses NodeGraphView (full-featured with settings).
 */
import { NodeGraphView } from './NodeGraphView';
import './GraphViewAll.css';

export interface GraphViewAllProps {
  /** CSS class */
  className?: string;
}

export function GraphViewAll({ className = '' }: GraphViewAllProps) {
  return (
    <div className={`graph-view-all ${className}`}>
      <NodeGraphView className="graph-view-all__graph" />
    </div>
  );
}

export default GraphViewAll;
