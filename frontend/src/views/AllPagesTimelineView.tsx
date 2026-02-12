/**
 * AllPagesTimelineView - displays all pages on a timeline
 * 
 * Pseudo-page that fetches all pages and passes them to TimelineView.
 * Similar to AllPagesView but for timeline visualization.
 */
import { usePages } from '@/hooks';
import { TimelineView } from '@/components/nodes/views/TimelineView';
import './AllPagesTimelineView.css';

export interface AllPagesTimelineViewProps {
  className?: string;
}

export function AllPagesTimelineView({ className = '' }: AllPagesTimelineViewProps) {
  const { data: pages, isLoading } = usePages();

  if (isLoading) {
    return (
      <div className={`all-pages-timeline-view all-pages-timeline-view--loading ${className}`}>
        <div className="all-pages-timeline-view__loading">Loading timeline...</div>
      </div>
    );
  }

  if (!pages || pages.length === 0) {
    return (
      <div className={`all-pages-timeline-view all-pages-timeline-view--empty ${className}`}>
        <div className="all-pages-timeline-view__empty">
          <h3>No pages found</h3>
          <p>Create some pages to see them in the timeline.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`all-pages-timeline-view ${className}`}>
      <TimelineView
        nodes={pages}
        className="all-pages-timeline-view__timeline"
      />
    </div>
  );
}

export default AllPagesTimelineView;
