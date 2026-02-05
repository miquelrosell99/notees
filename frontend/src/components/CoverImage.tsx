/**
 * CoverImage Component
 * 
 * Displays a cover image as a small card aligned to the right of the page header.
 * Uses the 'Cover' system property to store the asset node reference.
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
import { useProperties, useSetNodeProperty } from '@/hooks';
import { uploadAsset, type Asset } from '@/api/assets';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { Button } from './core/Button';
import { ImageNode } from './ImageNode';
import { mdiImageOutline, mdiChevronLeft, mdiPencil, mdiClose } from '@mdi/js';
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
  // Default: collapsed if no image, expanded if has image
  return !hasImage;
}

/**
 * Set collapsed state for a specific node in localStorage
 */
function setCollapsedState(pageId: number, collapsed: boolean): void {
  try {
    const stored = localStorage.getItem(COVER_COLLAPSED_KEY);
    const states = stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
    states[pageId.toString()] = collapsed;
    localStorage.setItem(COVER_COLLAPSED_KEY, JSON.stringify(states));
  } catch {
    // Ignore storage errors
  }
}

interface CoverImageProps {
  pageId: number;
  coverImageId: number | null;
  editable?: boolean;
  onSelectImage: () => void;
  onImageUploaded?: (asset: Asset) => void;
}

/**
 * CoverImage - Displays a cover image card in page header
 */
export function CoverImage({
  pageId,
  coverImageId,
  editable = false,
  onSelectImage,
  onImageUploaded,
}: CoverImageProps) {
  const [isCollapsed, setIsCollapsed] = useState(() => getCollapsedState(pageId, !!coverImageId));
  const [isDragging, setIsDragging] = useState(false);
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  
  // Persist collapsed state when it changes
  useEffect(() => {
    setCollapsedState(pageId, isCollapsed);
  }, [pageId, isCollapsed]);
  
  // Reset collapsed state when pageId or coverImageId changes
  useEffect(() => {
    setIsCollapsed(getCollapsedState(pageId, !!coverImageId));
  }, [pageId, coverImageId]);
  
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
  
  // No cover image
  if (!coverImageId) {
    // Show collapsed strip if editable
    if (!editable) return null;
    
    return (
      <div 
        className={`cover-image-card cover-image-card--empty ${isDragging ? 'cover-image-card--dragging' : ''}`}
      >
        <button
          className="cover-image-card__collapse-btn"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title={isCollapsed ? "Expand to add cover" : "Collapse cover"}
          aria-label={isCollapsed ? "Expand cover" : "Collapse cover"}
          aria-expanded={!isCollapsed}
        >
          <Icon path={mdiChevronLeft} size={0.7} rotate={isCollapsed ? 0 : 180} />
        </button>
        <div className={`cover-image-card__content ${isCollapsed ? 'cover-image-card__content--collapsed' : 'cover-image-card__content--expanded'}`}>
          <div
            className="cover-image-card__dropzone"
            onDragOver={!isCollapsed ? handleDragOver : undefined}
            onDragLeave={!isCollapsed ? handleDragLeave : undefined}
            onDrop={!isCollapsed ? handleDrop : undefined}
          >
            <Button 
              variant="ghost"
              size="sm"
              className="cover-image-card__add-btn"
              onClick={onSelectImage}
              title="Add cover image"
            >
              <Icon path={mdiImageOutline} size={0.8} />
            </Button>
          </div>
        </div>
      </div>
    );
  }
  
  // Has cover image
  return (
    <div 
      className={`cover-image-card cover-image-card--with-image ${isDragging ? 'cover-image-card--dragging' : ''}`}
    >
      <button
        className="cover-image-card__collapse-btn"
        onClick={handleToggleCollapse}
        onKeyDown={handleCollapseKeyDown}
        title={isCollapsed ? "Expand cover image" : "Collapse cover"}
        aria-label={isCollapsed ? "Expand cover image" : "Collapse cover image"}
        aria-expanded={!isCollapsed}
      >
        <Icon path={mdiChevronLeft} size={0.7} rotate={isCollapsed ? 0 : 180} />
      </button>
      
      <div 
        className={`cover-image-card__content ${isCollapsed ? 'cover-image-card__content--collapsed' : 'cover-image-card__content--expanded'}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ImageNode
          assetNodeId={coverImageId}
          alt="Cover"
          className="cover-image-card__image-node"
          showCard={true}
          elevation="low"
          radius="md"
          clickable={true}
          showActions={editable && !isCollapsed}
          actions={
            <>
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
            </>
          }
          actionsDirection="vertical"
          isDragging={isDragging}
          showModalBullet={true}
        />
      </div>
    </div>
  );
}

export default CoverImage;
