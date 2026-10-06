/**
 * ImageModal Component
 *
 * Fullscreen modal for displaying images.
 * - Fullscreen overlay with image centered
 * - Download + fullscreen + close buttons top right (the original button set)
 * - Optional bullet in top left corner for navigation
 * - Click outside or Escape to close
 * - Rendered using React portal to escape parent constraints
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useOverlaySurface } from './overlay-hooks.js';
import { Button } from './Button.js';
import './ImageModal.css';

export interface ImageModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Image source URL */
  src: string;
  /** Image alt text */
  alt?: string | undefined;
  /** Optional filename for download */
  filename?: string | undefined;
  /** Optional bullet element rendered in the top-left corner. */
  bullet?: ReactNode | undefined;
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
  /** The fullscreen toggle mirrors the document state (Esc exits fullscreen
   *  too, so the button label must follow the fullscreenchange event). */
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onChange = (): void => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [isOpen]);

  const fullscreenAvailable =
    typeof document !== 'undefined' &&
    typeof document.fullscreenEnabled === 'boolean';

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === null) {
      backdropRef.current?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Register with the local overlay stack so Escape closes this modal
  // regardless of where DOM focus is.
  useOverlaySurface({
    type: 'modal',
    enabled: isOpen,
    onClose,
  });

  // Trap focus inside the modal while it is open and return focus on close.
  // Escape handling is owned by the overlay stack.
  useFocusTrap(backdropRef, {
    enabled: isOpen,
    onEscape: undefined,
    restoreFocus: true,
  });

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
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
    // Backdrop closes on click; an explicit close button is provided.
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
        {fullscreenAvailable && (
          <Button aria-label="Toggle fullscreen"
            icon={isFullscreen ? "mdi mdi-fullscreen-exit" : "mdi mdi-fullscreen"}
            className="image-modal-fullscreen"
            onClick={toggleFullscreen}
            size="md"
            variant="ghost"
            title="Toggle fullscreen"
          />
        )}
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
