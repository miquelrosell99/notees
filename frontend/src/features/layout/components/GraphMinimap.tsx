/**
 * GraphMinimap Component
 * 
 * Compact graph view displayed in the bottom-right corner.
 * Shows all workspace pages as a force-directed graph.
 */
import { useGraphNodes } from '@/hooks';
import { GraphView } from '@/features/content/components/nodes/views/GraphView';
import { Button } from '@/components/ui/Button';
import './GraphMinimap.css';

export interface GraphMinimapProps {
  /** CSS class */
  className?: string;
  /** Callback when close button is clicked */
  onClose?: () => void;
}

export function GraphMinimap({ 
  className = '',
  onClose
}: GraphMinimapProps) {
  const { data: graphNodes } = useGraphNodes();

  if (!graphNodes || graphNodes.length === 0) return null;

  return (
    <div className={`graph-minimap ${className}`}>
      {onClose && (
        <Button 
          icon={"mdi mdi-close"}
          className="graph-minimap__close"
          onClick={onClose}
          title="Close minimap"
          size="xs"
          variant="ghost"
        />
      )}
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

