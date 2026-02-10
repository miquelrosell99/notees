/**
 * Journals view - displays all existing daily pages
 * 
 * Only shows pages that already exist, does not create new ones.
 * Uses NodeView component for each daily page for consistent editing experience.
 */
import { useState, useMemo, useEffect } from 'react';
import { useExistingDailyPages, useNode } from '@/hooks';
import './JournalsView.css';
import { useNodesStore } from '@/stores';
import { NodeViewContent } from './NodeView';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import { getNodeColorStyles } from '@/utils/color';

interface JournalEntryProps {
  dailyPageId: number;
}

function JournalEntry({ dailyPageId }: JournalEntryProps) {
  const { viewMode } = useNodesStore();
  const { data: page } = useNode(dailyPageId);
  const [isDarkMode, setIsDarkMode] = useState(() => 
    document.documentElement.getAttribute('data-theme') === 'dark'
  );
  
  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.getAttribute('data-theme') === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  
  // Get color style if page has a color
  const colorStyle = useMemo(() => {
    if (!page?.color) return undefined;
    return getNodeColorStyles(page.color, isDarkMode);
  }, [page?.color, isDarkMode]);
  
  return (
    <article 
      className={`journal-entry${colorStyle ? ' journal-entry--colored' : ''}`}
      style={colorStyle}
    >
      {colorStyle ? (
        <Card 
          elevation="medium" 
          variant="default" 
          padding={false}
          radius="lg"
          className="journal-entry__card"
        >
          <NodeViewContent 
            nodeId={dailyPageId} 
            nodeType="page" 
            viewMode={viewMode} 
            compactMode={true} 
          />
        </Card>
      ) : (
        <NodeViewContent 
          nodeId={dailyPageId} 
          nodeType="page" 
          viewMode={viewMode} 
          compactMode={true} 
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
