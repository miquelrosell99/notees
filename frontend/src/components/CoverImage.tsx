/**
 * CoverImage Component
 * 
 * Displays a cover image as a small card aligned to the right of the page header.
 * Uses the 'cover' system property to store the asset node reference.
 * 
 * The cover appears as a card with fixed height and adaptive width to maintain
 * the image's aspect ratio. It floats to the right of the header title.
 * 
 * Features:
 * - Collapsible: Can be collapsed to just an arrow icon to reclaim header space
 * - State persistence: Collapsed state is remembered per node
 * - Smooth animations between collapsed/expanded states
 * 
 * Supports:
 * - Displaying existing cover image
 * - Removing cover image
 * - Changing cover image (opens asset selector)
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNode, useProperties, useSetNodeProperty } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getAssetUrlAsync, uploadAsset, type Asset } from '@/api/assets';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { ImageModal } from './core/ImageModal';
import { FloatingButtonArray } from './core/FloatingButtonArray';
import { mdiImageOutline, mdiChevronRight, mdiChevronLeft, mdiPencil, mdiClose } from '@mdi/js';
import Icon from '@mdi/react';
import './CoverImage.css';

// Local storage key for collapsed state
const COVER_COLLAPSED_KEY = 'notees:cover-collapsed';

/**
 * Get collapsed state for a specific node from localStorage
 * Returns true (collapsed) by default if no state is stored and no image
 */
function getCollapsedState(pageId: number, hasImage: boolean): boolean {
  try {
    const stored = localStorage.getItem(COVER_COLLAPSED_KEY);
    if (stored) {
      const states = JSON.parse(stored) as Record<string, boolean>;
      const storedState = states[pageId.toString()];
      if (storedState !== undefined) {
        return storedState;
      }
    }
  } catch {
    // Ignore parse errors
  }
  // Default: collapsed when empty, expanded when has image
  return !hasImage;
}

/**
 * Save collapsed state for a specific node to localStorage
 */
function setCollapsedState(pageId: number, collapsed: boolean): void {
  try {
    const stored = localStorage.getItem(COVER_COLLAPSED_KEY);
    const states = stored ? JSON.parse(stored) as Record<string, boolean> : {};
    states[pageId.toString()] = collapsed;
    localStorage.setItem(COVER_COLLAPSED_KEY, JSON.stringify(states));
  } catch {
    // Ignore storage errors
  }
}

interface CoverImageProps {
  /** Page node ID */
  pageId: number;
  /** Cover image asset node ID (from properties.cover) */
  coverImageId: number | null;
  /** Callback to open asset picker */
  onSelectImage?: () => void;
  /** Callback when image uploaded (for handling after drag-drop) */
  onImageUploaded?: (asset: Asset) => void;
  /** Whether cover can be edited */
  editable?: boolean;
}

