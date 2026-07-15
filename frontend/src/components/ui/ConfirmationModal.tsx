/**
 * ConfirmationModal Component
 *
 * A reusable confirmation dialog for important actions.
 * Uses the base Modal component for consistent styling.
 */
import { useEffect, useCallback, useState } from 'react';
import { Modal } from './Modal';
import { AlertIcon } from './icons';
import { Button } from './Button';
import './ConfirmationModal.css';

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  secondaryMessage?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmationModal({
  isOpen,
  title,
  message,
  secondaryMessage,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  onConfirm,
  onCancel,
}: ConfirmationModalProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset internal state whenever the modal opens/closes.
  useEffect(() => {
    if (isOpen) {
      setIsPending(false);
      setError(null);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(async () => {
    if (isPending) return;
    setError(null);
    setIsPending(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setIsPending(false);
    }
  }, [isPending, onConfirm]);

  // Enter on the dialog body = confirm (capture phase to beat button activation).
  // Interactive elements handle Enter themselves — Enter on the focused Cancel
  // button must cancel, never trigger the (possibly destructive) shortcut.
  useEffect(() => {
    if (!isOpen || isPending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (!target.closest('.confirmation-modal')) return;
      if (target.closest('button, input, select, textarea, a, [contenteditable]')) return;
      e.preventDefault();
      e.stopPropagation();
      handleConfirm();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen, isPending, handleConfirm]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="sm"
      showCloseButton={false}
      className={`confirmation-modal confirmation-modal--${variant}`}
    >
      <div className="confirmation-modal__header">
        <div className="confirmation-modal__icon">
          <AlertIcon />
        </div>
        <h3 id="modal-title" className="confirmation-modal__title">{title}</h3>
      </div>

      <p className="confirmation-modal__message">{message}</p>
      {secondaryMessage && (
        <p className="confirmation-modal__secondary-message">{secondaryMessage}</p>
      )}

      {error && (
        <p className="confirmation-modal__error" role="alert">
          {error}
        </p>
      )}

      <div className="confirmation-modal__actions">
        <Button
          variant="default"
          onClick={onCancel}
          disabled={isPending}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={variant === 'danger' ? 'danger-solid' : 'primary'}
          onClick={handleConfirm}
          loading={isPending}
          hapticIntensity={variant === 'danger' ? 'medium' : 'light'}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

