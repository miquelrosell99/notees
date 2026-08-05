/**
 * SidebarCardNode Component
 * 
 * A sidebar card that displays a node (page or block) with full NodeView.
 * - Pages: Show page name as the card title
 * - Blocks: Show block name as the card title
 */
import { useCallback } from 'react';
import { useNode } from '@/features/content';
import { useNodeDisplayName } from '@/features/queries';
import { useNavigationStore } from '@/stores';
import { SidebarCard } from './SidebarCard';
import { SidebarNodeView } from './SidebarNodeView';
import './SidebarCardNode.css';

interface SidebarCardNodeProps {
  /** The node UUID to display */
  nodeUuid: string;
  /** Whether this is a page or block */
  cardType: 'page' | 'block';
  /** Callback when the card is closed */
  onClose: () => void;
}

export function SidebarCardNode({ nodeUuid, cardType, onClose }: SidebarCardNodeProps) {
  const { data: node, isLoading, error } = useNode(nodeUuid);
  const openNode = useNavigationStore((state) => state.openNode);
  const displayName = useNodeDisplayName(node);

  const handleOpen = useCallback(() => {
    if (node) openNode(node.uuid);
  }, [node, openNode]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!node) return;
    e.dataTransfer.setData(
      'application/x-notees-node',
      JSON.stringify({
        nodeUuid: node.uuid,
        name: displayName,
      })
    );
    e.dataTransfer.effectAllowed = 'link';
  }, [node, displayName]);

  const titleText = displayName;

  const title = (
    <button
      type="button"
      className="sidebar-card-node__title-link"
      onClick={handleOpen}
    >
      {titleText}
    </button>
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
      <SidebarNodeView nodeUuid={nodeUuid} nodeType={cardType} />
    </SidebarCard>
  );
}

