/**
 * Trash Node Context Menu
 * 
 * Context menu for nodes in the trash view with restore and permanent delete actions.
 */
import { useCallback, useState } from 'react';
import { nodeNameToDisplayText } from '@/features/queries';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import type { Node } from '@/types';
import { copyToClipboard } from '@/utils/clipboardManager';
import { useTrashMutations } from '@/features/content/hooks/useTrash';

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
  const [showPermanentDeleteModal, setShowPermanentDeleteModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const { restore, permanentDelete } = useTrashMutations();
  
  const handleRestoreClick = useCallback(() => {
    setShowRestoreModal(true);
  }, []);
  
  const handleConfirmRestore = useCallback(async () => {
    await restore.mutateAsync(node.uuid);
    setShowRestoreModal(false);
  }, [node.uuid, restore]);

  const handleCancelRestore = useCallback(() => {
    setShowRestoreModal(false);
    onClose();
  }, [onClose]);

  const handlePermanentDeleteClick = useCallback(() => {
    setShowPermanentDeleteModal(true);
  }, []);

  const handleConfirmPermanentDelete = useCallback(async () => {
    await permanentDelete.mutateAsync(node.uuid);
    setShowPermanentDeleteModal(false);
  }, [node.uuid, permanentDelete]);
  
  const handleCancelPermanentDelete = useCallback(() => {
    setShowPermanentDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const menuItems: ContextMenuItem[] = [
    {
      id: 'restore',
      label: 'Restore',
      icon: 'mdi-restore',
      keepOpen: true,
      onClick: handleRestoreClick,
    },
    {
      id: 'copy-uuid',
      label: 'Copy UUID',
      icon: 'mdi-identifier',
      onClick: () => {
        copyToClipboard(node.uuid);
        onClose();
      }
    },
    { id: 'sep-1', label: '', separator: true },
    {
      id: 'permanent-delete',
      label: 'Delete Permanently',
      icon: 'mdi-delete-forever-outline',
      danger: true,
      keepOpen: true,
      onClick: handlePermanentDeleteClick,
    },
  ];
  
  return (
    <>
      {!showPermanentDeleteModal && !showRestoreModal && (
        <ContextMenu
          items={menuItems}
          position={position}
          onClose={onClose}
        />
      )}
      <ConfirmationModal
        isOpen={showRestoreModal}
        title="Restore Node"
        message={`Restore "${nodeNameToDisplayText(node) || 'Untitled'}" from trash?`}
        confirmLabel="Restore"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={handleConfirmRestore}
        onCancel={handleCancelRestore}
      />
      <ConfirmationModal
        isOpen={showPermanentDeleteModal}
        title="Permanently Delete"
        message={`Are you sure you want to permanently delete "${nodeNameToDisplayText(node) || 'Untitled'}"? This cannot be undone!`}
        confirmLabel="Delete Permanently"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmPermanentDelete}
        onCancel={handleCancelPermanentDelete}
      />
    </>
  );
}

