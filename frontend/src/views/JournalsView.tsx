/**
 * Journals view - displays all existing daily pages
 * 
 * Only shows pages that already exist, does not create new ones.
 * Uses NodeView component for each daily page for consistent editing experience.
 */
import { useState, useMemo, useCallback } from 'react';
import { useExistingDailyPages, useNode, useDailyNote } from '@/hooks';
import './JournalsView.css';
import { useAppStore } from '@/stores';
import { NodeViewContent } from './NodeView';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import { JournalIcon } from '../components/core/icons';

interface JournalEntryProps {
  dailyPageId: number;
}

function JournalEntry({ dailyPageId }: JournalEntryProps) {
  const { viewMode } = useAppStore();
  const { data: page } = useNode(dailyPageId);
  
  // Get border color if page has a color
  const borderColor = page?.color;
  
  return (
    <article className="journal-entry">
      {borderColor ? (
        <Card 
          elevation="medium" 
          variant="default" 
          padding={false}
          radius="lg"
          className="journal-entry__card"
          style={{ 
            '--card-border-color': borderColor,
            borderLeft: '8px solid var(--card-border-color)'
          } as React.CSSProperties}
        >
          <NodeViewContent 
            nodeId={dailyPageId} 
            nodeType="page" 
            viewMode={viewMode}
          />
        </Card>
      ) : (
        <NodeViewContent 
          nodeId={dailyPageId} 
          nodeType="page" 
          viewMode={viewMode}
        />
      )}
    </article>
  );
}

interface JournalsViewProps {
  className?: string;
}

export function JournalsView({ className = '' }: JournalsViewProps) {
  const { data: dailyPages, isLoading, error } = useExistingDailyPages();
  const [visibleCount, setVisibleCount] = useState(10);
  const { openNode } = useAppStore();
  const { refetch: refetchToday } = useDailyNote(new Date());

  const handleOpenToday = useCallback(async () => {
    const result = await refetchToday();
    if (result.data) openNode(result.data.id);
  }, [refetchToday, openNode]);
  
  // Sort daily pages in descending order (newest first)
  const sortedPages = useMemo(() => {
    if (!dailyPages) return [];
    return [...dailyPages].sort((a, b) => {
      const nameA = a.name || '';
      const nameB = b.name || '';
      return nameB.localeCompare(nameA); // Descending order
    });
  }, [dailyPages]);
  
  const visiblePages = useMemo(() => {
    return sortedPages.slice(0, visibleCount);
  }, [sortedPages, visibleCount]);
  
  const hasMore = sortedPages.length > visibleCount;
  
  const handleLoadMore = () => {
    setVisibleCount(prev => Math.min(prev + 10, sortedPages.length));
  };
  
  if (isLoading) {
    return (
      <div className={`journals-view ${className}`}>
        <div className="journals-loading">
          <div className="journals-loading__spinner" aria-label="Loading journal entries" />
          <p>Loading journal entries...</p>
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className={`journals-view ${className}`}>
        <div className="journals-error">Failed to load journal entries</div>
      </div>
    );
  }
  
  return (
    <div className={`journals-view ${className}`}>
      <div className="journals-list">
        {visiblePages && visiblePages.length > 0 ? (
          <>
            {visiblePages.map((page) => (
              <JournalEntry key={page.id} dailyPageId={page.id} />
            ))}
            {hasMore && (
              <div className="journals-load-more">
                <Button onClick={handleLoadMore} variant="ghost" size="sm">
                  Load more ({sortedPages.length - visibleCount} remaining)
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="journals-empty">
            <JournalIcon size="lg" className="journals-empty__icon" />
            <h3 className="journals-empty__title">No journal entries yet</h3>
            <p className="journals-empty__description">
              Daily journal pages are created automatically when you open today's note.
            </p>
            <Button
              variant="primary"
              size="md"
              onClick={handleOpenToday}
            >
              Open today's note
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default JournalsView;
