/**
 * BlockAsset Component
 * 
 * Displays a non-image asset node as a block with:
 * - File icon and asset info
 * - Title section (editable block name)
 * - Download/replace buttons
 */
import { useState, useCallback } from 'react';
import { getAssetUrl } from '@/api/assets';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import './BlockAsset.css';

export interface BlockAssetProps {
  /** The asset node ID */
  nodeId: number;
  /** Asset node UUID */
  nodeUuid: string;
  /** Block name/title */
  title: string;
  /** File extension (if known) */
  fileExtension?: string;
  /** Whether editable */
  editable?: boolean;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
  /** Callback when asset is replaced */
  onAssetReplace?: () => void;
}

export function BlockAsset({
  nodeUuid,
  title,
  fileExtension,
  editable = true,
  onTitleChange,
  onAssetReplace,
}: BlockAssetProps) {
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  
  const assetUrl = getAssetUrl(nodeUuid);
  
  const handleDownload = useCallback(() => {
    // Create temporary anchor to trigger download
    const link = document.createElement('a');
    link.href = assetUrl;
    link.download = title || 'asset';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [assetUrl, title]);
  
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
  
  const handleUpload = useCallback((asset: any) => {
    // TODO: Replace asset file
    console.log('Replace asset with:', asset);
    setIsUploadOpen(false);
    onAssetReplace?.();
  }, [onAssetReplace]);
  
  return (
    <>
      <Card
        className="block-asset"
        padding={true}
        radius="md"
        elevation="low"
      >
        {/* Asset info */}
        <div className="block-asset__content">
          <div className="block-asset__icon">
            📄
          </div>
          
          <div className="block-asset__info">
            <div className="block-asset__filename">
              {title || 'Untitled'}{fileExtension ? `.${fileExtension}` : ''}
            </div>
            {fileExtension && (
              <div className="block-asset__type">
                {fileExtension.toUpperCase()} File
              </div>
            )}
          </div>
          
          {/* Actions */}
          <div className="block-asset__actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              title="Download"
            >
              ⬇️
            </Button>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsUploadOpen(true)}
                title="Replace"
              >
                🔄
              </Button>
            )}
          </div>
        </div>
        
        {/* Title section */}
        <div className="block-asset__title">
          {editable ? (
            <input
              type="text"
              className="block-asset__title-input"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Add title..."
            />
          ) : (
            <div className="block-asset__title-text">{title || 'Untitled'}</div>
          )}
        </div>
      </Card>
      
      {/* Upload modal for replacement */}
      {editable && (
        <AssetUploadModal
          isOpen={isUploadOpen}
          onClose={() => setIsUploadOpen(false)}
          onUpload={handleUpload}
        />
      )}
    </>
  );
}

export default BlockAsset;
