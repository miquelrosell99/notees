/**
 * ImageModal Component
 * 
 * Fullscreen modal for displaying images.
 * - Fullscreen overlay with image centered
 * - Close button in top right corner of screen
 * - Optional bullet in top left corner for navigation
 * - Click outside or Escape to close
 * - Rendered using React portal to escape parent constraints
 */
import { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
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
  /** Optional filename for download */
  filename?: string;
  /** Optional bullet element rendered in the top-left corner. */
  bullet?: React.ReactNode;
}

/**
 * Modal component for displaying fullscreen images.
 */
export function ImageModal({
  isOpen,
  onClose,
  src,
  filename,
  alt = filename || '',
  bullet,
}: ImageModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  // Register with the global overlay stack so Escape closes this modal
  // regardless of where DOM focus is.
  useOverlaySurface({
    type: 'modal',
    enabled: isOpen,
    onClose,
  });

  // Trap focus inside the modal while it is open and return focus on close.
  // Escape handling is owned by the global overlay stack.
  useFocusTrap(backdropRef, {
    enabled: isOpen,
    onEscape: undefined,
    restoreFocus: true,
  });

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Handle download
  const handleDownload = useCallback(() => {
    const link = document.createElement('a');
    link.href = src;
    link.download = filename || 'image';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [src, filename]);

  if (!isOpen) return null;

  const modalContent = (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided
    <div
      ref={backdropRef}
      className="image-modal-backdrop"
      onClick={handleBackdropClick}
    >
      {/* Action buttons - top right corner of screen */}
      <div className="image-modal-actions">
        <Button aria-label="Download image"
          icon={"mdi mdi-download"}
          className="image-modal-download"
          onClick={handleDownload}
          size="md"
          variant="ghost"
          title="Download image"
        />
        <Button aria-label="Close (Esc)"
          icon={"mdi mdi-close"}
          className="image-modal-close"
          onClick={onClose}
          size="md"
          variant="ghost"
          title="Close (Esc)"
        />
      </div>
      
      {/* Bullet - top left corner of screen */}
      {bullet && <div className="image-modal-bullet">{bullet}</div>}
      
      {/* Image - centered, fullscreen */}
      <img
        src={src}
        alt={alt}
        className="image-modal-image"
      />
    </div>
  );

  // Render in a portal to escape any parent constraints
  return createPortal(modalContent, document.body);
}

