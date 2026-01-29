/**
 * Archived Node Context Menu
 * 
 * Context menu for archived nodes with unarchive and delete actions.
 */
import { useCallback, useState } from 'react';
import { useUnarchiveNode, useDeleteNode, useLinkedReferencesCount } from '@/hooks';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import './NodeContextMenu.css';

interface ArchivedNodeContextMenuProps {
  /** The node to show context menu for */
  node: Node;
  /** Position for the menu */
  position: { x: number; y: number };
  /** Callback to close the menu */
  onClose: () => void;
}

/**
 * Context menu for archived nodes
 */
export function ArchivedNodeContextMenu({ node, position, onClose }: ArchivedNodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const unarchiveNode = useUnarchiveNode();
  const deleteNode = useDeleteNode();
  const { addSidebarCard, openLocalGraph } = useNodesStore();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);
  
  const handleUnarchive = useCallback(() => {
    unarchiveNode.mutate(node.id);
    onClose();
  }, [node.id, unarchiveNode, onClose]);
  
  const handleDeleteClick = useCallback(() => {
    setShowDeleteModal(true);
  }, []);
  
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(node.id);
    setShowDeleteModal(false);
    onClose();
  }, [node.id, deleteNode, onClose]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const menuItems: ContextMenuItem[] = [
    {
      id: 'unarchive',
      label: 'Unarchive',
      onClick: handleUnarchive,
    },
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
      onClick: () => {
        const link = `[[${node.name || 'Untitled'}]]`;
        navigator.clipboard.writeText(link);
        onClose();
      }
    },
    { id: 'sep-1', label: '', separator: true },
    {
      id: 'open-sidebar',
      label: 'Open in sidebar',
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
    { id: 'sep-2', label: '', separator: true },
    {
      id: 'delete',
      label: 'Delete',
      danger: true,
      keepOpen: true,
      onClick: handleDeleteClick,
    },
  ];
  
  return (
    <>
      {!showDeleteModal && (
        <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
          <ContextMenu
            items={menuItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={showDeleteModal}
        title={`Delete ${node.is_page ? 'page' : 'block'}`}
        message={`Are you sure you want to delete "${node.name || 'Untitled'}"? It will be moved to trash.`}
        secondaryMessage={linkedRefsCount > 0 ? `This ${node.is_page ? 'page' : 'block'} is linked in ${linkedRefsCount} other node${linkedRefsCount === 1 ? '' : 's'}.` : undefined}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
}

export default ArchivedNodeContextMenu;
