/**
 * AllPagesTimelineView - displays all pages on a timeline
 * 
 * Pseudo-page that fetches all pages and passes them to TimelineView.
 * Similar to AllPagesView but for timeline visualization.
 */
import { usePages } from '@/hooks';
import { TimelineView } from '@/features/content/components/nodes/views/TimelineView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { DataStateView } from '@/components/ui/DataStateView';
import './AllPagesTimelineView.css';

export interface AllPagesTimelineViewProps {
  className?: string;
}

export function AllPagesTimelineView({ className = '' }: AllPagesTimelineViewProps) {
  const { data: pages, isLoading, error, refetch, isPlaceholderData } = usePages();

  return (
    <div className={`all-pages-timeline-view ${className}`}>
      <DataStateView
        isLoading={isLoading || isPlaceholderData}
        error={error}
        isEmpty={!pages || pages.length === 0}
        skeletonRows={6}
        emptyTitle="No pages found"
        emptyDescription="Create some pages to see them in the timeline."
        onRetry={refetch}
      >
        <ErrorBoundary context="Timeline View" showRetry>
          <TimelineView
            nodes={pages!}
            className="all-pages-timeline-view__timeline"
          />
        </ErrorBoundary>
      </DataStateView>
    </div>
  );
}

export default AllPagesTimelineView;
