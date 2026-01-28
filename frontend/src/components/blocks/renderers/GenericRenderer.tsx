/**
 * GenericRenderer Component
 * 
 * Renders generic file assets with:
 * - File card with MIME-derived icon
 * - Click to open/download file
 * - File metadata
 * - Title below card
 */
import { useState, useCallback } from 'react';
import { getIconForMime, getMimeLabel } from '@/utils/mimeUtils';
import { Card } from '../../core/Card';
import { Button } from '../../core/Button';
import './GenericRenderer.css';

interface GenericRendererProps {
  /** Asset file URL */
  assetUrl: string;
  /** MIME type */
  mimeType: string;
  /** File extension */
  extension: string;
  /** Block title (editable block name) */
  title: string;
  /** Whether title is editable */
  editable?: boolean;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
}

export function GenericRenderer({
  assetUrl,
  mimeType,
  extension,
  title,
  editable = true,
  onTitleChange,
}: GenericRendererProps) {
  const [titleValue, setTitleValue] = useState(title);
  
  const icon = getIconForMime(mimeType);
  const label = getMimeLabel(mimeType);
  
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
  
  const handleOpen = useCallback(() => {
    // Open in new tab
    window.open(assetUrl, '_blank', 'noopener,noreferrer');
  }, [assetUrl]);
  
  const handleDownload = useCallback(() => {
    // Create temporary anchor to trigger download
    const link = document.createElement('a');
    link.href = assetUrl;
    link.download = `${title}.${extension}` || `file.${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [assetUrl, title, extension]);
  
  return (
    <div className="generic-renderer">
      {/* File card */}
      <Card
        className="generic-renderer__card"
        padding={true}
        radius="md"
        elevation="low"
      >
        <div className="generic-renderer__content">
          {/* Icon */}
          <div className="generic-renderer__icon">
            {icon}
          </div>
          
          {/* Info */}
          <div className="generic-renderer__info">
            <div className="generic-renderer__filename">
              {title || 'Untitled'}{extension ? `.${extension}` : ''}
            </div>
            <div className="generic-renderer__type">
              {label}
            </div>
          </div>
          
          {/* Actions */}
          <div className="generic-renderer__actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpen}
              title="Open file"
            >
              📂
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              title="Download"
            >
              ⬇️
            </Button>
          </div>
        </div>
      </Card>
      
      {/* Title */}
      <div className="generic-renderer__title">
        {editable ? (
          <input
            type="text"
            className="generic-renderer__title-input"
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Add title..."
          />
        ) : (
          <div className="generic-renderer__title-text">{title || 'Untitled'}</div>
        )}
      </div>
    </div>
  );
}
