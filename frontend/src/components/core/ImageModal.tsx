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
import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { mdiClose, mdiDownload } from '@mdi/js';
import { Button } from './Button';
import { Bullet } from '../blocks/Bullet';
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
  /** Optional asset node for bullet navigation */
  assetNode?: {
    id: number;
    icon: string | null;
    is_page: boolean;
  } | null;
  /** Callback when bullet is clicked */
  onBulletClick?: (e: React.MouseEvent) => void;
  /** Callback when bullet is shift-clicked */
  onBulletShiftClick?: () => void;
  /** Callback for bullet context menu */
  onBulletContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
}

/**
 * Modal component for displaying fullscreen images.
 */
export function ImageModal({
  isOpen,
  onClose,
  src,
  alt = 'Image',
  filename,
  assetNode,
  onBulletClick,
  onBulletShiftClick,
  onBulletContextMenu,
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
    <div className="image-modal-backdrop" onClick={handleBackdropClick}>
      {/* Action buttons - top right corner of screen */}
      <div className="image-modal-actions">
        <Button
          icon={mdiDownload}
          iconOnly
          className="image-modal-download"
          onClick={handleDownload}
          size="md"
          variant="ghost"
          title="Download image"
        />
        <Button
          icon={mdiClose}
          iconOnly
          className="image-modal-close"
          onClick={onClose}
          size="md"
          variant="ghost"
          title="Close (Esc)"
        />
      </div>
      
      {/* Bullet - top left corner of screen */}
      {assetNode && (
        <div className="image-modal-bullet">
          <Bullet
            nodeId={assetNode.id}
            icon={assetNode.icon}
            isPage={assetNode.is_page}
            interactive={true}
            onClick={onBulletClick}
            onShiftClick={onBulletShiftClick}
            onContextMenu={onBulletContextMenu}
            size="md"
            title="Click to open, Shift+click for sidebar"
          />
        </div>
      )}
      
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

export default ImageModal;
