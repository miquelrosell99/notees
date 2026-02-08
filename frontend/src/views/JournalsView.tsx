/**
 * Journals view - displays all existing daily pages
 * 
 * Only shows pages that already exist, does not create new ones.
 * Uses NodeView component for each daily page for consistent editing experience.
 */
import { useState, useMemo } from 'react';
import { useExistingDailyPages } from '@/hooks';
import './JournalsView.css';
import { useNodesStore } from '@/stores';
import { NodeViewContent } from './NodeView';
import { Button } from '../components/core/Button';

interface JournalEntryProps {
  dailyPageId: number;
}

function JournalEntry({ dailyPageId }: JournalEntryProps) {
  const { viewMode } = useNodesStore();
  
  // NodeViewContent handles its own data fetching — no need to pre-fetch here.
  // Previously this called useNode(dailyPageId, { include_children: true }) which
  // created a duplicate request (different query key than what NodeView uses).
  return (
    <article className="journal-entry">
      <NodeViewContent 
        nodeId={dailyPageId} 
        nodeType="page" 
        viewMode={viewMode} 
        compactMode={true} 
      />
    </article>
  );
}

interface JournalsViewProps {
  className?: string;
}

export function JournalsView({ className = '' }: JournalsViewProps) {
  const { data: dailyPages, isLoading, error } = useExistingDailyPages();
  const [visibleCount, setVisibleCount] = useState(10);
  
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
        <div className="journals-loading">Loading journal entries...</div>
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
            <p>No journal entries yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default JournalsView;
