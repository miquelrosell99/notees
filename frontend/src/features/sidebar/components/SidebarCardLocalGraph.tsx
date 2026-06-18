/**
 * SidebarCardLocalGraph Component
 * 
 * A sidebar card that displays the local graph for a specific node.
 * Shows the page name as the card title and renders SidebarLocalGraph in the content.
 */
import { useNode } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { SidebarCard } from './SidebarCard';
import { SidebarLocalGraph } from './SidebarLocalGraph';
import './SidebarCardLocalGraph.css';

interface SidebarCardLocalGraphProps {
  /** The node ID to show the local graph for */
  nodeId: number;
  /** Callback when the card is closed */
  onClose: () => void;
}

export function SidebarCardLocalGraph({ nodeId, onClose }: SidebarCardLocalGraphProps) {
  const { data: node, isLoading, error } = useNode(nodeId);
  
  const title = nodeNameToText(node?.name) || 'Local Graph';
  
  return (
    <SidebarCard
      title={title}
      onClose={onClose}
      className="sidebar-card-local-graph"
      scrollable={false}
      loading={isLoading}
      error={error ? 'Failed to load node' : undefined}
    >
      <SidebarLocalGraph nodeId={nodeId} className="sidebar-card-local-graph__content" />
    </SidebarCard>
  );
}

