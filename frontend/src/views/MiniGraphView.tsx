/**
 * MiniGraphView component
 * 
 * A compact global graph view used as a minimap for navigation.
 * Features:
 * - Shows entire graph in a small view
 * - Highlights currently open node with gold glare
 * - Single click navigates to node
 * - Shift+click opens in sidebar
 * - Doesn't dim non-selected nodes like the main graph
 */
import { GraphView } from './GraphView';
import { Card } from '@/components/core/Card';
import './MiniGraphView.css';

interface MiniGraphViewProps {
  /** Currently open node ID to highlight */
  currentNodeId: number | null;
  /** Optional class name */
  className?: string;
}

export function MiniGraphView({ currentNodeId, className = '' }: MiniGraphViewProps) {
  return (
    <Card 
      className={`mini-graph-view ${className}`}
      elevation="medium"
      padding={false}
    >
      <div className="mini-graph-header">
        <h4>Graph Minimap</h4>
        <span className="mini-graph-hint">Click to navigate</span>
      </div>
      <div className="mini-graph-container">
        <GraphView 
          minimap={true}
          currentNodeId={currentNodeId}
          className="mini-graph-canvas"
        />
      </div>
    </Card>
  );
}

export default MiniGraphView;
