/**
 * SidebarCardNode Component
 * 
 * A sidebar card that displays a node (page or block) with full NodeView.
 * - Pages: Show page name as the card title
 * - Blocks: Show block name as the card title
 */
import { useCallback } from 'react';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore } from '@/stores';
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
  const { openNode } = useNavigationStore();

  const handleOpen = useCallback(() => {
    if (node) openNode(node.id);
  }, [node, openNode]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!node) return;
    e.dataTransfer.setData(
      'application/x-notees-node',
      JSON.stringify({
        nodeId: node.id,
        nodeUuid: node.uuid,
        name: nodeNameToText(node.name) || 'Untitled',
      })
    );
    e.dataTransfer.effectAllowed = 'link';
  }, [node]);

  const titleText = nodeNameToText(node?.name) || 'Untitled';

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpen();
    }
  }, [handleOpen]);

  const title = (
    <span
      className="sidebar-card-node__title-link"
      onClick={handleOpen}
      onKeyDown={handleTitleKeyDown}
      role="button"
      tabIndex={0}
    >
      {titleText}
    </span>
  );

  return (
    <SidebarCard
      title={title}
      onClose={onClose}
      onOpen={handleOpen}
      draggable={true}
      onHeaderDragStart={handleDragStart}
      className={`sidebar-card-node sidebar-card-node--${cardType}`}
      scrollable={true}
      loading={isLoading}
      error={error ? 'Failed to load node' : undefined}
    >
      <SidebarNodeView nodeId={nodeId} nodeType={cardType} />
    </SidebarCard>
  );
}

