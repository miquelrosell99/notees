/**
 * Trash Node Context Menu
 * 
 * Context menu for nodes in the trash view with restore and permanent delete actions.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restoreNode, permanentlyDeleteNode } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import type { Node } from '@/types';
import { copyToClipboard } from '@/utils/clipboardManager';
import { nodeKeys, trashKeys } from '@/hooks/queryKeys';

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
    onMutate: () => {
      // Close menu immediately; invalidate caches optimistically so the UI
      // updates even if this component unmounts before onSuccess fires.
      onClose();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trashKeys.all });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
    },
  });

  // Permanent delete mutation
  const permanentDeleteMutation = useMutation({
    mutationFn: permanentlyDeleteNode,
    onMutate: () => {
      onClose();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trashKeys.all });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPropertyBacklinks(), refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks(), refetchType: 'active' });
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

