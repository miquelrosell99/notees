/**
 * ImageModal Component
 * 
 * Modal for displaying full-size images.
 * - Shows image with aspect ratio preserved
 * - Close button in top right
 * - Max size with good proportions
 * - Click outside or Escape to close
 */
import { useEffect, useCallback } from 'react';
import { mdiClose } from '@mdi/js';
import { Button } from './Button';
import './ImageModal.css';

export interface ImageModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Image source URL */
  src: string;
  /** Image alt text */
  alt?: string;
}

/**
 * Modal component for displaying full-size images.
 */
export function ImageModal({
  isOpen,
  onClose,
  src,
  alt = 'Image',
}: ImageModalProps) {
  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div className="image-modal-backdrop" onClick={handleBackdropClick}>
      <div className="image-modal-container">
        <Button
          icon={mdiClose}
          iconOnly
          className="image-modal-close"
          onClick={onClose}
          size="md"
          variant="ghost"
          title="Close (Esc)"
        />
        <img
          src={src}
          alt={alt}
          className="image-modal-image"
        />
      </div>
    </div>
  );
}

export default ImageModal;
