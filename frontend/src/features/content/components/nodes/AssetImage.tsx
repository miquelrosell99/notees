/**
 * AssetImage Component
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
import { Card, type CardVariant } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ImageModal } from '@/components/ui/ImageModal';
import { FloatingButtonArray } from '@/components/ui/FloatingButtonArray';
import { Bullet } from '@/features/content/components/blocks/Bullet';
import './AssetImage.css';

interface AssetImageProps {
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
  /** Card visual variant */
  variant?: CardVariant;
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
  /** Placeholder rendered when no image is set */
  emptyPlaceholder?: React.ReactNode;
  /** Whether to show bullet in modal */
  showModalBullet?: boolean;
}

export function AssetImage({
  assetNodeId,
  alt = 'Image',
  className = '',
  showCard = true,
  elevation = 'low',
  variant = 'default',
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
  emptyPlaceholder,
  showModalBullet = true,
}: AssetImageProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const { data: assetNode, isLoading } = useNode(assetNodeId, { include_children: false });
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);

  // Get the image URL from the asset node's uuid (async with token)
  useEffect(() => {
    if (!assetNodeId || !assetNode?.uuid) {
      setImageUrl(null);
      setHasError(false);
      return;
    }

    let cancelled = false;
    setHasError(false);

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

  const handleImageError = useCallback(() => {
    console.error(`Image failed to load: ${imageUrl}`);
    setHasError(true);
  }, [imageUrl]);

  // Loading state
  if (assetNodeId && isLoading) {
    return loadingPlaceholder || (
      <div className={`asset-image asset-image--loading ${className}`}>
        {showCard ? (
          <Card padding={false} radius={radius} elevation={elevation}>
            <div className="asset-image__placeholder" />
          </Card>
        ) : (
          <div className="asset-image__placeholder" />
        )}
      </div>
    );
  }

  // No image
  if (!assetNodeId || !imageUrl || hasError) {
    return (
      <div className={`asset-image asset-image--empty ${className}`}>
        {showCard ? (
          <Card padding={false} radius={radius} elevation={elevation} variant={variant}>
            {emptyPlaceholder || <div className="asset-image__placeholder" />}
          </Card>
        ) : (
          emptyPlaceholder || <div className="asset-image__placeholder" />
        )}
      </div>
    );
  }

  // Render image content
  const imageElement = (
    <img
      key={imageUrl}
      src={imageUrl}
      alt={alt}
      loading="lazy"
      className="asset-image__img"
      onError={handleImageError}
      style={{
        pointerEvents: isDragging ? 'none' : 'auto'
      }}
      title={clickable ? 'Click to view full size' : undefined}
      draggable="false"
    />
  );

  const imageContent = clickable ? (
    <button
      type="button"
      className="asset-image__button"
      onClick={handleImageClick}
      title="Click to view full size"
    >
      {imageElement}
    </button>
  ) : (
    imageElement
  );

  // Render default action buttons if onEdit/onRemove provided
  const defaultActions = (onEdit || onRemove) ? (
    <>
      {onEdit && (
        <Button aria-label="Change image"
          icon={"mdi mdi-pencil"}
          variant="ghost"
          size="xs"
          onClick={onEdit}
          title="Change image"
        />
      )}
      {onRemove && (
        <Button aria-label="Remove image"
          icon={"mdi mdi-close"}
          variant="ghost"
          size="xs"
          onClick={onRemove}
          title="Remove image"
        />
      )}
    </>
  ) : null;

  const actionButtons = actions || defaultActions;

  return (
    <>
      <div className={`asset-image ${className}`}>
        {/* Action buttons */}
        {showActions && actionButtons && (
          <FloatingButtonArray
            className="asset-image__actions"
            direction={actionsDirection}
            size="xs"
          >
            {actionButtons}
          </FloatingButtonArray>
        )}

        {/* Image with optional card wrapper */}
        {showCard ? (
          <Card padding={false} radius={radius} elevation={elevation} variant={variant}>
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
          bullet={
            showModalBullet && assetNode ? (
              <Bullet
                nodeId={assetNode.id}
                icon={assetNode.icon}
                isPage={assetNode.is_page}
                interactive={true}
                onClick={handleBulletClick}
                onShiftClick={handleBulletShiftClick}
                size="md"
                title="Click to open, Shift+click for sidebar"
              />
            ) : undefined
          }
        />
      )}
    </>
  );
}
