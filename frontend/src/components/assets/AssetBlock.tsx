/**
 * AssetBlock component.
 * 
 * Renders an asset (image, audio, file) within a block context.
 * Supports selection, deletion, and replacement.
 */
import { useState, useCallback } from 'react';
import { AssetPreview } from './AssetPreview';
import { deleteAsset, type AssetCategory } from '@/api/assets';
import { getLogger } from '@/utils/logger';
import './AssetBlock.css';

const log = getLogger('asset-block');

interface AssetBlockProps {
  /** Asset UUID */
  uuid: string;
  /** Asset category */
  category: AssetCategory;
  /** Content type (MIME type) */
  contentType?: string;
  /** Original filename */
  filename?: string;
  /** Optional caption */
  caption?: string;
  /** Width for resizable assets (images) */
  width?: number;
  /** Height for resizable assets (images) */
  height?: number;
  /** Whether the block is selected */
  selected?: boolean;
  /** Whether the asset is editable (shows controls) */
  editable?: boolean;
  /** Callback when asset is clicked */
  onClick?: () => void;
  /** Callback when asset is deleted */
  onDelete?: () => void;
  /** Callback when caption is changed */
  onCaptionChange?: (caption: string) => void;
  /** Callback when asset is resized */
  onResize?: (width: number, height: number) => void;
  /** Callback to replace the asset */
  onReplace?: () => void;
}

export function AssetBlock({
  uuid,
  category,
  contentType,
  filename,
  caption,
  width,
  height,
  selected = false,
  editable = true,
  onClick,
  onDelete,
  onCaptionChange,
  onResize,
  onReplace,
}: AssetBlockProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [captionValue, setCaptionValue] = useState(caption || '');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (isDeleting) return;
    
    try {
      setIsDeleting(true);
      log.info(`Deleting asset: ${uuid}`);
      await deleteAsset(uuid);
      onDelete?.();
    } catch (error) {
      log.error('Failed to delete asset:', error);
    } finally {
      setIsDeleting(false);
    }
  }, [uuid, onDelete, isDeleting]);

  const handleCaptionBlur = () => {
    if (captionValue !== caption) {
      onCaptionChange?.(captionValue);
    }
  };

  const showControls = editable && (isHovered || selected);

  return (
    <div
      className={`asset-block ${selected ? 'selected' : ''} asset-block-${category}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      <div className="asset-block-content">
        <AssetPreview
          asset={uuid}
          category={category}
          contentType={contentType}
          alt={caption || filename}
          resizable={editable && category === 'image'}
          width={width}
          height={height}
          onResize={onResize}
          selected={selected}
        />
        
        {showControls && (
          <div className="asset-block-controls">
            {onReplace && (
              <button
                className="asset-control-btn"
                onClick={(e) => { e.stopPropagation(); onReplace(); }}
                title="Replace"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                </svg>
              </button>
            )}
            <button
              className="asset-control-btn asset-control-delete"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              disabled={isDeleting}
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
            </button>
          </div>
        )}
      </div>
      
      {editable && (
        <input
          type="text"
          className="asset-block-caption"
          placeholder="Add a caption..."
          value={captionValue}
          onChange={(e) => setCaptionValue(e.target.value)}
          onBlur={handleCaptionBlur}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      
      {!editable && caption && (
        <div className="asset-block-caption-text">{caption}</div>
      )}
    </div>
  );
}

export default AssetBlock;
