/**
 * ConfirmationModal Component
 * 
 * A reusable confirmation dialog for important actions.
 * Uses the base Modal component for consistent styling.
 */
import { Modal } from './Modal';
import { AlertIcon } from '../icons';
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
  onConfirm: () => void;
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
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="sm"
      showCloseButton={false}
      className="confirmation-modal"
    >
      <div className="confirmation-modal__header">
        <div className="confirmation-modal__icon">
          <AlertIcon />
        </div>
        <h3 className="confirmation-modal__title">{title}</h3>
      </div>
      
      <p className="confirmation-modal__message">{message}</p>
      {secondaryMessage && (
        <p className="confirmation-modal__secondary-message">{secondaryMessage}</p>
      )}
      
      <div className="confirmation-modal__actions">
        <Button
          variant="default"
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant={variant === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export default ConfirmationModal;
