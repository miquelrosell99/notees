/**
 * ImageRenderer Component
 * 
 * Renders image assets with:
 * - Inline preview using ImageNode component
 * - Click to open lightbox
 * - Constrained to block width
 */
import { useState, useCallback } from 'react';
import { ImageNode } from '../../ImageNode';
import { Button } from '../../core/Button';
import { mdiDownload } from '@mdi/js';
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
  const [titleValue, setTitleValue] = useState(title);
  
  // Extract extension from title for download
  const extension = title ? title.split('.').pop() || 'jpg' : 'jpg';
  
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
    <div className="image-renderer">
      {/* Image preview using ImageNode */}
      <div className="image-renderer__container">
        <ImageNode
          assetNodeId={nodeId}
          alt={title || 'Image'}
          className="image-renderer__image-node"
          showCard={true}
          elevation="low"
          radius="md"
          clickable={true}
          showActions={true}
          actions={
            <Button
              icon={mdiDownload}
              iconOnly
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              title="Download image"
            />
          }
          actionsDirection="horizontal"
          showModalBullet={true}
        />
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
  );
}
