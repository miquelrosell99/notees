/**
 * FloatingMinimap component
 * 
 * A floating minimap window that appears in the bottom right corner.
 * Can be toggled from the TopBar using the map icon button.
 */
import { useNodesStore } from '@/stores';
import { GraphView } from '../views/GraphView';
import { ButtonClose } from './core/ButtonClose';
import './FloatingMinimap.css';

export function FloatingMinimap() {
  const { isMinimapOpen, setMinimapOpen, currentNodeId } = useNodesStore();
  
  if (!isMinimapOpen) {
    return null;
  }
  
  return (
    <div className="floating-minimap">
      <ButtonClose 
        className="floating-minimap-close"
        onClick={() => setMinimapOpen(false)}
        title="Close minimap"
        size="xs"
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
