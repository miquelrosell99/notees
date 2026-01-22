/**
 * Main content area component
 * 
 * Centralized view routing - determines which view to show based on mainViewType.
 * For 'node' view type, uses NodeView which auto-detects page vs block.
 */
import { useMemo } from 'react';
import { useNodesStore, type CardLayoutMode } from '@/stores';
import { useNode } from '@/hooks';
import { mdiTextBoxOutline, mdiFormatListBulleted, mdiWeatherNight, mdiCardOutline, mdiGraphOutline } from '@mdi/js';
import { NodeBreadcrumbs } from './nodes/NodeBreadcrumbs';
import { SelectionButton } from './core/SelectionButton';
import { Button } from './core/Button';
import { NodeView } from '../views/NodeView';
import { AllPagesView } from '../views/AllPagesView';
import { JournalsView } from '../views/JournalsView';
import { GraphViewAll } from './graph';
import { PropertyView } from '../views/PropertyView';
import type { Node } from '@/types';

export function MainContent() {
  const { currentNodeId, currentNodeType, currentPropertyContext, viewMode, mainViewType, currentPropertyId, openNode, openPropertyView, addSidebarCard, contentDisplayMode, setContentDisplayMode, cardLayout, setCardLayout, lateNightThoughtsFilter, toggleLateNightThoughts, openLocalGraph, rightSidebarContent } = useNodesStore();
  
  // Fetch current node to get color (only for pages)
  const { data: currentNode } = useNode(currentNodeId ?? null);
  
  // Compute background color for page nodes only
  const pageBackgroundStyle = useMemo(() => {
    if (!currentNode || currentNodeType !== 'page' || !currentNode.color) {
      return undefined;
    }
    return {
      backgroundColor: currentNode.color,
    } as React.CSSProperties;
  }, [currentNode, currentNodeType]);
  
  // Handle shift-click on page bullets in All Pages view
  const handlePageShiftClick = (page: Node) => {
    addSidebarCard(page.id, 'page');
  };
  
  // Render different views based on mainViewType
  if (mainViewType === 'all-pages') {
    return (
      <main className="main-content">
        <AllPagesView onPageShiftClick={handlePageShiftClick} />
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
  
  if (mainViewType === 'property' && currentPropertyId) {
    return (
      <main className="main-content">
        <PropertyView 
          propertyId={currentPropertyId}
          onNavigateToNode={(nodeId) => openNode(nodeId, 'page')}
          onOpenInSidebar={(nodeId) => addSidebarCard(nodeId, 'page')}
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

  return (
    <div className="main-content-wrapper">
      {/* Fixed header with breadcrumbs and controls */}
      <div className="main-content-header">
        <div className="node-view-header-content">
          {/* Left section - breadcrumbs */}
          <div className="node-view-header-left">
            <NodeBreadcrumbs
              nodeId={currentNodeId}
              nodeType={currentNodeType}
              onNavigate={(id, type) => openNode(id, type)}
              onNavigateToProperty={(propertyId) => openPropertyView(propertyId)}
              propertyContext={currentPropertyContext}
              className="node-view-breadcrumbs"
            />
          </div>
          
          {/* Center section - empty for now */}
          <div className="node-view-header-center"></div>
          
          {/* Right section - document mode selector and controls */}
          <div className="node-view-header-right">
            <div className="node-view-controls">
              {/* Document/Bullet/Card mode selector - only for pages, not blocks */}
              {currentNodeType !== 'block' && (
                <SelectionButton
                  options={[
                    { value: 'bullet', icon: mdiFormatListBulleted, label: 'Bullet mode' },
                    { value: 'document', icon: mdiTextBoxOutline, label: 'Document mode' },
                    { value: 'card', icon: mdiCardOutline, label: 'Card mode' },
                  ]}
                  value={contentDisplayMode}
                  onChange={(val) => setContentDisplayMode(val as 'bullet' | 'document' | 'card')}
                  size="sm"
                />
              )}
              
              {/* Card layout selector - only visible in card mode for pages */}
              {currentNodeType !== 'block' && contentDisplayMode === 'card' && (
                <div className="card-layout-selector">
                  <Button 
                    variant="ghost"
                    size="xs"
                    className={`card-layout-option ${cardLayout === 'no-cover' ? 'card-layout-option--active' : ''}`}
                    onClick={() => setCardLayout('no-cover' as CardLayoutMode)}
                    title="No cover"
                  >
                    <span className="layout-icon layout-icon--no-cover">
                      <span className="layout-icon__content"></span>
                    </span>
                  </Button>
                  <Button 
                    variant="ghost"
                    size="xs"
                    className={`card-layout-option ${cardLayout === 'cover-top' ? 'card-layout-option--active' : ''}`}
                    onClick={() => setCardLayout('cover-top' as CardLayoutMode)}
                    title="Cover on top"
                  >
                    <span className="layout-icon layout-icon--cover-top">
                      <span className="layout-icon__cover"></span>
                      <span className="layout-icon__content"></span>
                    </span>
                  </Button>
                  <Button 
                    variant="ghost"
                    size="xs"
                    className={`card-layout-option ${cardLayout === 'cover-side' ? 'card-layout-option--active' : ''}`}
                    onClick={() => setCardLayout('cover-side' as CardLayoutMode)}
                    title="Cover on side"
                  >
                    <span className="layout-icon layout-icon--cover-side">
                      <span className="layout-icon__cover"></span>
                      <span className="layout-icon__content"></span>
                    </span>
                  </Button>
                </div>
              )}
              
              {/* Late night thoughts filter */}
              <Button
                icon={mdiWeatherNight}
                variant="ghost"
                size="sm"
                onClick={toggleLateNightThoughts}
                active={lateNightThoughtsFilter}
                aria-label="Toggle late night thoughts"
                title="Show only late night thoughts (created 10PM-4AM)"
                className="toolbar-btn"
              />
              
              {/* Local graph button */}
              <Button
                icon={mdiGraphOutline}
                variant="ghost"
                size="sm"
                active={rightSidebarContent === 'localGraph'}
                onClick={() => openLocalGraph(currentNodeId!)}
                aria-label="Local graph"
                title="Show local graph for this node"
                className="toolbar-btn"
              />
            </div>
          </div>
        </div>
      </div>
      
      {/* Scrollable content area */}
      <main 
        className={`main-content${pageBackgroundStyle ? ' has-page-color' : ''}`}
        style={pageBackgroundStyle}
      >
        <NodeView nodeId={currentNodeId} nodeType={currentNodeType} viewMode={viewMode} />
      </main>
    </div>
  );
}
