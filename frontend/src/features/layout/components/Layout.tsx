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
import React, { useEffect, useCallback, useRef, useState, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useModalStore, useSettingsStore, usePresentationStore } from '@/stores';
import { useCommand } from '@/hooks/useCommand';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useTodayNote, useCreateNode, useNode, useIsMobile, useDocumentTitle } from '@/hooks';
import { RouteAdapter } from './RouteAdapter';
import { NavigationUrlSync } from './NavigationUrlSync';
import { useSettingsQuery } from '@/hooks/useSettings';
import { recentKeys } from '@/hooks/queryKeys';
import { markPageOpened, fixLinksForUuid } from '@/api/nodes';
import type { BlockData } from '@/utils/clipboardManager';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import { TabBar } from './TabBar/TabBar';
import { OfflineBanner } from './OfflineBanner';
import { MobileLayout } from './MobileLayout';
import { RightSidebarCards } from '@/features/sidebar/components/RightSidebarCards';
import { GraphMinimap } from './GraphMinimap';
import { CommandPalette } from './CommandPalette';
import { BrokenLinkFixContext } from '@/contexts/BrokenLinkFixContext';
const ImportDataModal = React.lazy(() => import('@/features/workspace/components/ImportDataModal').then(m => ({ default: m.ImportDataModal })));
const ImportLogseqModal = React.lazy(() => import('@/features/workspace/components/ImportLogseqModal').then(m => ({ default: m.ImportLogseqModal })));
const ImportLogseqFolderModal = React.lazy(() => import('@/features/workspace/components/ImportLogseqFolderModal').then(m => ({ default: m.ImportLogseqFolderModal })));
const ImportMarkdownModal = React.lazy(() => import('@/features/workspace/components/ImportMarkdownModal').then(m => ({ default: m.ImportMarkdownModal })));
const ExportPageModal = React.lazy(() => import('@/features/workspace/components/ExportPageModal').then(m => ({ default: m.ExportPageModal })));
const ShareModal = React.lazy(() => import('@/features/content/components/nodes/ShareModal').then(m => ({ default: m.ShareModal })));
const RebuildLinksModal = React.lazy(() => import('@/features/maintenance/components/RebuildLinksModal').then(m => ({ default: m.RebuildLinksModal })));
const FixRawLinksModal = React.lazy(() => import('@/features/maintenance/components/FixRawLinksModal').then(m => ({ default: m.FixRawLinksModal })));
const MergePagesModal = React.lazy(() => import('./Modals').then(m => ({ default: m.MergePagesModal })));
const CreatePageWithUuidModal = React.lazy(() => import('@/features/layout/components/Modals').then(m => ({ default: m.CreatePageWithUuidModal })));
const AutoExportProgressModal = React.lazy(() => import('@/features/workspace/components/AutoExportProgressModal').then(m => ({ default: m.AutoExportProgressModal })));
import { Card } from '@/components/ui/Card';
import { PresentationModal } from '@/features/content/components/PresentationModal';
import './Layout.css';

