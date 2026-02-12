/**
 * Main content area component
 * 
 * Centralized view routing - determines which view to show based on mainViewType.
 * For 'node' view type, uses NodeView which auto-detects page vs block.
 */
import { useMemo, useEffect, useRef } from 'react';
import { useAppStore } from '@/stores';
import { useNode } from '@/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { NodeViewWrapper, NodeViewContent } from '../../views/NodeView';
import { AllPagesView } from '../../views/AllPagesView';
import { ArchivedPagesView } from '../../views/ArchivedPagesView';
import { TrashView } from '../../views/TrashView';
import { JournalsView } from '../../views/JournalsView';
import { NodeGraphView } from '../nodeGraph';
import { TimelineViewAll } from '../timeline/TimelineViewAll';
import { PropertyViewWrapper, PropertyViewContent } from '../../views/PropertyView';

export function MainContent() {
  const { currentNodeId, currentNodeType, viewMode, mainViewType, currentPropertyId, openNode, addSidebarCard } = useAppStore();
  const queryClient = useQueryClient();
  const prevViewRef = useRef(mainViewType);

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
  
  // Compute border color for colored nodes (thick border, no background)
  const nodeColorStyle = useMemo(() => {
    if (!currentNode || !currentNode.color) {
      return undefined;
    }
    return {
      '--node-border-color': currentNode.color,
    } as React.CSSProperties;
  }, [currentNode]);
  
  // Render different views based on mainViewType
  if (mainViewType === 'all-pages') {
    return (
      <main className="main-content">
        <AllPagesView />
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
  
  if (mainViewType === 'graph') {
    return (
      <main className="main-content graph-content">
        <NodeGraphView viewId="global" className="main-graph-view" />
      </main>
    );
  }
  
  if (mainViewType === 'timeline') {
    return (
      <main className="main-content timeline-content">
        <TimelineViewAll className="main-timeline-view" />
      </main>
    );
  }
  
  if (mainViewType === 'property' && currentPropertyId) {
    return (
      <div className="main-content-wrapper">
        <PropertyViewWrapper
          propertyId={currentPropertyId}
          onNavigateToNode={(nodeId) => openNode(nodeId, 'page')}
          onOpenInSidebar={(nodeId) => addSidebarCard(nodeId, 'page')}
        />
        <main className="main-content">
          <PropertyViewContent
            propertyId={currentPropertyId}
            onNavigateToNode={(nodeId) => openNode(nodeId, 'page')}
            onOpenInSidebar={(nodeId) => addSidebarCard(nodeId, 'page')}
          />
        </main>
      </div>
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

  return (
    <div className="main-content-wrapper">
      {/* Fixed header */}
      <NodeViewWrapper
        nodeId={currentNodeId}
        nodeType={currentNodeType}
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
          nodeType={currentNodeType}
          viewMode={viewMode}
        />
      </main>
    </div>
  );
}