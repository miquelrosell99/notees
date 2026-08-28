/**
 * MainContentPane — renders a single view (node, graph, pages, etc.) based on
 * explicit view props.
 *
 * Extracted from MainContent so it can be reused in both the main area
 * and split-pane panes.
 */
import React, { useMemo, Suspense } from 'react';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useNode, useClasses } from '@/features/content';
import { useSystemClasses, NodeViewWrapper, NodeViewContent, ClassViewWrapper, ClassViewContent, PagesView, ClassesView, ArchivedPagesView, TrashView, TemplateGallery } from '@/features/content';
import { WhiteboardsView } from '@/features/whiteboard';
import { useNavigationStore } from '@/stores';
import { getEffectiveColor } from '@/utils/nodeIcon';
import { JournalsView } from '@/features/journals';
import { useViewDefinition } from '@/plugins/core';
import type { MainViewType } from '@/stores';
import './MainContentPane.css';

const PropertyViewFull = React.lazy(() => import('@/features/properties/pages/PropertyView').then(m => ({ default: m.PropertyViewFull })));
const WhiteboardView = React.lazy(() => import('@/features/whiteboard').then(m => ({ default: m.WhiteboardView })));
const SharesUnifiedView = React.lazy(() => import('@/features/shares/pages/SharesUnifiedView').then(m => ({ default: m.SharesUnifiedView })));
const NodeCollectionView = React.lazy(() => import('@/features/content').then(m => ({ default: m.NodeCollectionView })));
const CollectionView = React.lazy(() => import('@/features/content/pages/CollectionView').then(m => ({ default: m.CollectionView })));

interface MainContentPaneProps {
  viewType: MainViewType;
  nodeUuid?: string;
  propertyUuid?: string;
  nodeCollectionTitle?: string | null;
  onNavigateToNode?: (nodeUuid: string) => void;
}

export function MainContentPane({
  viewType,
  nodeUuid,
  propertyUuid,
  nodeCollectionTitle,
  onNavigateToNode,
}: MainContentPaneProps) {
  const { data: currentNode } = useNode(nodeUuid ?? null);
  const { data: allClasses } = useClasses();
  const { systemClassUuids } = useSystemClasses();
  const viewMode = useNavigationStore(s => s.viewMode);
  const nodeCollectionQueryAST = useNavigationStore(s => s.nodeCollectionQueryAST);
  const nodeCollectionNodeUuids = useNavigationStore(s => s.nodeCollectionNodeUuids);
  // Reactive lookup: when a plugin is disabled, its view unregisters and this
  // pane falls through to the default empty state on the next render.
  const pluginView = useViewDefinition(viewType);

  const nodeColorStyle = useMemo(() => {
    const color = getEffectiveColor(currentNode, allClasses);
    if (!color) return undefined;
    return { '--node-border-color': color } as React.CSSProperties;
  }, [currentNode, allClasses]);

  if (viewType === 'pages' || viewType === 'all-pages') {
    return (
      <div className="main-content">
        <PagesView />
      </div>
    );
  }

  if (viewType === 'classes') {
    return (
      <div className="main-content">
        <ClassesView />
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

  if (viewType === 'property' && propertyUuid) {
    return (
      <div className="main-content-wrapper">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <PropertyViewFull
            propertyId={propertyUuid}
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
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <NodeCollectionView
            title={nodeCollectionTitle ?? 'Temporary query'}
            queryAST={nodeCollectionQueryAST}
            nodeUuids={nodeCollectionNodeUuids}
          />
        </Suspense>
      </div>
    );
  }

  // Plugin-registered top-level views (reactive: unregistered views, e.g. after
  // a plugin is disabled, fall through to the default empty state).
  if (pluginView) {
    const PluginViewComponent = pluginView.component;
    return (
      <div className="main-content">
        <PluginViewComponent />
      </div>
    );
  }

  // Default: node view (page or block)
  if (!nodeUuid) {
    return (
      <div className="main-content">
        <div className="empty-state">
          <h1>Welcome to Notees</h1>
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

  // Class-drives-chrome (Decision 22, same principle as whiteboard): a page
  // classed `collection` renders the collection-manager view — a member list
  // instead of the document flow.
  const isCollection = currentNode?.is_page && systemClassUuids?.collection &&
    currentNode.classes_uuid?.includes(systemClassUuids.collection);

  if (isCollection && currentNode) {
    return (
      <div className="main-content">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <CollectionView nodeUuid={currentNode.uuid} />
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

  if (currentNode.is_class) {
    return (
      <div className="main-content-wrapper" style={nodeColorStyle}>
        <ClassViewWrapper nodeUuid={currentNode.uuid} viewMode={viewMode} />
        <div
          id="main-content"
          className={`main-content${nodeColorStyle ? ' has-node-border' : ''}`}
          style={nodeColorStyle}
        >
          <ClassViewContent nodeUuid={currentNode.uuid} viewMode={viewMode} />
        </div>
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
