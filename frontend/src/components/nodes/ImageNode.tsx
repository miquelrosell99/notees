/**
 * ImageNode Component
 * 
 * A reusable component for displaying image assets within Card containers.
 * Used for banner images, cover images, and asset blocks to provide consistent
 * image rendering with loading states, click-to-view, and action buttons.
 * 
 * The component adapts to its parent container size using CSS containment,
 * and supports various display modes and interactions.
 */
import { useState, useEffect, useCallback } from 'react';
import { useNode } from '@/hooks';
import { useNavigationStore } from '@/stores';
import { getAssetUrlAsync } from '@/api/assets';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { ImageModal } from '../core/ImageModal';
import { FloatingButtonArray } from '../core/FloatingButtonArray';
import { mdiPencil, mdiClose } from '@mdi/js';
import './ImageNode.css';

interface ImageNodeProps {
  /** Asset node ID */
  assetNodeId: number | null;
  /** Alt text for the image */
  alt?: string;
  /** CSS class for customization */
  className?: string;
  /** Whether to show card wrapper (default: true) */
  showCard?: boolean;
  /** Card elevation level */
  elevation?: 'none' | 'low' | 'medium' | 'high';
  /** Card border radius */
  radius?: 'none' | 'sm' | 'md' | 'lg';
  /** Whether the image is clickable to open modal (default: true) */
  clickable?: boolean;
  /** Whether to show action buttons on hover */
  showActions?: boolean;
  /** Custom action buttons to show (overrides onEdit/onRemove) */
  actions?: React.ReactNode;
  /** Direction for action buttons */
  actionsDirection?: 'horizontal' | 'vertical';
  /** Callback when edit button is clicked (shows default edit button) */
  onEdit?: () => void;
  /** Callback when remove button is clicked (shows default remove button) */
  onRemove?: () => void;
  /** Callback when image is clicked */
  onClick?: () => void;
  /** Whether drag events are happening (disables pointer events) */
  isDragging?: boolean;
  /** Loading placeholder component */
  loadingPlaceholder?: React.ReactNode;
  /** Whether to show bullet in modal */
  showModalBullet?: boolean;
}

export function ImageNode({
  assetNodeId,
  alt = 'Image',
  className = '',
  showCard = true,
  elevation = 'low',
  radius = 'md',
  clickable = true,
  showActions = false,
  actions,
  actionsDirection = 'horizontal',
  onEdit,
  onRemove,
  onClick,
  isDragging = false,
  loadingPlaceholder,
  showModalBullet = true,
}: ImageNodeProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const { data: assetNode, isLoading } = useNode(assetNodeId, { include_children: false });
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);

  // Get the image URL from the asset node's uuid (async with token)
  useEffect(() => {
    if (!assetNodeId || !assetNode?.uuid) {
      setImageUrl(null);
      return;
    }

    let cancelled = false;

    getAssetUrlAsync(assetNode.uuid)
      .then(url => {
        if (!cancelled) {
          setImageUrl(url);
        }
      })
      .catch(err => {
        console.error('Failed to load image URL:', err);
        if (!cancelled) {
          setImageUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [assetNodeId, assetNode?.uuid]);

  // Bullet handlers for modal
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (assetNode) {
      openNode(assetNode.id);
    }
  }, [assetNode, openNode]);

  const handleBulletShiftClick = useCallback(() => {
    if (assetNode) {
      addSidebarCard(assetNode.id, assetNode.is_page ? 'page' : 'block');
    }
  }, [assetNode, addSidebarCard]);

  const handleImageClick = useCallback(() => {
    if (clickable) {
      setIsModalOpen(true);
    }
    onClick?.();
  }, [clickable, onClick]);

  // Loading state
  if (assetNodeId && isLoading) {
    return loadingPlaceholder || (
      <div className={`image-node image-node--loading ${className}`}>
        {showCard ? (
          <Card padding={false} radius={radius} elevation={elevation}>
            <div className="image-node__placeholder" />
          </Card>
        ) : (
          <div className="image-node__placeholder" />
        )}
      </div>
    );
  }

  // No image
  if (!assetNodeId || !imageUrl) {
    return null;
  }

  // Render image content
  const imageContent = (
    <img
      key={imageUrl}
      src={imageUrl}
      alt={alt}
      className="image-node__img"
      onClick={handleImageClick}
      style={{
        cursor: clickable ? 'pointer' : 'default',
        pointerEvents: isDragging ? 'none' : 'auto'
      }}
      title={clickable ? 'Click to view full size' : undefined}
      draggable="false"
    />
  );

  // Render default action buttons if onEdit/onRemove provided
  const defaultActions = (onEdit || onRemove) ? (
    <>
      {onEdit && (
        <Button
          icon={mdiPencil}
          iconOnly
          variant="ghost"
          size="sm"
          onClick={onEdit}
          title="Change image"
        />
      )}
      {onRemove && (
        <Button
          icon={mdiClose}
          iconOnly
          variant="ghost"
          size="sm"
          onClick={onRemove}
          title="Remove image"
        />
      )}
    </>
  ) : null;

  const actionButtons = actions || defaultActions;

  return (
    <>
      <div className={`image-node ${className}`}>
        {/* Action buttons */}
        {showActions && actionButtons && (
          <FloatingButtonArray
            className="image-node__actions"
            direction={actionsDirection}
            size="sm"
          >
            {actionButtons}
          </FloatingButtonArray>
        )}

        {/* Image with optional card wrapper */}
        {showCard ? (
          <Card padding={false} radius={radius} elevation={elevation}>
            {imageContent}
          </Card>
        ) : (
          imageContent
        )}
      </div>

      {/* Modal for full-size view */}
      {clickable && (
        <ImageModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          src={imageUrl}
          alt={alt}
          assetNode={showModalBullet ? assetNode : undefined}
          onBulletClick={showModalBullet ? handleBulletClick : undefined}
          onBulletShiftClick={showModalBullet ? handleBulletShiftClick : undefined}
        />
      )}
    </>
  );
}

export default ImageNode;