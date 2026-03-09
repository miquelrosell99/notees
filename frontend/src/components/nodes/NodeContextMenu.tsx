/**
 * Node Context Menu Components
 * 
 * Provides a hierarchical context menu system:
 * - NodeContextMenu: Base menu with common actions (delete, archive, copy UUID, color)
 * - PageContextMenu: Page-specific actions (parent, favorites, etc.)
 * - BlockContextMenu: Block-specific actions
 * 
 * The menus are composable - page and block menus include the common items.
 */
import { useMemo, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useNode, useLinkedReferencesCount } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useAppStore, useFavoritesStore, useSettingsStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { ASTViewerModal } from './ASTViewerModal';
import { ExportPageModal } from '../workspace/ExportPageModal';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { SearchBox } from '../core/SearchBox';
import type { Node, NodeUpdate } from '@/types';
import { getNodePickerPalette } from '@/components/nodes/views/viewTypes';
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

/**
 * Get common context menu items shared between pages and blocks
 */
function useCommonMenuItems(
  node: Node, 
  onClose: () => void, 
  onDeleteClick: () => void,
  onArchiveClick: () => void,
  onViewAST?: () => void,
  onExportClick?: () => void
): ContextMenuItem[] {
  const unarchiveNode = useUnarchiveNode();
  const { addSidebarCard, openLocalGraph } = useAppStore();
  
  return useMemo(() => {
    const items: ContextMenuItem[] = [
      {
        id: 'copy-uuid',
        label: 'Copy UUID',
        onClick: () => {
          navigator.clipboard.writeText(node.uuid);
          onClose();
        }
      },
      {
        id: 'copy-link',
        label: 'Copy link',
        shortcut: '⌘C',
        onClick: () => {
          const link = `[[${node.uuid}]]`;
          navigator.clipboard.writeText(link);
          onClose();
        }
      },
      { id: 'sep-common-1', label: '', separator: true },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          addSidebarCard(node.id, node.is_page ? 'page' : 'block');
          onClose();
        }
      },
      {
        id: 'local-graph',
        label: 'Show local graph',
        onClick: () => {
          openLocalGraph(node.id);
          onClose();
        }
      },
    ];

    if (onExportClick) {
      items.push({
        id: 'export',
        label: 'Export…',
        keepOpen: true,
        onClick: onExportClick,
      });
    }
    
    // View AST (debug) - keepOpen so modal renders before unmount
    if (onViewAST) {
      items.push({
        id: 'view-ast',
        label: 'View AST',
        keepOpen: true,
        onClick: onViewAST
      });
    }
    
    items.push({ id: 'sep-common-2', label: '', separator: true });
    
    // Archive/Unarchive
    if (node.active !== false) {
      items.push({
        id: 'archive',
        label: 'Archive',
        danger: true,
        keepOpen: true,
        onClick: onArchiveClick
      });
    } else {
      items.push({
        id: 'unarchive',
        label: 'Unarchive',
        onClick: () => {
          unarchiveNode.mutate(node.id);
          onClose();
        }
      });
    }
    
    // Delete (dangerous)
    items.push({
      id: 'delete',
      label: 'Delete',
      danger: true,
      keepOpen: true,
      onClick: onDeleteClick
    });
    
    return items;
  }, [node, onClose, unarchiveNode, addSidebarCard, openLocalGraph, onDeleteClick, onArchiveClick, onViewAST, onExportClick]);
}

// ==================== Node Context Menu (Base) ====================

interface NodeContextMenuProps extends BaseContextMenuProps {}

/**
 * Base context menu with common actions
 */
export function NodeContextMenu({ node, position, onClose }: NodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showASTModal, setShowASTModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  const { showDevOptions } = useSettingsStore();
  
  const handleDeleteClick = useCallback(() => {
    // Only show confirmation for pages, not for blocks
    if (node.is_page) {
      setShowDeleteModal(true);
    } else {
      deleteNode.mutate(node.id);
      onClose();
    }
  }, [node.is_page, node.id, deleteNode, onClose]);
  
  const handleArchiveClick = useCallback(() => {
    // Show warning if node has a parent
    if (node.parent_id) {
      setShowArchiveModal(true);
    } else {
      archiveNode.mutate(node.id);
      onClose();
    }
  }, [node.parent_id, node.id, archiveNode, onClose]);
  
  const handleViewAST = useCallback(() => {
    setShowASTModal(true);
  }, []);

  const handleExportClick = useCallback(() => {
    setShowExportModal(true);
  }, []);
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick, showDevOptions ? handleViewAST : undefined, handleExportClick);
  const updateNode = useUpdateNode();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);
  
  const handleColorChange = useCallback((color: string | null) => {
    const data: NodeUpdate = { color };
    updateNode.mutate({ id: node.id, data });
  }, [node.id, updateNode]);
  
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(node.id);
    setShowDeleteModal(false);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const handleConfirmArchive = useCallback(() => {
    archiveNode.mutate(node.id);
    setShowArchiveModal(false);
    onClose();
  }, [node.id, archiveNode, onClose]);
  
  const handleCancelArchive = useCallback(() => {
    setShowArchiveModal(false);
    onClose();
  }, [onClose]);
  
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
          <ContextMenu
            items={commonItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
            containerRef={wrapperRef}
          />
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
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
      <ConfirmationModal
        isOpen={showArchiveModal}
        title="Archive child node"
        message={`This node is a child of another node. If the parent is deleted in the future, this archived node will also be deleted.`}
        secondaryMessage="Archiving this node will also archive all its child nodes."
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmArchive}
        onCancel={handleCancelArchive}
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

