/**
 * Main content area component
 * 
 * Centralized view routing - determines which view to show based on mainViewType.
 * For 'node' view type, uses NodeView which auto-detects page vs block.
 */
import { useMemo, useEffect, useState } from 'react';
import { useNodesStore } from '@/stores';
import { useNode } from '@/hooks';
import { getNodeColorStyles } from '@/utils/color';
import { NodeViewWrapper, NodeViewContent } from '../../views/NodeView';
import { AllPagesView } from '../../views/AllPagesView';
import { ArchivedPagesView } from '../../views/ArchivedPagesView';
import { TrashView } from '../../views/TrashView';
import { JournalsView } from '../../views/JournalsView';
import { GraphViewAll } from '../graph';
import { TimelineViewAll } from '../timeline/TimelineViewAll';
import { PropertyViewWrapper, PropertyViewContent } from '../../views/PropertyView';

export function MainContent() {
  const { currentNodeId, currentNodeType, viewMode, mainViewType, currentPropertyId, openNode, addSidebarCard } = useNodesStore();
  
  // Fetch current node to get color (for pages and focused blocks)
  const { data: currentNode } = useNode(currentNodeId ?? null);
  
  // Track dark mode for color styling
  const [isDarkMode, setIsDarkMode] = useState(() => 
    document.documentElement.getAttribute('data-theme') === 'dark'
  );
  
  // Listen for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.getAttribute('data-theme') === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  
  // Compute color styles for nodes (gradient border + tint) - applies to both pages and focused blocks
  const nodeColorStyle = useMemo(() => {
    // Debug log - remove after fixing
    console.log('[MainContent] currentNode:', currentNodeId, 'color:', currentNode?.color, 'rawColor:', JSON.stringify(currentNode?.color));
    if (!currentNode || !currentNode.color) {
      return undefined;
    }
    return getNodeColorStyles(currentNode.color, isDarkMode);
  }, [currentNode, isDarkMode, currentNodeId]);
  
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
        <GraphViewAll className="main-graph-view" />
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
        className={`main-content${nodeColorStyle ? ' has-page-color' : ''}`}
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
