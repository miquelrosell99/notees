/**
 * Trash Node Context Menu
 * 
 * Context menu for nodes in the trash view with restore and permanent delete actions.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restoreNode, permanentDeleteNode } from '@/api/nodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { nodeKeys } from '@/hooks/useNodes';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ConfirmationModal } from '../core/ConfirmationModal';
import type { Node } from '@/types';
import './NodeContextMenu.css';

interface TrashNodeContextMenuProps {
  /** The node to show context menu for */
  node: Node;
  /** Position for the menu */
  position: { x: number; y: number };
  /** Callback to close the menu */
  onClose: () => void;
}

/**
 * Context menu for deleted nodes in trash view
 */
export function TrashNodeContextMenu({ node, position, onClose }: TrashNodeContextMenuProps) {
  const queryClient = useQueryClient();
  const [showPermanentDeleteModal, setShowPermanentDeleteModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  
  // Restore mutation
  const restoreMutation = useMutation({
    mutationFn: restoreNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      onClose();
    },
  });
  
  // Permanent delete mutation
  const permanentDeleteMutation = useMutation({
    mutationFn: permanentDeleteNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      onClose();
    },
  });
  
  const handleRestoreClick = useCallback(() => {
    setShowRestoreModal(true);
  }, []);
  
  const handleConfirmRestore = useCallback(() => {
    restoreMutation.mutate(node.id);
    setShowRestoreModal(false);
  }, [node.id, restoreMutation]);
  
  const handleCancelRestore = useCallback(() => {
    setShowRestoreModal(false);
    onClose();
  }, [onClose]);
  
  const handlePermanentDeleteClick = useCallback(() => {
    setShowPermanentDeleteModal(true);
  }, []);
  
  const handleConfirmPermanentDelete = useCallback(() => {
    permanentDeleteMutation.mutate(node.id);
    setShowPermanentDeleteModal(false);
  }, [node.id, permanentDeleteMutation]);
  
  const handleCancelPermanentDelete = useCallback(() => {
    setShowPermanentDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const menuItems: ContextMenuItem[] = [
    {
      id: 'restore',
      label: 'Restore',
      keepOpen: true,
      onClick: handleRestoreClick,
    },
    {
      id: 'copy-uuid',
      label: 'Copy UUID',
      onClick: () => {
        navigator.clipboard.writeText(node.uuid);
        onClose();
      }
    },
    { id: 'sep-1', label: '', separator: true },
    {
      id: 'permanent-delete',
      label: 'Delete Permanently',
      danger: true,
      keepOpen: true,
      onClick: handlePermanentDeleteClick,
    },
  ];
  
  return (
    <>
      {!showPermanentDeleteModal && !showRestoreModal && (
        <div className="node-context-menu-wrapper" style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 1000 }}>
          <ContextMenu
            items={menuItems}
            position={{ x: 0, y: 0 }}
            onClose={onClose}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={showRestoreModal}
        title="Restore Node"
        message={`Restore "${nodeNameToText(node.name) || 'Untitled'}" from trash?`}
        confirmLabel="Restore"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={handleConfirmRestore}
        onCancel={handleCancelRestore}
      />
      <ConfirmationModal
        isOpen={showPermanentDeleteModal}
        title="Permanently Delete"
        message={`Are you sure you want to permanently delete "${nodeNameToText(node.name) || 'Untitled'}"? This cannot be undone!`}
        confirmLabel="Delete Permanently"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmPermanentDelete}
        onCancel={handleCancelPermanentDelete}
      />
    </>
  );
}

export default TrashNodeContextMenu;
