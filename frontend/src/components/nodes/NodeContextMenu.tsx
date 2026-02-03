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
import { useMemo, useCallback, useState } from 'react';
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useNode, useLinkedReferencesCount } from '@/hooks';
import { useNodesStore, useFavoritesStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { SearchBox } from '../SearchBox';
import type { Node, NodeUpdate } from '@/types';
import './NodeContextMenu.css';

// Color palette for node color picker (subset for quick access)
const NODE_COLORS = [
  null, // No color
  '#ff4d4d', '#ff9933', '#ffcc00', '#33cc33', 
  '#00b3b3', '#3366ff', '#9933ff', '#ff33cc',
];

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
  // Stop propagation to prevent ContextMenu's outside click handler from closing the menu
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div className="context-menu-color-row" onMouseDown={handleMouseDown}>
      <span className="context-menu-color-label">Color</span>
      <div className="context-menu-color-swatches">
        {NODE_COLORS.map((color) => (
          <button
            key={color || 'none'}
            className={`context-menu-color-swatch ${currentColor === color ? 'selected' : ''} ${!color ? 'no-color' : ''}`}
            style={color ? { backgroundColor: color } : undefined}
            onClick={() => onColorChange(color)}
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
  onArchiveClick: () => void
): ContextMenuItem[] {
  const archiveNode = useArchiveNode();
  const unarchiveNode = useUnarchiveNode();
  const { addSidebarCard, openLocalGraph } = useNodesStore();
  
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
          const link = `[[${node.name || 'Untitled'}]]`;
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
      { id: 'sep-common-2', label: '', separator: true },
    ];
    
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
  }, [node, onClose, archiveNode, unarchiveNode, addSidebarCard, openLocalGraph, onDeleteClick, onArchiveClick]);
}

// ==================== Node Context Menu (Base) ====================

interface NodeContextMenuProps extends BaseContextMenuProps {}

/**
 * Base context menu with common actions
 */
export function NodeContextMenu({ node, position, onClose }: NodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  
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
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick);
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
  
  return (
    <>
      {!showDeleteModal && !showArchiveModal && (
        <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
          <ContextMenu
            items={commonItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title="Delete page"
        message={`Are you sure you want to delete "${node.name || 'Untitled'}"?`}
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
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  
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
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick);
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
          <span className="parent-selector-name">{parentPage.name || 'Untitled'}</span>
        </div>
      )}
      <div className="parent-selector-search">
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleParentSelect}
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
    return [
      {
        id: 'favorite',
        label: isPageFavorited ? 'Remove from Favorites' : 'Add to Favorites',
        icon: isPageFavorited ? '☆' : '★',
        onClick: handleToggleFavorite
      },
      { id: 'sep-page-1', label: '', separator: true },
      {
        id: 'change-parent',
        label: `Parent: ${parentPage?.name || 'None'}`,
        submenu: parentSubmenu
      },
      { id: 'sep-page-2', label: '', separator: true },
      ...commonItems,
    ];
  }, [isPageFavorited, parentPage, parentSubmenu, commonItems, handleToggleFavorite]);
  
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
      {!showDeleteModal && !showArchiveModal && (
        <div className="page-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
          <ContextMenu
            items={pageItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title="Delete page"
        message={`Are you sure you want to delete "${node.name || 'Untitled'}"?`}
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
  const deleteNode = useDeleteNode();
  const archiveNode = useArchiveNode();
  
  const handleDeleteClick = useCallback(() => {
    deleteNode.mutate(node.id);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleArchiveClick = useCallback(() => {
    // Always show warning for blocks since they always have a parent
    setShowArchiveModal(true);
  }, []);
  
  const commonItems = useCommonMenuItems(node, onClose, handleDeleteClick, handleArchiveClick);
  const { openNode } = useNodesStore();
  const updateNode = useUpdateNode();
  
  const blockItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'focus-block',
        label: 'Focus on block',
        onClick: () => {
          openNode(node.id, 'block');
          onClose();
        }
      },
    ];
    
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
    
    items.push({ id: 'sep-block-1', label: '', separator: true });
    items.push(...commonItems);
    
    return items;
  }, [node, onClose, openNode, onConvertToPage, onMoveBlock, commonItems]);
  
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
  
  return (
    <>
      {!showArchiveModal && (
        <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
          <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
          <ContextMenu
            items={blockItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
          />
        </div>
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
    </>
  );
}

export default NodeContextMenu;
