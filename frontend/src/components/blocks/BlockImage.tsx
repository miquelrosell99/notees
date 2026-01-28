/**
 * BlockImage Component
 * 
 * Displays an image asset node as a block with:
 * - Image preview with click-to-expand
 * - Title section (editable block name)
 * - Edit/remove buttons (like Banner/Cover)
 * - Fullscreen modal on click
 */
import { useState, useCallback } from 'react';
import { useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getAssetUrl } from '@/api/assets';
import { Card } from '../core/Card';
import { ImageModal } from '../core/ImageModal';
import { AssetActions } from '../assets/AssetActions';
import { AssetUploadModal } from '../assets/AssetUploadModal';
import './BlockImage.css';

export interface BlockImageProps {
  /** The asset node ID */
  nodeId: number;
  /** Asset node UUID */
  nodeUuid: string;
  /** Block name/title */
  title: string;
  /** Whether editable */
  editable?: boolean;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
  /** Callback when asset is replaced */
  onAssetReplace?: () => void;
}

export function BlockImage({
  nodeId,
  nodeUuid,
  title,
  editable = true,
  onTitleChange,
  onAssetReplace,
}: BlockImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [titleValue, setTitleValue] = useState(title);
  
  const { openNode, addSidebarCard } = useNodesStore();
  const { data: assetNode } = useNode(nodeId, { include_children: false });
  
  const imageUrl = getAssetUrl(nodeUuid);
  
  // Bullet handlers for modal
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
  
  const handleRemove = useCallback(() => {
    // TODO: Implement asset removal
    console.log('Remove asset:', nodeId);
  }, [nodeId]);
  
  const handleUpload = useCallback((asset: any) => {
    // TODO: Replace asset file
    console.log('Replace asset with:', asset);
    setIsUploadOpen(false);
    onAssetReplace?.();
  }, [onAssetReplace]);
  
  return (
    <>
      <Card
        className="block-image"
        padding={false}
        radius="md"
        elevation="low"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Image */}
        <div className="block-image__content">
          <img
            src={imageUrl}
            alt={title || 'Image'}
            className="block-image__img"
            onClick={() => setIsModalOpen(true)}
            style={{ cursor: 'pointer' }}
            title="Click to view full size"
          />
          
          {/* Action buttons */}
          {editable && (
            <AssetActions
              onEdit={() => setIsUploadOpen(true)}
              onRemove={handleRemove}
              visible={isHovered}
              position="bottom-right"
              compact
            />
          )}
        </div>
        
        {/* Title section */}
        <div className="block-image__title">
          {editable ? (
            <input
              type="text"
              className="block-image__title-input"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Add title..."
            />
          ) : (
            <div className="block-image__title-text">{title || 'Untitled'}</div>
          )}
        </div>
      </Card>
      
      {/* Fullscreen modal */}
      <ImageModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        src={imageUrl}
        alt={title || 'Image'}
        assetNode={assetNode}
        onBulletClick={handleBulletClick}
        onBulletShiftClick={handleBulletShiftClick}
      />
      
      {/* Upload modal for replacement */}
      {editable && (
        <AssetUploadModal
          isOpen={isUploadOpen}
          onClose={() => setIsUploadOpen(false)}
          onUpload={handleUpload}
          acceptedTypes={['image']}
        />
      )}
    </>
  );
}

export default BlockImage;
