/**
 * Pages View - hub for All Pages, Graph, and Timeline views
 *
 * Replaces the individual sidebar items with a single hub
 * that contains tabs for each view mode.
 */
import React, { useState, Suspense } from 'react';
import { AllPagesView } from './AllPagesView';
import { Spinner } from '@/components/core/Spinner';
import { Button } from '@/components/core/Button';
import './PagesView.css';

const AllPagesGraphView = React.lazy(() => import('./AllPagesGraphView').then(m => ({ default: m.AllPagesGraphView })));
const AllPagesTimelineView = React.lazy(() => import('./AllPagesTimelineView').then(m => ({ default: m.AllPagesTimelineView })));

type PagesTab = 'all-pages' | 'graph' | 'timeline';

const TABS: { id: PagesTab; label: string; icon: string }[] = [
  { id: 'all-pages', label: 'All Pages', icon: 'mdi mdi-book-open-page-variant' },
  { id: 'graph', label: 'Graph', icon: 'mdi mdi-graph-outline' },
  { id: 'timeline', label: 'Timeline', icon: 'mdi mdi-timeline-clock-outline' },
];

export function PagesView() {
  const [activeTab, setActiveTab] = useState<PagesTab>('all-pages');

  return (
    <article className="node-view node-view--page pages-view">
      {/* Page Header with Tabs */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header pages-view__header">
            <h1 className="page-header__title">Pages</h1>
            <nav className="pages-view__tabs" role="tablist" aria-label="Pages view modes">
              {TABS.map((tab) => (
                <Button
                  key={tab.id}
                  variant="ghost"
                  size="sm"
                  icon={tab.icon}
                  active={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  title={tab.label}
                >
                  {tab.label}
                </Button>
              ))}
            </nav>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="pages-view__content">
        {activeTab === 'all-pages' && <AllPagesView />}
        {activeTab === 'graph' && (
          <Suspense fallback={<div className="pages-view__loading"><Spinner size="lg" centered /></div>}>
            <AllPagesGraphView className="pages-view__graph" />
          </Suspense>
        )}
        {activeTab === 'timeline' && (
          <Suspense fallback={<div className="pages-view__loading"><Spinner size="lg" centered /></div>}>
            <AllPagesTimelineView className="pages-view__timeline" />
          </Suspense>
        )}
      </div>
    </article>
  );
}

export default PagesView;
