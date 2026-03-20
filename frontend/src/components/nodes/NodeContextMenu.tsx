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
import { createPortal } from 'react-dom';
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useLinkedReferencesCount } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNavigationStore, useFavoritesStore, useSettingsStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';

import { ASTViewerModal } from './ASTViewerModal';
import { ExportPageModal } from '../workspace/ExportPageModal';
import { NodeSelector } from './NodeSelector';
import type { Node, NodeUpdate } from '@/types';
import { getNodePickerPalette } from '@/components/nodes/views/viewTypes';
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
    <div 
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

// ==================== Action Configuration ====================

export type ActionScope = 'page' | 'block' | 'both';

export type ActionName =
  | 'favorite'
  | 'move-to'
  | 'convert-to-page'
  | 'toggle-header'
  | 'copy-uuid'
  | 'copy-link'
  | 'open-sidebar'
  | 'local-graph'
  | 'export'
  | 'view-ast'
  | 'archive'
  | 'delete';

export type ActionConfig = readonly [ActionName, ActionScope];

/**
 * Default action list. Order determines menu order.
 * Callers can pass a custom subset/reordering via the `actions` prop.
 */
export const DEFAULT_ACTIONS: ActionConfig[] = [
  ['favorite',        'page'],
  ['convert-to-page', 'block'],
  ['move-to',         'both'],
  ['toggle-header',   'block'],
  ['copy-link',       'both'],
  ['open-sidebar',    'both'],
  ['export',          'both'],
  ['view-ast',        'both'],
  ['archive',         'both'],
  ['delete',          'both'],
];

// A separator is inserted before these actions (when they are visible and there are preceding items)
const SEP_BEFORE = new Set<ActionName>(['archive']);

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
}

export function NodeContextMenu({
  node,
  position,
  onClose,
  actions = DEFAULT_ACTIONS,
  onParentChange,
  onConvertToPage,
}: NodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showASTModal, setShowASTModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  const unarchiveNode = useUnarchiveNode();
  const updateNode = useUpdateNode();
  const { addSidebarCard, openLocalGraph } = useNavigationStore();
  const { showDevOptions } = useSettingsStore();
  const favorites = useFavoritesStore((state) => state.favorites);
  const isPageFavorited = favorites.some(f => f.nodeId === node.id);
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);

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
            icon: isPageFavorited ? '☆' : '★',
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
            submenu: <MoveToSubmenu node={node} onClose={onClose} onParentChange={onParentChange} />,
          });
          break;

        case 'convert-to-page':
          if (!onConvertToPage) break;
          items.push({
            id: 'convert-to-page',
            label: 'Convert to page',
            onClick: () => { onConvertToPage(); onClose(); },
          });
          break;

        case 'toggle-header':
          items.push({
            id: 'toggle-header',
            label: isHeader ? 'Remove header' : 'Set as header',
            onClick: () => {
              try {
                const ast = JSON.parse(node.name || '[]');
                if (!Array.isArray(ast) || ast.length === 0) return;
                const newAst = ast.map((block: { type: string; [key: string]: unknown }, i: number) =>
                  i === 0 ? { ...block, type: block.type === 'heading' ? 'paragraph' : 'heading' } : block
                ) as ContentAST;

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
            onClick: () => { navigator.clipboard.writeText(node.uuid); onClose(); },
          });
          break;

        case 'copy-link':
          items.push({
            id: 'copy-link',
            label: 'Copy link',
            shortcut: '⌘C',
            onClick: () => { navigator.clipboard.writeText(`[[${node.uuid}]]`); onClose(); },
          });
          break;

        case 'open-sidebar':
          items.push({
            id: 'open-sidebar',
            label: 'Open in sidebar',
            shortcut: '⇧Click',
            onClick: () => { addSidebarCard(node.id, node.is_page ? 'page' : 'block'); onClose(); },
          });
          break;

        case 'local-graph':
          items.push({
            id: 'local-graph',
            label: 'Show local graph',
            onClick: () => { openLocalGraph(node.id); onClose(); },
          });
          break;

        case 'export':
          items.push({
            id: 'export',
            label: 'Export…',
            keepOpen: true,
            onClick: () => setShowExportModal(true),
          });
          break;

        case 'view-ast':
          if (!showDevOptions) break;
          items.push({
            id: 'view-ast',
            label: 'View AST',
            badge: 'DEV',
            keepOpen: true,
            onClick: () => setShowASTModal(true),
          });
          break;

        case 'archive':
          if (node.active !== false) {
            items.push({
              id: 'archive',
              label: 'Archive',
              danger: true,
              keepOpen: true,
              onClick: handleArchiveClick,
            });
          } else {
            items.push({
              id: 'unarchive',
              label: 'Unarchive',
              onClick: () => { unarchiveNode.mutate(node.id); onClose(); },
            });
          }
          break;

        case 'delete':
          items.push({
            id: 'delete',
            label: 'Delete',
            danger: true,
            keepOpen: true,
            onClick: handleDeleteClick,
          });
          break;
      }
    }

    return items;
  }, [
    actions, nodeScope, node, isPageFavorited, isHeader,
    onConvertToPage, onClose,
    addSidebarCard, openLocalGraph, updateNode, unarchiveNode,
    showDevOptions, handleDeleteClick, handleArchiveClick,
  ]);

  const handleColorChange = useCallback((color: string | null) => {
    updateNode.mutate({ id: node.id, data: { color } as NodeUpdate });
  }, [node.id, updateNode]);

  const menuVisible = !showDeleteModal && !showArchiveModal && !showASTModal && !showExportModal;
  const menuCallbackRef = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    adjustMenuPosition(el, position);
  }, [position]);

  return (
    <>
      {menuVisible && createPortal(
        <div ref={menuCallbackRef} className="node-context-menu-wrapper">
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
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
      />

    </>
  );
}

// Backward-compatible aliases — no call-site changes needed
export const PageContextMenu = NodeContextMenu;
export const BlockContextMenu = NodeContextMenu;

export default NodeContextMenu;
