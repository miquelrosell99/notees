/**
 * DeletionConfirmationModal Component
 * 
 * A specialized confirmation modal for node deletion with clear warning messaging.
 */
import { ConfirmationModal } from './core/ConfirmationModal';
import type { Node } from '@/types';

interface DeletionConfirmationModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The node to be deleted */
  node: Node | null;
  /** Callback when deletion is confirmed */
  onConfirm: () => void;
  /** Callback when deletion is cancelled */
  onCancel: () => void;
}

export function DeletionConfirmationModal({
  isOpen,
  node,
  onConfirm,
  onCancel,
}: DeletionConfirmationModalProps) {
  if (!node) return null;

  const nodeName = node.name || 'Untitled';
  const nodeType = node.is_page ? 'page' : 'block';

  return (
    <ConfirmationModal
      isOpen={isOpen}
      title={`Delete ${nodeType}`}
      message={`Are you sure you want to delete "${nodeName}"? This action cannot be undone.`}
      confirmLabel="Delete permanently"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
