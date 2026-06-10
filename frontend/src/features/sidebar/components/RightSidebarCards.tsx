/**
 * RightSidebarCards Component
 * 
 * A scrollable panel containing sidebar cards in the right sidebar.
 * Each card is rendered based on its type (page, block, localGraph).
 * Cards are added via various actions:
 * - shift-click on bullets adds page/block cards
 * - local graph button adds a localGraph card
 */
import { useCallback, memo, useEffect, useRef } from 'react';
import { useNavigationStore } from '@/stores';
import type { SidebarCard } from '@/stores';
import { SidebarContextSections } from './SidebarContextSections';
import { Button } from '@/components/ui/Button';
import { getSidebarCardRenderer } from './sidebarCardRegistry';
import './registerSidebarCards';
import './RightSidebarCards.css';

/**
 * Renders a single sidebar card based on its type
 */
const SidebarCardRenderer = memo(function SidebarCardRenderer({
  card,
  onClose
}: {
  card: SidebarCard;
  onClose: (cardId: number) => void;
}) {
  const handleClose = useCallback(() => {
    onClose(card.id);
  }, [card.id, onClose]);

  const renderer = getSidebarCardRenderer(card.cardType);
  if (!renderer) return null;

  const Component = renderer.component;
  return <Component card={card} onClose={handleClose} />;
});

/**
 * Main component - scrollable panel of sidebar cards
 */
export function RightSidebarCards() {
  const { 
    sidebarCards, 
    removeSidebarCard, 
    clearSidebarCards,
    flashSidebarCardId,
  } = useNavigationStore();
  const listRef = useRef<HTMLDivElement>(null);

  const handleCardClose = useCallback((cardId: number) => {
    removeSidebarCard(cardId);
  }, [removeSidebarCard]);

  useFlashScroll(listRef, flashSidebarCardId);

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
      <div className="right-sidebar-cards__list" ref={listRef}>
        {sidebarCards.map(card => (
          <div
            key={card.id}
            data-card-id={card.id}
            className={`right-sidebar-cards__item ${flashSidebarCardId === card.id ? 'right-sidebar-cards__item--flash' : ''}`}
          >
            <SidebarCardRenderer
              card={card}
              onClose={handleCardClose}
            />
          </div>
        ))}
      </div>
      {/* Context sections always appear at bottom, after all cards */}
      <SidebarContextSections />
    </div>
  );
}

function useFlashScroll(listRef: React.RefObject<HTMLDivElement | null>, flashId: number | null) {
  useEffect(() => {
    if (!flashId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-card-id="${flashId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [flashId, listRef]);
}

