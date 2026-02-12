/**
 * GraphMinimap Component
 * 
 * Compact graph view displayed in the bottom-right corner.
 * Shows all workspace pages as a force-directed graph.
 */
import { useGraphNodes } from '@/hooks';
import { GraphView } from '@/components/nodes/views/GraphView';
import './GraphMinimap.css';

export interface GraphMinimapProps {
  /** CSS class */
  className?: string;
}

export function GraphMinimap({ 
  className = '' 
}: GraphMinimapProps) {
  const { data: graphNodes } = useGraphNodes();

  if (!graphNodes || graphNodes.length === 0) return null;

  return (
    <div className={`graph-minimap ${className}`}>
      <GraphView
        viewId="minimap"
        nodes={graphNodes}
        showSettings={false}
        showSearch={false}
        showViewModes={false}
        className="graph-minimap__graph"
      />
    </div>
  );
}

export default GraphMinimap;
