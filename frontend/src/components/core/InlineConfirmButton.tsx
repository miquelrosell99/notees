/**
 * InlineConfirmButton Component
 * 
 * A button that requires inline confirmation before executing an action.
 * Shows confirm (check) and cancel (close) buttons when clicked.
 * Used for destructive actions like delete without opening a modal.
 */
import { useState, useCallback, useEffect } from 'react';
import { Button } from './Button';
import { CheckIcon, CloseIcon } from '../icons';
import './InlineConfirmButton.css';

interface InlineConfirmButtonProps {
  /** Called when action is confirmed */
  onConfirm: () => void | Promise<void>;
  /** The trigger button content (icon/text) */
  children: React.ReactNode;
  /** Button variant for the trigger */
  variant?: 'ghost' | 'default' | 'primary' | 'danger';
  /** Button size */
  size?: 'sm' | 'md';
  /** Title tooltip for trigger button */
  title?: string;
  /** Title tooltip for confirm button */
  confirmTitle?: string;
  /** Title tooltip for cancel button */
  cancelTitle?: string;
  /** Additional CSS class */
  className?: string;
  /** Whether the button is disabled */
  disabled?: boolean;
}

export function InlineConfirmButton({
  onConfirm,
  children,
  variant = 'ghost',
  size = 'sm',
  title,
  confirmTitle = 'Confirm',
  cancelTitle = 'Cancel',
  className = '',
  disabled = false,
}: InlineConfirmButtonProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  // Reset confirming state when disabled changes
  useEffect(() => {
    if (disabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset UI state when disabled prop changes
      setIsConfirming(false);
    }
  }, [disabled]);

  const handleTriggerClick = useCallback(() => {
    setIsConfirming(true);
  }, []);

  const handleConfirm = useCallback(async () => {
    await onConfirm();
    setIsConfirming(false);
  }, [onConfirm]);

  const handleCancel = useCallback(() => {
    setIsConfirming(false);
  }, []);

  if (isConfirming) {
    return (
      <div className={`inline-confirm-button inline-confirm-button--confirming ${className}`}>
        <Button
          variant="danger"
          size={size}
          onClick={handleConfirm}
          title={confirmTitle}
        >
          <CheckIcon size={size} />
        </Button>
        <Button
          variant="ghost"
          size={size}
          onClick={handleCancel}
          title={cancelTitle}
        >
          <CloseIcon size={size} />
        </Button>
      </div>
    );
  }

  return (
    <div className={`inline-confirm-button ${className}`}>
      <Button
        variant={variant}
        size={size}
        onClick={handleTriggerClick}
        title={title}
        disabled={disabled}
      >
        {children}
      </Button>
    </div>
  );
}
