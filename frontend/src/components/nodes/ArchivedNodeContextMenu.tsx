/**
 * Archived Node Context Menu
 * 
 * Context menu for archived nodes with unarchive and delete actions.
 */
import { useCallback, useState } from 'react';
import { useUnarchiveNode, useDeleteNode, useLinkedReferencesCount } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { useNavigationStore } from '@/stores';
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
  const [showUnarchiveModal, setShowUnarchiveModal] = useState(false);
  const unarchiveNode = useUnarchiveNode();
  const deleteNode = useDeleteNode();
  const { addSidebarCard, openLocalGraph } = useNavigationStore();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.id);
  
  const handleUnarchiveClick = useCallback(() => {
    setShowUnarchiveModal(true);
  }, []);
  
  const handleConfirmUnarchive = useCallback(() => {
    unarchiveNode.mutate(node.id);
    setShowUnarchiveModal(false);
    onClose();
  }, [node.id, unarchiveNode, onClose]);
  
  const handleCancelUnarchive = useCallback(() => {
    setShowUnarchiveModal(false);
    onClose();
  }, [onClose]);
  
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
      keepOpen: true,
      onClick: handleUnarchiveClick,
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
        const link = `[[${node.uuid}]]`;
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
      {!showDeleteModal && !showUnarchiveModal && (
        <ContextMenu
          items={menuItems}
          position={position}
          onClose={onClose}
        />
      )}
      <ConfirmationModal
        isOpen={showUnarchiveModal}
        title="Unarchive Page"
        message={`Unarchive "${nodeNameToText(node.name) || 'Untitled'}"? It will be restored to normal view.`}
        confirmLabel="Unarchive"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={handleConfirmUnarchive}
        onCancel={handleCancelUnarchive}
      />
      <ConfirmationModal
        isOpen={showDeleteModal}
        title={`Delete ${node.is_page ? 'page' : 'block'}`}
        message={`Are you sure you want to delete "${nodeNameToText(node.name) || 'Untitled'}"? It will be moved to trash.`}
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
