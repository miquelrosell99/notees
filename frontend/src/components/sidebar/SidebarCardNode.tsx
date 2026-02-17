/**
 * SidebarCardNode Component
 * 
 * A sidebar card that displays a node (page or block) with full NodeView.
 * - Pages: Show page name as the card title
 * - Blocks: Show "Block" as the card title
 */
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { SidebarCard } from './SidebarCard';
import { SidebarNodeView } from './SidebarNodeView';
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
  
  // Pages show the name, blocks show "Block"
  const title = cardType === 'page' ? (nodeNameToText(node?.name) || 'Untitled') : 'Block';
  
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
