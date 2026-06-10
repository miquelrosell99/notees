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
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useLinkedReferencesCount } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore, useFavoritesStore, useSettingsStore, usePresentationStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';

import { ASTViewerModal } from './ASTViewerModal';
import { ExportPageModal } from '@/features/workspace/components/ExportPageModal';
import { ShareModal } from './ShareModal';
import { NodeSelector } from './NodeSelector';
import api from '@/api/client';
import type { Node, NodeUpdate } from '@/types';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { getMdiClass } from '@/utils/iconDom';
import { Icon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { ColorButton } from '@/components/ui/ColorButton';
import { getNodePickerPalette } from '@/features/content/components/nodes/views/viewTypes';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { ContentAST } from '@/runtime/types';
import './NodeContextMenu.css';

// ==================== Viewport Adjustment =====================

/**
 * Adjusts a fixed-position element so it stays within the viewport.
 * Uses a callback ref to directly modify DOM style on mount — no state,
 * no re-render, guaranteed to run before the first paint.
 */
function adjustMenuPosition(el: HTMLElement | null, position: { x: number; y: number }) {
  if (!el) return;
  // Place at requested position first so we can measure true dimensions
  el.style.left = `${position.x}px`;
  el.style.top = `${position.y}px`;

  const rect = el.getBoundingClientRect();
  const padding = 8;
  let x = position.x;
  let y = position.y;

  // If menu overflows bottom, open upward from click point
  if (y + rect.height > window.innerHeight) {
    y = position.y - rect.height;
  }
  // If menu overflows right
  if (x + rect.width > window.innerWidth) {
    x = window.innerWidth - rect.width - padding;
  }
  // Clamp to viewport edges
  if (x < padding) x = padding;
  if (y < padding) y = padding;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

// ==================== Common Context Menu Items ====================

interface BaseContextMenuProps {
  /** The node to show context menu for */
  node: Node;
  /** Position for the menu */
  position: { x: number; y: number };
  /** Callback to close the menu */
  onClose: () => void;
}

/**
 * Inline color picker row for context menu
 */
interface ColorPickerRowProps {
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
}

export function ColorPickerRow({ currentColor, onColorChange }: ColorPickerRowProps) {
  const nodeColors = useMemo(() => getNodePickerPalette(), []);
  // Stop propagation to prevent ContextMenu's outside click handler from closing the menu
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleColorClick = (e: React.MouseEvent, color: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    onColorChange(color);
  };

  return (
    <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} 
      className="context-menu-color-row" 
      onMouseDown={handleMouseDown}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
    >
      <span className="context-menu-color-label">Color</span>
      <div className="context-menu-color-swatches">
        {nodeColors.map((color) => (
          <button
            key={color || 'none'}
            className={`context-menu-color-swatch ${currentColor === color ? 'selected' : ''} ${!color ? 'no-color' : ''}`}
            style={color ? { backgroundColor: color } : undefined}
            onClick={(e) => handleColorClick(e, color)}
            onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
            title={color || 'No color'}
          >
            {!color && <span className="context-menu-color-swatch-line" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Compact icon + color picker row for context menu
 */
interface IconColorPickerRowProps {
  currentIcon: string | null;
  currentColor: string | null;
  isFavorited?: boolean;
  onFavoriteToggle?: () => void;
  onIconChange: (icon: string | null) => void;
  onColorChange: (color: string | null) => void;
}

function IconColorPickerRow({ currentIcon, currentColor, isFavorited, onFavoriteToggle, onIconChange, onColorChange }: IconColorPickerRowProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleIconClick = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPickerPos({
        x: Math.min(rect.left, window.innerWidth - 340),
        y: Math.min(rect.bottom + 4, window.innerHeight - 450),
      });
    }
    setShowPicker((prev) => !prev);
  }, []);

  const handleIconSelect = useCallback((value: string) => {
    onIconChange(value || null);
    setShowPicker(false);
  }, [onIconChange]);

  const renderTriggerValue = () => {
    if (!currentIcon) {
      return <Icon path="mdi-emoticon-happy-outline" size={0.9} />;
    }
    const mdiPath = getMdiClass(currentIcon);
    if (mdiPath) {
      return <Icon path={mdiPath} size={0.9} />;
    }
    if (currentIcon.match(/^mdi[A-Z]/)) {
      return null;
    }
    return <span className="context-menu-icon-emoji">{currentIcon}</span>;
  };

  return (
    <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      className="context-menu-icon-color-row"
      onMouseDown={handleMouseDown}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
    >
      <button
        ref={triggerRef}
        className="context-menu-icon-btn"
        onClick={handleIconClick}
        type="button"
        title="Change icon"
      >
        {renderTriggerValue()}
      </button>
      {onFavoriteToggle && (
        <Button
          variant="ghost"
          size="sm"
          icon={isFavorited ? 'mdi mdi-star' : 'mdi mdi-star-outline'}
          className={`context-menu-favorite-btn ${isFavorited ? 'favorited' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onFavoriteToggle();
          }}
          title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
        />
      )}
      <ColorButton
        color={currentColor || ''}
        size="sm"
        showPicker
        showNoneOption
        onColorChange={onColorChange}
      />
      {showPicker && createPortal(
        <EmojiPicker
          value={currentIcon || ''}
          onSelect={handleIconSelect}
          onClose={() => setShowPicker(false)}
          position={pickerPos}
        />,
        document.body
      )}
    </div>
  );
}

// ==================== Action Configuration ====================

export type ActionScope = 'page' | 'block' | 'both';

export type ActionName =
  | 'favorite'
  | 'move-to'
  | 'convert-to-page'
  | 'toggle-header'
  | 'copy-uuid'
  | 'copy-link'
  | 'open-main-view'
  | 'copy-blocks'
  | 'paste-blocks'
  | 'open-sidebar'
  | 'local-graph'
  | 'export'
  | 'presentation'
  | 'copy-text'
  | 'share'
  | 'view-ast'
  | 'toggle-private'
  | 'archive'
  | 'delete';

export type ActionConfig = readonly [ActionName, ActionScope];

/**
 * Default action list. Order determines menu order.
 * Callers can pass a custom subset/reordering via the `actions` prop.
 */
const DEFAULT_ACTIONS: ActionConfig[] = [
  ['copy-link',       'both'],
  ['open-main-view',  'both'],
  ['share',           'both'],
  ['open-sidebar',    'both'],
  ['copy-blocks',     'both'],
  ['paste-blocks',    'both'],
  ['move-to',         'both'],
  ['convert-to-page', 'block'],
  ['toggle-header',   'block'],
  ['copy-text',       'both'],
  ['export',          'both'],
  ['presentation',    'both'],
  ['view-ast',        'both'],
  ['archive',         'both'],
  ['toggle-private',  'page'],
  ['delete',          'both'],
];

// A separator is inserted before these actions (when they are visible and there are preceding items)
const SEP_BEFORE = new Set<ActionName>(['copy-text', 'view-ast', 'delete']);

// ==================== Move To Submenu ====================

interface MoveToSubmenuProps {
  node: Node;
  onClose: () => void;
  onParentChange?: (parentId: number | null) => void;
}

function MoveToSubmenu({ node, onClose, onParentChange }: MoveToSubmenuProps) {
  const updateNode = useUpdateNode();

  const handleSelect = useCallback((val: number | number[] | null) => {
    const parentId = typeof val === 'number' ? val : null;
    updateNode.mutate({ id: node.id, data: { parent_id: parentId } });
    onParentChange?.(parentId);
    onClose();
  }, [node.id, updateNode, onParentChange, onClose]);

  return (
    <NodeSelector
      trigger="select"
      value={node.parent_id ?? null}
      searchMode={node.is_page ? 'pages' : 'all'}
      excludeNodeId={node.id}
      placeholder={node.is_page ? 'Search pages...' : 'Search pages & blocks...'}
      onChange={handleSelect}
      allowCreate={false}
      size="sm"
      className="move-to-submenu"
    />
  );
}

// ==================== Unified Node Context Menu ====================

interface BaseContextMenuProps {
  node: Node;
  position: { x: number; y: number };
  onClose: () => void;
}

export interface NodeContextMenuProps extends BaseContextMenuProps {
  /**
   * Which actions to show and for which scope.
   * Defaults to DEFAULT_ACTIONS. Order determines menu order.
   */
  actions?: ActionConfig[];
  /** Callback when parent changes (move-to action) */
  onParentChange?: (parentId: number | null) => void;
  /** Enables 'convert-to-page' action (block-scoped) */
  onConvertToPage?: () => void;
  /** Called by 'copy-blocks' action — caller should copy the block to clipboard */
  onCopyBlocks?: () => void;
  /** Called by 'paste-blocks' action — caller should paste clipboard blocks after this block */
  onPasteBlocks?: () => void;
}

export function NodeContextMenu({
  node,
  position,
  onClose,
  actions = DEFAULT_ACTIONS,
  onParentChange,
  onConvertToPage,
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
  const { addSidebarCard, openLocalGraph, openNode, currentNodeId, sidebarCards, flashSidebarCard } = useNavigationStore();
  const { showDevOptions } = useSettingsStore();
  const favorites = useFavoritesStore((state) => state.favorites);
  const isPageFavorited = favorites.some(f => f.nodeId === node.id);
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);
  const clipboardMode = useClipboardStore((state) => state.mode);

  const nodeScope: 'page' | 'block' = node.is_page ? 'page' : 'block';

  const handleDeleteClick = useCallback(() => {
    if (node.is_page) {
      setShowDeleteModal(true);
    } else {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      deleteNode.mutate(node.id);
      onClose();
    }
  }, [node.is_page, node.id, deleteNode, onClose]);

  const handleArchiveClick = useCallback(() => {
    // Always warn for blocks (they always have a parent); warn for pages only if they have a parent
    if (!node.is_page || node.parent_id) {
      setShowArchiveModal(true);
    } else {
      archiveNode.mutate(node.id);
      onClose();
    }
  }, [node.is_page, node.parent_id, node.id, archiveNode, onClose]);

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
      // Auto-insert separator before certain actions when there are preceding non-separator items
      if (SEP_BEFORE.has(name) && items.length > 0 && !items[items.length - 1].separator) {
        items.push({ id: `sep-before-${name}`, label: '', separator: true });
      }

      switch (name) {
        case 'favorite':
          items.push({
            id: 'favorite',
            label: isPageFavorited ? 'Remove from Favorites' : 'Add to Favorites',
            icon: isPageFavorited ? "mdi mdi-star-outline" : "mdi mdi-star",
            onClick: () => {
              const store = useFavoritesStore.getState();
              if (isPageFavorited) store.removeFavorite(node.id);
              else store.addFavorite(node.id);
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

        case 'toggle-header':
          items.push({
            id: 'toggle-header',
            label: isHeader ? 'Remove header' : 'Set as header',
            icon: 'mdi-format-header-pound',
            onClick: () => {
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
                const runtime = getNodeGraphRuntime();
                const runtimeNode = runtime.getNode(node.uuid);
                if (runtimeNode) {
                  runtime.applyIntent({
                    type: 'update_content',
                    blockId: node.uuid,
                    contentAST: newAst,
                  });
                  runtime.flushEvents();
                }

                // Also persist to backend
                updateNode.mutate({ id: node.id, data: { name: JSON.stringify(newAst) } });
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
          if (node.id === currentNodeId) break;
          items.push({
            id: 'open-main-view',
            label: 'Open in main view',
            icon: 'mdi-open-in-new',
            onClick: () => { openNode(node.id); onClose(); },
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
            (c) => c.nodeId === node.id && c.cardType === (node.is_page ? 'page' : 'block')
          );
          items.push({
            id: 'open-sidebar',
            label: existingCard ? 'Scroll to sidebar card' : 'Open in sidebar',
            icon: 'mdi-dock-right',
            onClick: () => {
              if (existingCard) {
                flashSidebarCard(existingCard.id);
              } else {
                addSidebarCard(node.id, node.is_page ? 'page' : 'block');
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
            onClick: () => { openLocalGraph(node.id); onClose(); },
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
              usePresentationStore.getState().openPresentation(node.id);
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
            onClick: (event?) => {
              const flat = event?.shiftKey ?? false;
              api
                .get(`/export/${node.uuid}`, {
                  params: {
                    format: 'markdown',
                    include_children: true,
                    formatting: false,
                    link_style: 'text',
                    layout: flat ? 'flat' : 'outline',
                    properties: 'none',
                  },
                  responseType: 'text',
                })
                .then((response) => {
                  copyToClipboard(response.data as string);
                });
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
              updateNode.mutate({ id: node.id, data: { is_private: !node.is_private } });
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
              onClick: () => { unarchiveNode.mutate(node.id); onClose(); },
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

    return items;
  }, [
    actions, nodeScope, node, isPageFavorited, isHeader, clipboardMode,
    onConvertToPage, onCopyBlocks, onPasteBlocks, onClose,
    addSidebarCard, openLocalGraph, openNode, updateNode, unarchiveNode,
    showDevOptions, handleDeleteClick, handleArchiveClick, setShowShareModal,
  ]);

  const handleColorChange = useCallback((color: string | null) => {
    updateNode.mutate({ id: node.id, data: { color } as NodeUpdate });
  }, [node.id, updateNode]);

  const handleIconChange = useCallback((icon: string | null) => {
    updateNode.mutate({ id: node.id, data: { icon } as NodeUpdate });
  }, [node.id, updateNode]);

  const handleFavoriteToggle = useCallback(() => {
    const store = useFavoritesStore.getState();
    if (isPageFavorited) store.removeFavorite(node.id);
    else store.addFavorite(node.id);
    onClose();
  }, [node.id, isPageFavorited, onClose]);

  const menuVisible = !showDeleteModal && !showArchiveModal && !showASTModal && !showExportModal && !showShareModal;
  const menuCallbackRef = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    adjustMenuPosition(el, position);
  }, [position]);

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
          <ContextMenu items={menuItems} position={{ x: 0, y: 0 }} onClose={onClose} containerRef={wrapperRef} inline />
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
        onConfirm={() => { deleteNode.mutate(node.id); setShowDeleteModal(false); onClose(); }}
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
        onConfirm={() => { archiveNode.mutate(node.id); setShowArchiveModal(false); onClose(); }}
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
        nodeId={node.id}
        isOpen={showShareModal}
        onClose={() => { setShowShareModal(false); onClose(); }}
      />
    </>
  );
}

// Backward-compatible aliases — no call-site changes needed
export const PageContextMenu = NodeContextMenu;
export const BlockContextMenu = NodeContextMenu;

