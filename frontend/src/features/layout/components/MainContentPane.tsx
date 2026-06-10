/**
 * MainContentPane — renders a single view (node, graph, pages, etc.) based on a tab.
 *
 * Extracted from MainContent so it can be reused in both the main area
 * and split-pane panes.
 */
import React, { useMemo, Suspense } from 'react';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useNode, useClasses } from '@/hooks';
import { useSystemClasses } from '@/hooks/usePageClass';
import { useNavigationStore } from '@/stores';
import { getEffectiveColor } from '@/utils/nodeIcon';
import { NodeViewWrapper, NodeViewContent } from '@/features/content/pages/NodeView';
import { PagesView } from '@/features/content/pages/PagesView';
import { ArchivedPagesView } from '@/features/content/pages/ArchivedPagesView';
import { TrashView } from '@/features/content/pages/TrashView';
import { JournalsView } from '@/features/journals/pages/JournalsView';

import { WhiteboardsView } from '@/features/content/pages/WhiteboardsView';
import { TasksView } from '@/features/tasks/pages/TasksView';
import type { Tab } from '@/stores/navigationStore';

const PropertyViewFull = React.lazy(() => import('@/features/content/pages/PropertyView').then(m => ({ default: m.PropertyViewFull })));
const WhiteboardView = React.lazy(() => import('@/features/content/components/nodes/views/WhiteboardView').then(m => ({ default: m.WhiteboardView })));
const SharesUnifiedView = React.lazy(() => import('@/features/shares/pages/SharesUnifiedView').then(m => ({ default: m.SharesUnifiedView })));

interface MainContentPaneProps {
  tab: Tab;
  onNavigateToNode?: (nodeId: number) => void;
}

export function MainContentPane({ tab, onNavigateToNode }: MainContentPaneProps) {
  const { data: currentNode } = useNode(tab.nodeId ?? null);
  const { data: allClasses } = useClasses();
  const { systemClassIds } = useSystemClasses();
  const viewMode = useNavigationStore(s => s.viewMode);

  const nodeColorStyle = useMemo(() => {
    const color = getEffectiveColor(currentNode, allClasses);
    if (!color) return undefined;
    return { '--node-border-color': color } as React.CSSProperties;
  }, [currentNode, allClasses]);

  const viewType = tab.type;

  if (viewType === 'pages' || viewType === 'all-pages') {
    return (
      <main className="main-content">
        <PagesView />
      </main>
    );
  }

  if (viewType === 'archived') {
    return (
      <main className="main-content">
        <ArchivedPagesView />
      </main>
    );
  }

  if (viewType === 'trash') {
    return (
      <main className="main-content">
        <TrashView />
      </main>
    );
  }

  if (viewType === 'journals') {
    return (
      <main className="main-content">
        <JournalsView />
      </main>
    );
  }

  if (viewType === 'whiteboards') {
    return (
      <main className="main-content">
        <WhiteboardsView />
      </main>
    );
  }

  if (viewType === 'tasks') {
    return (
      <main className="main-content">
        <TasksView />
      </main>
    );
  }

  if (viewType === 'graph') {
    return (
      <main className="main-content">
        <PagesView initialViewMode="graph" />
      </main>
    );
  }

  if (viewType === 'timeline') {
    return (
      <main className="main-content">
        <PagesView initialViewMode="timeline" />
      </main>
    );
  }

  if (viewType === 'property' && tab.propertyId) {
    return (
      <div className="main-content-wrapper">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <PropertyViewFull
            propertyId={tab.propertyId}
            onNavigateToNode={onNavigateToNode}
          />
        </Suspense>
      </div>
    );
  }

  if (viewType === 'shares' || viewType === 'inbox') {
    return (
      <main className="main-content">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <SharesUnifiedView initialTab={viewType === 'inbox' ? 'inbox' : 'shared-out'} />
        </Suspense>
      </main>
    );
  }

  if (viewType === 'node-collection') {
    return (
      <main className="main-content">
        <div className="empty-state">
          <h2>Collection</h2>
          <p>This view is not available in tab mode.</p>
        </div>
      </main>
    );
  }

  // Default: node view (page or block)
  if (!tab.nodeId) {
    return (
      <main className="main-content">
        <div className="empty-state">
          <h2>Welcome to Notees</h2>
          <p>Select a page from the sidebar or create a new one.</p>
        </div>
      </main>
    );
  }

  const isWhiteboard = currentNode && systemClassIds?.whiteboard &&
    currentNode.classes?.includes(systemClassIds.whiteboard);

  if (isWhiteboard && currentNode) {
    return (
      <main className="main-content" style={{ padding: 0, overflow: 'hidden' }}>
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <WhiteboardView nodeId={currentNode.id} nodeUuid={currentNode.uuid} />
        </Suspense>
      </main>
    );
  }

  return (
    <div className="main-content-wrapper" style={nodeColorStyle}>
      <NodeViewWrapper nodeId={tab.nodeId} viewMode={viewMode} />
      <main
        id="main-content"
        className={`main-content${nodeColorStyle ? ' has-node-border' : ''}`}
        style={nodeColorStyle}
      >
        <NodeViewContent nodeId={tab.nodeId} viewMode={viewMode} />
      </main>
    </div>
  );
}
