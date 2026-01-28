/**
 * ImageRenderer Component
 * 
 * Renders image assets with:
 * - Inline preview (thumbnail if available, else original)
 * - Click to open lightbox
 * - Constrained to block width
 */
import { useState, useCallback } from 'react';
import { ImageModal } from '../../core/ImageModal';
import { Button } from '../../core/Button';
import { useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import './ImageRenderer.css';

interface ImageRendererProps {
  /** Asset node ID (for navigation) */
  nodeId: number;
  /** Asset file URL */
  assetUrl: string;
  /** Thumbnail URL (optional) */
  thumbnailUrl?: string | null;
  /** Block title (editable block name) */
  title: string;
  /** Whether title is editable */
  editable?: boolean;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
}

export function ImageRenderer({
  nodeId,
  assetUrl,
  thumbnailUrl,
  title,
  editable = true,
  onTitleChange,
}: ImageRendererProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  const [useThumbnail, setUseThumbnail] = useState(true);
  const [thumbnailError, setThumbnailError] = useState(false);
  
  const { openNode, addSidebarCard } = useNodesStore();
  const { data: assetNode } = useNode(nodeId, { include_children: false });
  
  // Determine which URL to use for display
  // Use thumbnail if available and no error, else use original
  const displayUrl = (thumbnailUrl && useThumbnail && !thumbnailError) 
    ? thumbnailUrl 
    : assetUrl;
  
  // Extract extension from title for download
  const extension = title ? title.split('.').pop() || 'jpg' : 'jpg';
  
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openNode(nodeId, 'block');
  }, [nodeId, openNode]);
  
  const handleBulletShiftClick = useCallback(() => {
    addSidebarCard(nodeId, 'block');
  }, [nodeId, addSidebarCard]);
  
  const handleTitleBlur = useCallback(() => {
    if (titleValue !== title && onTitleChange) {
      onTitleChange(titleValue);
    }
  }, [titleValue, title, onTitleChange]);
  
  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);
  
  const handleDownload = useCallback(() => {
    // Create temporary anchor to trigger download
    const link = document.createElement('a');
    link.href = assetUrl;
    link.download = `${title}.${extension}` || `image.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [assetUrl, title, extension]);
  
  return (
    <>
      <div className="image-renderer">
        {/* Image preview */}
        <div className="image-renderer__container">
          <div 
            className="image-renderer__preview"
            onClick={() => setIsModalOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsModalOpen(true);
              }
            }}
          >
            <img
              src={displayUrl}
              alt={title || 'Image'}
              className="image-renderer__img"
              draggable={false}
              onError={() => {
                // If thumbnail fails, fall back to original
                if (useThumbnail && thumbnailUrl) {
                  setThumbnailError(true);
                  setUseThumbnail(false);
                }
              }}
            />
          </div>
          
          {/* Download button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownload}
            className="image-renderer__download"
            title="Download image"
          >
            ⬇️
          </Button>
        </div>
        
        {/* Title */}
        <div className="image-renderer__title">
          {editable ? (
            <input
              type="text"
              className="image-renderer__title-input"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Add title..."
            />
          ) : (
            <div className="image-renderer__title-text">{title || 'Untitled'}</div>
          )}
        </div>
      </div>
      
      {/* Fullscreen modal */}
      <ImageModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        src={assetUrl}
        alt={title || 'Image'}
        filename={title || 'image'}
        assetNode={assetNode}
        onBulletClick={handleBulletClick}
        onBulletShiftClick={handleBulletShiftClick}
      />
    </>
  );
}
