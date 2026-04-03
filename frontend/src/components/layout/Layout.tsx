/**
 * Main layout component with floating containers design
 * 
 * The layout consists of:
 * - Canvas: The background area containing all elements
 * - Left Sidebar: Database switcher, navigation, settings (optional, fully hidden when collapsed)
 * - Main Container: Primary content area with rounded corners
 * - Comments Sidebar: Comments panel for selected node (between main and right sidebar)
 * - Right Sidebar: Secondary content (local graph, node cards) with rounded corners
 * 
 * Sidebar resizing:
 * - Drag the right edge of left sidebar to resize
 * - Drag the left edge of right sidebar to resize
 */
import { useEffect, useCallback, useRef, useState } from 'react';
import { useNavigationStore, useModalStore, useSettingsStore, useFavoritesStore } from '@/stores';
import { useTodayNote, RouterSync, useCreateNode, useNode } from '@/hooks';
import { useSettingsQuery } from '@/hooks/useSettings';
import { markPageOpened } from '@/api/nodes';
import type { BlockData } from '@/utils/clipboardManager';
import { Sidebar } from './NavigationSidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import { RightSidebarCards } from '../sidebar/RightSidebarCards';
import { GraphMinimap } from './GraphMinimap';
import { CommandPalette } from './CommandPalette';
import { ImportDataModal } from '../workspace/ImportDataModal';
import { ImportLogseqModal } from '../workspace/ImportLogseqModal';
import { ImportMarkdownModal } from '../workspace/ImportMarkdownModal';
import { ExportPageModal } from '../workspace/ExportPageModal';
import { RebuildLinksModal } from '../maintenance/RebuildLinksModal';
import { FixRawLinksModal } from '../maintenance/FixRawLinksModal';
import { MergePagesModal } from './MergePagesModal';
import { mdiClose } from '@mdi/js';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import './Layout.css';

