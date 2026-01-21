/**
 * Main layout component with floating containers design
 * 
 * The layout consists of:
 * - Canvas: The background area containing all elements
 * - Left Sidebar: Database switcher, navigation, settings (optional, fully hidden when collapsed)
 * - Main Container: Primary content area with rounded corners
 * - Comments Sidebar: Comments panel for selected node (between main and right sidebar)
 * - Right Sidebar: Secondary content (local graph, node cards) with rounded corners
 */
import { useEffect, useCallback, useRef } from 'react';
import { useNodesStore, useSettingsStore, useFavoritesStore } from '@/stores';
import { useTodayNote, RouterSync } from '@/hooks';
import { markPageOpened } from '@/api/nodes';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import { RightSidebarCards } from './RightSidebarCards';
import { LocalGraphCard } from './LocalGraphCard';
import { CommandPalette } from './CommandPalette';
import { CommentsSidebar } from './CommentsSidebar';
import { FloatingMinimap } from './FloatingMinimap';
import { mdiClose } from '@mdi/js';
import { Card } from './core/Card';
import { Button } from './core/Button';
import './Layout.css';

export function Layout() {
  const { 
    isSidebarCollapsed, 
    rightSidebarOpen, 
    rightSidebarContent,
    sidebarCards,
    localGraphNodeId,
    currentNodeId,
    currentNodeType,
    mainViewType,
    isCommandPaletteOpen,
    setCommandPaletteOpen,
    commentsSidebarOpen,
    setMainViewType,
    openNode,
    clearSidebarCards,
    closeLocalGraph,
  } = useNodesStore();
  
  const { defaultView } = useSettingsStore();
  const hasAppliedDefaultView = useRef(false);
  
  // Fetch today's note for default view
  const { data: todayNote } = useTodayNote();
  
  // Load favorites and recents when component mounts
  useEffect(() => {
    useFavoritesStore.getState().loadFavorites();
    useFavoritesStore.getState().loadRecents();
  }, []);
  
  // Track page opens by calling the API and refreshing recents
  useEffect(() => {
    if (currentNodeId && currentNodeType === 'page' && mainViewType === 'node') {
      // Mark the page as opened in the database
      markPageOpened(currentNodeId)
        .then(() => {
          // Refresh recents list after marking page opened
          useFavoritesStore.getState().loadRecents();
        })
        .catch((error) => {
          console.error('Failed to mark page as opened:', error);
        });
    }
  }, [currentNodeId, currentNodeType, mainViewType]);
  
  // Apply default view ONLY on initial load when URL is "/" (home)
  // This ensures URL-based navigation takes precedence
  useEffect(() => {
    if (hasAppliedDefaultView.current) return;
    
    // Only apply default view if we're at the root URL with no specific view/node
    const isAtRoot = window.location.pathname === '/' || window.location.pathname === '';
    const hasNoCurrentNode = currentNodeId === null;
    const isDefaultNodeView = mainViewType === 'node';
    
    if (!isAtRoot || !hasNoCurrentNode || !isDefaultNodeView) {
      // URL specifies a destination, don't override
      hasAppliedDefaultView.current = true;
      return;
    }
    
    if (defaultView === 'today') {
      // Wait for today's note to load, then set as current page
      if (todayNote) {
        openNode(todayNote.id, 'page');
        hasAppliedDefaultView.current = true;
      }
    } else if (defaultView === 'journal') {
      setMainViewType('journals');
      hasAppliedDefaultView.current = true;
    } else if (defaultView === 'all-pages') {
      setMainViewType('all-pages');
      hasAppliedDefaultView.current = true;
    } else if (defaultView === 'graph') {
      setMainViewType('graph');
      hasAppliedDefaultView.current = true;
    } else {
      hasAppliedDefaultView.current = true;
    }
  }, [defaultView, todayNote, setMainViewType, openNode, currentNodeId, mainViewType]);

  // Global keyboard shortcut handler
  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    // Ctrl/Cmd + K to open command palette
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      setCommandPaletteOpen(true);
    }
  }, [setCommandPaletteOpen]);

  // Register global keyboard shortcuts
  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  // Determine which content to show in right sidebar
  const showNodeCards = rightSidebarContent === 'node' && sidebarCards.length > 0;
  const showLocalGraph = rightSidebarContent === 'localGraph';
  
  // For local graph, use currentNodeId so it updates when switching nodes
  const localGraphId = localGraphNodeId ?? currentNodeId;

  return (
    <RouterSync>
      <div className="app-canvas">
        {/* Top Bar - part of canvas */}
        <TopBar />
        
        {/* Main content area with floating containers */}
        <div className="app-workspace">
          {/* Left Sidebar - part of canvas, completely hidden when collapsed */}
          <Sidebar collapsed={isSidebarCollapsed} />
          
          {/* Floating Main Container */}
          <Card className="main-container" padding={false} elevation="medium">
            <MainContent />
          </Card>
          
          {/* Comments Sidebar - positioned between main and right sidebar */}
          {commentsSidebarOpen && <CommentsSidebar />}
          
          {/* Floating Right Sidebar - uses Card component with different content */}
          <Card 
            className={`right-container ${rightSidebarOpen ? 'right-container--expanded' : 'right-container--collapsed'}`} 
            padding={false} 
            elevation="medium"
          >
            {/* Right sidebar header */}
            <div className="right-sidebar-header">
              <span className="right-sidebar-title">
                {showLocalGraph ? 'Local Graph' : ''}
              </span>
              <Button 
                icon={mdiClose}
                iconOnly
                size="sm" 
                onClick={showLocalGraph ? closeLocalGraph : clearSidebarCards}
                title="Close sidebar"
                variant="ghost"
              />
            </div>
            <div className="right-sidebar-content">
              {showLocalGraph && localGraphId && (
                <LocalGraphCard nodeId={localGraphId} />
              )}
              {showNodeCards && (
                <RightSidebarCards />
              )}
            </div>
          </Card>
        </div>
        
        {/* Command Palette Modal (Ctrl+K) */}
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />
        
        {/* Floating Minimap */}
        <FloatingMinimap />
      </div>
    </RouterSync>
  );
}
