/**
 * MainContentPane — renders a single view (node, graph, pages, etc.) based on a tab.
 *
 * Extracted from MainContent so it can be reused in both the main area
 * and split-pane panes.
 */
import React, { useMemo, Suspense } from 'react';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useNode, useClasses } from '@/features/content';
import { useSystemClasses, NodeViewWrapper, NodeViewContent, PagesView, ArchivedPagesView, TrashView, TemplateGallery } from '@/features/content';
import { WhiteboardsView } from '@/features/whiteboard';
import { useNavigationStore } from '@/stores';
import { getEffectiveColor } from '@/utils/nodeIcon';
import { JournalsView } from '@/features/journals';
import { TasksView } from '@/features/tasks';
import { getViewDefinition } from '@/plugins/core';
import type { Tab } from '@/stores/navigationStore';
import './MainContentPane.css';

const PropertyViewFull = React.lazy(() => import('@/features/properties/pages/PropertyView').then(m => ({ default: m.PropertyViewFull })));
const WhiteboardView = React.lazy(() => import('@/features/whiteboard').then(m => ({ default: m.WhiteboardView })));
const SharesUnifiedView = React.lazy(() => import('@/features/shares/pages/SharesUnifiedView').then(m => ({ default: m.SharesUnifiedView })));

interface MainContentPaneProps {
  tab: Tab;
  onNavigateToNode?: (nodeUuid: string) => void;
}

export function MainContentPane({ tab, onNavigateToNode }: MainContentPaneProps) {
  const { data: currentNode } = useNode(tab.nodeUuid ?? null);
  const { data: allClasses } = useClasses();
  const { systemClassUuids } = useSystemClasses();
  const viewMode = useNavigationStore(s => s.viewMode);

  const nodeColorStyle = useMemo(() => {
    const color = getEffectiveColor(currentNode, allClasses);
    if (!color) return undefined;
    return { '--node-border-color': color } as React.CSSProperties;
  }, [currentNode, allClasses]);

  const viewType = tab.type;

  if (viewType === 'pages' || viewType === 'all-pages') {
    return (
      <div className="main-content">
        <PagesView />
      </div>
    );
  }

  if (viewType === 'archived') {
    return (
      <div className="main-content">
        <ArchivedPagesView />
      </div>
    );
  }

  if (viewType === 'trash') {
    return (
      <div className="main-content">
        <TrashView />
      </div>
    );
  }

  if (viewType === 'journals') {
    return (
      <div className="main-content">
        <JournalsView />
      </div>
    );
  }

  if (viewType === 'whiteboards') {
    return (
      <div className="main-content">
        <WhiteboardsView />
      </div>
    );
  }

  if (viewType === 'tasks') {
    return (
      <div className="main-content">
        <TasksView />
      </div>
    );
  }

  if (viewType === 'templates') {
    return (
      <div className="main-content">
        <TemplateGallery />
      </div>
    );
  }

  if (viewType === 'graph') {
    return (
      <div className="main-content">
        <PagesView initialViewMode="graph" />
      </div>
    );
  }

  if (viewType === 'timeline') {
    return (
      <div className="main-content">
        <PagesView initialViewMode="timeline" />
      </div>
    );
  }

  if (viewType === 'property' && tab.propertyUuid) {
    return (
      <div className="main-content-wrapper">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <PropertyViewFull
            propertyId={tab.propertyUuid}
            onNavigateToNode={onNavigateToNode}
          />
        </Suspense>
      </div>
    );
  }

  if (viewType === 'shares' || viewType === 'inbox') {
    return (
      <div className="main-content">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <SharesUnifiedView initialTab={viewType === 'inbox' ? 'inbox' : 'shared-out'} />
        </Suspense>
      </div>
    );
  }

  if (viewType === 'node-collection') {
    return (
      <div className="main-content">
        <div className="empty-state">
          <h2>Collection</h2>
          <p>This collection view isn&apos;t available in tabs.</p>
        </div>
      </div>
    );
  }

  // Plugin-registered top-level views
  const pluginView = getViewDefinition(viewType);
  if (pluginView) {
    const PluginViewComponent = pluginView.component;
    return (
      <div className="main-content">
        <PluginViewComponent />
      </div>
    );
  }

  // Default: node view (page or block)
  if (!tab.nodeUuid) {
    return (
      <div className="main-content">
        <div className="empty-state">
          <h2>Welcome to Notees</h2>
          <p>Select a page from the sidebar, or press Ctrl+K to create one.</p>
        </div>
      </div>
    );
  }

  const isWhiteboard = currentNode && systemClassUuids?.whiteboard &&
    currentNode.classes_uuid?.includes(systemClassUuids.whiteboard);

  if (isWhiteboard && currentNode) {
    return (
      <div className="main-content main-content--whiteboard">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <WhiteboardView nodeUuid={currentNode.uuid} />
        </Suspense>
      </div>
    );
  }

  if (!currentNode) {
    return (
      <div className="main-content">
        <LoadingScreen fullscreen={false} label="Loading…" />
      </div>
    );
  }

  return (
    <div className="main-content-wrapper" style={nodeColorStyle}>
      <NodeViewWrapper nodeUuid={currentNode.uuid} viewMode={viewMode} liveSync />
      <div
        id="main-content"
        className={`main-content${nodeColorStyle ? ' has-node-border' : ''}`}
        style={nodeColorStyle}
      >
        <NodeViewContent nodeUuid={currentNode.uuid} viewMode={viewMode} liveSync />
      </div>
    </div>
  );
}