export function Layout() {
  // Use granular selectors to avoid re-rendering on unrelated store changes
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const rightSidebarOpen = useNavigationStore(s => s.rightSidebarOpen);
  const currentNodeId = useNavigationStore(s => s.currentNodeId);
  const mainViewType = useNavigationStore(s => s.mainViewType);
  const viewMode = useNavigationStore(s => s.viewMode);
  const toggleSidebar = useNavigationStore(s => s.toggleSidebar);
  const toggleRightSidebar = useNavigationStore(s => s.toggleRightSidebar);
  const isCommandPaletteOpen = useModalStore(s => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useModalStore(s => s.setCommandPaletteOpen);
  const isImportDataModalOpen = useModalStore(s => s.isImportDataModalOpen);
  const setImportDataModalOpen = useModalStore(s => s.setImportDataModalOpen);
  const isImportLogseqModalOpen = useModalStore(s => s.isImportLogseqModalOpen);
  const setImportLogseqModalOpen = useModalStore(s => s.setImportLogseqModalOpen);
  const isImportMarkdownModalOpen = useModalStore(s => s.isImportMarkdownModalOpen);
  const setImportMarkdownModalOpen = useModalStore(s => s.setImportMarkdownModalOpen);
  const isExportPageModalOpen = useModalStore(s => s.isExportPageModalOpen);
  const setExportPageModalOpen = useModalStore(s => s.setExportPageModalOpen);
  const isRebuildLinksModalOpen = useModalStore(s => s.isRebuildLinksModalOpen);
  const setRebuildLinksModalOpen = useModalStore(s => s.setRebuildLinksModalOpen);
  const isFixRawLinksModalOpen = useModalStore(s => s.isFixRawLinksModalOpen);
  const setFixRawLinksModalOpen = useModalStore(s => s.setFixRawLinksModalOpen);
  const isMergePagesModalOpen = useModalStore(s => s.isMergePagesModalOpen);
  const setMergePagesModalOpen = useModalStore(s => s.setMergePagesModalOpen);
  const isMinimapOpen = useModalStore(s => s.isMinimapOpen);
  const setMinimapOpen = useModalStore(s => s.setMinimapOpen);
  const setMainViewType = useNavigationStore(s => s.setMainViewType);
  const openNode = useNavigationStore(s => s.openNode);
  
  const { defaultView } = useSettingsStore();
  const createNodeMutation = useCreateNode();
  const hasAppliedDefaultView = useRef(false);
  const { data: currentNode } = useNode(currentNodeId);
  
  // Settings are guaranteed to be in TanStack Query cache before Layout mounts
  // (App.tsx gates rendering behind fetchQuery completion).
  // useSettingsQuery() is used here only so components downstream can read cached data.
  useSettingsQuery();
  
  // Sidebar resize state
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number | null>(null); // null = use CSS default
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number | null>(null); // null = use CSS default
  const isResizingLeftRef = useRef(false);
  const isResizingRightRef = useRef(false);

  // ── Mobile: Obsidian-style off-canvas overlay drawers ──────────────────────
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);

  // Update isMobile when viewport changes
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Close left drawer when the user navigates to a node on mobile (mirrors Obsidian behaviour)
  const prevNodeIdRef = useRef(currentNodeId);
  useEffect(() => {
    if (isMobile && currentNodeId !== prevNodeIdRef.current && !isSidebarCollapsed) {
      toggleSidebar();
    }
    prevNodeIdRef.current = currentNodeId;
  }, [currentNodeId, isMobile, isSidebarCollapsed, toggleSidebar]);

  // Right-edge swipe to open the right sidebar on mobile.
  // (Left-edge swipe is skipped: Android system gestures own that edge.)
  useEffect(() => {
    if (!isMobile) return;
    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - startX;
      const dy = endY - startY;
      // Must be a mostly-horizontal swipe
      if (Math.abs(dy) > Math.abs(dx) * 0.8) return;
      // Swipe left from the right edge → open right sidebar
      if (startX > window.innerWidth - 28 && dx < -50 && !rightSidebarOpen) {
        toggleRightSidebar();
      }
      // Swipe right when right sidebar is open → close it
      if (rightSidebarOpen && dx > 80 && startX > window.innerWidth - 320) {
        toggleRightSidebar();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [isMobile, rightSidebarOpen, toggleRightSidebar]);
  // ───────────────────────────────────────────────────────────────────────────
  
  // Fetch today's note for default view
  const { data: todayNote } = useTodayNote();
  
  // NOTE: loadFavorites() and loadRecents() are called in App.tsx when dbData?.active changes.
  // Do NOT duplicate them here — it causes 3x duplicate requests competing for browser connections.
  
  // Track page opens by calling the API and refreshing recents
  // markPageOpened is a no-op for blocks on the backend, so always call it
  useEffect(() => {
    if (currentNodeId && mainViewType === 'node') {
      markPageOpened(currentNodeId)
        .then(() => {
          useFavoritesStore.getState().loadRecents();
        })
        .catch((error) => {
          console.error('Failed to mark page as opened:', error);
        });
    }
  }, [currentNodeId, mainViewType]);
  
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
        openNode(todayNote.id);
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
    // Ctrl/Cmd + Shift + I to open import data modal
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
      e.preventDefault();
      setImportDataModalOpen(true);
    }
  }, [setCommandPaletteOpen, setImportDataModalOpen]);

  // Register global keyboard shortcuts
  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);
  
  // Sidebar resize handlers
  const handleLeftSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingLeftRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  
  const handleRightSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRightRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);
  
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingLeftRef.current) {
        const newWidth = Math.max(200, Math.min(400, e.clientX - 8)); // 8px for canvas padding
        setLeftSidebarWidth(newWidth);
      }
      if (isResizingRightRef.current) {
        const newWidth = Math.max(260, Math.min(500, window.innerWidth - e.clientX - 8));
        setRightSidebarWidth(newWidth);
      }
    };
    
    const handleMouseUp = () => {
      if (isResizingLeftRef.current || isResizingRightRef.current) {
        isResizingLeftRef.current = false;
        isResizingRightRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Sidebar visibility is controlled by rightSidebarOpen state
  const showSidebar = rightSidebarOpen;
  
  // Build dynamic styles for sidebars
  const leftSidebarStyle = leftSidebarWidth ? { 
    '--sidebar-width': `${leftSidebarWidth}px` 
  } as React.CSSProperties : undefined;
  
  const rightSidebarStyle = rightSidebarWidth ? { 
    '--right-sidebar-width': `${rightSidebarWidth}px` 
  } as React.CSSProperties : undefined;

  return (
    <RouterSync>
      <div className={`app-canvas${viewMode === 'focus' ? ' focus-mode' : ''}`}>
        {/* Top Bar - part of canvas */}
        <TopBar />
        
        {/* Main content area with floating containers */}
        <div className="app-workspace">
          {/* Left Sidebar - part of canvas, completely hidden when collapsed */}
          <div className={`sidebar-wrapper${isSidebarCollapsed ? ' sidebar-wrapper--collapsed' : ''}`} style={leftSidebarStyle}>
            <Sidebar collapsed={isSidebarCollapsed} />
            {/* Left sidebar resize handle */}
            {!isSidebarCollapsed && (
              <div 
                className="sidebar-resize-handle sidebar-resize-handle--left"
                onMouseDown={handleLeftSidebarResizeStart}
              />
            )}
          </div>
          
          {/* Floating Main Container */}
          <Card className="main-container" padding={false} elevation="medium">
            <MainContent />
          </Card>
          
          {/* Floating Right Sidebar - uses Card component with panel of cards */}
          <div className={`sidebar-wrapper sidebar-wrapper--right${!showSidebar ? ' sidebar-wrapper--collapsed' : ''}`} style={rightSidebarStyle}>
            {/* Right sidebar resize handle */}
            {showSidebar && (
              <div 
                className="sidebar-resize-handle sidebar-resize-handle--right"
                onMouseDown={handleRightSidebarResizeStart}
              />
            )}
            <Card 
              className={`right-container ${showSidebar ? 'right-container--expanded' : 'right-container--collapsed'}`} 
              padding={false} 
              elevation="medium"
            >
              <div className="right-sidebar-content">
                <RightSidebarCards />
              </div>
            </Card>
          </div>
        </div>
        
        {/* Mobile: scrim backdrop that closes whichever drawer is open */}
        {isMobile && (!isSidebarCollapsed || rightSidebarOpen) && (
          <div
            className="mobile-drawer-backdrop"
            onClick={() => {
              if (!isSidebarCollapsed) toggleSidebar();
              if (rightSidebarOpen) toggleRightSidebar();
            }}
            aria-hidden="true"
          />
        )}

        {/* Command Palette Modal (Ctrl+K) */}
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />
        
        {/* Import Data Modal (Ctrl+Shift+I) */}
        <ImportDataModal
          isOpen={isImportDataModalOpen}
          onClose={() => setImportDataModalOpen(false)}
          onImport={async (blocks: BlockData[]) => {
            // Import blocks as children of current node
            if (!currentNodeId) return;
            
            // Create blocks recursively
            const createBlocksRecursively = async (
              blockDataList: BlockData[],
              parentId: number
            ) => {
              for (const blockData of blockDataList) {
                const newNode = await createNodeMutation.mutateAsync({
                  name: (blockData as any).content || '',
                  parent_id: parentId,
                });
                
                // Recursively create children
                if (blockData.children && blockData.children.length > 0) {
                  await createBlocksRecursively(blockData.children, newNode.id);
                }
              }
            };
            
            await createBlocksRecursively(blocks, currentNodeId);
          }}
        />
        
        {/* Floating Graph Minimap */}
        {isMinimapOpen && (
          <GraphMinimap onClose={() => setMinimapOpen(false)} />
        )}

        {/* Import Logseq Modal */}
        <ImportLogseqModal
          isOpen={isImportLogseqModalOpen}
          onClose={() => setImportLogseqModalOpen(false)}
        />

        {/* Import Markdown Modal */}
        <ImportMarkdownModal
          isOpen={isImportMarkdownModalOpen}
          onClose={() => setImportMarkdownModalOpen(false)}
        />

        {/* Export Page Modal */}
        {currentNodeId && currentNode?.uuid && (
          <ExportPageModal
            isOpen={isExportPageModalOpen}
            onClose={() => setExportPageModalOpen(false)}
            nodeUuid={currentNode.uuid}
          />
        )}

        {/* Rebuild Links Modal */}
        <RebuildLinksModal
          isOpen={isRebuildLinksModalOpen}
          onClose={() => setRebuildLinksModalOpen(false)}
        />

        {/* Fix Raw UUID Links Modal */}
        <FixRawLinksModal
          isOpen={isFixRawLinksModalOpen}
          onClose={() => setFixRawLinksModalOpen(false)}
        />

        {/* Merge Pages Modal */}
        <MergePagesModal
          isOpen={isMergePagesModalOpen}
          onClose={() => setMergePagesModalOpen(false)}
        />
      </div>
    </RouterSync>
  );
}
