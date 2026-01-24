/**
 * RightSidebarCards Component
 * 
 * A scrollable panel containing sidebar cards in the right sidebar.
 * Each card is rendered based on its type (page, block, localGraph).
 * Cards are added via various actions:
 * - shift-click on bullets adds page/block cards
 * - local graph button adds a localGraph card
 */
import { useCallback } from 'react';
import { useNodesStore } from '@/stores';
import type { SidebarCard } from '@/stores';
import { SidebarCardLocalGraph, SidebarCardNode } from '.';
import { SidebarContextSections } from './SidebarContextSections';
import { Button } from '../core/Button';
import './RightSidebarCards.css';

/**
 * Renders a single sidebar card based on its type
 */
function SidebarCardRenderer({ 
  card, 
  onClose 
}: { 
  card: SidebarCard; 
  onClose: (cardId: number) => void;
}) {
  const handleClose = useCallback(() => {
    onClose(card.id);
  }, [card.id, onClose]);

  switch (card.cardType) {
    case 'localGraph':
      return (
        <SidebarCardLocalGraph 
          nodeId={card.nodeId} 
          onClose={handleClose} 
        />
      );
    case 'page':
    case 'block':
      return (
        <SidebarCardNode 
          nodeId={card.nodeId} 
          cardType={card.cardType}
          onClose={handleClose} 
        />
      );
    default:
      return null;
  }
}

/**
 * Main component - scrollable panel of sidebar cards
 */
export function RightSidebarCards() {
  const { 
    sidebarCards, 
    removeSidebarCard, 
    clearSidebarCards,
  } = useNodesStore();

  const handleCardClose = useCallback((cardId: number) => {
    removeSidebarCard(cardId);
  }, [removeSidebarCard]);

  if (sidebarCards.length === 0) {
    return (
      <div className="right-sidebar-cards right-sidebar-cards--empty">
        <div className="right-sidebar-cards__empty-content">
          <p className="right-sidebar-cards__empty-text">
            Shift+click on a bullet to add blocks here
          </p>
        </div>
        {/* Context sections always appear at bottom */}
        <SidebarContextSections />
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
          <SidebarCardRenderer
            key={card.id}
            card={card}
            onClose={handleCardClose}
          />
        ))}
      </div>
      {/* Context sections always appear at bottom, after all cards */}
      <SidebarContextSections />
    </div>
  );
}

export default RightSidebarCards;
