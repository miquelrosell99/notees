/**
 * Main layout component with floating containers design
 *
 * The layout consists of:
 * - Canvas: The background area containing all elements
 * - Left Sidebar: Database switcher, navigation, settings (collapses to an icon-only strip)
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
import { useIsMobile, useDocumentTitle } from '@/hooks';
import { useCreateNode, useNode } from '@/features/content';
import { RouteAdapter } from './RouteAdapter';
import { NavigationUrlSync } from './NavigationUrlSync';
import { useSettingsQuery } from '@/features/workspace';
import { recentKeys } from '@/hooks/queryKeys';
import { markPageOpened, fixLinksForUuid } from '@/api/nodes';
import type { BlockData } from '@/utils/clipboardManager';
import { Sidebar, SidebarRail } from './Sidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import { OfflineBanner } from './OfflineBanner';
import { MobileLayout } from './MobileLayout';
import { RightSidebarCards } from '@/features/sidebar';
import { GraphMinimap } from './GraphMinimap';
import { CommandPalette } from './CommandPalette';
import { BrokenLinkFixContext } from '@/features/content';
const ImportDataModal = React.lazy(() => import('@/features/workspace/components/ImportDataModal').then(m => ({ default: m.ImportDataModal })));
const ImportLogseqModal = React.lazy(() => import('@/features/workspace/components/ImportLogseqModal').then(m => ({ default: m.ImportLogseqModal })));
const ImportLogseqFolderModal = React.lazy(() => import('@/plugins/builtin/logseq_importer/components/ImportLogseqFolderModal').then(m => ({ default: m.ImportLogseqFolderModal })));
const ImportMarkdownModal = React.lazy(() => import('@/features/workspace/components/ImportMarkdownModal').then(m => ({ default: m.ImportMarkdownModal })));
const ExportPageModal = React.lazy(() => import('@/features/workspace/components/ExportPageModal').then(m => ({ default: m.ExportPageModal })));
const ShareModal = React.lazy(() => import('@/features/content/components/nodes/ShareModal').then(m => ({ default: m.ShareModal })));
const RebuildLinksModal = React.lazy(() => import('@/features/maintenance/components/RebuildLinksModal').then(m => ({ default: m.RebuildLinksModal })));
const FixRawLinksModal = React.lazy(() => import('@/features/maintenance/components/FixRawLinksModal').then(m => ({ default: m.FixRawLinksModal })));
const MergePagesModal = React.lazy(() => import('./Modals').then(m => ({ default: m.MergePagesModal })));
const FilterBuilderModal = React.lazy(() => import('@/features/queries/components/FilterBuilderModal').then(m => ({ default: m.FilterBuilderModal })));
const CreatePageWithUuidModal = React.lazy(() => import('@/features/layout/components/Modals').then(m => ({ default: m.CreatePageWithUuidModal })));
const AutoExportProgressModal = React.lazy(() => import('@/features/workspace/components/AutoExportProgressModal').then(m => ({ default: m.AutoExportProgressModal })));
import { Card } from '@/components/ui/Card';
import { PresentationModal } from '@/features/content';
import { PluginManagerModal, PluginCommandRegistrations } from '@/plugins/core';
import { ConflictResolutionModal } from '@/features/sync';
import './Layout.css';

export function Layout() {
  const hasInitialized = useRef(false);
  const isProcessingUrl = useRef(false);

  useDocumentTitle();

  // Use granular selectors to avoid re-rendering on unrelated store changes
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const rightSidebarOpen = useNavigationStore(s => s.rightSidebarOpen);
  const currentNodeUuid = useNavigationStore(s => s.currentNodeUuid);
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

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
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
  const presentationNodeUuid = usePresentationStore(s => s.nodeUuid);
  const setMinimapOpen = useModalStore(s => s.setMinimapOpen);
  const openNode = useNavigationStore(s => s.openNode);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Callback provided to all BlockEditors via context — opens the create-with-UUID modal
  // pre-filled with the missing UUID so the user can create the target node.
  const handleFixBrokenLink = useCallback((nodeUuid: string) => {
    setCreateWithUuidModalOpen(true, nodeUuid);
  }, [setCreateWithUuidModalOpen]);

  const wideMode = useSettingsStore(s => s.wideMode);
  const createNodeMutation = useCreateNode();
  const { data: currentNode } = useNode(currentNodeUuid);

  // Settings are synced from the backend into the local store before Layout
  // mounts. useSettingsQuery() is used here only so components downstream can
  // read cached data.
  useSettingsQuery();

  // Responsive: true on phones/small tablets
  const isMobile = useIsMobile();

  // Sidebar resize state (desktop only)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number | null>(null);
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number | null>(null);
  const isResizingLeftRef = useRef(false);
  const isResizingRightRef = useRef(false);

  const queryClient = useQueryClient();

  // NOTE: loadFavorites() and loadRecents() are called in App.tsx when dbData?.active changes.
  // Do NOT duplicate them here — it causes 3x duplicate requests competing for browser connections.

  // Track page opens by calling the API and refreshing recents.
  // Only call for actual pages; blocks return 400.
  useEffect(() => {
    if (currentNodeUuid && mainViewType === 'node' && currentNode?.is_page && currentNode.uuid) {
      markPageOpened(currentNode.uuid)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: recentKeys.all });
        })
        .catch((error) => {
          console.error('Failed to mark page as opened:', error);
        });
    }
  }, [currentNodeUuid, mainViewType, currentNode?.is_page, queryClient]);

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

      // Handle node drop
      if (!e.dataTransfer?.types.includes('application/x-notees-node')) return;

      const data = e.dataTransfer.getData('application/x-notees-node');
      if (!data) return;

      try {
        const nodeInfo = JSON.parse(data) as { nodeUuid?: string };
        if (nodeInfo?.nodeUuid) {
          openNode(nodeInfo.nodeUuid);
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
          <MobileLayout currentNodeUuid={currentNodeUuid} />
        ) : (
          <div className={`app-canvas${wideMode ? ' wide-mode' : ''}`}>
            <TopBar />
            <div className="app-workspace" ref={workspaceRef}>
              <SidebarRail hidden={isMobile || viewMode === 'focus'} />
              <aside
                className={`sidebar-wrapper sidebar-wrapper--content${isSidebarCollapsed ? ' sidebar-wrapper--collapsed' : ''}`}
                style={leftSidebarStyle}
                aria-label="Primary sidebar"
                aria-hidden={isSidebarCollapsed}
              >
                <Sidebar collapsed={isSidebarCollapsed} />
                {!isSidebarCollapsed && (
                  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
                  <div
                    role="separator"
                    aria-label="Resize left sidebar"
                    tabIndex={0}
                    className="sidebar-resize-handle sidebar-resize-handle--left"
                    onMouseDown={handleLeftSidebarResizeStart}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      e.preventDefault();
                      setLeftSidebarWidth((prev) => {
                        const current = prev ?? 300;
                        const step = e.key === 'ArrowRight' ? 20 : -20;
                        return Math.max(200, Math.min(400, current + step));
                      });
                    }}
                  />
                  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
                )}
              </aside>
              <main id="main-content" className="main-container">
                <Card className="main-container__card layout-card" padding={false} elevation="medium">
                  <MainContent />
                </Card>
              </main>
              <aside
                className={`sidebar-wrapper sidebar-wrapper--right${!showSidebar ? ' sidebar-wrapper--collapsed' : ''}`}
                style={rightSidebarStyle}
                data-focus-mode={viewMode === 'focus' || undefined}
                aria-label="Secondary sidebar"
              >
                {showSidebar && (
                  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
                  <div
                    role="separator"
                    aria-label="Resize right sidebar"
                    tabIndex={0}
                    className="sidebar-resize-handle sidebar-resize-handle--right"
                    onMouseDown={handleRightSidebarResizeStart}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      e.preventDefault();
                      setRightSidebarWidth((prev) => {
                        const current = prev ?? 360;
                        // ArrowLeft moves resizer left, widening the right sidebar
                        const step = e.key === 'ArrowLeft' ? 20 : -20;
                        return Math.max(260, Math.min(500, current + step));
                      });
                    }}
                  />
                  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
                )}
                <Card
                  className={`right-container ${showSidebar ? 'right-container--expanded' : 'right-container--collapsed'} layout-card`}
                  padding={false}
                  elevation="medium"
                >
                  <div className="right-sidebar-content">
                    <RightSidebarCards />
                  </div>
                </Card>
              </aside>
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
              if (!currentNodeUuid) return;

              // Create blocks recursively
              const createBlocksRecursively = async (
                blockDataList: BlockData[],
                parentUuid: string
              ) => {
                for (const blockData of blockDataList) {
                  const newNode = await createNodeMutation.mutateAsync({
                    name: blockData.name || '',
                    parent_uuid: parentUuid,
                  });

                  // Recursively create children
                  if (blockData.children && blockData.children.length > 0) {
                    await createBlocksRecursively(blockData.children, newNode.uuid);
                  }
                }
              };

              await createBlocksRecursively(blocks, currentNodeUuid);
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
        {currentNodeUuid && currentNode?.uuid && (
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
        {currentNodeUuid && (
          <Suspense fallback={null}>
            <ShareModal
              nodeUuid={currentNodeUuid}
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

        {/* Filter Builder Modal (global — "New temporary query" palette command) */}
        <Suspense fallback={null}>
          <FilterBuilderModal />
        </Suspense>

        {/* Presentation Modal */}
        <PresentationModal key={presentationNodeUuid ?? 'closed'} />

        {/* Create Page with UUID Modal (global — opened from Command Palette or broken-link context menu) */}
        <Suspense fallback={null}>
          <CreatePageWithUuidModal
            isOpen={isCreateWithUuidModalOpen}
            prefillUuid={createWithUuidPrefill}
            onClose={() => setCreateWithUuidModalOpen(false, null)}
            onSuccess={(node) => {
              setCreateWithUuidModalOpen(false, null);
              openNode(node.uuid);
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

        {/* Conflict resolution modal */}
        <ConflictResolutionModal />

        {/* Plugin Manager */}
        <PluginCommandRegistrations onOpenPluginManager={() => setPluginManagerOpen(true)} />
        <Suspense fallback={null}>
          <PluginManagerModal
            isOpen={pluginManagerOpen}
            onClose={() => setPluginManagerOpen(false)}
          />
        </Suspense>
      </BrokenLinkFixContext.Provider>
    </>
  );
}
