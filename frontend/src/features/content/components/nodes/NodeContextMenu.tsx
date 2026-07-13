/**
 * Node Context Menu
 *
 * Single unified context menu for pages and blocks.
 * Actions are filtered by scope based on node.is_page:
 *   'page'  → pages only
 *   'block' → blocks only
 *   'both'  → always shown
 *
 * Callers configure via `actions?: [ActionName, ActionScope][]`.
 * PageContextMenu / BlockContextMenu are backward-compatible aliases.
 */
import { useMemo, useCallback, useState, useRef } from 'react';
import { copyToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { createPortal } from 'react-dom';
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useLinkedReferencesCount } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useSettingsStore, usePresentationStore } from '@/stores';
import {
  useCurrentNodeUuid,
  useOpenNodeAction,
  useOpenLocalGraphAction,
  useSidebarCards,
  useAddSidebarCardAction,
  useFlashSidebarCardAction,
} from '@/features/layout';
import { useFavorites, useAddFavoriteMutation, useRemoveFavoriteMutation } from '@/features/content';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import {
  getVisibleNodeActions,
  NODE_ACTION_DEFAULT_ORDER,
  useNodeActions,
  type NodeActionContext,
  type NodeMenuGroup,
} from '@/plugins/core';

import { ASTViewerModal } from './ASTViewerModal';
import { ExportPageModal } from '@/features/workspace';
import { ShareModal } from './ShareModal';
import { startSingleExportJob, pollExportJob, fetchExportResult } from '@/api/exportJobs';
import type { Node, NodeUpdate } from '@/types';

import type { ContentAST } from '@/runtime/types';
import { adjustMenuPosition } from './NodeContextMenu/adjustMenuPosition';
import { IconColorPickerRow } from './NodeContextMenu/iconRow';
import { MoveToSubmenu } from './NodeContextMenu/moveTo';
import {
  DEFAULT_ACTIONS,
  type ActionConfig,
} from './NodeContextMenu/actions';
import { composeMenuItems, type ComposableMenuItem } from './NodeContextMenu/composeMenuItems';
import './NodeContextMenu.css';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';


// ==================== Common Context Menu Items ====================

/**
 * Menu section for each core action item, keyed by the item id pushed in the
 * switch below. Items not listed land in 'main'. Reproduces the historical
 * separator layout while letting contributed actions compose into sections.
 */
const CORE_ITEM_GROUP: Record<string, NodeMenuGroup> = {
  'copy-text': 'export',
  export: 'export',
  presentation: 'export',
  'view-ast': 'manage',
  archive: 'manage',
  unarchive: 'manage',
  'toggle-private': 'manage',
  'add-banner': 'manage',
  delete: 'danger',
};

interface BaseContextMenuProps {
  /** The node to show context menu for */
  node: Node;
  /** Explicit screen position (used for right-click menus) */
  position?: { x: number; y: number };
  /** Anchor element — menu is positioned relative to this element's rect */
  anchorEl?: HTMLElement | null;
  /** Callback to close the menu */
  onClose: () => void;
}

export interface NodeContextMenuProps extends BaseContextMenuProps {
  /**
   * Which actions to show and for which scope.
   * Defaults to DEFAULT_ACTIONS. Order determines menu order.
   */
  actions?: ActionConfig[];
  /** Callback when parent changes (move-to action) */
  onParentChange?: (parentId: string | null) => void;
  /** Enables 'convert-to-page' action (block-scoped) */
  onConvertToPage?: () => void;
  /** Enables 'convert-to-block' action (page-scoped) */
  onConvertToBlock?: () => void;
  /** Called by 'add-banner' action (page-scoped) */
  onAddBanner?: () => void;
  /** Called by 'copy-blocks' action — caller should copy the block to clipboard */
  onCopyBlocks?: () => void;
  /** Called by 'paste-blocks' action — caller should paste clipboard blocks after this block */
  onPasteBlocks?: () => void;
}

