/**
 * TimelineViewAll Component
 * 
 * Global timeline view showing all pages in the system.
 * Rendered in the main content area as a dedicated view.
 */
import { usePages } from '@/hooks';
import { NodeTimelineRenderer } from './NodeTimelineRenderer';
import './TimelineViewAll.css';

export interface TimelineViewAllProps {
  /** CSS class */
  className?: string;
}

export function TimelineViewAll({ className = '' }: TimelineViewAllProps) {
  const { data: pages, isLoading } = usePages();

  if (isLoading) {
    return (
      <div className={`timeline-view-all timeline-view-all--loading ${className}`}>
        <div className="timeline-view-all__loading">Loading timeline...</div>
      </div>
    );
  }

  if (!pages || pages.length === 0) {
    return (
      <div className={`timeline-view-all timeline-view-all--empty ${className}`}>
        <div className="timeline-view-all__empty">
          <h3>No pages found</h3>
          <p>Create some pages to see them in the timeline.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`timeline-view-all ${className}`}>
      <NodeTimelineRenderer 
        nodes={pages}
        className="timeline-view-all__timeline" 
      />
    </div>
  );
}

export default TimelineViewAll;
