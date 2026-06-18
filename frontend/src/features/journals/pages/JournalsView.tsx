/**
 * Journals view - displays all existing daily pages
 * 
 * Only shows pages that already exist, does not create new ones.
 * Uses NodeView component for each daily page for consistent editing experience.
 */
import { useState, useMemo, useCallback } from 'react';
import { useJournals } from '@/features/journals';
import { useNode, useDailyNote } from '@/features/content';
import { PageViewHeader } from '@/features/content';
import './JournalsView.css';
import { useNavigationStore } from '@/stores';
import { NodeViewContent } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataStateView } from '@/components/ui/DataStateView';
import { JournalIcon } from '@/components/ui/icons';

interface JournalEntryProps {
  dailyPageId: number;
}

function JournalEntry({ dailyPageId }: JournalEntryProps) {
  const viewMode = useNavigationStore((state) => state.viewMode);
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
            borderLeft: 'var(--border-width-node-color-strong) solid var(--card-border-color)'
          } as React.CSSProperties}
        >
          <NodeViewContent
            nodeId={dailyPageId}
            viewMode={viewMode}
            className="journal-entry__node-view"
            pageHeaderClassName="journal-entry__page-header"
            breadcrumbsClassName="journal-entry__breadcrumbs"
          />
        </Card>
      ) : (
        <NodeViewContent
          nodeId={dailyPageId}
          viewMode={viewMode}
          className="journal-entry__node-view"
          pageHeaderClassName="journal-entry__page-header"
          breadcrumbsClassName="journal-entry__breadcrumbs"
        />
      )}
    </article>
  );
}

interface JournalsViewProps {
  className?: string;
}

export function JournalsView({ className = '' }: JournalsViewProps) {
  const { data: dailyPages, isLoading, error, refetch } = useJournals();
  const [visibleCount, setVisibleCount] = useState(10);
  const openNode = useNavigationStore((state) => state.openNode);
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
  
  return (
    <div className={`journals-view ${className}`}>
      <PageViewHeader
        className="journals-view__header"
        title={<h1>Journals</h1>}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon="mdi mdi-notebook-edit-outline"
            onClick={handleOpenToday}
          >
            Open today&apos;s note
          </Button>
        }
      />

      <div className="journals-list">
        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={visiblePages.length === 0}
          onRetry={refetch}
          errorTitle="Failed to load journal entries"
          emptyTitle="No journal entries yet"
          emptyDescription="Daily journal pages are created when you open today's note."
          emptyIcon={<JournalIcon size="lg" />}
          emptyAction={{ label: "Open today's note", onClick: handleOpenToday }}
          skeletonRows={5}
          skeletonShowHeading
        >
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
        </DataStateView>
      </div>
    </div>
  );
}

export default JournalsView;
