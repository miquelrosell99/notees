/**
 * SidebarCardNode Component
 * 
 * A sidebar card that displays a node (page or block) with full NodeView.
 * - Pages: Show page name as the card title
 * - Blocks: No title in the header (empty)
 */
import { useNode } from '@/hooks';
import { SidebarCard } from '../SidebarCard';
import { SidebarNodeView } from '../SidebarNodeView';
import './SidebarCardNode.css';

interface SidebarCardNodeProps {
  /** The node ID to display */
  nodeId: number;
  /** Whether this is a page or block */
  cardType: 'page' | 'block';
  /** Callback when the card is closed */
  onClose: () => void;
}

export function SidebarCardNode({ nodeId, cardType, onClose }: SidebarCardNodeProps) {
  const { data: node, isLoading, error } = useNode(nodeId);
  
  // Pages show the name, blocks show no title
  const title = cardType === 'page' ? (node?.name || 'Untitled') : undefined;
  
  return (
    <SidebarCard
      title={title}
      onClose={onClose}
      className={`sidebar-card-node sidebar-card-node--${cardType}`}
      scrollable={true}
      loading={isLoading}
      error={error ? 'Failed to load node' : undefined}
    >
      <SidebarNodeView nodeId={nodeId} nodeType={cardType} hideHeader />
    </SidebarCard>
  );
}

export default SidebarCardNode;
