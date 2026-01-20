/**
 * RightSidebarCards Component
 * 
 * A scrollable list of node cards in the right sidebar.
 * Each card shows a preview of a node (page or block) and can be dismissed.
 * Cards are added via shift-click on block bullets.
 */
import { useCallback } from 'react';
import { useNodesStore } from '@/stores';
import type { SidebarCard } from '@/stores';
import { useNode } from '@/hooks';
import { NodeIcon } from './icons';
import { Button } from './core/Button';
import { ButtonClose } from './core/ButtonClose';
import './RightSidebarCards.css';

interface SidebarCardItemProps {
  card: SidebarCard;
  onClose: (cardId: number) => void;
  onClick: (nodeId: number, nodeType: 'page' | 'block') => void;
}

/**
 * Individual card item in the sidebar
 */
function SidebarCardItem({ card, onClose, onClick }: SidebarCardItemProps) {
  const { data: node, isLoading, error } = useNode(card.nodeId, {
    include_children: true,
  });

  const handleClick = useCallback(() => {
    onClick(card.nodeId, card.nodeType);
  }, [card.nodeId, card.nodeType, onClick]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(card.id);
  }, [card.id, onClose]);

  if (isLoading) {
    return (
      <div className="sidebar-card-item sidebar-card-item--loading">
        <div className="sidebar-card-item__spinner" />
      </div>
    );
  }

  if (error || !node) {
    return (
      <div className="sidebar-card-item sidebar-card-item--error">
        <span>Failed to load</span>
        <ButtonClose size="xs" onClick={handleClose} title="Remove" />
      </div>
    );
  }

  // Get a preview of children for pages
  const childPreview = node.children?.slice(0, 3) || [];
  
  // Truncate content for display
  const truncateContent = (content: string | null | undefined, maxLength: number) => {
    if (!content) return '';
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  return (
    <div className="sidebar-card-item" onClick={handleClick}>
      <div className="sidebar-card-item__header">
        <NodeIcon 
          icon={node.icon} 
          isPage={node.is_page} 
          isDaily={node.is_daily}
          isMonthly={node.is_monthly}
          isYearly={node.is_yearly}
          size="xs" 
          className="sidebar-card-item__icon"
        />
        <span className="sidebar-card-item__title">
          {node.name || 'Untitled'}
        </span>
        <ButtonClose 
          size="xs" 
          onClick={handleClose} 
          title="Remove from sidebar"
          className="sidebar-card-item__close"
        />
      </div>
      
      {/* Show content preview for blocks */}
      {card.nodeType === 'block' && node.name && (
        <div className="sidebar-card-item__content">
          {truncateContent(node.name, 100)}
        </div>
      )}
      
      {/* Show children preview for pages */}
      {card.nodeType === 'page' && childPreview.length > 0 && (
        <div className="sidebar-card-item__children">
          {childPreview.map(child => (
            <div key={child.id} className="sidebar-card-item__child">
              <span className="sidebar-card-item__child-bullet">•</span>
              <span className="sidebar-card-item__child-text">
                {truncateContent(child.name, 50)}
              </span>
            </div>
          ))}
          {(node.children?.length || 0) > 3 && (
            <div className="sidebar-card-item__more">
              +{(node.children?.length || 0) - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main component - scrollable list of sidebar cards
 */
export function RightSidebarCards() {
  const { 
    sidebarCards, 
    removeSidebarCard, 
    clearSidebarCards,
    openNode,
  } = useNodesStore();

  const handleCardClose = useCallback((cardId: number) => {
    removeSidebarCard(cardId);
  }, [removeSidebarCard]);

  const handleCardClick = useCallback((nodeId: number, nodeType: 'page' | 'block') => {
    openNode(nodeId, nodeType);
  }, [openNode]);

  if (sidebarCards.length === 0) {
    return (
      <div className="right-sidebar-cards right-sidebar-cards--empty">
        <p className="right-sidebar-cards__empty-text">
          Shift+click on a bullet to add blocks here
        </p>
      </div>
    );
  }

  return (
    <div className="right-sidebar-cards">
      <div className="right-sidebar-cards__subheader">
        <span className="right-sidebar-cards__count">
          {sidebarCards.length} {sidebarCards.length === 1 ? 'card' : 'cards'}
        </span>
        <Button 
          variant="ghost"
          size="xs"
          className="right-sidebar-cards__clear-btn"
          onClick={clearSidebarCards}
          title="Clear all cards"
        >
          Clear all
        </Button>
      </div>
      <div className="right-sidebar-cards__list">
        {sidebarCards.map(card => (
          <SidebarCardItem
            key={card.id}
            card={card}
            onClose={handleCardClose}
            onClick={handleCardClick}
          />
        ))}
      </div>
    </div>
  );
}

export default RightSidebarCards;
