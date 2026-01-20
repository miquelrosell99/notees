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
import { useArchiveNode, useUnarchiveNode, useDeleteNode, useUpdateNode, useNode, useCreatePage } from '@/hooks';
import { useNodesStore, useFavoritesStore } from '@/stores';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import { NodePicker } from './NodePicker';
import { DeletionConfirmationModal } from './DeletionConfirmationModal';
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
function useCommonMenuItems(node: Node, onClose: () => void, onDeleteClick: () => void): ContextMenuItem[] {
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
        onClick: () => {
          archiveNode.mutate(node.id);
          onClose();
        }
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
      label: 'Delete permanently',
      danger: true,
      onClick: () => {
        onDeleteClick();
        onClose();
      }
    });
    
    return items;
  }, [node, onClose, archiveNode, unarchiveNode, addSidebarCard, openLocalGraph, onDeleteClick]);
}

// ==================== Node Context Menu (Base) ====================

interface NodeContextMenuProps extends BaseContextMenuProps {}

/**
 * Base context menu with common actions
 */
export function NodeContextMenu({ node, position, onClose }: NodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const deleteNode = useDeleteNode();
  const commonItems = useCommonMenuItems(node, onClose, () => setShowDeleteModal(true));
  const updateNode = useUpdateNode();
  
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
  }, []);
  
  return (
    <>
      <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
        <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
        <ContextMenu
          items={commonItems}
          position={{ x: 0, y: 0 }}
          onClose={onClose}
        />
      </div>
      <DeletionConfirmationModal
        isOpen={showDeleteModal}
        node={node}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
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
  const deleteNode = useDeleteNode();
  const commonItems = useCommonMenuItems(node, onClose, () => setShowDeleteModal(true));
  const { data: parentPage } = useNode(node.parent_id ?? null);
  const updateNode = useUpdateNode();
  const createPage = useCreatePage();
  const { openNode } = useNodesStore();
  
  // Favorites
  const favorites = useFavoritesStore((state) => state.favorites);
  const addFavorite = useFavoritesStore((state) => state.addFavorite);
  const removeFavorite = useFavoritesStore((state) => state.removeFavorite);
  const isPageFavorited = favorites.some(f => f.nodeId === node.id);
  
  // Parent picker state
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [parentPickerPos, setParentPickerPos] = useState({ x: 0, y: 0 });
  
  const handleToggleFavorite = useCallback(() => {
    if (isPageFavorited) {
      removeFavorite(node.id);
    } else {
      addFavorite(node.id);
    }
    onClose();
  }, [isPageFavorited, node.id, addFavorite, removeFavorite, onClose]);
  
  const handleParentChange = useCallback((newParentId: number | number[] | null) => {
    const parentId = Array.isArray(newParentId) ? newParentId[0] : newParentId;
    updateNode.mutate({ id: node.id, data: { parent_id: parentId } });
    setShowParentPicker(false);
    onParentChange?.(parentId);
    onClose();
  }, [node.id, updateNode, onParentChange, onClose]);
  
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
        onClick: () => {
          setParentPickerPos(position);
          setShowParentPicker(true);
        }
      },
      { id: 'sep-page-2', label: '', separator: true },
      ...commonItems,
    ];
  }, [isPageFavorited, parentPage, commonItems, handleToggleFavorite, position]);
  
  if (showParentPicker) {
    return (
      <div className="parent-picker-overlay" onClick={() => { setShowParentPicker(false); onClose(); }}>
        <div 
          className="parent-picker-modal"
          style={{ top: parentPickerPos.y, left: parentPickerPos.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="parent-picker-header">
            <span>Select Parent Page</span>
            <button onClick={() => { setShowParentPicker(false); onClose(); }}>✕</button>
          </div>
          <NodePicker
            property={{ id: 0, name: 'parent', property_type: 'node', tag_filters: [] } as any}
            value={node.parent_id ?? null}
            onChange={handleParentChange}
            onNavigate={(id) => openNode(id, 'page')}
            onCreate={async (name) => {
              const newPage = await createPage.mutateAsync({ name });
              return newPage;
            }}
          />
          {node.parent_id && (
            <button 
              className="parent-picker-clear"
              onClick={() => handleParentChange(null)}
            >
              Remove parent
            </button>
          )}
        </div>
      </div>
    );
  }
  
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
  }, []);
  
  return (
    <>
      <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
        <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
        <ContextMenu
          items={pageItems}
          position={{ x: 0, y: 0 }}
          onClose={onClose}
        />
      </div>
      <DeletionConfirmationModal
        isOpen={showDeleteModal}
        node={node}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
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
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const deleteNode = useDeleteNode();
  const commonItems = useCommonMenuItems(node, onClose, () => setShowDeleteModal(true));
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
  
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(node.id);
    setShowDeleteModal(false);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
  }, []);
  
  return (
    <>
      <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
        <ColorPickerRow currentColor={node.color ?? null} onColorChange={handleColorChange} />
        <ContextMenu
          items={blockItems}
          position={{ x: 0, y: 0 }}
          onClose={onClose}
        />
      </div>
      <DeletionConfirmationModal
        isOpen={showDeleteModal}
        node={node}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
}

export default NodeContextMenu;