export function NodeContextMenu({
  node,
  position,
  anchorEl,
  onClose,
  actions = DEFAULT_ACTIONS,
  onParentChange,
  onConvertToPage,
  onConvertToBlock,
  onAddBanner,
  onCopyBlocks,
  onPasteBlocks,
}: NodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showASTModal, setShowASTModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  const unarchiveNode = useUnarchiveNode();
  const updateNode = useUpdateNode();
  const currentNodeUuid = useCurrentNodeUuid();
  const openNode = useOpenNodeAction();
  const openLocalGraph = useOpenLocalGraphAction();
  const sidebarCards = useSidebarCards();
  const addSidebarCard = useAddSidebarCardAction();
  const flashSidebarCard = useFlashSidebarCardAction();
  const showDevOptions = useSettingsStore((s) => s.showDevOptions);
  const { data: favoriteIds } = useFavorites();
  const favorites = favoriteIds ?? [];
  const isPageFavorited = favorites.some((favoriteUuid) => favoriteUuid === node.uuid);
  const addFavoriteMutation = useAddFavoriteMutation();
  const removeFavoriteMutation = useRemoveFavoriteMutation();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.uuid);
  const clipboardMode = useClipboardStore((state) => state.mode);
  const pluginActions = useNodeActions();

  const nodeScope: 'page' | 'block' = node.is_page ? 'page' : 'block';

  const handleDeleteClick = useCallback(() => {
    if (node.is_page) {
      setShowDeleteModal(true);
    } else {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      deleteNode.mutate(node.uuid);
      onClose();
    }
  }, [node.is_page, node.uuid, deleteNode, onClose]);

  const handleArchiveClick = useCallback(() => {
    // Always warn for blocks (they always have a parent); warn for pages only if they have a parent
    if (!node.is_page || node.parent_uuid) {
      setShowArchiveModal(true);
    } else {
      archiveNode.mutate(node.uuid);
      onClose();
    }
  }, [node.is_page, node.parent_uuid, node.uuid, archiveNode, onClose]);

  const isHeader = useMemo(() => {
    try {
      const ast = JSON.parse(node.name || '[]');
      return Array.isArray(ast) && ast.length > 0 && ast[0].type === 'heading';
    } catch { return false; }
  }, [node.name]);

  const menuItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    const visibleActions = actions.filter(([, scope]) => scope === 'both' || scope === nodeScope);

    for (const [name] of visibleActions) {
      switch (name) {
        case 'favorite':
          items.push({
            id: 'favorite',
            label: isPageFavorited ? 'Remove from Favorites' : 'Add to Favorites',
            icon: isPageFavorited ? "mdi mdi-star-outline" : "mdi mdi-star",
            onClick: () => {
              if (isPageFavorited) removeFavoriteMutation.mutate(node.uuid);
              else addFavoriteMutation.mutate(node.uuid);
              onClose();
            },
          });
          break;

        case 'move-to':
          // Pages: hide for daily/monthly journals. Blocks: always show.
          if (node.is_page && (node.is_daily || node.is_monthly)) break;
          items.push({
            id: 'move-to',
            label: 'Move to…',
            icon: 'mdi-folder-move-outline',
            submenu: <MoveToSubmenu node={node} onClose={onClose} onParentChange={onParentChange} />,
          });
          break;

        case 'convert-to-page':
          if (!onConvertToPage) break;
          items.push({
            id: 'convert-to-page',
            label: 'Convert to page',
            icon: 'mdi-file-document-outline',
            onClick: () => { onConvertToPage(); onClose(); },
          });
          break;

        case 'convert-to-block':
          if (!onConvertToBlock) break;
          items.push({
            id: 'convert-to-block',
            label: 'Convert to block',
            icon: 'mdi-format-list-bulleted',
            onClick: () => { onConvertToBlock(); onClose(); },
          });
          break;

        case 'toggle-header':
          items.push({
            id: 'toggle-header',
            label: isHeader ? 'Remove header' : 'Set as header',
            icon: 'mdi-format-header-pound',
            onClick: async () => {
              try {
                const ast = JSON.parse(node.name || '[]');
                if (!Array.isArray(ast) || ast.length === 0) return;
                const newAst = ast.map((block: { type: string; [key: string]: unknown }, i: number) =>
                  i === 0 ? { ...block, type: block.type === 'heading' ? 'paragraph' : 'heading' } : block
                ) as unknown as ContentAST;

                // Update runtime directly for immediate UI feedback.
                // The runtime is the source of truth for contentAST;
                // going only through the API would be blocked by
                // upsertNodes preserving the old contentAST.
                const runtime = getOperationRuntime();
                const runtimeNode = getNode(runtime, node.uuid);
                if (runtimeNode) {
                  const intent: MutationIntent = {
                    type: 'update_content',
                    blockId: node.uuid,
                    contentAST: newAst,
                  };
                  await getUndoEngine().applyIntent(intent, (intent as { type: string }).type === 'update_content' ? { sourceEditorId: (intent as { sourceEditorId?: string }).sourceEditorId } : undefined);
                  getRuntimeEventBus().flushEvents();
                }

                // Also persist to backend
                updateNode.mutate({ nodeUuid: node.uuid, data: { name: JSON.stringify(newAst) } });
              } catch { /* ignore */ }
              onClose();
            },
          });
          break;

        case 'copy-uuid':
          items.push({
            id: 'copy-uuid',
            label: 'Copy UUID',
            icon: 'mdi-identifier',
            onClick: () => { copyToClipboard(node.uuid); onClose(); },
          });
          break;

        case 'copy-link':
          items.push({
            id: 'copy-link',
            label: 'Copy link',
            icon: 'mdi-link-variant',
            shortcut: '⌘C',
            onClick: () => { copyToClipboard(`[[${node.uuid}]]`); onClose(); },
          });
          break;

        case 'open-main-view':
          if (node.uuid === currentNodeUuid) break;
          items.push({
            id: 'open-main-view',
            label: 'Open in main view',
            icon: 'mdi-open-in-new',
            onClick: () => { openNode(node.uuid); onClose(); },
          });
          break;

        case 'copy-blocks':
          if (!onCopyBlocks) break;
          items.push({
            id: 'copy-blocks',
            label: 'Copy',
            icon: 'mdi-content-copy',
            shortcut: 'Ctrl+C',
            onClick: () => { onCopyBlocks(); onClose(); },
          });
          break;

        case 'paste-blocks':
          // Only show when there's something to paste
          if (!onPasteBlocks || clipboardMode !== 'blocks') break;
          items.push({
            id: 'paste-blocks',
            label: 'Paste',
            icon: 'mdi-content-paste',
            shortcut: 'Ctrl+V',
            onClick: () => { onPasteBlocks(); onClose(); },
          });
          break;

        case 'open-sidebar': {
          const existingCard = sidebarCards.find(
            (c) => c.nodeUuid === node.uuid && c.cardType === (node.is_page ? 'page' : 'block')
          );
          items.push({
            id: 'open-sidebar',
            label: existingCard ? 'Scroll to sidebar card' : 'Open in sidebar',
            icon: 'mdi-dock-right',
            onClick: () => {
              if (existingCard) {
                flashSidebarCard(existingCard.nodeUuid);
              } else {
                addSidebarCard(node.uuid, node.is_page ? 'page' : 'block');
              }
              onClose();
            },
          });
          break;
        }

        case 'local-graph':
          items.push({
            id: 'local-graph',
            label: 'Show local graph',
            icon: 'mdi-graph-outline',
            onClick: () => { openLocalGraph(node.uuid); onClose(); },
          });
          break;

        case 'export':
          items.push({
            id: 'export',
            label: 'Export…',
            icon: 'mdi-export',
            keepOpen: true,
            onClick: () => setShowExportModal(true),
          });
          break;

        case 'presentation':
          items.push({
            id: 'presentation',
            label: 'Start presentation',
            icon: 'mdi-presentation-play',
            onClick: () => {
              usePresentationStore.getState().openPresentation(node.uuid);
              onClose();
            },
          });
          break;

        case 'share':
          items.push({
            id: 'share',
            label: 'Share…',
            icon: 'mdi mdi-share-variant-outline',
            keepOpen: true,
            onClick: () => setShowShareModal(true),
          });
          break;

        case 'copy-text':
          items.push({
            id: 'copy-text',
            label: 'Copy as text',
            icon: 'mdi-text-box-outline',
            onClick: async (event?) => {
              const flat = event?.shiftKey ?? false;
              try {
                const jobUuid = await startSingleExportJob(node.uuid, {
                  format: 'markdown',
                  include_children: true,
                  formatting: false,
                  link_style: 'text',
                  layout: flat ? 'flat' : 'outline',
                  properties: 'none',
                });
                const job = await pollExportJob(jobUuid);
                const { data } = await fetchExportResult<string>(job.job_uuid, 'text');
                copyToClipboard(data as string);
              } catch {
                // Silently ignore — this is a quick-action convenience.
              }
              onClose();
            },
          });
          break;

        case 'view-ast':
          if (!showDevOptions) break;
          items.push({
            id: 'view-ast',
            label: 'View AST',
            icon: 'mdi-code-json',
            badge: 'DEV',
            keepOpen: true,
            onClick: () => setShowASTModal(true),
          });
          break;

        case 'toggle-private':
          items.push({
            id: 'toggle-private',
            label: node.is_private ? 'Make public' : 'Make private',
            icon: node.is_private ? 'mdi-eye-outline' : 'mdi-eye-off-outline',
            onClick: () => {
              updateNode.mutate({ nodeUuid: node.uuid, data: { is_private: !node.is_private } });
              onClose();
            },
          });
          break;

        case 'add-banner':
          if (!onAddBanner) break;
          items.push({
            id: 'add-banner',
            label: 'Add banner',
            icon: 'mdi-image-outline',
            onClick: () => {
              onAddBanner();
              onClose();
            },
          });
          break;

        case 'archive':
          if (node.active !== false) {
            items.push({
              id: 'archive',
              label: 'Archive',
              icon: 'mdi-archive-arrow-down-outline',
              keepOpen: true,
              onClick: handleArchiveClick,
            });
          } else {
            items.push({
              id: 'unarchive',
              label: 'Unarchive',
              icon: 'mdi-archive-arrow-up-outline',
              onClick: () => { unarchiveNode.mutate(node.uuid); onClose(); },
            });
          }
          break;

        case 'delete':
          items.push({
            id: 'delete',
            label: 'Delete',
            icon: 'mdi-delete-outline',
            danger: true,
            keepOpen: true,
            onClick: handleDeleteClick,
          });
          break;
      }
    }

    // Tag core items with their section and order, merge contributed node
    // actions (core features + plugins, see NodeActionRegistry), and compose
    // the final list — sections render in NODE_MENU_GROUP_ORDER with the
    // destructive section last.
    const actionContext: NodeActionContext = { menu: 'node', nodeUuid: node.uuid, node, close: onClose };
    const contributed = getVisibleNodeActions(pluginActions, {
      nodeScope,
      showDevOptions,
      context: actionContext,
    });
    const composed: ComposableMenuItem[] = items.map((item, index) => ({
      ...item,
      group: CORE_ITEM_GROUP[item.id] ?? 'main',
      order: index,
    }));
    contributed.forEach((action, regIndex) => {
      composed.push({
        id: `plugin:${action.id}`,
        label: action.label,
        icon: action.icon,
        shortcut: action.shortcut,
        badge: action.badge ?? (action.devOnly ? 'DEV' : undefined),
        danger: action.danger,
        keepOpen: action.keepOpen,
        group: action.group,
        order: action.order ?? NODE_ACTION_DEFAULT_ORDER + regIndex,
        onClick: () => {
          action.execute(actionContext);
          if (!action.keepOpen) onClose();
        },
      });
    });
    return composeMenuItems(composed);
  }, [
    actions, nodeScope, node, isPageFavorited, isHeader, clipboardMode,
    onConvertToPage, onConvertToBlock, onAddBanner, onCopyBlocks, onPasteBlocks, onClose, onParentChange,
    addSidebarCard, openLocalGraph, openNode, updateNode, unarchiveNode,
    showDevOptions, handleDeleteClick, handleArchiveClick, setShowShareModal,
    addFavoriteMutation, removeFavoriteMutation, currentNodeUuid, sidebarCards,
    flashSidebarCard, pluginActions,
  ]);

  const handleColorChange = useCallback((color: string | null) => {
    updateNode.mutate({ nodeUuid: node.uuid, data: { color } as NodeUpdate });
  }, [node.uuid, updateNode]);

  const handleIconChange = useCallback((icon: string | null) => {
    updateNode.mutate({ nodeUuid: node.uuid, data: { icon } as NodeUpdate });
  }, [node.uuid, updateNode]);

  const handleFavoriteToggle = useCallback(() => {
    if (isPageFavorited) removeFavoriteMutation.mutate(node.uuid);
    else addFavoriteMutation.mutate(node.uuid);
    onClose();
  }, [node.uuid, isPageFavorited, onClose, addFavoriteMutation, removeFavoriteMutation]);

  const menuVisible = !showDeleteModal && !showArchiveModal && !showASTModal && !showExportModal && !showShareModal;
  const menuCallbackRef = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    adjustMenuPosition(el, position, anchorEl);
  }, [position, anchorEl]);

  return (
    <>
      {menuVisible && createPortal(
        <div ref={menuCallbackRef} className="node-context-menu-wrapper">
          <IconColorPickerRow
            currentIcon={node.icon ?? null}
            currentColor={node.color ?? null}
            isFavorited={node.is_page ? isPageFavorited : undefined}
            onFavoriteToggle={node.is_page ? handleFavoriteToggle : undefined}
            onIconChange={handleIconChange}
            onColorChange={handleColorChange}
          />
          <ContextMenu items={menuItems} position={{ x: 0, y: 0 }} onClose={onClose} containerRef={wrapperRef} inline className="node-context-menu" />
        </div>,
        document.body
      )}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title="Delete page"
        message={`Are you sure you want to delete "${nodeNameToText(node.name) || 'Untitled'}"?`}
        secondaryMessage={linkedRefsCount > 0 ? `This page is linked in ${linkedRefsCount} other node${linkedRefsCount === 1 ? '' : 's'}.` : undefined}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => { deleteNode.mutate(node.uuid); setShowDeleteModal(false); onClose(); }}
        onCancel={() => { setShowDeleteModal(false); onClose(); }}
      />
      <ConfirmationModal
        isOpen={showArchiveModal}
        title={node.is_page ? 'Archive page' : 'Archive block'}
        message={node.is_page
          ? `This page is a child of another page. If the parent is deleted, this archived page will also be deleted.`
          : `This block is a child of another node. If the parent is deleted, this archived block will also be deleted.`}
        secondaryMessage={node.is_page
          ? 'Archiving this page will also archive all its child pages and blocks.'
          : 'Archiving this block will also archive all its child blocks.'}
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => { archiveNode.mutate(node.uuid); setShowArchiveModal(false); onClose(); }}
        onCancel={() => { setShowArchiveModal(false); onClose(); }}
      />
      <ASTViewerModal
        isOpen={showASTModal}
        onClose={() => { setShowASTModal(false); onClose(); }}
        node={node}
      />
      <ExportPageModal
        isOpen={showExportModal}
        onClose={() => { setShowExportModal(false); onClose(); }}
        nodeUuid={node.uuid}
        nodeName={node.name}
      />
      <ShareModal
        nodeUuid={node.uuid}
        isOpen={showShareModal}
        onClose={() => { setShowShareModal(false); onClose(); }}
      />
    </>
  );
}

// Backward-compatible aliases — no call-site changes needed
export const PageContextMenu = NodeContextMenu;
export const BlockContextMenu = NodeContextMenu;