export function Layout() {
  const hasInitialized = useRef(false);
  const isProcessingUrl = useRef(false);

  useDocumentTitle();

  // Use granular selectors to avoid re-rendering on unrelated store changes
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const rightSidebarOpen = useNavigationStore(s => s.rightSidebarOpen);
  const currentNodeId = useNavigationStore(s => s.currentNodeId);
  const mainViewType = useNavigationStore(s => s.mainViewType);
  const viewMode = useNavigationStore(s => s.viewMode);
  const isCommandPaletteOpen = useModalStore(s => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useModalStore(s => s.setCommandPaletteOpen);
  const isImportDataModalOpen = useModalStore(s => s.isImportDataModalOpen);
  const setImportDataModalOpen = useModalStore(s => s.setImportDataModalOpen);
  const isImportLogseqModalOpen = useModalStore(s => s.isImportLogseqModalOpen);
  const setImportLogseqModalOpen = useModalStore(s => s.setImportLogseqModalOpen);
  const isImportLogseqFolderModalOpen = useModalStore(s => s.isImportLogseqFolderModalOpen);
  const setImportLogseqFolderModalOpen = useModalStore(s => s.setImportLogseqFolderModalOpen);
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
  const isCreateWithUuidModalOpen = useModalStore(s => s.isCreateWithUuidModalOpen);
  const setCreateWithUuidModalOpen = useModalStore(s => s.setCreateWithUuidModalOpen);
  const createWithUuidPrefill = useModalStore(s => s.createWithUuidPrefill);
  const isShareModalOpen = useModalStore(s => s.isShareModalOpen);
  const setShareModalOpen = useModalStore(s => s.setShareModalOpen);
  const isAutoExportProgressModalOpen = useModalStore(s => s.isAutoExportProgressModalOpen);
  const setAutoExportProgressModalOpen = useModalStore(s => s.setAutoExportProgressModalOpen);
  const isMinimapOpen = useModalStore(s => s.isMinimapOpen);
  const presentationNodeId = usePresentationStore(s => s.nodeId);
  const setMinimapOpen = useModalStore(s => s.setMinimapOpen);
  const setMainViewType = useNavigationStore(s => s.setMainViewType);
  const openNode = useNavigationStore(s => s.openNode);
  const splitTab = useNavigationStore(s => s.splitTab);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Callback provided to all BlockEditors via context — opens the create-with-UUID modal
  // pre-filled with the missing UUID so the user can create the target node.
  const handleFixBrokenLink = useCallback((uuid: string) => {
    setCreateWithUuidModalOpen(true, uuid);
  }, [setCreateWithUuidModalOpen]);
  
  const { defaultView, wideMode, tabPosition } = useSettingsStore();
  const createNodeMutation = useCreateNode();
  const hasAppliedDefaultView = useRef(false);
  const { data: currentNode } = useNode(currentNodeId);
  
  // Settings are guaranteed to be in TanStack Query cache before Layout mounts
  // (App.tsx gates rendering behind fetchQuery completion).
  // useSettingsQuery() is used here only so components downstream can read cached data.
  useSettingsQuery();
  
  // Responsive: true on phones/small tablets
  const isMobile = useIsMobile();

  // Sidebar resize state (desktop only)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number | null>(null);
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number | null>(null);
  const isResizingLeftRef = useRef(false);
  const isResizingRightRef = useRef(false);

  // Fetch today's note for default view
  const { data: todayNote } = useTodayNote();
  
  const queryClient = useQueryClient();

  // NOTE: loadFavorites() and loadRecents() are called in App.tsx when dbData?.active changes.
  // Do NOT duplicate them here — it causes 3x duplicate requests competing for browser connections.

  // Track page opens by calling the API and refreshing recents.
  // Only call for actual pages; blocks return 400.
  useEffect(() => {
    if (currentNodeId && mainViewType === 'node' && currentNode?.is_page) {
      markPageOpened(currentNodeId)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: recentKeys.all });
        })
        .catch((error) => {
          console.error('Failed to mark page as opened:', error);
        });
    }
  }, [currentNodeId, mainViewType, currentNode?.is_page, queryClient]);
  
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
      setMainViewType('pages');
      hasAppliedDefaultView.current = true;
    } else if (defaultView === 'graph') {
      setMainViewType('graph');
      hasAppliedDefaultView.current = true;
    } else {
      hasAppliedDefaultView.current = true;
    }
  }, [defaultView, todayNote, setMainViewType, openNode, currentNodeId, mainViewType]);

  // Register commands in the Command Registry
  useCommand(COMMAND_IDS.COMMAND_PALETTE, () => {
    setCommandPaletteOpen(true);
  }, { label: 'Open Command Palette' });

  useCommand(COMMAND_IDS.IMPORT_DATA, () => {
    setImportDataModalOpen(true);
  }, { label: 'Import Data' });

  // Native drop handler for sidebar cards / items dragged to the main workspace
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;

    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/x-notees-node')) {
        e.preventDefault();
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (e.altKey) return;

      // Handle tab drag-to-split
      const tabData = e.dataTransfer?.getData('application/x-notees-tab');
      if (tabData && workspaceRef.current) {
        const rect = workspaceRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const xPct = x / rect.width;
        const yPct = y / rect.height;
        const EDGE_THRESHOLD = 0.15;

        if (xPct < EDGE_THRESHOLD || xPct > 1 - EDGE_THRESHOLD) {
          splitTab(tabData, 'horizontal');
          e.preventDefault();
          return;
        }
        if (yPct < EDGE_THRESHOLD || yPct > 1 - EDGE_THRESHOLD) {
          splitTab(tabData, 'vertical');
          e.preventDefault();
          return;
        }
      }

      // Handle node drop
      if (!e.dataTransfer?.types.includes('application/x-notees-node')) return;

      const data = e.dataTransfer.getData('application/x-notees-node');
      if (!data) return;

      try {
        const nodeInfo = JSON.parse(data) as { nodeId?: number };
        if (nodeInfo?.nodeId) {
          openNode(nodeInfo.nodeId);
          e.preventDefault();
        }
      } catch {
        // ignore malformed drag data
      }
    };

    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('drop', handleDrop);

    return () => {
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('drop', handleDrop);
    };
  }, [openNode]);
  
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
    <>
      <RouteAdapter hasInitialized={hasInitialized} isProcessingUrl={isProcessingUrl} />
      <NavigationUrlSync hasInitialized={hasInitialized} isProcessingUrl={isProcessingUrl} />
      <BrokenLinkFixContext.Provider value={handleFixBrokenLink}>
        <OfflineBanner />
        {/* ── Chrome: MobileLayout or desktop three-column ── */}
        {isMobile ? (
          <MobileLayout currentNodeId={currentNodeId} />
        ) : (
          <div className={`app-canvas${viewMode === 'focus' ? ' focus-mode' : ''}${wideMode ? ' wide-mode' : ''}`}>
            <TopBar />
            <div className="app-workspace" ref={workspaceRef}>
              <div className={`sidebar-wrapper${isSidebarCollapsed ? ' sidebar-wrapper--collapsed' : ''}`} style={leftSidebarStyle}>
                <Sidebar collapsed={isSidebarCollapsed} />
                {!isSidebarCollapsed && (
                  <div
                    className="sidebar-resize-handle sidebar-resize-handle--left"
                    onMouseDown={handleLeftSidebarResizeStart}
                  />
                )}
              </div>
              {tabPosition === 'left' && <TabBar />}
              <Card className="main-container" padding={false} elevation="medium">
                <MainContent />
              </Card>
              <div className={`sidebar-wrapper sidebar-wrapper--right${!showSidebar ? ' sidebar-wrapper--collapsed' : ''}`} style={rightSidebarStyle}>
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
          </div>
        )}

        {/* ── Modals (always present, portal-rendered) ── */}

        {/* Command Palette Modal (Ctrl+K) */}
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
        />
        
        {/* Import Data Modal (Ctrl+Shift+I) */}
        <Suspense fallback={null}>
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
                    name: blockData.name || '',
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
        </Suspense>
        
        {/* Floating Graph Minimap */}
        {isMinimapOpen && (
          <GraphMinimap onClose={() => setMinimapOpen(false)} />
        )}

        {/* Import Logseq Modal */}
        <Suspense fallback={null}>
          <ImportLogseqModal
            isOpen={isImportLogseqModalOpen}
            onClose={() => setImportLogseqModalOpen(false)}
          />
        </Suspense>

        {/* Import Logseq Folder Modal */}
        <Suspense fallback={null}>
          <ImportLogseqFolderModal
            isOpen={isImportLogseqFolderModalOpen}
            onClose={() => setImportLogseqFolderModalOpen(false)}
          />
        </Suspense>

        {/* Import Markdown Modal */}
        <Suspense fallback={null}>
          <ImportMarkdownModal
            isOpen={isImportMarkdownModalOpen}
            onClose={() => setImportMarkdownModalOpen(false)}
          />
        </Suspense>

        {/* Export Page Modal */}
        {currentNodeId && currentNode?.uuid && (
          <Suspense fallback={null}>
            <ExportPageModal
              isOpen={isExportPageModalOpen}
              onClose={() => setExportPageModalOpen(false)}
              nodeUuid={currentNode.uuid}
              nodeName={currentNode.name}
            />
          </Suspense>
        )}

        {/* Share Modal */}
        {currentNodeId && (
          <Suspense fallback={null}>
            <ShareModal
              nodeId={currentNodeId}
              isOpen={isShareModalOpen}
              onClose={() => setShareModalOpen(false)}
            />
          </Suspense>
        )}

        {/* Rebuild Links Modal */}
        <Suspense fallback={null}>
          <RebuildLinksModal
            isOpen={isRebuildLinksModalOpen}
            onClose={() => setRebuildLinksModalOpen(false)}
          />
        </Suspense>

        {/* Fix Raw UUID Links Modal */}
        <Suspense fallback={null}>
          <FixRawLinksModal
            isOpen={isFixRawLinksModalOpen}
            onClose={() => setFixRawLinksModalOpen(false)}
          />
        </Suspense>

        {/* Merge Pages Modal */}
        <Suspense fallback={null}>
          <MergePagesModal
            isOpen={isMergePagesModalOpen}
            onClose={() => setMergePagesModalOpen(false)}
          />
        </Suspense>

        {/* Presentation Modal */}
        <PresentationModal key={presentationNodeId ?? 'closed'} />

        {/* Create Page with UUID Modal (global — opened from Command Palette or broken-link context menu) */}
        <Suspense fallback={null}>
          <CreatePageWithUuidModal
            isOpen={isCreateWithUuidModalOpen}
            prefillUuid={createWithUuidPrefill}
            onClose={() => setCreateWithUuidModalOpen(false, null)}
            onSuccess={(node) => {
              setCreateWithUuidModalOpen(false, null);
              openNode(node.id);
              // If this was opened from a broken-link context menu, fix all references
              if (createWithUuidPrefill) {
                fixLinksForUuid(createWithUuidPrefill).catch(console.error);
              }
            }}
          />
        </Suspense>

        {/* Auto-export batch progress modal */}
        <Suspense fallback={null}>
          <AutoExportProgressModal
            isOpen={isAutoExportProgressModalOpen}
            onClose={() => setAutoExportProgressModalOpen(false)}
          />
        </Suspense>
      </BrokenLinkFixContext.Provider>
    </>
  );
}
