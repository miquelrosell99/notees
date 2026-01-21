/**
 * FloatingMinimap component
 * 
 * A floating minimap window that appears in the bottom right corner.
 * Can be toggled from the TopBar using the map icon button.
 */
import { mdiClose } from '@mdi/js';
import { useNodesStore } from '@/stores';
import { GraphView } from '../views/GraphView';
import { Button } from './core/Button';
import './FloatingMinimap.css';

export function FloatingMinimap() {
  const { isMinimapOpen, setMinimapOpen, currentNodeId } = useNodesStore();
  
  if (!isMinimapOpen) {
    return null;
  }
  
  return (
    <div className="floating-minimap">
      <Button 
        icon={mdiClose}
        iconOnly
        className="floating-minimap-close"
        onClick={() => setMinimapOpen(false)}
        title="Close minimap"
        size="xs"
        variant="ghost"
      />
      <div className="floating-minimap-content">
        <GraphView 
          minimap={true}
          currentNodeId={currentNodeId}
          className="floating-minimap-graph"
        />
      </div>
    </div>
  );
}

export default FloatingMinimap;
