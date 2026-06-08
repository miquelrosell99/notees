/**
 * Main content area component
 * 
 * Centralized view routing - determines which view to show based on mainViewType.
 * For 'node' view type, uses NodeView which auto-detects page vs block.
 */
import React, { useMemo, useEffect, useRef, Suspense } from 'react';
import { useNavigationStore } from '@/stores';
import { LoadingScreen } from '@/components/core/LoadingScreen';
import { useNode, useClasses } from '@/hooks';
import { useSystemClasses } from '@/hooks/usePageClass';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { getEffectiveColor } from '@/utils/nodeIcon';
import { NodeViewWrapper, NodeViewContent } from '@/views/NodeView';
import { PagesView } from '@/views/PagesView';
import { ArchivedPagesView } from '@/views/ArchivedPagesView';
import { TrashView } from '@/views/TrashView';
import { JournalsView } from '@/views/JournalsView';
import { NodeCollectionView } from '@/views/NodeCollectionView';
import { WhiteboardsView } from '@/views/WhiteboardsView';
import { TasksView } from '@/views/TasksView';
const PropertyViewFull = React.lazy(() => import('@/views/PropertyView').then(m => ({ default: m.PropertyViewFull })));
const WhiteboardView = React.lazy(() => import('@/components/nodes/views/WhiteboardView').then(m => ({ default: m.WhiteboardView })));
const SharesUnifiedView = React.lazy(() => import('@/views/SharesUnifiedView').then(m => ({ default: m.SharesUnifiedView })));

export function MainContent() {
  const { currentNodeId, viewMode, mainViewType, currentPropertyId, nodeCollectionTitle, nodeCollectionQueryAST, nodeCollectionNodes, openNode, addSidebarCard } = useNavigationStore();
  const queryClient = useQueryClient();
  const prevViewRef = useRef(mainViewType);
  const { systemClassIds } = useSystemClasses();

  // Cancel in-flight per-node queries when navigating away from a view.
  // This prevents journal's ~50+ requests from blocking graph/settings responses.
  useEffect(() => {
    const prevView = prevViewRef.current;
    prevViewRef.current = mainViewType;
    if (prevView !== mainViewType && prevView === 'journals') {
      // Cancel all per-node detail, linked-ref, property-backlink, and view queries
      queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      queryClient.cancelQueries({ queryKey: [...nodeKeys.all, 'linked-refs'] });
      queryClient.cancelQueries({ queryKey: [...nodeKeys.all, 'property-backlinks'] });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.lists() });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.queryResults() });
    }
  }, [mainViewType, queryClient]);
  
  // Fetch current node to get color (for pages and focused blocks)
  const { data: currentNode } = useNode(currentNodeId ?? null);
  const { data: allClasses } = useClasses();
  
  // Compute border color for colored nodes (thick border, no background)
  const nodeColorStyle = useMemo(() => {
    const color = getEffectiveColor(currentNode, allClasses);
    if (!color) {
      return undefined;
    }
    return {
      '--node-border-color': color,
    } as React.CSSProperties;
  }, [currentNode, allClasses]);
  
  // Render different views based on mainViewType
  if (mainViewType === 'pages') {
    return (
      <main className="main-content">
        <PagesView />
      </main>
    );
  }

  if (mainViewType === 'all-pages') {
    return (
      <main className="main-content">
        <PagesView />
      </main>
    );
  }
  
  if (mainViewType === 'archived') {
    return (
      <main className="main-content">
        <ArchivedPagesView />
      </main>
    );
  }
  
  if (mainViewType === 'trash') {
    return (
      <main className="main-content">
        <TrashView />
      </main>
    );
  }
  
  if (mainViewType === 'journals') {
    return (
      <main className="main-content">
        <JournalsView />
      </main>
    );
  }

  if (mainViewType === 'whiteboards') {
    return (
      <main className="main-content">
        <WhiteboardsView />
      </main>
    );
  }

  if (mainViewType === 'tasks') {
    return (
      <main className="main-content">
        <TasksView />
      </main>
    );
  }
  
  if (mainViewType === 'graph') {
    return (
      <main className="main-content">
        <PagesView initialViewMode="graph" />
      </main>
    );
  }

  if (mainViewType === 'timeline') {
    return (
      <main className="main-content">
        <PagesView initialViewMode="timeline" />
      </main>
    );
  }
  
  if (mainViewType === 'property' && currentPropertyId) {
    return (
      <div className="main-content-wrapper">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <PropertyViewFull
            propertyId={currentPropertyId}
            onNavigateToNode={(nodeId: number) => openNode(nodeId)}
            onOpenInSidebar={(nodeId: number) => addSidebarCard(nodeId, 'page')}
          />
        </Suspense>
      </div>
    );
  }

  if (mainViewType === 'shares' || mainViewType === 'inbox') {
    return (
      <main className="main-content">
        <Suspense fallback={<LoadingScreen fullscreen={false} label="Loading…" />}>
          <SharesUnifiedView initialTab={mainViewType === 'inbox' ? 'inbox' : 'shared-out'} />
        </Suspense>
      </main>
    );
  }

  if (mainViewType === 'node-collection' && (nodeCollectionQueryAST || nodeCollectionNodes)) {
    return (
      <main className="main-content">
        <NodeCollectionView
          title={nodeCollectionTitle ?? 'Results'}
          queryAST={nodeCollectionQueryAST}
          nodes={nodeCollectionNodes}
        />
      </main>
    );
  }

  // Default: node view (page or block)
  if (!currentNodeId) {
    return (
      <main className="main-content">
        <div className="empty-state">
          <h2>Welcome to Notees</h2>
          <p>Select a page from the sidebar or create a new one.</p>
        </div>
      </main>
    );
  }

  // Whiteboard view: if the current node has the whiteboard class, show WhiteboardView
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
    <div className="main-content-wrapper">
      {/* Fixed header */}
      <NodeViewWrapper
        nodeId={currentNodeId}
        viewMode={viewMode}
      />
      
      {/* Scrollable content area */}
      <main 
        id="main-content"
        className={`main-content${nodeColorStyle ? ' has-node-border' : ''}`}
        style={nodeColorStyle}
      >
        <NodeViewContent
          nodeId={currentNodeId}
          viewMode={viewMode}
        />
      </main>
    </div>
  );
}