// ==================== Page Context Menu ====================

interface PageContextMenuProps extends BaseContextMenuProps {
  /** Callback when parent changes */
  onParentChange?: (parentId: number | null) => void;
}

/**
 * Page-specific context menu with parent selection, favorites, etc.
 */
export function PageContextMenu({ node, position, onClose, onParentChange }: PageContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showASTModal, setShowASTModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  const { showDevOptions } = useSettingsStore();
  
  const handleDeleteClick = useCallback(() => {
    setShowDeleteModal(true);
  }, []);
  
  const handleArchiveClick = useCallback(() => {
    // Show warning if node has a parent
    if (node.parent_id) {
      setShowArchiveModal(true);
    } else {
      archiveNode.mutate(node.id);
      onClose();
    }
  }, [node.parent_id, node.id, archiveNode, onClose]);
  
  const handleViewAST = useCallback(() => {
    setShowASTModal(true);
  }, []);

  const handleExportClick = useCallback(() => {
    setShowExportModal(true);
  }, []);
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick, showDevOptions ? handleViewAST : undefined, handleExportClick);
  const { data: parentPage } = useNode(node.parent_id ?? null);
  const updateNode = useUpdateNode();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);
  
  // Favorites - use selector for data, getState() for actions
  const favorites = useFavoritesStore((state) => state.favorites);
  const isPageFavorited = favorites.some(f => f.nodeId === node.id);
  
  const handleToggleFavorite = useCallback(() => {
    const store = useFavoritesStore.getState();
    if (isPageFavorited) {
      store.removeFavorite(node.id);
    } else {
      store.addFavorite(node.id);
    }
    onClose();
  }, [isPageFavorited, node.id, onClose]);
  
  const handleParentSelect = useCallback((selectedNode: Node) => {
    updateNode.mutate({ id: node.id, data: { parent_id: selectedNode.id } });
    onParentChange?.(selectedNode.id);
    onClose();
  }, [node.id, updateNode, onParentChange, onClose]);
  
  const handleRemoveParent = useCallback(() => {
    updateNode.mutate({ id: node.id, data: { parent_id: null } });
    onParentChange?.(null);
    onClose();
  }, [node.id, updateNode, onParentChange, onClose]);
  
  // Parent selection submenu content
  const parentSubmenu = useMemo(() => (
    <Card elevation="high" padding={true} className="parent-selector-submenu">
      {node.parent_id && parentPage && (
        <div className="parent-selector-current">
          <span className="parent-selector-label">Current:</span>
          <span className="parent-selector-name">{nodeNameToText(parentPage.name) || 'Untitled'}</span>
        </div>
      )}
      <div className="parent-selector-search">
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleParentSelect}
          filterFn={(n: Node) => n.is_page === true}
          autoFocus
        />
      </div>
      {node.parent_id && (
        <Button 
          variant="ghost"
          size="sm"
          className="parent-selector-remove"
          onClick={handleRemoveParent}
        >
          Remove parent
        </Button>
      )}
    </Card>
  ), [node.parent_id, parentPage, handleParentSelect, handleRemoveParent]);
  
  const pageItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'favorite',
        label: isPageFavorited ? 'Remove from Favorites' : 'Add to Favorites',
        icon: isPageFavorited ? '☆' : '★',
        onClick: handleToggleFavorite
      },
      { id: 'sep-page-1', label: '', separator: true },
    ];
    
    // Hide parent selector for day and month pages
    if (!node.is_daily && !node.is_monthly) {
      items.push({
        id: 'change-parent',
        label: `Parent: ${parentPage ? nodeNameToText(parentPage.name) || 'Untitled' : 'None'}`,
        submenu: parentSubmenu
      });
      items.push({ id: 'sep-page-2', label: '', separator: true });
    }
    
    items.push(...commonItems);
    
    return items;
  }, [isPageFavorited, parentPage, parentSubmenu, commonItems, handleToggleFavorite, node.is_daily, node.is_monthly]);
  
  const handleColorChange = useCallback((color: string | null) => {
    const data: NodeUpdate = { color };
    updateNode.mutate({ id: node.id, data });
  }, [node.id, updateNode]);
  
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(node.id);
    setShowDeleteModal(false);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const handleConfirmArchive = useCallback(() => {
    archiveNode.mutate(node.id);
    setShowArchiveModal(false);
    onClose();
  }, [node.id, archiveNode, onClose]);
  
  const handleCancelArchive = useCallback(() => {
    setShowArchiveModal(false);
    onClose();
  }, [onClose]);
  
  return (
    <>
      {!showDeleteModal && !showArchiveModal && !showASTModal && !showExportModal && (
        <div ref={wrapperRef} className="page-context-menu-wrapper" style={{ left: position.x, top: position.y }}>
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
          <ContextMenu
            items={pageItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
            containerRef={wrapperRef}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title="Delete page"
        message={`Are you sure you want to delete "${nodeNameToText(node.name) || 'Untitled'}"?`}
        secondaryMessage={linkedRefsCount > 0 ? `This page is linked in ${linkedRefsCount} other node${linkedRefsCount === 1 ? '' : 's'}.` : undefined}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
      <ConfirmationModal
        isOpen={showArchiveModal}
        title="Archive child page"
        message={`This page is a child of another page. If the parent is deleted in the future, this archived page will also be deleted.`}
        secondaryMessage="Archiving this page will also archive all its child pages and blocks."
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmArchive}
        onCancel={handleCancelArchive}
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

// ==================== Block Context Menu ====================

interface BlockContextMenuProps extends BaseContextMenuProps {
  /** Callback to convert block to page */
  onConvertToPage?: () => void;
  /** Callback to move block */
  onMoveBlock?: () => void;
}

/**
 * Block-specific context menu
 */
export function BlockContextMenu({ 
  node, 
  position, 
  onClose, 
  onConvertToPage,
  onMoveBlock 
}: BlockContextMenuProps) {
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [showASTModal, setShowASTModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  const { showDevOptions } = useSettingsStore();
  
  const handleDeleteClick = useCallback(() => {
    // Blur active element so Lexical doesn't auto-focus the previous block
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    deleteNode.mutate(node.id);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleArchiveClick = useCallback(() => {
    // Always show warning for blocks since they always have a parent
    setShowArchiveModal(true);
  }, []);
  
  const handleViewAST = useCallback(() => {
    setShowASTModal(true);
  }, []);

  const handleExportClick = useCallback(() => {
    setShowExportModal(true);
  }, []);
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick, showDevOptions ? handleViewAST : undefined, handleExportClick);
  const updateNode = useUpdateNode();
  
  const isHeader = useMemo(() => {
    try {
      const ast = JSON.parse(node.name || '[]');
      return Array.isArray(ast) && ast.length > 0 && ast[0].type === 'heading';
    } catch {
      return false;
    }
  }, [node.name]);

  const blockItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    
    if (onConvertToPage) {
      items.push({
        id: 'convert-to-page',
        label: 'Convert to page',
        onClick: () => {
          onConvertToPage();
          onClose();
        }
      });
    }
    
    if (onMoveBlock) {
      items.push({
        id: 'move-block',
        label: 'Move block...',
        onClick: () => {
          onMoveBlock();
          onClose();
        }
      });
    }

    items.push({
      id: 'toggle-header',
      label: isHeader ? 'Remove header' : 'Set as header',
      onClick: () => {
        try {
          const ast = JSON.parse(node.name || '[]');
          if (!Array.isArray(ast) || ast.length === 0) return;
          const newAst = ast.map((block: { type: string; [key: string]: unknown }, i: number) =>
            i === 0 ? { ...block, type: block.type === 'heading' ? 'paragraph' : 'heading' } : block
          );
          updateNode.mutate({ id: node.id, data: { name: JSON.stringify(newAst) } });
        } catch { /* ignore */ }
        onClose();
      },
    });
    
    items.push({ id: 'sep-block-1', label: '', separator: true });
    items.push(...commonItems);
    
    return items;
  }, [onClose, onConvertToPage, onMoveBlock, commonItems, isHeader, node.name, node.id, updateNode]);
  
  const handleColorChange = useCallback((color: string | null) => {
    const data: NodeUpdate = { color };
    updateNode.mutate({ id: node.id, data });
  }, [node.id, updateNode]);
  
  const handleConfirmArchive = useCallback(() => {
    archiveNode.mutate(node.id);
    setShowArchiveModal(false);
    onClose();
  }, [node.id, archiveNode, onClose]);
  
  const handleCancelArchive = useCallback(() => {
    setShowArchiveModal(false);
    onClose();
  }, [onClose]);
  
  const menuVisible = !showArchiveModal && !showASTModal && !showExportModal;
  const menuCallbackRef = useCallback((el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    adjustMenuPosition(el, position);
  }, [position]);

  return (
    <>
      {menuVisible && createPortal(
        <div ref={menuCallbackRef} className="node-context-menu-wrapper">
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
          <ContextMenu
            items={blockItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
            containerRef={wrapperRef}
          />
        </div>,
        document.body
      )}
      <ConfirmationModal
        isOpen={showArchiveModal}
        title="Archive child block"
        message={`This block is a child of another node. If the parent is deleted in the future, this archived block will also be deleted.`}
        secondaryMessage="Archiving this block will also archive all its child blocks."
        confirmLabel="Archive"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmArchive}
        onCancel={handleCancelArchive}
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

export default NodeContextMenu;