export function CoverImage({ 
  pageId, 
  coverImageId, 
  onSelectImage,
  onImageUploaded,
  editable = true,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => getCollapsedState(pageId, !!coverImageId));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const { data: assetNode, isLoading } = useNode(coverImageId, { include_children: false });
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Persist collapsed state when it changes
  useEffect(() => {
    setCollapsedState(pageId, isCollapsed);
  }, [pageId, isCollapsed]);
  
  // Reset collapsed state when pageId or coverImageId changes
  useEffect(() => {
    setIsCollapsed(getCollapsedState(pageId, !!coverImageId));
  }, [pageId, coverImageId]);
  
  // Bullet handlers
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (assetNode) {
      openNode(assetNode.id, assetNode.is_page ? 'page' : 'block');
    }
  }, [assetNode, openNode]);
  
  const handleBulletShiftClick = useCallback(() => {
    if (assetNode) {
      addSidebarCard(assetNode.id, assetNode.is_page ? 'page' : 'block');
    }
  }, [assetNode, addSidebarCard]);
  
  // Find the cover property by UUID
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);
  
  const handleRemove = useCallback(() => {
    if (!coverProperty) return;
    setPropertyMutation.mutate({
      nodeId: pageId,
      propertyId: coverProperty.id,
      value: null
    });
  }, [pageId, coverProperty, setPropertyMutation]);
  
  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);
  
  // Handle keyboard navigation for collapse toggle
  const handleCollapseKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleCollapse();
    }
  }, [handleToggleCollapse]);
  
  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, [editable]);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);
  
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (!editable || !coverProperty) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        const asset = await uploadAsset(result.file);
        setPropertyMutation.mutate({
          nodeId: pageId,
          propertyId: coverProperty.id,
          value: asset.node_id
        });
        if (onImageUploaded) {
          onImageUploaded(asset);
        }
        // Expand if collapsed after successful drop
        if (isCollapsed) {
          setIsCollapsed(false);
        }
      }
    } catch (error) {
      console.error('Failed to upload dropped cover:', error);
    }
  }, [editable, coverProperty, pageId, setPropertyMutation, onImageUploaded, isCollapsed]);
  
  // State for the image URL (needs to be async to get token)
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  
  // Get the image URL from the asset node's uuid (async with token)
  useEffect(() => {
    if (!coverImageId || !assetNode?.uuid) {
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
        console.error('Failed to load cover image URL:', err);
        if (!cancelled) {
          setImageUrl(null);
        }
      });
    
    return () => {
      cancelled = true;
    };
  }, [coverImageId, assetNode?.uuid]);
  
  // Loading state
  if (coverImageId && isLoading) {
    return (
      <div className="cover-image-card cover-image-card--loading">
        <Card padding={false} radius="md" elevation="low">
          <div className="cover-image-card__placeholder" />
        </Card>
      </div>
    );
  }
  
  // No cover image
  if (!coverImageId || !imageUrl) {
    // Show collapsed strip if editable
    if (!editable) return null;
    
    // Collapsed state - just the expand arrow
    if (isCollapsed) {
      return (
        <div 
          className="cover-image-card cover-image-card--collapsed cover-image-card--empty-collapsed"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <button
            className="cover-image-card__collapse-btn cover-image-card__collapse-btn--collapsed"
            onClick={handleToggleCollapse}
            onKeyDown={handleCollapseKeyDown}
            title="Expand to add cover"
            aria-label="Expand cover area"
            aria-expanded="false"
          >
            <Icon path={mdiChevronLeft} size={0.7} />
          </button>
        </div>
      );
    }
    
    // Expanded empty state - show add button with collapse option
    return (
      <div 
        className={`cover-image-card cover-image-card--empty ${isDragging ? 'cover-image-card--dragging' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <button
          className="cover-image-card__collapse-btn cover-image-card__collapse-btn--empty-expanded"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Collapse cover area"
          aria-label="Collapse cover area"
          aria-expanded="true"
        >
          <Icon path={mdiChevronRight} size={0.6} />
        </button>
        <button 
          className="cover-image-card__add-btn"
          onClick={onSelectImage}
          title="Add cover image"
        >
          <Icon path={mdiImageOutline} size={0.7} />
        </button>
      </div>
    );
  }
  
  // Collapsed state with image - show only the expand arrow
  if (isCollapsed) {
    return (
      <div 
        className="cover-image-card cover-image-card--collapsed"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="cover-image-card__collapse-btn cover-image-card__collapse-btn--collapsed"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Expand cover image"
          aria-label="Expand cover image"
          aria-expanded="false"
        >
          <Icon path={mdiChevronLeft} size={0.7} />
        </button>
        
        {/* Preview tooltip on hover */}
        {isHovered && (
          <div className="cover-image-card__preview-tooltip">
            <img 
              src={imageUrl} 
              alt="Cover preview" 
              className="cover-image-card__preview-img"
            />
          </div>
        )}
      </div>
    );
  }
  
  // Expanded state - show full card
  return (
    <div 
      className={`cover-image-card cover-image-card--expanded ${isDragging ? 'cover-image-card--dragging' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Action buttons - vertical stack on left side of image */}
      {editable && isHovered && (
        <FloatingButtonArray
          className="cover-image-card__actions"
          direction="vertical"
          size="sm"
        >
          <Button
            icon={mdiChevronRight}
            iconOnly
            variant="ghost"
            size="sm"
            onClick={handleToggleCollapse}
            title="Collapse cover"
            aria-label="Collapse cover image"
            aria-expanded="true"
          />
          <Button
            icon={mdiPencil}
            iconOnly
            variant="ghost"
            size="sm"
            onClick={onSelectImage}
            title="Change image"
          />
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            title="Remove image"
          />
        </FloatingButtonArray>
      )}
      
      <Card padding={false} radius="md" elevation="low">
        <img 
          key={imageUrl}
          src={imageUrl} 
          alt="Cover" 
          className="cover-image-card__img"
          onClick={() => setIsModalOpen(true)}
          style={{ cursor: 'pointer', pointerEvents: isDragging ? 'none' : 'auto' }}
          title="Click to view full size"
          draggable="false"
        />
      </Card>
      
      <ImageModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        src={imageUrl}
        alt="Cover"
        assetNode={assetNode}
        onBulletClick={handleBulletClick}
        onBulletShiftClick={handleBulletShiftClick}
      />
    </div>
  );
}

export default CoverImage;
